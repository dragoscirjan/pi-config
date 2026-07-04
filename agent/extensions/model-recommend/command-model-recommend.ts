import { syncBenchmarks, getAllBenchmarks, findBenchmarkForModel } from "./benchmarks";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir, type ExtensionAPI, DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Input, Text, Key, matchesKey } from "@mariozechner/pi-tui";
import { type ModelLike as RegistryModelLike, buildCostHintIndex, buildModelProfile } from "./model-profile";

type ModelLike = RegistryModelLike & { maxTokens?: number };

type Taxonomy = {
	version: string;
	lastUpdated: string;
	categories: Record<string, { weight: number; concepts: Record<string, string[]> }>;
};

type RecommendConfig = {
	version: string;
	lastUpdated: string;
	aliases: Record<string, string[]>;
	skillWeights: Record<string, { intel: number; speed: number; price: number; context: number }>;
	liveTaxonomy: {
		enabledSources: string[];
		maxTermsPerSource: number;
		requestTimeoutMs: number;
		externalCategoryWeight: number;
		sourceWeights: Record<string, number>;
	};
	router: {
		autoMode: "off" | "suggest" | "enforce";
		learnEnabled: boolean;
		minMarginForAutoPick: number;
		askOutcomeFeedback: boolean;
		learning: { maxAlpha: number; alphaWarmupSamples: number; pairwiseStep: number };
	};
	defaults: {
		minIntelForComplexCheap: number;
		cheapWeightCap: number;
		freeModelBonusCap: number;
		tieJitterMax: number;
		intentSpread: number;
		externalSignalInferenceWeight: number;
		capabilityDeltaGuard: number;
		capabilityDeltaPenalty: number;
		capabilityDeltaMinComplexity: number;
	};
};

type Intent = {
	complexity: number;
	domains: Set<string>;
	matchedTaxonomyCategories: Set<string>;
	matchedTaxonomyConcepts: Set<string>;
	languages: Set<string>;
	capabilityNeeds: {
		reasoningDepth: number;
		systemBreadth: number;
		correctnessRisk: number;
		contextVolume: number;
		safetyCriticality: number;
		latencySensitivity: number;
		costSensitivity: number;
		codingLikelihood: number;
		designLikelihood: number;
		bestQualityBias: number;
	};
};

type RecommendOptions = {
	task: string;
	rebuildTaxonomy: boolean;
	liveTaxonomy: boolean;
	liveSourcesArg?: string;
	trusted: boolean;
	providers: string[];
	grep?: string;
	sortBy: "score" | "intelligence" | "reasoning" | "reliability" | "speed" | "price" | "context";
	sortDir: "asc" | "desc";
	strategy: "cheapest-capable" | "capability-first" | "local-first";
	localPrefer: boolean;
	localOnly: boolean;
	limit: number;
	help: boolean;
	explain: boolean;
	autoModeArg?: "off" | "suggest" | "enforce";
	learningModeArg?: "on" | "off";
	status: boolean;
	resetLearning: boolean;
	exportTaxonomyPath?: string;
	importTaxonomyPath?: string;
	mergeTaxonomyPath?: string;
	mergePolicy: "append" | "replace" | "keep";
};

type TaxonomyState = {
	taxonomy: Taxonomy;
	rebuilt: boolean;
	enriched: boolean;
	liveSources: string[];
};

type ScoreBreakdown = {
	normIntel: number;
	normSpeed: number;
	normPrice: number;
	normContext: number;
	weightedBase: number;
	affinity: number;
	tieJitter: number;
	final: number;
	weights: { intel: number; speed: number; price: number; context: number };
	reasons: string[];
};

type ScoredModel = {
	provider: string;
	model: string;
	score: number;
	intelligence: number;
	reasoning: number;
	toolReliability: number;
	speed: number;
	inputPrice: number;
	outputPrice: number;
	effectivePrice: number;
	priceEstimated: boolean;
	contextWindow: number;
	supportsImages: boolean;
	isLocal: boolean;
	breakdown: ScoreBreakdown;
};

const TRUSTED_ORGS = new Set([
	"meta-llama",
	"mistralai",
	"google",
	"microsoft",
	"anthropic",
	"openai",
	"deepseek-ai",
	"qwen",
	"nousresearch",
	"nexusflow",
	"cohereforai",
	"gradientai",
	"nvidia",
	"apple",
	"unsloth",
	"bartowski",
	"mradermacher",
	"maziyarpanahi",
	"thebloke",
	"lonestriker",
	"m-a-p",
	"lmstudio-community",
]);

const LOCAL_PROVIDER_HINTS = ["ollama", "lmstudio", "llama.cpp", "llamacpp", "vllm", "local", "openwebui", "kobold", "jan"];

const DOMAIN_KEYWORDS: Record<string, string[]> = {
	coding: [
		"python",
		"typescript",
		"javascript",
		"js",
		"ts",
		"rust",
		"go",
		"java",
		"elixir",
		"code",
		"coding",
		"api",
		"algorithm",
		"godot",
		"gdscript",
	],
	reasoning: ["logic", "math", "reason", "complex", "solve", "architecture", "analysis", "hld", "system design"],
	creative: ["story", "write", "creative", "tone", "copywriting", "game", "dialog"],
};

const LANGUAGE_HINTS: Record<string, { aliases: string[]; rarity: number }> = {
	javascript: { aliases: ["javascript", "js", "node", "nodejs"], rarity: 0.1 },
	typescript: { aliases: ["typescript", "ts"], rarity: 0.2 },
	python: { aliases: ["python", "py"], rarity: 0.1 },
	java: { aliases: ["java", "spring", "springboot", "jdk"], rarity: 0.2 },
	go: { aliases: ["go", "golang"], rarity: 0.25 },
	rust: { aliases: ["rust"], rarity: 0.45 },
	csharp: { aliases: ["c#", "csharp", ".net", "dotnet"], rarity: 0.25 },
	php: { aliases: ["php", "laravel", "symfony"], rarity: 0.25 },
	elixir: { aliases: ["elixir", "elyxir", "phoenix", "beam"], rarity: 0.7 },
	scala: { aliases: ["scala", "akka"], rarity: 0.7 },
	haskell: { aliases: ["haskell"], rarity: 0.8 },
	gdscript: { aliases: ["godot", "gdscript"], rarity: 0.55 },
};

const SKILL_KEYWORDS: Record<string, string[]> = {
	algorithms: ["algorithm", "sorting", "quicksort", "mergesort", "dijkstra", "dp", "segment tree", "fenwick", "hld", "heavy light"],
	system_design: ["hld", "high level design", "architecture", "distributed", "scalable", "microservice", "event-driven", "ddd", "cqrs", "saga"],
	security_auth: ["auth", "authentication", "authorization", "rbac", "oauth", "oidc", "jwt", "cognito", "iam", "security"],
	cloud_aws: ["aws", "cognito", "lambda", "dynamodb", "s3", "eventbridge", "eks", "rds", "cloudfront"],
	game_dev: ["godot", "unity", "unreal", "card game", "gameplay", "npc", "2d", "3d", "gdscript"],
	performance: ["fast", "low latency", "throughput", "optimize", "performance", "realtime"],
};

const SKILL_COMPLEXITY_BONUS: Record<string, number> = {
	algorithms: 18,
	system_design: 25,
	security_auth: 22,
	cloud_aws: 20,
	game_dev: 14,
	performance: 12,
};

const COMPLEXITY_TRIGGERS: Record<string, number> = {
	microservice: 25,
	architecture: 24,
	auth: 16,
	authorization: 16,
	rbac: 20,
	cognito: 24,
	distributed: 24,
	optimize: 15,
	refactor: 12,
	migration: 14,
	security: 18,
	hld: 26,
	algorithm: 10,
	sorting: 8,
};

const DEFAULT_TAXONOMY: Taxonomy = {
	version: "2.0.0",
	lastUpdated: "",
	categories: {
		algorithms_data_structures: {
			weight: 1.15,
			concepts: {
				sorting: ["quicksort", "mergesort", "heapsort", "radix sort", "topological sort"],
				graph: ["dijkstra", "a*", "toposort", "mst", "floyd-warshall"],
				trees: ["segment tree", "fenwick", "hld", "heavy light decomposition", "trie", "suffix tree"],
			},
		},
		architecture_design: {
			weight: 1.2,
			concepts: {
				design: ["hld", "high level design", "architecture", "tradeoff", "scalability", "distributed"],
				patterns: ["ddd", "cqrs", "event sourcing", "saga", "clean architecture", "hexagonal"],
			},
		},
		auth_identity_security: {
			weight: 1.2,
			concepts: {
				auth: ["authentication", "authorization", "rbac", "abac", "oauth2", "oidc", "jwt", "mfa"],
				platforms: ["aws cognito", "cognito", "auth0", "keycloak", "iam"],
				appsec: ["xss", "csrf", "ssrf", "sqli", "owasp", "threat model"],
			},
		},
		cloud_infrastructure: {
			weight: 1.05,
			concepts: {
				aws: ["aws", "lambda", "dynamodb", "s3", "cloudfront", "eventbridge", "eks", "rds"],
				devops: ["kubernetes", "docker", "terraform", "pulumi", "github actions", "ci/cd"],
			},
		},
		languages_frameworks: {
			weight: 1,
			concepts: {
				languages: ["javascript", "typescript", "python", "java", "go", "rust", "elixir", "scala", "haskell", "c#", "php"],
				frameworks: ["react", "vue", "angular", "fastapi", "spring", "phoenix", "laravel"],
			},
		},
		game_development: {
			weight: 1.1,
			concepts: {
				engines: ["godot", "gdscript", "unity", "unreal"],
				design: ["card game", "turn based", "state machine", "game loop", "multiplayer"],
			},
		},
	},
};

const DEFAULT_CONFIG: RecommendConfig = {
	version: "1.0.0",
	lastUpdated: "",
	aliases: {
		elyxir: ["elixir"],
		authn: ["authentication"],
		authz: ["authorization"],
		arround: ["around"],
		jscript: ["javascript"],
		highlevel: ["high level"],
		hld: ["high level design"],
		quick_sort: ["quicksort"],
	},
	skillWeights: {
		algorithms: { intel: 0.4, speed: 0.3, price: 0.05, context: 0.15 },
		system_design: { intel: 0.5, speed: 0.05, price: 0.0, context: 0.45 },
		security_auth: { intel: 0.45, speed: 0.05, price: 0.0, context: 0.4 },
		cloud_aws: { intel: 0.35, speed: 0.05, price: 0.0, context: 0.5 },
		game_dev: { intel: 0.25, speed: 0.2, price: 0.05, context: 0.5 },
		performance: { intel: 0.15, speed: 0.6, price: 0.05, context: 0.2 },
	},
	liveTaxonomy: {
		enabledSources: ["all"],
		maxTermsPerSource: 180,
		requestTimeoutMs: 4500,
		externalCategoryWeight: 0.2,
		sourceWeights: {
			stack_overflow: 1,
			stackexchange_network: 0.9,
			github_topics: 0.95,
			github_trending: 0.9,
			reddit: 0.7,
			hackernews: 0.85,
			lobsters: 0.75,
			npm: 0.8,
			pypi: 0.8,
			crates: 0.8,
			maven: 0.75,
			awesome_lists: 0.7,
			arxiv: 0.8,
			cloud_changelogs: 0.9,
			cncf_landscape: 0.85,
			job_boards: 0.6,
			google_trends: 0.65,
			gdelt: 0.6,
		},
	},
	router: {
		autoMode: "off",
		learnEnabled: true,
		minMarginForAutoPick: 6,
		askOutcomeFeedback: false,
		learning: {
			maxAlpha: 0.45,
			alphaWarmupSamples: 200,
			pairwiseStep: 1,
		},
	},
	defaults: {
		minIntelForComplexCheap: 72,
		cheapWeightCap: 1.9,
		freeModelBonusCap: 1.08,
		tieJitterMax: 0.35,
		intentSpread: 1.35,
		externalSignalInferenceWeight: 0.25,
		capabilityDeltaGuard: 0.12,
		capabilityDeltaPenalty: 0.2,
		capabilityDeltaMinComplexity: 55,
	},
};

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

function normalizeText(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/[_/]+/g, " ")
		.replace(/[^a-z0-9#+\.\-\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// ANSI styling (module-level, used in table rendering)
const ANSIreset   = "\x1b[0m";
const ANSIbold    = "\x1b[1m";
const ANSIdim     = "\x1b[2m";
const ANSIcyan    = "\x1b[36m";
const ANSIgreen   = "\x1b[32m";
const ANSImagenta = "\x1b[35m";
const ANSIyellow  = "\x1b[33m";
const ANSIblue    = "\x1b[34m";

function padCol(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function formatTokenCount(value: number): string {
	if (!value || value <= 0) return "-";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) {
		const k = value / 1_000;
		return Number.isInteger(k) ? `${k}K` : `${k.toFixed(1)}K`;
	}
	return `${value}`;
}

function formatMoney(value: number): string {
	return `$${value.toFixed(2)}`;
}

function tokenize(raw: string): string[] {
	const matches = raw.match(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g) ?? [];
	return matches.map((t) => {
		if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
		return t;
	});
}

function getAuthenticatedProvidersFromAuthJson(): Set<string> {
	const authPath = join(getAgentDir(), "auth.json");
	if (!existsSync(authPath)) return new Set();
	try {
		const raw = readFileSync(authPath, "utf-8");
		const json = JSON.parse(raw) as Record<string, any>;
		const providers = new Set<string>();
		for (const [provider, cfg] of Object.entries(json)) {
			if (!cfg || typeof cfg !== "object") continue;
			const type = String(cfg.type ?? "").toLowerCase();
			const hasApiKey = Boolean(cfg.key ?? cfg.apiKey);
			const hasOAuthToken = Boolean(cfg.access ?? cfg.refresh ?? cfg.token);
			if ((type === "api_key" && hasApiKey) || (type === "oauth" && hasOAuthToken) || (hasApiKey || hasOAuthToken)) providers.add(provider);
		}
		return providers;
	} catch {
		return new Set();
	}
}

function parseRecommendArgs(raw: string): RecommendOptions {
	const tokens = tokenize(raw);
	const opts: RecommendOptions = {
		task: "",
		rebuildTaxonomy: false,
		liveTaxonomy: false,
		liveSourcesArg: undefined,
		trusted: false,
		providers: [],
		sortBy: "score",
		sortDir: "desc",
		strategy: "cheapest-capable",
		localPrefer: false,
		localOnly: false,
		limit: 10,
		help: false,
		explain: false,
		autoModeArg: undefined,
		learningModeArg: undefined,
		status: false,
		resetLearning: false,
		exportTaxonomyPath: undefined,
		importTaxonomyPath: undefined,
		mergeTaxonomyPath: undefined,
		mergePolicy: "append",
	};
	const free: string[] = [];

	const pushProviders = (raw: string | undefined) => {
		if (!raw) return;
		for (const part of raw.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean)) opts.providers.push(part);
	};

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		switch (t) {
			case "--help":
			case "-h":
				opts.help = true;
				break;
			case "--rebuild-taxonomy":
				opts.rebuildTaxonomy = true;
				break;
			case "--sync-benchmarks":
				opts.syncBenchmarks = true;
				break;
			case "--set-auto": {
				const mode = (tokens[++i] ?? "").toLowerCase();
				if (mode === "off" || mode === "suggest" || mode === "enforce") opts.autoModeArg = mode;
				break;
			}
			case "--set-learning": {
				const mode = (tokens[++i] ?? "").toLowerCase();
				if (mode === "on" || mode === "off") opts.learningModeArg = mode;
				break;
			}
			case "--status":
				opts.status = true;
				break;
			case "--reset-learning":
				opts.resetLearning = true;
				break;

			case "--export-taxonomy":
				opts.exportTaxonomyPath = tokens[++i];
				break;
			case "--import-taxonomy":
				opts.importTaxonomyPath = tokens[++i];
				break;
			case "--merge-taxonomy":
				opts.mergeTaxonomyPath = tokens[++i];
				break;
			case "--merge-policy": {
				const policy = (tokens[++i] ?? "").toLowerCase();
				if (policy === "append" || policy === "replace" || policy === "keep") opts.mergePolicy = policy;
				break;
			}
			case "--trusted":
				opts.trusted = true;
				break;
			case "--live-taxonomy":
				opts.liveTaxonomy = true;
				break;
			case "--live-sources":
				opts.liveTaxonomy = true;
				opts.liveSourcesArg = tokens[++i];
				break;
			case "--explain":
				opts.explain = true;
				break;
			case "--provider":
			case "--providers":
				pushProviders(tokens[++i]);
				break;
			case "--grep":
				opts.grep = tokens[++i];
				break;
			case "--sort-by": {
				const rawSort = (tokens[++i] ?? "").toLowerCase();
				const v = rawSort === "intel" ? "intelligence" : rawSort;
				if (["score", "intelligence", "reasoning", "reliability", "speed", "price", "context"].includes(v)) opts.sortBy = v as RecommendOptions["sortBy"];
				const maybeDir = (tokens[i + 1] ?? "").toLowerCase();
				if (maybeDir === "asc" || maybeDir === "desc") {
					opts.sortDir = maybeDir;
					i++;
				}
				break;
			}
			case "--strategy": {
				const s = (tokens[++i] ?? "").toLowerCase();
				if (s === "cheapest-capable" || s === "capability-first" || s === "local-first") opts.strategy = s;
				break;
			}
			case "--local-prefer":
				opts.localPrefer = true;
				break;
			case "--local-only":
				opts.localOnly = true;
				break;
			case "--limit": {
				const n = parseInt(tokens[++i] ?? "10", 10);
				if (!Number.isNaN(n) && n > 0) opts.limit = n;
				break;
			}
			default:
				if (t.startsWith("-")) break;
				free.push(t);
		}
	}

	opts.task = free.join(" ").trim();
	return opts;
}

function isTrustedAuthor(modelId: string): boolean {
	if (!modelId.includes("/")) return true;
	return TRUSTED_ORGS.has(modelId.split("/")[0].toLowerCase());
}

function isLocalModel(provider: string): boolean {
	const lower = provider.toLowerCase();
	if (lower === "github-copilot") return false;
	return LOCAL_PROVIDER_HINTS.some((hint) => lower.includes(hint));
}

function hashString(value: string): number {
	let hash = 0;
	for (let i = 0; i < value.length; i++) {
		hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
	}
	return hash;
}

function getModelSizeBillionHint(modelId: string): number {
	const lower = modelId.toLowerCase();
	const m = lower.match(/(?:^|[^0-9])(\d{1,4})(?:\.?\d+)?\s*b(?:[^a-z0-9]|$)/i);
	if (!m) return 0;
	const v = Number(m[1]);
	return Number.isFinite(v) ? v : 0;
}

function getIntelHeuristic(model: ModelLike): number {
	const name = model.id.toLowerCase();
	const sizeB = getModelSizeBillionHint(model.id);
	let score = 44;

	if (model.reasoning) score += 16;
	if (model.contextWindow && model.contextWindow >= 200_000) score += 11;
	else if (model.contextWindow && model.contextWindow >= 128_000) score += 8;
	else if (model.contextWindow && model.contextWindow >= 32_000) score += 4;

	if (sizeB >= 400) score += 26;
	else if (sizeB >= 200) score += 22;
	else if (sizeB >= 70) score += 16;
	else if (sizeB >= 30) score += 10;
	else if (sizeB >= 14) score += 6;
	else if (sizeB >= 8) score += 3;

	if (["mini", "lite", "flash", "nano", "small", "tiny", "3b"].some((k) => name.includes(k))) score -= 9;
	if (["coder", "code", "instruct"].some((k) => name.includes(k))) score += 5;
	if (["reason", "think", "r1", "o1", "o3"].some((k) => name.includes(k))) score += 7;
	if (["preview", "experimental"].some((k) => name.includes(k))) score -= 2;

	const jitter = (hashString(`${model.provider}/${model.id}`) % 9) / 10;
	score += jitter;
	return clamp(Math.round(score), 22, 98);
}

function getSpeedHeuristic(model: ModelLike): number {
	const name = model.id.toLowerCase();
	const sizeB = getModelSizeBillionHint(model.id);
	let score = 55;

	if (["mini", "lite", "flash", "nano", "small", "tiny", "8b", "3b"].some((k) => name.includes(k))) score += 36;
	if (sizeB >= 200) score -= 24;
	else if (sizeB >= 70) score -= 16;
	else if (sizeB >= 30) score -= 8;
	if (model.reasoning) score -= 10;
	if (model.contextWindow && model.contextWindow >= 200_000) score -= 8;

	const jitter = (hashString(`${model.id}/${model.provider}`) % 7) / 10;
	score += jitter;
	return clamp(Math.round(score), 12, 170);
}

function getTaxonomyPath(): string {
	return join(homedir(), ".pi", "model-taxonomy.json");
}

function getConfigPath(): string {
	return join(getAgentDir(), "model-recommend-config.json");
}

function createTaxonomySnapshot(): Taxonomy {
	return {
		...DEFAULT_TAXONOMY,
		lastUpdated: new Date().toISOString(),
		categories: JSON.parse(JSON.stringify(DEFAULT_TAXONOMY.categories)) as Taxonomy["categories"],
	};
}

function createConfigSnapshot(): RecommendConfig {
	return {
		...DEFAULT_CONFIG,
		lastUpdated: new Date().toISOString(),
		aliases: JSON.parse(JSON.stringify(DEFAULT_CONFIG.aliases)) as RecommendConfig["aliases"],
		skillWeights: JSON.parse(JSON.stringify(DEFAULT_CONFIG.skillWeights)) as RecommendConfig["skillWeights"],
		liveTaxonomy: JSON.parse(JSON.stringify(DEFAULT_CONFIG.liveTaxonomy)) as RecommendConfig["liveTaxonomy"],
		router: JSON.parse(JSON.stringify(DEFAULT_CONFIG.router)) as RecommendConfig["router"],
		defaults: JSON.parse(JSON.stringify(DEFAULT_CONFIG.defaults)) as RecommendConfig["defaults"],
	};
}

const ALL_LIVE_SOURCES = [
	"stack_overflow",
	"stackexchange_network",
	"github_topics",
	"github_trending",
	"reddit",
	"hackernews",
	"lobsters",
	"npm",
	"pypi",
	"crates",
	"maven",
	"awesome_lists",
	"arxiv",
	"cloud_changelogs",
	"cncf_landscape",
	"job_boards",
	"google_trends",
	"gdelt",
] as const;

type LiveSource = (typeof ALL_LIVE_SOURCES)[number];

type LiveSourceContext = { timeoutMs: number; maxTerms: number };

type LiveFetcher = (ctx: LiveSourceContext) => Promise<string[]>;

function sanitizeLiveTerms(values: string[], maxTerms = 150): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const normalized = normalizeText(value);
		if (!normalized || normalized.length < 2 || normalized.length > 48) continue;
		if (/^\d+$/.test(normalized)) continue;
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
		if (out.length >= maxTerms) break;
	}
	return out;
}

function parseRssTitles(xml: string): string[] {
	const cdataTitles = [...xml.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/gis)].map((m) => m[1]);
	const plainTitles = [...xml.matchAll(/<title>(.*?)<\/title>/gis)].map((m) => m[1]);
	return [...cdataTitles, ...plainTitles]
		.map((t) => t.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim())
		.filter(Boolean);
}

async function fetchJson(url: string, headers?: Record<string, string>, timeoutMs = 4000): Promise<any | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { headers, signal: controller.signal });
		if (!response.ok) return undefined;
		return await response.json();
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

async function fetchText(url: string, headers?: Record<string, string>, timeoutMs = 4000): Promise<string | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { headers, signal: controller.signal });
		if (!response.ok) return undefined;
		return await response.text();
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

async function fetchStackOverflowTags(ctx: LiveSourceContext): Promise<string[]> {
	const tags: string[] = [];
	for (let page = 1; page <= 2; page++) {
		const url = `https://api.stackexchange.com/2.3/tags?page=${page}&pagesize=100&order=desc&sort=popular&site=stackoverflow`;
		const json = await fetchJson(url, undefined, ctx.timeoutMs);
		if (!json?.items || !Array.isArray(json.items)) break;
		for (const item of json.items) if (typeof item?.name === "string") tags.push(item.name);
	}
	return sanitizeLiveTerms(tags, ctx.maxTerms);
}

async function fetchStackExchangeNetworkTags(ctx: LiveSourceContext): Promise<string[]> {
	const terms: string[] = [];
	const sites = ["serverfault", "superuser", "datascience", "devops"];
	for (const site of sites) {
		const url = `https://api.stackexchange.com/2.3/tags?page=1&pagesize=60&order=desc&sort=popular&site=${site}`;
		const json = await fetchJson(url, undefined, ctx.timeoutMs);
		if (!json?.items || !Array.isArray(json.items)) continue;
		for (const item of json.items) if (typeof item?.name === "string") terms.push(item.name);
	}
	return sanitizeLiveTerms(terms, ctx.maxTerms);
}

async function fetchGithubTopics(ctx: LiveSourceContext): Promise<string[]> {
	const url = "https://api.github.com/search/repositories?q=stars:>5000&sort=updated&order=desc&per_page=100";
	const headers = { Accept: "application/vnd.github+json", "User-Agent": "pi-model-recommend-taxonomy" };
	const json = await fetchJson(url, headers, ctx.timeoutMs);
	if (!json?.items || !Array.isArray(json.items)) return [];
	const topics: string[] = [];
	for (const repo of json.items) {
		for (const topic of repo?.topics ?? []) if (typeof topic === "string") topics.push(topic);
	}
	return sanitizeLiveTerms(topics, ctx.maxTerms);
}

async function fetchGithubTrending(ctx: LiveSourceContext): Promise<string[]> {
	const html = await fetchText("https://github.com/trending?since=daily", { "User-Agent": "pi-model-recommend-taxonomy" }, ctx.timeoutMs);
	if (!html) return [];
	const repos = [...html.matchAll(/href="\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
	return sanitizeLiveTerms(repos, ctx.maxTerms);
}

async function fetchReddit(ctx: LiveSourceContext): Promise<string[]> {
	const subs = ["programming", "webdev", "MachineLearning", "devops"];
	const terms: string[] = [];
	for (const sub of subs) {
		const url = `https://www.reddit.com/r/${sub}/hot.json?limit=40`;
		const json = await fetchJson(url, { "User-Agent": "pi-model-recommend-taxonomy" }, ctx.timeoutMs);
		for (const child of json?.data?.children ?? []) {
			const title = child?.data?.title;
			if (typeof title === "string") terms.push(title);
		}
	}
	return sanitizeLiveTerms(terms, ctx.maxTerms);
}

async function fetchHackerNews(ctx: LiveSourceContext): Promise<string[]> {
	const url = "https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=100";
	const json = await fetchJson(url, undefined, ctx.timeoutMs);
	const terms = (json?.hits ?? []).map((h: any) => h?.title).filter((t: any) => typeof t === "string") as string[];
	return sanitizeLiveTerms(terms, ctx.maxTerms);
}

async function fetchLobsters(ctx: LiveSourceContext): Promise<string[]> {
	const xml = await fetchText("https://lobste.rs/rss", undefined, ctx.timeoutMs);
	if (!xml) return [];
	return sanitizeLiveTerms(parseRssTitles(xml), ctx.maxTerms);
}

async function fetchNpm(ctx: LiveSourceContext): Promise<string[]> {
	const url = "https://registry.npmjs.org/-/v1/search?text=keywords:typescript+OR+keywords:javascript&size=100";
	const json = await fetchJson(url, undefined, ctx.timeoutMs);
	const terms: string[] = [];
	for (const obj of json?.objects ?? []) {
		const pkg = obj?.package;
		if (typeof pkg?.name === "string") terms.push(pkg.name);
		if (Array.isArray(pkg?.keywords)) terms.push(...pkg.keywords.filter((k: any) => typeof k === "string"));
	}
	return sanitizeLiveTerms(terms, ctx.maxTerms);
}

async function fetchPypi(ctx: LiveSourceContext): Promise<string[]> {
	const url = "https://hugovk.github.io/top-pypi-packages/top-pypi-packages-30-days.min.json";
	const json = await fetchJson(url, undefined, ctx.timeoutMs);
	const terms = (json?.rows ?? []).map((r: any) => r?.project).filter((t: any) => typeof t === "string") as string[];
	return sanitizeLiveTerms(terms, ctx.maxTerms);
}

async function fetchCrates(ctx: LiveSourceContext): Promise<string[]> {
	const url = "https://crates.io/api/v1/crates?page=1&per_page=100&sort=downloads";
	const json = await fetchJson(url, undefined, ctx.timeoutMs);
	const terms: string[] = [];
	for (const c of json?.crates ?? []) {
		if (typeof c?.name === "string") terms.push(c.name);
		if (Array.isArray(c?.keywords)) terms.push(...c.keywords.filter((k: any) => typeof k === "string"));
	}
	return sanitizeLiveTerms(terms, ctx.maxTerms);
}

async function fetchMaven(ctx: LiveSourceContext): Promise<string[]> {
	const url = "https://search.maven.org/solrsearch/select?q=*:*&rows=100&wt=json";
	const json = await fetchJson(url, undefined, ctx.timeoutMs);
	const terms: string[] = [];
	for (const d of json?.response?.docs ?? []) {
		if (typeof d?.a === "string") terms.push(d.a);
		if (typeof d?.g === "string") terms.push(d.g);
	}
	return sanitizeLiveTerms(terms, ctx.maxTerms);
}

async function fetchAwesomeLists(ctx: LiveSourceContext): Promise<string[]> {
	const url = "https://raw.githubusercontent.com/sindresorhus/awesome/main/readme.md";
	const text = await fetchText(url, undefined, ctx.timeoutMs);
	if (!text) return [];
	const terms = [...text.matchAll(/^\s*[-*]\s+\[([^\]]+)\]/gm)].map((m) => m[1]);
	return sanitizeLiveTerms(terms, ctx.maxTerms);
}

async function fetchArxiv(ctx: LiveSourceContext): Promise<string[]> {
	const url = "https://export.arxiv.org/api/query?search_query=cat:cs.LG+OR+cat:cs.SE+OR+cat:cs.DC&start=0&max_results=80";
	const xml = await fetchText(url, undefined, ctx.timeoutMs);
	if (!xml) return [];
	const titles = [...xml.matchAll(/<title>(.*?)<\/title>/gis)].map((m) => m[1]);
	return sanitizeLiveTerms(titles, ctx.maxTerms);
}

async function fetchCloudChangelogs(ctx: LiveSourceContext): Promise<string[]> {
	const urls = [
		"https://aws.amazon.com/about-aws/whats-new/recent/feed/",
		"https://cloud.google.com/feeds/release-notes.xml",
		"https://azurecomcdn.azureedge.net/en-us/updates/feed/",
	];
	const terms: string[] = [];
	for (const url of urls) {
		const xml = await fetchText(url, undefined, ctx.timeoutMs);
		if (!xml) continue;
		terms.push(...parseRssTitles(xml));
	}
	return sanitizeLiveTerms(terms, ctx.maxTerms);
}

async function fetchCNCFLandscape(ctx: LiveSourceContext): Promise<string[]> {
	const url = "https://raw.githubusercontent.com/cncf/landscape/master/landscape.yml";
	const text = await fetchText(url, undefined, ctx.timeoutMs);
	if (!text) return [];
	const names = [...text.matchAll(/^\s*name:\s*['"]?([^'"\n]+)['"]?/gm)].map((m) => m[1]);
	return sanitizeLiveTerms(names, ctx.maxTerms);
}

async function fetchJobBoards(ctx: LiveSourceContext): Promise<string[]> {
	const json = await fetchJson("https://remoteok.com/api", { "User-Agent": "pi-model-recommend-taxonomy" }, ctx.timeoutMs);
	const terms: string[] = [];
	if (Array.isArray(json)) {
		for (const job of json.slice(0, 120)) {
			if (typeof job?.position === "string") terms.push(job.position);
			if (Array.isArray(job?.tags)) terms.push(...job.tags.filter((t: any) => typeof t === "string"));
		}
	}
	return sanitizeLiveTerms(terms, ctx.maxTerms);
}

async function fetchGoogleTrends(ctx: LiveSourceContext): Promise<string[]> {
	const rssUrl = "https://trends.google.com/trends/trendingsearches/daily/rss?geo=US";
	const xml = await fetchText(rssUrl, { "User-Agent": "pi-model-recommend-taxonomy" }, ctx.timeoutMs);
	if (!xml) return [];
	const titles = parseRssTitles(xml).filter((t) => !/daily search trends/i.test(t));
	return sanitizeLiveTerms(titles, ctx.maxTerms);
}

async function fetchGdelt(ctx: LiveSourceContext): Promise<string[]> {
	const url = "https://api.gdeltproject.org/api/v2/doc/doc?query=technology%20OR%20software&mode=ArtList&format=json&maxrecords=100&sort=datedesc";
	const json = await fetchJson(url, undefined, ctx.timeoutMs);
	const terms = (json?.articles ?? []).map((a: any) => a?.title).filter((t: any) => typeof t === "string") as string[];
	return sanitizeLiveTerms(terms, ctx.maxTerms);
}

const LIVE_FETCHERS: Record<LiveSource, LiveFetcher> = {
	stack_overflow: fetchStackOverflowTags,
	stackexchange_network: fetchStackExchangeNetworkTags,
	github_topics: fetchGithubTopics,
	github_trending: fetchGithubTrending,
	reddit: fetchReddit,
	hackernews: fetchHackerNews,
	lobsters: fetchLobsters,
	npm: fetchNpm,
	pypi: fetchPypi,
	crates: fetchCrates,
	maven: fetchMaven,
	awesome_lists: fetchAwesomeLists,
	arxiv: fetchArxiv,
	cloud_changelogs: fetchCloudChangelogs,
	cncf_landscape: fetchCNCFLandscape,
	job_boards: fetchJobBoards,
	google_trends: fetchGoogleTrends,
	gdelt: fetchGdelt,
};

function resolveLiveSources(config: RecommendConfig, override?: string): LiveSource[] {
	const raw = (override ?? "").trim();
	const fromConfig = config.liveTaxonomy.enabledSources ?? ["all"];
	const sourceList = raw.length > 0 ? raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : fromConfig;
	if (sourceList.includes("all")) return [...ALL_LIVE_SOURCES];
	const known = new Set<LiveSource>(ALL_LIVE_SOURCES);
	const resolved = sourceList.filter((s): s is LiveSource => known.has(s as LiveSource));
	return resolved.length > 0 ? resolved : [...ALL_LIVE_SOURCES];
}

async function enrichTaxonomyWithLiveSignals(taxonomy: Taxonomy, config: RecommendConfig, sourceOverride?: string): Promise<{ taxonomy: Taxonomy; liveSources: string[]; enriched: boolean }> {
	const selectedSources = resolveLiveSources(config, sourceOverride);
	const copy = JSON.parse(JSON.stringify(taxonomy)) as Taxonomy;
	if (!copy.categories.external_signals) {
		copy.categories.external_signals = { weight: config.liveTaxonomy.externalCategoryWeight, concepts: {} };
	}
	copy.categories.external_signals.weight = config.liveTaxonomy.externalCategoryWeight;

	const ctx: LiveSourceContext = {
		timeoutMs: config.liveTaxonomy.requestTimeoutMs,
		maxTerms: config.liveTaxonomy.maxTermsPerSource,
	};
	const results = await Promise.all(
		selectedSources.map(async (source) => {
			const weight = Number(config.liveTaxonomy.sourceWeights[source] ?? 1);
			const sourceCap = clamp(Math.round(ctx.maxTerms * clamp(weight, 0.2, 1.5)), 30, ctx.maxTerms);
			const terms = await LIVE_FETCHERS[source](ctx);
			return { source, terms: sanitizeLiveTerms(terms, sourceCap) };
		}),
	);

	const liveSources: string[] = [];
	for (const result of results) {
		if (result.terms.length === 0) continue;
		copy.categories.external_signals.concepts[result.source] = result.terms;
		liveSources.push(`${result.source}:${result.terms.length}`);
	}

	copy.lastUpdated = new Date().toISOString();
	return { taxonomy: copy, liveSources, enriched: liveSources.length > 0 };
}

function isTaxonomyEmptyInDb(): boolean {
	const row = getRouterDb().prepare("SELECT COUNT(*) AS c FROM router_taxonomy_categories").get() as { c?: number } | undefined;
	return Number(row?.c ?? 0) === 0;
}

function writeTaxonomyToDb(taxonomy: Taxonomy): void {
	const db = getRouterDb();
	db.exec("BEGIN IMMEDIATE");
	try {
		db.prepare("DELETE FROM router_taxonomy_terms").run();
		db.prepare("DELETE FROM router_taxonomy_categories").run();
		const insertCategory = db.prepare("INSERT INTO router_taxonomy_categories(name, weight) VALUES(?, ?)");
		const insertTerm = db.prepare("INSERT INTO router_taxonomy_terms(category_name, concept_name, term) VALUES(?, ?, ?)");
		for (const [categoryName, category] of Object.entries(taxonomy.categories ?? {})) {
			insertCategory.run(categoryName, Number(category.weight ?? 1));
			for (const [conceptName, terms] of Object.entries(category.concepts ?? {})) {
				for (const term of terms ?? []) {
					const normalized = normalizeText(term);
					if (!normalized) continue;
					insertTerm.run(categoryName, conceptName, normalized);
				}
			}
		}
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

function readTaxonomyFromDb(): Taxonomy {
	const db = getRouterDb();
	const categoriesRows = db.prepare("SELECT name, weight FROM router_taxonomy_categories ORDER BY name").all() as Array<{ name: string; weight: number }>;
	const termRows = db
		.prepare("SELECT category_name, concept_name, term FROM router_taxonomy_terms ORDER BY category_name, concept_name, term")
		.all() as Array<{ category_name: string; concept_name: string; term: string }>;
	const categories: Taxonomy["categories"] = {};
	for (const row of categoriesRows) categories[row.name] = { weight: Number(row.weight ?? 1), concepts: {} };
	for (const row of termRows) {
		if (!categories[row.category_name]) categories[row.category_name] = { weight: 1, concepts: {} };
		if (!categories[row.category_name].concepts[row.concept_name]) categories[row.category_name].concepts[row.concept_name] = [];
		categories[row.category_name].concepts[row.concept_name].push(row.term);
	}
	return { version: DEFAULT_TAXONOMY.version, lastUpdated: new Date().toISOString(), categories };
}

function loadLegacyTaxonomyFromJsonIfPresent(): Taxonomy | undefined {
	const legacyPath = getTaxonomyPath();
	if (!existsSync(legacyPath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(legacyPath, "utf-8")) as Taxonomy;
		if (parsed?.categories && typeof parsed.categories === "object") return parsed;
		return undefined;
	} catch {
		return undefined;
	}
}

function ensureTaxonomySeeded(): { rebuilt: boolean } {
	if (!isTaxonomyEmptyInDb()) return { rebuilt: false };
	const legacy = loadLegacyTaxonomyFromJsonIfPresent();
	const seed = legacy ?? createTaxonomySnapshot();
	writeTaxonomyToDb(seed);
	return { rebuilt: true };
}

async function ensureTaxonomy(rebuild: boolean, liveTaxonomy: boolean, config: RecommendConfig, liveSourceOverride?: string): Promise<TaxonomyState> {
	let rebuilt = false;
	if (rebuild) {
		writeTaxonomyToDb(createTaxonomySnapshot());
		rebuilt = true;
	} else {
		const seedState = ensureTaxonomySeeded();
		rebuilt = seedState.rebuilt;
	}

	let taxonomy = readTaxonomyFromDb();
	const shouldLiveEnrich = liveTaxonomy || rebuild || process.env.PI_MODEL_RECOMMEND_LIVE_TAXONOMY === "1";
	if (shouldLiveEnrich) {
		const enriched = await enrichTaxonomyWithLiveSignals(taxonomy, config, liveSourceOverride);
		taxonomy = enriched.taxonomy;
		writeTaxonomyToDb(taxonomy);
		return { taxonomy, rebuilt, enriched: enriched.enriched, liveSources: enriched.liveSources };
	}

	return { taxonomy, rebuilt, enriched: false, liveSources: [] };
}

function exportTaxonomyToPath(path: string): { categories: number; concepts: number; terms: number } {
	const taxonomy = readTaxonomyFromDb();
	const outPath = path.trim();
	if (!outPath) throw new Error("Missing export path");
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, JSON.stringify(taxonomy, null, 2));
	let concepts = 0;
	let terms = 0;
	for (const category of Object.values(taxonomy.categories)) {
		concepts += Object.keys(category.concepts ?? {}).length;
		for (const conceptTerms of Object.values(category.concepts ?? {})) terms += conceptTerms.length;
	}
	return { categories: Object.keys(taxonomy.categories).length, concepts, terms };
}

function taxonomyStats(taxonomy: Taxonomy): { categories: number; concepts: number; terms: number } {
	let concepts = 0;
	let terms = 0;
	for (const category of Object.values(taxonomy.categories)) {
		concepts += Object.keys(category.concepts ?? {}).length;
		for (const conceptTerms of Object.values(category.concepts ?? {})) terms += conceptTerms.length;
	}
	return { categories: Object.keys(taxonomy.categories).length, concepts, terms };
}

function parseTaxonomyFromPath(path: string): Taxonomy {
	const inPath = path.trim();
	if (!inPath) throw new Error("Missing taxonomy path");
	const raw = readFileSync(inPath, "utf-8");
	const parsed = JSON.parse(raw) as Taxonomy;
	if (!parsed?.categories || typeof parsed.categories !== "object") throw new Error("Invalid taxonomy JSON: missing categories object");
	const normalized: Taxonomy = { version: parsed.version ?? DEFAULT_TAXONOMY.version, lastUpdated: new Date().toISOString(), categories: {} };
	for (const [categoryName, category] of Object.entries(parsed.categories)) {
		if (!category || typeof category !== "object") continue;
		const conceptsObj = (category as any).concepts;
		if (!conceptsObj || typeof conceptsObj !== "object") continue;
		normalized.categories[categoryName] = { weight: Number((category as any).weight ?? 1), concepts: {} };
		for (const [conceptName, values] of Object.entries(conceptsObj as Record<string, unknown>)) {
			if (!Array.isArray(values)) continue;
			normalized.categories[categoryName].concepts[conceptName] = values
				.map((v) => normalizeText(String(v)))
				.filter((v) => v.length > 0);
		}
	}
	if (Object.keys(normalized.categories).length === 0) throw new Error("Invalid taxonomy JSON: no categories after normalization");
	return normalized;
}

function importTaxonomyFromPath(path: string): { categories: number; concepts: number; terms: number } {
	const normalized = parseTaxonomyFromPath(path);
	writeTaxonomyToDb(normalized);
	return taxonomyStats(normalized);
}

function mergeTaxonomyFromPath(path: string, policy: "append" | "replace" | "keep"): { categories: number; concepts: number; terms: number } {
	const incoming = parseTaxonomyFromPath(path);
	const existing = readTaxonomyFromDb();
	const merged: Taxonomy = JSON.parse(JSON.stringify(existing));

	for (const [categoryName, incomingCategory] of Object.entries(incoming.categories)) {
		const existingCategory = merged.categories[categoryName];
		if (!existingCategory) {
			merged.categories[categoryName] = JSON.parse(JSON.stringify(incomingCategory));
			continue;
		}
		if (policy === "replace") {
			existingCategory.weight = incomingCategory.weight;
		} else if (policy === "append") {
			existingCategory.weight = (Number(existingCategory.weight ?? 1) + Number(incomingCategory.weight ?? 1)) / 2;
		}
		for (const [conceptName, incomingTerms] of Object.entries(incomingCategory.concepts ?? {})) {
			const existingTerms = existingCategory.concepts[conceptName] ?? [];
			if (policy === "replace") {
				existingCategory.concepts[conceptName] = [...incomingTerms];
				continue;
			}
			if (policy === "keep") {
				if (!existingCategory.concepts[conceptName]) existingCategory.concepts[conceptName] = [...incomingTerms];
				continue;
			}
			const union = new Set<string>([...existingTerms, ...incomingTerms]);
			existingCategory.concepts[conceptName] = [...union];
		}
	}

	writeTaxonomyToDb(merged);
	return taxonomyStats(merged);
}

function ensureRecommendConfig(): RecommendConfig {
	const path = getConfigPath();
	const fallback = createConfigSnapshot();
	if (!existsSync(path)) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(fallback, null, 2));
		return fallback;
	}
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<RecommendConfig>;
		const merged: RecommendConfig = {
			...fallback,
			...(parsed as any),
			aliases: { ...fallback.aliases, ...(parsed?.aliases ?? {}) },
			skillWeights: { ...fallback.skillWeights, ...(parsed?.skillWeights ?? {}) },
			liveTaxonomy: {
				...fallback.liveTaxonomy,
				...(parsed?.liveTaxonomy ?? {}),
				sourceWeights: { ...fallback.liveTaxonomy.sourceWeights, ...(parsed?.liveTaxonomy?.sourceWeights ?? {}) },
			},
			router: {
				...fallback.router,
				...(parsed?.router ?? {}),
				learning: { ...fallback.router.learning, ...(parsed?.router?.learning ?? {}) },
			},
			defaults: { ...fallback.defaults, ...(parsed?.defaults ?? {}) },
		};
		writeFileSync(path, JSON.stringify(merged, null, 2));
		return merged;
	} catch {
		writeFileSync(path, JSON.stringify(fallback, null, 2));
		return fallback;
	}
}

let routerDb: DatabaseSync | undefined;

const ROUTER_DB_SCHEMA_VERSION = 3;

type RouterMigration = {
	version: number;
	name: string;
	up: (db: DatabaseSync) => void;
};

const ROUTER_MIGRATIONS: RouterMigration[] = [
	{
		version: 1,
		name: "initial-router-schema",
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS router_settings (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS router_weights (
					scope TEXT NOT NULL,
					key TEXT NOT NULL,
					weight REAL NOT NULL DEFAULT 0,
					updates INTEGER NOT NULL DEFAULT 0,
					PRIMARY KEY(scope, key)
				);
				CREATE TABLE IF NOT EXISTS router_samples (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					ts INTEGER NOT NULL,
					mode TEXT NOT NULL,
					prompt_hash TEXT NOT NULL,
					selected_exact TEXT NOT NULL,
					selected_provider_family TEXT NOT NULL,
					selected_family TEXT NOT NULL,
					candidate_count INTEGER NOT NULL,
					margin REAL NOT NULL DEFAULT 0,
					features_json TEXT NOT NULL
				);
			`);
		},
	},
	{
		version: 2,
		name: "performance-indexes",
		up: (db) => {
			db.exec(`
				CREATE INDEX IF NOT EXISTS idx_router_samples_ts ON router_samples(ts);
				CREATE INDEX IF NOT EXISTS idx_router_samples_family ON router_samples(selected_family);
				CREATE INDEX IF NOT EXISTS idx_router_weights_scope_key ON router_weights(scope, key);
			`);
		},
	},
	{
		version: 3,
		name: "taxonomy-tables",
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS router_taxonomy_categories (
					name TEXT PRIMARY KEY,
					weight REAL NOT NULL
				);
				CREATE TABLE IF NOT EXISTS router_taxonomy_terms (
					category_name TEXT NOT NULL,
					concept_name TEXT NOT NULL,
					term TEXT NOT NULL,
					PRIMARY KEY(category_name, concept_name, term),
					FOREIGN KEY(category_name) REFERENCES router_taxonomy_categories(name) ON DELETE CASCADE
				);
				CREATE INDEX IF NOT EXISTS idx_router_taxonomy_terms_category ON router_taxonomy_terms(category_name);
			`);
		},
	},
];

function getRouterDbPath(): string {
	return join(getAgentDir(), "model-recommend.db");
}

function ensureRouterMigrationsTable(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS router_migrations (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			applied_at INTEGER NOT NULL
		);
	`);
}

function getAppliedRouterSchemaVersion(db: DatabaseSync): number {
	const row = db.prepare("SELECT MAX(version) AS v FROM router_migrations").get() as { v?: number } | undefined;
	return Number(row?.v ?? 0);
}

function applyRouterMigrations(db: DatabaseSync): void {
	ensureRouterMigrationsTable(db);
	let current = getAppliedRouterSchemaVersion(db);
	const pending = ROUTER_MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
	if (pending.length === 0) return;
	db.exec("BEGIN IMMEDIATE");
	try {
		for (const migration of pending) {
			migration.up(db);
			db.prepare("INSERT INTO router_migrations(version, name, applied_at) VALUES(?, ?, ?)").run(migration.version, migration.name, Date.now());
			current = migration.version;
		}
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

function normalizeLegacyRouterSchema(db: DatabaseSync): void {
	const hasTable = (name: string): boolean => {
		const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) as { name?: string } | undefined;
		return Boolean(row?.name);
	};

	if (hasTable("router_weights")) {
		const cols = db.prepare("PRAGMA table_info(router_weights)").all() as Array<{ name: string }>;
		const names = new Set(cols.map((c) => String(c.name)));
		if (names.has("type") && !names.has("scope")) {
			try {
				db.exec("ALTER TABLE router_weights RENAME COLUMN type TO scope");
			} catch {
				// Fallback for older SQLite: add scope and backfill from type
				db.exec("ALTER TABLE router_weights ADD COLUMN scope TEXT");
				db.exec("UPDATE router_weights SET scope = type WHERE scope IS NULL OR scope = ''");
			}
		}
		if (!names.has("updates")) {
			try {
				db.exec("ALTER TABLE router_weights ADD COLUMN updates INTEGER NOT NULL DEFAULT 0");
			} catch {
				// ignore if already added by a concurrent init
			}
		}
	}

	// Early experimental schema used router_kv; migrate values into router_settings.
	if (hasTable("router_kv")) {
		db.exec("CREATE TABLE IF NOT EXISTS router_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		db.exec("INSERT OR REPLACE INTO router_settings(key, value) SELECT key, value FROM router_kv");
	}
}

function getRouterDb(): DatabaseSync {
	if (routerDb) return routerDb;
	const path = getRouterDbPath();
	mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	normalizeLegacyRouterSchema(db);
	applyRouterMigrations(db);
	routerDb = db;
	return db;
}

function getRouterSchemaVersion(): number {
	return getAppliedRouterSchemaVersion(getRouterDb());
}

function dbGetNumber(key: string, fallback = 0): number {
	const row = getRouterDb().prepare("SELECT value FROM router_settings WHERE key = ?").get(key) as { value?: string } | undefined;
	if (!row?.value) return fallback;
	const n = Number(row.value);
	return Number.isFinite(n) ? n : fallback;
}

function dbSetNumber(key: string, value: number): void {
	// SQLite compatibility: avoid ON CONFLICT ... DO UPDATE (not available on older builds)
	getRouterDb().prepare("INSERT OR REPLACE INTO router_settings(key, value) VALUES(?, ?)").run(key, String(value));
}

function canonicalFamily(modelId: string): string {
	let v = modelId.toLowerCase().trim();
	v = v.replace(/:[a-z0-9_-]+$/g, "");
	v = v.replace(/\/(?:[^/]+)$/g, (m) => m.replace("/", ""));
	v = v.replace(/[-_](20\d{2}(?:[-_]?\d{2}){0,2}|\d{6,8})$/g, "");
	v = v.replace(/[-_]?v\d+(?:\.\d+)?$/g, "");
	v = v.replace(/\s+/g, "-");
	return v;
}

function exactKey(model: { provider: string; model: string }): string {
	return `${model.provider.toLowerCase()}::${model.model.toLowerCase().replace(/:[a-z0-9_-]+$/g, "")}`;
}

function familyKey(model: { model: string }): string {
	return canonicalFamily(model.model);
}

function providerFamilyKey(model: { provider: string; model: string }): string {
	return `${model.provider.toLowerCase()}::${familyKey(model)}`;
}

function readWeight(scope: string, key: string): { weight: number; updates: number } {
	const row = getRouterDb().prepare("SELECT weight, updates FROM router_weights WHERE scope = ? AND key = ?").get(scope, key) as
		| { weight?: number; updates?: number }
		| undefined;
	return { weight: Number(row?.weight ?? 0), updates: Number(row?.updates ?? 0) };
}

function addWeight(scope: string, key: string, delta: number): void {
	const db = getRouterDb();
	const row = db.prepare("SELECT weight, updates FROM router_weights WHERE scope = ? AND key = ?").get(scope, key) as
		| { weight?: number; updates?: number }
		| undefined;
	if (row) {
		db.prepare("UPDATE router_weights SET weight = ?, updates = ? WHERE scope = ? AND key = ?").run(
			Number(row.weight ?? 0) + delta,
			Number(row.updates ?? 0) + 1,
			scope,
			key,
		);
		return;
	}
	db.prepare("INSERT INTO router_weights(scope, key, weight, updates) VALUES(?, ?, ?, 1)").run(scope, key, delta);
}

function routerSampleCount(): number {
	const cached = dbGetNumber("sample_count", -1);
	if (cached >= 0) return cached;
	const row = getRouterDb().prepare("SELECT COUNT(*) as c FROM router_samples").get() as { c?: number } | undefined;
	const count = Number(row?.c ?? 0);
	dbSetNumber("sample_count", count);
	return count;
}

function applyLearnedAdjustments(scored: ScoredModel[], config: RecommendConfig): ScoredModel[] {
	const samples = routerSampleCount();
	const warmup = Math.max(1, Number(config.router.learning.alphaWarmupSamples ?? 200));
	const maxAlpha = clamp(Number(config.router.learning.maxAlpha ?? 0.45), 0, 0.9);
	const alpha = clamp((samples / warmup) * maxAlpha, 0, maxAlpha);
	for (const m of scored) {
		const fam = readWeight("family", familyKey(m));
		const pf = readWeight("provider_family", providerFamilyKey(m));
		const ex = readWeight("exact", exactKey(m));
		const learned = fam.weight * 0.5 + pf.weight * 0.3 + ex.weight * 0.2;
		m.score = clamp(m.score + learned * alpha, 0, 100);
		if (Math.abs(learned) > 0.001) m.breakdown.reasons.push(`learned-bias=${(learned * alpha).toFixed(2)} alpha=${alpha.toFixed(2)}`);
		m.breakdown.final = m.score;
	}
	return scored;
}

function persistTrainingSample(task: string, mode: string, intent: Intent, selected: ScoredModel, offered: ScoredModel[], margin: number): void {
	const ts = Date.now();
	const promptHash = String(hashString(task));
	getRouterDb()
		.prepare(
			"INSERT INTO router_samples(ts, mode, prompt_hash, selected_exact, selected_provider_family, selected_family, candidate_count, margin, features_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			ts,
			mode,
			promptHash,
			exactKey(selected),
			providerFamilyKey(selected),
			familyKey(selected),
			offered.length,
			margin,
			JSON.stringify({
				complexity: intent.complexity,
				domains: Array.from(intent.domains),
				languages: Array.from(intent.languages),
				categories: Array.from(intent.matchedTaxonomyCategories),
				needs: intent.capabilityNeeds,
			}),
		);
	dbSetNumber("sample_count", routerSampleCount() + 1);
}

function trainPairwiseSelection(config: RecommendConfig, selected: ScoredModel, offered: ScoredModel[]): void {
	const step = clamp(Number(config.router.learning.pairwiseStep ?? 1), 0.05, 5);
	const negatives = offered.filter((m) => exactKey(m) !== exactKey(selected));
	if (negatives.length === 0) return;
	const negStep = step / negatives.length;
	addWeight("family", familyKey(selected), step * 0.5);
	addWeight("provider_family", providerFamilyKey(selected), step * 0.3);
	addWeight("exact", exactKey(selected), step * 0.2);
	for (const n of negatives) {
		addWeight("family", familyKey(n), -negStep * 0.5);
		addWeight("provider_family", providerFamilyKey(n), -negStep * 0.3);
		addWeight("exact", exactKey(n), -negStep * 0.2);
	}
}

function resetLearningStore(): void {
	const db = getRouterDb();
	db.exec("DELETE FROM router_weights; DELETE FROM router_samples;");
	dbSetNumber("sample_count", 0);
}

function getLearningStats(): { samples: number; weights: number } {
	const db = getRouterDb();
	const sampleRow = db.prepare("SELECT COUNT(*) as c FROM router_samples").get() as { c?: number } | undefined;
	const weightRow = db.prepare("SELECT COUNT(*) as c FROM router_weights").get() as { c?: number } | undefined;
	return { samples: Number(sampleRow?.c ?? 0), weights: Number(weightRow?.c ?? 0) };
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function levenshteinDistance(a: string, b: string, maxDistance = 2): number {
	if (a === b) return 0;
	if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
	const prev = new Array(b.length + 1);
	const curr = new Array(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		let rowMin = curr[0];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
			if (curr[j] < rowMin) rowMin = curr[j];
		}
		if (rowMin > maxDistance) return maxDistance + 1;
		for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
	}
	return prev[b.length];
}

function containsTerm(text: string, tokens: string[], term: string): boolean {
	const t = normalizeText(term);
	if (!t) return false;
	if (t.includes(" ")) {
		const re = new RegExp(`(^|\\s)${escapeRegExp(t)}($|\\s)`);
		if (re.test(text)) return true;
	}
	const isShort = t.length <= 3;
	if (tokens.includes(t)) return true;
	if (isShort) return false;

	for (const token of tokens) {
		if (token.length < 4) continue;
		const maxDist = token.length >= 8 ? 2 : 1;
		if (levenshteinDistance(token, t, maxDist) <= maxDist) return true;
	}
	return false;
}

function hasAny(text: string, tokens: string[], words: string[]): boolean {
	return words.some((w) => containsTerm(text, tokens, w));
}

function applyAliases(text: string, aliases: Record<string, string[]>): string {
	let out = ` ${normalizeText(text)} `;
	for (const [raw, replacements] of Object.entries(aliases)) {
		const source = normalizeText(raw);
		if (!source) continue;
		const re = new RegExp(`(^|\\s)${escapeRegExp(source)}(?=\\s|$)`, "g");
		if (!re.test(out)) continue;
		out = out.replace(re, `$1${normalizeText(replacements[0] ?? source)}`);
	}
	return normalizeText(out);
}

type CapabilityConstraints = {
	minIntel: number;
	minReasoning: number;
	minToolReliability: number;
	minContext: number;
	requireReasoning: boolean;
	maxAffordablePrice: number;
};

function analyzeIntent(task: string, taxonomy: Taxonomy, config: RecommendConfig): Intent {
	const text = normalizeText(applyAliases(task, config.aliases));
	const tokens = text.split(" ").filter(Boolean);
	const tokenCount = tokens.length;
	const clauseCount = (text.match(/[,:;()]/g)?.length ?? 0) + (text.match(/\b(and|with|across|plus|while|where|under)\b/g)?.length ?? 0);
	const spread = clamp(config.defaults.intentSpread ?? 1.35, 0.8, 2.2);
	const externalWeight = clamp(config.defaults.externalSignalInferenceWeight ?? 0.25, 0, 1);

	const matchedTaxonomyCategories = new Set<string>();
	const matchedTaxonomyConcepts = new Set<string>();
	const languages = new Set<string>();
	let externalHits = 0;
	let internalHits = 0;

	for (const [categoryName, category] of Object.entries(taxonomy.categories ?? {})) {
		for (const concepts of Object.values(category.concepts ?? {})) {
			for (const concept of concepts ?? []) {
				if (!containsTerm(text, tokens, concept)) continue;
				matchedTaxonomyCategories.add(categoryName);
				matchedTaxonomyConcepts.add(concept.toLowerCase());
				if (categoryName === "external_signals") externalHits++;
				else internalHits++;
				if (LANGUAGE_HINTS[concept.toLowerCase()]) languages.add(concept.toLowerCase());
			}
		}
	}

	for (const [lang, cfg] of Object.entries(LANGUAGE_HINTS)) {
		if (hasAny(text, tokens, cfg.aliases)) languages.add(lang);
	}

	const breadth = matchedTaxonomyCategories.size;
	const taxonomySignal = clamp(internalHits * 0.045 + externalHits * 0.045 * externalWeight + breadth * 0.09, 0, 1);
	const structureSignal = clamp(tokenCount / 28 + clauseCount * 0.08, 0, 1);

	const categories = Array.from(matchedTaxonomyCategories);
	const architectureSignal = categories.some((c) => /arch|design|system/.test(c)) ? 1 : 0;
	const securitySignal = categories.some((c) => /security|auth|identity/.test(c)) ? 1 : 0;
	const cloudSignal = categories.some((c) => /cloud|infra|devops/.test(c)) ? 1 : 0;
	const algoSignal = categories.some((c) => /algorithm|data_struct/.test(c)) ? 1 : 0;
	const gameSignal = categories.some((c) => /game/.test(c)) ? 1 : 0;

	const costSensitivity = hasAny(text, tokens, ["cheap", "budget", "affordable", "low cost", "free", "minimum cost", "least expensive"]) ? 1 : 0.3;
	const latencySensitivity = hasAny(text, tokens, ["fast", "quick", "latency", "realtime", "throughput", "p99", "p95"]) ? 0.95 : 0.25;
	const bestBias = hasAny(text, tokens, ["best", "top", "highest quality", "state of the art", "most capable", "most intelligent"]) ? 1 : 0.2;
	const safetyBias = hasAny(text, tokens, ["safety", "critical", "secure", "compliance", "mission", "threat", "hazard"]) ? 1 : 0.15;

	const capabilityNeeds = {
		reasoningDepth: clamp((0.12 + taxonomySignal * 0.42 + structureSignal * 0.45 + architectureSignal * 0.28 + securitySignal * 0.26) * spread, 0, 1),
		systemBreadth: clamp((0.08 + structureSignal * 0.62 + cloudSignal * 0.28 + architectureSignal * 0.24) * spread, 0, 1),
		correctnessRisk: clamp((0.1 + securitySignal * 0.42 + safetyBias * 0.5 + architectureSignal * 0.22) * spread, 0, 1),
		contextVolume: clamp((0.08 + structureSignal * 0.45 + cloudSignal * 0.3 + architectureSignal * 0.25 + (hasAny(text, tokens, ["large", "huge", "many", "massive", "multi", "scale", "millions"]) ? 0.3 : 0)) * spread, 0, 1),
		safetyCriticality: clamp((0.06 + securitySignal * 0.42 + safetyBias * 0.55) * spread, 0, 1),
		latencySensitivity,
		costSensitivity,
		codingLikelihood: clamp((0.15 + (languages.size > 0 ? 0.55 : 0) + algoSignal * 0.35 + gameSignal * 0.2) * spread, 0, 1),
		designLikelihood: clamp((0.12 + architectureSignal * 0.5 + cloudSignal * 0.24 + securitySignal * 0.24 + (hasAny(text, tokens, ["design", "architecture", "hld", "system"]) ? 0.25 : 0)) * spread, 0, 1),
		bestQualityBias: bestBias,
	};

	const complexity = clamp(
		Math.round(
			8 +
				capabilityNeeds.reasoningDepth * 30 +
				capabilityNeeds.systemBreadth * 20 +
				capabilityNeeds.correctnessRisk * 22 +
				capabilityNeeds.contextVolume * 18 +
				capabilityNeeds.safetyCriticality * 12,
		),
		1,
		100,
	);

	const domains = new Set<string>();
	if (capabilityNeeds.codingLikelihood >= 0.35) domains.add("coding");
	if (capabilityNeeds.reasoningDepth >= 0.45) domains.add("reasoning");
	if (gameSignal > 0) domains.add("creative");

	return {
		complexity,
		domains,
		matchedTaxonomyCategories,
		matchedTaxonomyConcepts,
		languages,
		capabilityNeeds,
	};
}

function deriveConstraints(intent: Intent, config: RecommendConfig): CapabilityConstraints {
	const n = intent.capabilityNeeds;
	const minIntel = clamp(Math.round(36 + n.reasoningDepth * 36 + n.correctnessRisk * 22 + n.safetyCriticality * 14 + n.bestQualityBias * 10), 30, 99);
	const minReasoning = clamp(Math.round(18 + n.reasoningDepth * 56 + n.safetyCriticality * 12), 10, 98);
	const minToolReliability = clamp(Math.round(28 + n.correctnessRisk * 36 + n.systemBreadth * 24 + n.safetyCriticality * 10), 20, 99);
	const minContext = n.contextVolume >= 0.9 ? 512_000 : n.contextVolume >= 0.75 ? 256_000 : n.contextVolume >= 0.55 ? 128_000 : n.contextVolume >= 0.35 ? 64_000 : 16_000;
	const requireReasoning = n.reasoningDepth >= 0.76 || n.safetyCriticality >= 0.8;
	const maxAffordablePrice = clamp(18 - n.costSensitivity * 15, 1, 20);
	if (n.costSensitivity >= 0.9 && intent.complexity >= 60) {
		return { minIntel: Math.max(minIntel, config.defaults.minIntelForComplexCheap), minReasoning, minToolReliability, minContext, requireReasoning, maxAffordablePrice };
	}
	return { minIntel, minReasoning, minToolReliability, minContext, requireReasoning, maxAffordablePrice };
}

function relaxConstraints(base: CapabilityConstraints, level: number): CapabilityConstraints {
	if (level <= 0) return base;
	// If task demands heavy reasoning, hold reasoning score firm, sacrifice context/price instead
	const reasonDrop = base.requireReasoning ? Math.round(level * 1.5) : level * 8;
	const ctxDropFactor = base.requireReasoning ? 3.0 : 1.85;
	
	return {
		minIntel: clamp(base.minIntel - level * 7, 26, 99),
		minReasoning: clamp(base.minReasoning - reasonDrop, 8, 99),
		minToolReliability: clamp(base.minToolReliability - level * 7, 14, 99),
		minContext: Math.max(8_000, Math.round(base.minContext / Math.pow(ctxDropFactor, level))),
		requireReasoning: base.requireReasoning,
		maxAffordablePrice: base.maxAffordablePrice + level * 2.5,
	};
}

function modelSatisfiesConstraints(model: ScoredModel, c: CapabilityConstraints): boolean {
	return (
		model.intelligence >= c.minIntel &&
		model.reasoning >= c.minReasoning &&
		model.toolReliability >= c.minToolReliability &&
		model.contextWindow >= c.minContext &&
		(!c.requireReasoning || model.reasoning >= 70)
	);
}

function selectStageAFeasible(models: ScoredModel[], intent: Intent, config: RecommendConfig): { feasible: ScoredModel[]; constraints: CapabilityConstraints; relaxLevel: number } {
	const base = deriveConstraints(intent, config);
	for (let level = 0; level <= 4; level++) {
		const constraints = relaxConstraints(base, level);
		const feasible = models.filter((m) => modelSatisfiesConstraints(m, constraints));
		if (feasible.length > 0) return { feasible, constraints, relaxLevel: level };
	}
	return { feasible: [...models], constraints: relaxConstraints(base, 4), relaxLevel: 4 };
}

function scoreModel(model: ScoredModel, intent: Intent, config: RecommendConfig, constraints: CapabilityConstraints, relaxLevel: number): number {
	const n = intent.capabilityNeeds;
	const intelFit = clamp((model.intelligence - constraints.minIntel + 34) / 56, 0, 1);
	const reasoningFit = clamp((model.reasoning - constraints.minReasoning + 30) / 50, 0, 1);
	const relFit = clamp((model.toolReliability - constraints.minToolReliability + 34) / 56, 0, 1);
	const ctxFit = clamp((Math.log2(Math.max(8_000, model.contextWindow)) - Math.log2(constraints.minContext)) / 3 + 0.55, 0, 1);
	const speedFit = clamp(model.speed / 170, 0, 1);
	const priceFit = clamp(1 - Math.log1p(Math.max(0, model.effectivePrice)) / Math.log1p(50), 0, 1);

	const capabilityFit = clamp(
		intelFit * (0.32 + n.bestQualityBias * 0.24) +
			reasoningFit * (0.08 + n.reasoningDepth * 0.3) +
			relFit * (0.22 + n.correctnessRisk * 0.24) +
			ctxFit * (0.14 + n.contextVolume * 0.24) +
			speedFit * (0.04 + n.latencySensitivity * 0.22),
		0,
		1.95,
	) / 1.95;

	const priceWeight = clamp(0.33 + n.costSensitivity * 0.42 - n.bestQualityBias * 0.18 - n.safetyCriticality * 0.12, 0.12, 0.82);
	const rankLoss = (1 - priceFit) * priceWeight + (1 - capabilityFit) * (1 - priceWeight);
	let score = (1 - rankLoss) * 100;
	if (model.effectivePrice > constraints.maxAffordablePrice) score *= 0.9;
	score *= 1 - relaxLevel * 0.035;

	const tieJitter = ((hashString(`${model.provider}/${model.model}`) % 1000) / 1000) * config.defaults.tieJitterMax;
	score += tieJitter;

	model.breakdown = {
		normIntel: intelFit,
		normSpeed: speedFit,
		normPrice: priceFit,
		normContext: ctxFit,
		weightedBase: capabilityFit,
		affinity: 1 - rankLoss,
		tieJitter,
		final: clamp(score, 0, 100),
		weights: { intel: constraints.minIntel, speed: n.latencySensitivity, price: priceWeight, context: constraints.minContext },
		reasons: [
			`stageA constraints intel>=${constraints.minIntel} reason>=${constraints.minReasoning} tool>=${constraints.minToolReliability} context>=${constraints.minContext}`,
			`objective priceWeight=${priceWeight.toFixed(2)} capabilityWeight=${(1 - priceWeight).toFixed(2)}`,
			`relaxation-level=${relaxLevel}`,
		],
	};
	return clamp(score, 0, 100);
}

function applyCapabilityDeltaGuard(models: ScoredModel[], intent: Intent, config: RecommendConfig): ScoredModel[] {
	if (models.length === 0) return models;
	if (intent.complexity < Number(config.defaults.capabilityDeltaMinComplexity ?? 55)) return models;
	const guard = clamp(Number(config.defaults.capabilityDeltaGuard ?? 0.12), 0.02, 0.5);
	const penalty = clamp(Number(config.defaults.capabilityDeltaPenalty ?? 0.2), 0.01, 0.6);
	const bestCapability = Math.max(...models.map((m) => m.breakdown.weightedBase));
	for (const m of models) {
		const deficit = bestCapability - m.breakdown.weightedBase;
		if (deficit <= guard) continue;
		const over = deficit - guard;
		const factor = clamp(1 - penalty * (over / Math.max(0.05, 1 - guard)), 0.5, 1);
		m.score = clamp(m.score * factor, 0, 100);
		m.breakdown.reasons.push(`capability-delta-guard penalty factor=${factor.toFixed(2)}`);
		m.breakdown.final = m.score;
	}
	return models;
}

async function computeRecommendations(
	task: string,
	opts: RecommendOptions,
	ctx: { modelRegistry: { getAll(): unknown[] } },
	config: RecommendConfig,
	includeNearMissFill = false,
): Promise<{ top: ScoredModel[]; scored: ScoredModel[]; stageA: { constraints: CapabilityConstraints; relaxLevel: number }; intent: Intent; taxState: TaxonomyState }> {
	const taxState = await ensureTaxonomy(opts.rebuildTaxonomy, opts.liveTaxonomy, config, opts.liveSourcesArg);
	const intent = analyzeIntent(task, taxState.taxonomy, config);
	const registryModels = ctx.modelRegistry.getAll() as ModelLike[];
	const costHints = buildCostHintIndex(registryModels);
	const activeProviders = getAuthenticatedProvidersFromAuthJson();
	let models = registryModels.filter((m) => activeProviders.has(m.provider));
	if (opts.providers.length > 0) models = models.filter((m) => opts.providers.some((p) => m.provider.toLowerCase().includes(p)));
	if (opts.localOnly) models = models.filter((m) => buildModelProfile(m).isLocal);
	if (opts.grep) models = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(opts.grep!.toLowerCase()));

	const allCandidates = models
		.map(
			(m): ScoredModel => {
				const p = buildModelProfile(m, costHints);
				return {
					provider: p.provider,
					model: p.model,
					score: 0,
					intelligence: p.intel,
					reasoning: p.reasoning,
					toolReliability: p.toolReliability,
					speed: p.speed,
					inputPrice: p.costIn,
					outputPrice: p.costOut,
					effectivePrice: p.effectivePrice,
					priceEstimated: p.priceEstimated,
					contextWindow: p.context,
					supportsImages: p.supportsImages,
					isLocal: p.isLocal,
					breakdown: {
						normIntel: 0,
						normSpeed: 0,
						normPrice: 0,
						normContext: 0,
						weightedBase: 0,
						affinity: 1,
						tieJitter: 0,
						final: 0,
						weights: { intel: 1, speed: 1, price: 1, context: 1 },
						reasons: [],
					},
				};
			},
		)
		.filter((m) => (opts.trusted ? isTrustedAuthor(m.model) : true));

	if (allCandidates.length === 0) return { top: [], scored: [], stageA: { constraints: deriveConstraints(intent, config), relaxLevel: 0 }, intent, taxState };
	const stageA = selectStageAFeasible(allCandidates, intent, config);
	let scored = stageA.feasible.map((m) => ({ ...m, score: scoreModel(m, intent, config, stageA.constraints, stageA.relaxLevel) }));
	scored = applyCapabilityDeltaGuard(scored, intent, config);
	scored = applyLearnedAdjustments(scored, config);

	const dir = opts.sortDir === "asc" ? 1 : -1;
	const compareModels = (a: ScoredModel, b: ScoredModel): number => {
		let cmp = 0;
		switch (opts.sortBy) {
			case "score":
				if (opts.strategy === "local-first") {
					cmp = Number(a.isLocal) - Number(b.isLocal);
					if (cmp === 0) cmp = a.score - b.score;
				} else {
					if (opts.localPrefer) {
						cmp = Number(a.isLocal) - Number(b.isLocal);
						if (cmp !== 0) return cmp * dir;
					}
					cmp = a.score - b.score;
				}
				break;
			case "intelligence":
				cmp = a.intelligence - b.intelligence;
				break;
			case "reasoning":
				cmp = a.reasoning - b.reasoning;
				break;
			case "reliability":
				cmp = a.toolReliability - b.toolReliability;
				break;
			case "speed":
				cmp = a.speed - b.speed;
				break;
			case "price":
				cmp = a.outputPrice - b.outputPrice;
				break;
			case "context":
				cmp = a.contextWindow - b.contextWindow;
				break;
		}
		if (cmp === 0) cmp = a.model.localeCompare(b.model);
		return cmp * dir;
	};

	scored.sort(compareModels);

	if (includeNearMissFill && scored.length < Math.max(1, opts.limit)) {
		const feasibleSet = new Set(stageA.feasible.map((m) => `${m.provider}::${m.model}`));
		let nearMiss = allCandidates
			.filter((m) => !feasibleSet.has(`${m.provider}::${m.model}`))
			.map((m) => ({ ...m, score: scoreModel({ ...m }, intent, config, stageA.constraints, stageA.relaxLevel) }));
		nearMiss = applyLearnedAdjustments(nearMiss, config).map((m) => {
			m.breakdown.reasons.push("near-miss: did not satisfy stageA constraints");
			return m;
		});
		nearMiss.sort(compareModels);
		scored = [...scored, ...nearMiss].slice(0, Math.max(1, opts.limit));
	}

	return { top: scored.slice(0, Math.max(1, opts.limit)), scored, stageA, intent, taxState };
}

function usageText(): string {
	const reset = "\x1b[0m";
	const bold = "\x1b[1m";
	const dim = "\x1b[2m";
	const cyan = "\x1b[36m";
	const green = "\x1b[32m";
	const magenta = "\x1b[35m";
	const yellow = "\x1b[33m";

	return [
		`${bold}${cyan}🧠 /model-recommend <task> [options]${reset}`,
		`${dim}Intelligent model router with taxonomy, live enrichment, and online learning.${reset}`,
		"",
		`${bold}TAXONOMY:${reset}`,
		`  ${green}--rebuild-taxonomy${reset}                     Reset taxonomy in DB to defaults, then optionally enrich`,
		`  ${green}--sync-benchmarks${reset}                      Fetch and update Aider leaderboard dataset into DB`,
		`  ${green}--live-taxonomy${reset}                        Enrich current taxonomy with live sources (no reset)`,
		`  ${green}--live-sources <all|csv>${reset}               Override enabled live sources for this run`,
		`  ${green}--export-taxonomy <path>${reset}               Export taxonomy from DB to JSON file`,
		`  ${green}--import-taxonomy <path>${reset}               Import taxonomy JSON as REPLACE (overwrites DB taxonomy)`,
		`  ${green}--merge-taxonomy <path>${reset}                Merge taxonomy JSON into DB taxonomy`,
		`  ${green}--merge-policy <append|replace|keep>${reset}   Merge policy for --merge-taxonomy (default: append)`,
		"",
		`${bold}ROUTER & LEARNING:${reset}`,
		`  ${green}--set-auto <off|suggest|enforce>${reset}       Auto-routing mode`,
		`  ${dim}    off     – no automatic routing (default)${reset}`,
		`  ${dim}    suggest – before each prompt: interactive picker (↑↓ 5 recs, keep current, custom model)${reset}`,
		`  ${dim}    enforce – silently auto-switch to top recommendation before each prompt${reset}`,
		`  ${green}--set-learning <on|off>${reset}                Enable/disable online learning`,
		`  ${green}--status${reset}                               Print router status, DB schema, sample counts`,
		`  ${green}--reset-learning${reset}                       Clear learned weights and training samples`,

		"",
		`${bold}FILTERS & STRATEGY:${reset}`,
		`  ${green}--provider <name[,name]>${reset}               Filter providers (repeatable, comma-separated)`,
		`  ${green}--grep <text>${reset}                          Filter models by provider/model substring`,
		`  ${green}--trusted${reset}                              Keep only models from trusted org list`,
		`  ${green}--strategy <cheapest-capable|capability-first|local-first>${reset}`,
		`                                            Ranking strategy`,
		`  ${green}--local-prefer${reset}                         Prefer local models when scores are similar`,
		`  ${green}--local-only${reset}                           Only local providers/models`,
		`  ${green}--sort-by <score|intelligence|reasoning|reliability|speed|price|context> [asc|desc]${reset}`,
		`  ${green}--limit <n>${reset}                            Number of models to display`,
		`  ${green}--explain${reset}                              Show per-model score breakdown and reasons`,
		`  ${green}--help${reset}                                 Show this help`,
		"",
		`${bold}EXAMPLES:${reset}`,
		`  /model-recommend write a secure auth handler in rust`,
		`  /model-recommend --strategy capability-first secure multi-tenant auth design`,
		`  /model-recommend --set-auto suggest`,
		"",
		`${bold}NOTES:${reset}`,
		`  ${dim}- Config file: agent/model-recommend-config.json${reset}`,
		`  ${dim}- Data DB: agent/model-recommend.db (taxonomy + weights + samples + migrations)${reset}`,
		`  ${dim}- Legacy taxonomy JSON (~/.pi/model-taxonomy.json) is imported once if DB taxonomy is empty${reset}`,
		`${yellow}${dim}Tip: task is positional (no --task needed).${reset}`,
	].join("\n");
}

function findModelFromInput(input: string, registryModels: ModelLike[]): ModelLike | undefined {
	const raw = input.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw.includes("/")) {
		const [provider, ...rest] = raw.split("/");
		const id = rest.join("/");
		return registryModels.find((m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === id);
	}
	return (
		registryModels.find((m) => m.id.toLowerCase() === raw) ??
		registryModels.find((m) => canonicalFamily(m.id) === canonicalFamily(raw)) ??
		registryModels.find((m) => `${m.provider}/${m.id}`.toLowerCase().includes(raw))
	);
}

async function maybeChooseModelInteractive(
	ctx: any,
	top: ScoredModel[],
	allowCustom: boolean,
	title = "Model recommendation",
): Promise<ScoredModel | undefined> {
	if (!ctx.hasUI || top.length === 0) return top[0];
	const choices = top.map((m, i) => `${i + 1}. ${m.provider}/${m.model} (score ${m.score.toFixed(1)})`);
	if (allowCustom) choices.push("Custom model...");
	choices.push("Keep current model");
	const selected = await ctx.ui.select(title, choices);
	if (!selected || selected === "Keep current model") return undefined;
	if (selected === "Custom model...") {
		const input = await ctx.ui.input("Custom model", "provider/model or model id");
		if (!input) return undefined;
		const registryModels = ctx.modelRegistry.getAll() as ModelLike[];
		const found = findModelFromInput(input, registryModels);
		if (!found) {
			ctx.ui.notify(`Model not found: ${input}`, "warning");
			return undefined;
		}
		const p = buildModelProfile(found);
		return {
			provider: p.provider,
			model: p.model,
			score: 0,
			intelligence: p.intel,
			reasoning: p.reasoning,
			toolReliability: p.toolReliability,
			speed: p.speed,
			inputPrice: p.costIn,
			outputPrice: p.costOut,
			effectivePrice: p.effectivePrice,
			priceEstimated: p.priceEstimated,
			contextWindow: p.context,
			supportsImages: p.supportsImages,
			isLocal: p.isLocal,
			breakdown: {
				normIntel: 0,
				normSpeed: 0,
				normPrice: 0,
				normContext: 0,
				weightedBase: 0,
				affinity: 0,
				tieJitter: 0,
				final: 0,
				weights: { intel: 0, speed: 0, price: 0, context: 0 },
				reasons: ["custom-choice"],
			},
		};
	}
	const idx = Number(selected.split(".")[0]) - 1;
	return top[idx] ?? top[0];
}

async function setCurrentModel(pi: ExtensionAPI, ctx: any, selected: ScoredModel): Promise<boolean> {
	const model = (ctx.modelRegistry.getAll() as ModelLike[]).find((m) => m.provider === selected.provider && m.id === selected.model);
	if (!model) return false;
	return await pi.setModel(model as any);
}

let benchmarksCache: any = null;
export default function modelRecommendExtension(pi: ExtensionAPI) {
	pi.registerCommand("model-recommend", {
		description: "Recommend models for a task using auth-aware model access + local taxonomy scoring",
		handler: async (args, ctx) => {
			const opts = parseRecommendArgs(args);
			
			if (opts.syncBenchmarks) {
				ctx.ui.notify("Syncing Aider LLM benchmarks...", "info");
				const count = await syncBenchmarks();
				benchmarksCache = getAllBenchmarks();
				ctx.ui.notify(`Synced ${count} benchmark entries.`, "success");
				if (!opts.task) return;
			}
			
			// Auto-sync on first run if DB empty
			if (!benchmarksCache) benchmarksCache = getAllBenchmarks();
			if (benchmarksCache.length === 0) {
				ctx.ui.notify("First run: Syncing Aider LLM benchmarks database...", "info");
				await syncBenchmarks();
				benchmarksCache = getAllBenchmarks();
			}
			
			const benchmarks = benchmarksCache;

			const config = ensureRecommendConfig();

			if (opts.autoModeArg) config.router.autoMode = opts.autoModeArg;
			if (opts.learningModeArg) config.router.learnEnabled = opts.learningModeArg === "on";
			if (opts.resetLearning) resetLearningStore();

			if (opts.importTaxonomyPath && opts.mergeTaxonomyPath) {
				const msg = "Use either --import-taxonomy or --merge-taxonomy in one command (not both).";
				if (ctx.hasUI) ctx.ui.notify(msg, "error");
				else console.log(msg);
				return;
			}

			const hasTaxonomyRefreshFlags = opts.rebuildTaxonomy || opts.liveTaxonomy || Boolean(opts.liveSourcesArg);
			let taxonomyActionMessage = "";
			try {
				if (opts.importTaxonomyPath) {
					const imported = importTaxonomyFromPath(opts.importTaxonomyPath);
					taxonomyActionMessage = `Imported taxonomy (replace) from ${opts.importTaxonomyPath} (categories=${imported.categories}, concepts=${imported.concepts}, terms=${imported.terms})`;
				}
				if (opts.mergeTaxonomyPath) {
					const merged = mergeTaxonomyFromPath(opts.mergeTaxonomyPath, opts.mergePolicy);
					const mergeMsg = `Merged taxonomy from ${opts.mergeTaxonomyPath} policy=${opts.mergePolicy} (categories=${merged.categories}, concepts=${merged.concepts}, terms=${merged.terms})`;
					taxonomyActionMessage = taxonomyActionMessage ? `${taxonomyActionMessage}\n${mergeMsg}` : mergeMsg;
				}
				if (opts.exportTaxonomyPath) {
					const exported = exportTaxonomyToPath(opts.exportTaxonomyPath);
					const exportMsg = `Exported taxonomy to ${opts.exportTaxonomyPath} (categories=${exported.categories}, concepts=${exported.concepts}, terms=${exported.terms})`;
					taxonomyActionMessage = taxonomyActionMessage ? `${taxonomyActionMessage}\n${exportMsg}` : exportMsg;
				}
				if (!opts.task && hasTaxonomyRefreshFlags) {
					const taxState = await ensureTaxonomy(opts.rebuildTaxonomy, opts.liveTaxonomy, config, opts.liveSourcesArg);
					const refreshMsg = `Taxonomy refresh complete: ${taxState.rebuilt ? "rebuilt" : "updated"}${taxState.enriched ? " + live-signals" : ""}${taxState.liveSources.length ? ` (${taxState.liveSources.join(", ")})` : ""}`;
					taxonomyActionMessage = taxonomyActionMessage ? `${taxonomyActionMessage}\n${refreshMsg}` : refreshMsg;
				}
			} catch (error) {
				const msg = `Taxonomy import/export/merge failed: ${(error as Error).message}`;
				if (ctx.hasUI) ctx.ui.notify(msg, "error");
				else console.log(msg);
				return;
			}

			config.lastUpdated = new Date().toISOString();
			writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));

			if (opts.status || opts.autoModeArg || opts.learningModeArg || opts.resetLearning || opts.importTaxonomyPath || opts.mergeTaxonomyPath || opts.exportTaxonomyPath || hasTaxonomyRefreshFlags) {
				const stats = getLearningStats();
				const schemaVersion = getRouterSchemaVersion();
				const text = [
					`Auto mode: ${config.router.autoMode}`,
					`Learning: ${config.router.learnEnabled ? "on" : "off"}`,
					`Confidence margin: ${config.router.minMarginForAutoPick}`,
					`SQLite DB: ${getRouterDbPath()}`,
					`DB schema: v${schemaVersion}/${ROUTER_DB_SCHEMA_VERSION}`,
					`Training samples: ${stats.samples} | Learned weights: ${stats.weights}`,
					taxonomyActionMessage,
				]
					.filter(Boolean)
					.join("\n");
				if (ctx.hasUI) ctx.ui.notify(text, "info");
				else console.log(text);
				if (!opts.task) return;
			}

			if (opts.help || !opts.task) {
				const hint =
					!opts.help && args.trim().length === 0
						? "\n\nHint: command arguments were empty. In -p mode, pass the full slash command as a single quoted argument, e.g.\n  pi -p '/model-recommend --provider openrouter cheap model for writing quicksort in javascript'"
						: "";
				const text = usageText() + hint;
				if (ctx.hasUI) ctx.ui.notify(text, "info");
				else console.log(text);
				return;
			}

			const activeProviders = getAuthenticatedProvidersFromAuthJson();
			if (activeProviders.size === 0) {
				const msg = "No authenticated providers found in agent/auth.json";
				if (ctx.hasUI) ctx.ui.notify(msg, "warning");
				else console.log(msg);
				return;
			}

			const { top, stageA, intent, taxState } = await computeRecommendations(opts.task, opts, ctx, config, true);
			if (top.length === 0) {
				const msg = "No models matched your filters.";
				if (ctx.hasUI) ctx.ui.notify(msg, "warning");
				else console.log(msg);
				return;
			}

			const rows = top.map((m, i) => ({
				m,
				rank:     String(i + 1),
				score:    m.score.toFixed(1),
				provider: m.provider,
				model:    m.model,
				intel:    String(Math.round(m.intelligence)),
				reason:   String(Math.round(m.reasoning)),
				reliab:   String(Math.round(m.toolReliability)),
				speed:    `${Math.round(m.speed)} tps`,
				price:    `${formatMoney(m.inputPrice)} / ${formatMoney(m.outputPrice)}${m.priceEstimated ? " ~" : ""}`,
				context:  formatTokenCount(m.contextWindow),
				type:     m.breakdown.reasons.some((r) => r.startsWith("near-miss:")) ? (m.isLocal ? "local*" : "commercial*") : m.isLocal ? "local" : "commercial",
			}));

			// Dynamic column widths
			const cRank     = Math.max("#".length,                    ...rows.map(r => r.rank.length));
			const cScore    = Math.max("SCORE".length,                 ...rows.map(r => r.score.length));
			const cProvider = Math.max("PROVIDER".length,              ...rows.map(r => r.provider.length));
			const cModel    = Math.max("MODEL".length,                 ...rows.map(r => r.model.length));
			const cIntel    = Math.max("INTEL".length,                 ...rows.map(r => r.intel.length));
			const cReason   = Math.max("REASON".length,                ...rows.map(r => r.reason.length));
			const cReliab   = Math.max("RELIAB".length,                ...rows.map(r => r.reliab.length));
			const cSpeed    = Math.max("SPEED".length,                 ...rows.map(r => r.speed.length));
			const cPrice    = Math.max("PRICE (in/out per 1M)".length, ...rows.map(r => r.price.length));
			const cContext  = Math.max("CONTEXT".length,               ...rows.map(r => r.context.length));
			const cType     = Math.max("TYPE".length,                  ...rows.map(r => r.type.length));

			const totalWidth = cRank + cScore + cProvider + cModel + cIntel + cReason + cReliab + cSpeed + cPrice + cContext + cType + 10 * 3;
			const sep = `${ANSIdim}${"─".repeat(totalWidth)}${ANSIreset}`;

			const hdr = [
				padCol("#",                    cRank),
				padCol("SCORE",                cScore),
				padCol("PROVIDER",             cProvider),
				padCol("MODEL",                cModel),
				padCol("INTEL",                cIntel),
				padCol("REASON",               cReason),
				padCol("RELIAB",               cReliab),
				padCol("SPEED",                cSpeed),
				padCol("PRICE (in/out per 1M)",cPrice),
				padCol("CONTEXT",              cContext),
				"TYPE",
			].join("   ");

			const tableLines = rows.map((r, i) => {
				const isTop    = i === 0;
				const isLearned = r.m.breakdown.reasons.some(x => x.startsWith("learned-bias") && !x.startsWith("learned-bias=0") && !x.includes("=-0"));
				const rankStr   = isTop ? `${ANSIgreen}${padCol(r.rank, cRank)}${ANSIreset}` : padCol(r.rank, cRank);
				const provStr   = padCol(r.provider, cProvider);
				const modelStr  = `${ANSIcyan}${padCol(r.model, cModel)}${ANSIreset}`;
				const learnedMark = isLearned ? ` ${ANSImagenta}★learned${ANSIreset}` : "";
				const typeStr   = r.type.includes("*") ? `${ANSIyellow}${r.type}${ANSIreset}` : `${ANSIdim}${r.type}${ANSIreset}`;
				return [
					rankStr,
					padCol(r.score,   cScore),
					provStr,
					modelStr,
					padCol(r.intel,   cIntel),
					padCol(r.reason,  cReason),
					padCol(r.reliab,  cReliab),
					padCol(r.speed,   cSpeed),
					padCol(r.price,   cPrice),
					padCol(r.context, cContext),
					typeStr + learnedMark,
				].join("   ");
			});

			const needs = intent.capabilityNeeds;
			const preface = [
				`${ANSIbold}Task:${ANSIreset} ${opts.task}`,
				`${ANSIbold}Intent:${ANSIreset} ${Array.from(intent.domains).join("/") || "general"} | ${ANSIbold}Complexity:${ANSIreset} ${intent.complexity}/100`,
				`${ANSIdim}Needs: reasoning=${needs.reasoningDepth.toFixed(2)} system=${needs.systemBreadth.toFixed(2)} correctness=${needs.correctnessRisk.toFixed(2)} context=${needs.contextVolume.toFixed(2)} safety=${needs.safetyCriticality.toFixed(2)} cost=${needs.costSensitivity.toFixed(2)} latency=${needs.latencySensitivity.toFixed(2)}${ANSIreset}`,
				`${ANSIdim}StageA: intel>=${stageA.constraints.minIntel} reason>=${stageA.constraints.minReasoning} tool>=${stageA.constraints.minToolReliability} context>=${stageA.constraints.minContext} | relax=${stageA.relaxLevel}${ANSIreset}`,
				`${ANSIdim}Taxonomy: ${taxState.rebuilt ? "rebuilt" : "ready"}${taxState.enriched ? " + live-signals" : ""}${ANSIreset}`,
			].join("\n");

			const output = [
				preface,
				`${ANSIdim}* = near-miss fallback (did not fully satisfy StageA)${ANSIreset}`,
				sep,
				`${ANSIbold}${ANSIdim}${hdr}${ANSIreset}`,
				sep,
				...tableLines,
				sep,
			].join("\n");

			let explainBlock = "";
			if (opts.explain) {
				const explainLines: string[] = [`\n${ANSIbold}── Score Breakdown ──${ANSIreset}`];
				for (const r of rows) {
					const b = r.m.breakdown;
					explainLines.push(
						`${ANSIcyan}${r.provider}/${r.model}${ANSIreset}`,
						`  ${ANSIdim}intel-fit=${b.normIntel.toFixed(2)}  speed-fit=${b.normSpeed.toFixed(2)}  price-fit=${b.normPrice.toFixed(2)}  ctx-fit=${b.normContext.toFixed(2)}${ANSIreset}`,
						`  ${ANSIdim}capability=${(b.weightedBase*100).toFixed(1)}%  affinity=${(b.affinity*100).toFixed(1)}%  jitter=${b.tieJitter.toFixed(3)}  final=${b.final.toFixed(1)}${ANSIreset}`,
						...b.reasons.map(reason => `  ${ANSIdim}· ${reason}${ANSIreset}`),
					);
				}
				explainBlock = explainLines.join("\n");
			}


			// No learning on manual /model-recommend runs.
			// Learning happens only via before_agent_start auto-routing (set-auto suggest/enforce).

			const finalOutput = explainBlock ? [output, explainBlock].join("\n") : output;
			if (ctx.hasUI) ctx.ui.notify(finalOutput, "info");
			else console.log(finalOutput);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const config = ensureRecommendConfig();
		if (config.router.autoMode === "off") return;
		const prompt = String((event as any).prompt ?? "").trim();
		if (!prompt || prompt.startsWith("/")) return;

		const opts = parseRecommendArgs("");
		opts.limit = 5;  // top array → up to 5 recommendations in the picker
		const { top, intent } = await computeRecommendations(prompt, opts, ctx as any, config, true);
		if (top.length === 0) return;

		const margin = top.length > 1 ? top[0].score - top[1].score : 100;
		const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "current";

		// ── ENFORCE: auto-switch silently ────────────────────────────────────────
		if (config.router.autoMode === "enforce") {
			const selected = top[0];
			const ok = await setCurrentModel(pi, ctx as any, selected);
			(ctx as any).ui?.notify(`Routing: ${selected.provider}/${selected.model}${ok ? "" : " (switch failed)"}`, ok ? "info" : "warning");
			if (config.router.learnEnabled) {
				persistTrainingSample(prompt, "auto-enforce", intent, selected, top.slice(0, 5), margin);
				trainPairwiseSelection(config, selected, top.slice(0, 5));
			}
			return;
		}

		// ── SUGGEST: interactive picker ──────────────────────────────────────────
		if (!(ctx as any).hasUI) {
			// Headless mode: just print suggestions, don't block
			const lines = top.slice(0, 5).map((m, i) =>
				`  ${i + 1}. ${m.provider}/${m.model}  score=${m.score.toFixed(1)} reason=${m.reasoning} intel=${m.intelligence}`
			);
			console.log(`\n── Model Suggestions (suggest mode) ─────────────────\n${lines.join("\n")}\n  6. Keep current: ${currentModel}\n─────────────────────────────────────────────────────\n`);
			return;
		}

		// Build SelectList items: top 5 recommendations + keep current + custom entry
		const listItems: SelectItem[] = top.slice(0, 5).map((m, i) => ({
			value: `rec:${i}`,
			label: `${m.provider}/${m.model}`,
			description: `score ${m.score.toFixed(1)}  intel ${m.intelligence}  reason ${m.reasoning}  ${m.pricing ? `$${m.pricing.inputCostPer1M?.toFixed(2)}/$${m.pricing.outputCostPer1M?.toFixed(2)}` : ""}`,
		}));
		listItems.push({
			value: "keep",
			label: `⟳  Keep current  (${currentModel})`,
			description: "Continue with currently active model",
		});
		listItems.push({
			value: "custom",
			label: "✎  Enter custom model...",
			description: "Type provider/model-id manually",
		});

		const choice = await (ctx as any).ui.custom<string | null>((tui: any, theme: any, _kb: any, done: (v: string | null) => void) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(" Model Suggestions")), 1, 0));
			container.addChild(new Text(theme.fg("dim", ` Task intent: ${intent?.dominant ?? "general"} · complexity ${intent?.complexity ?? "?"}/100`), 1, 0));
			container.addChild(new Text("", 0, 0));

			class AutoWidthSelectList extends SelectList {
				getPrimaryColumnWidth() {
					return Math.max(20, ...this.filteredItems.map((i: any) => (i.label ? i.label.length : 0))) + 2;
				}
				truncatePrimary(item: any) {
					return item.label || item.value;
				}
			}
			const selectList = new AutoWidthSelectList(listItems, Math.min(listItems.length, 10), {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText:   (t: string) => theme.fg("accent", t),
				description:    (t: string) => theme.fg("dim", t),
				scrollInfo:     (t: string) => theme.fg("dim", t),
				noMatch:        (t: string) => theme.fg("warning", t),
			});
			selectList.onSelect  = (item: SelectItem) => done(item.value as string);
			selectList.onCancel  = () => done(null);
			container.addChild(selectList);

			container.addChild(new Text(theme.fg("dim", " ↑↓ navigate · enter select · esc keep current"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render:       (w: number) => container.render(w),
				invalidate:   () => container.invalidate(),
				handleInput:  (data: Uint8Array) => { selectList.handleInput(data); tui.requestRender(); },
			};
		});

		// Esc or null → keep current, no learning
		if (choice === null) return;

		// "keep" → record that user preferred current model over suggestions
		if (choice === "keep") {
			if (config.router.learnEnabled) {
				const fakeKeep = { provider: ctx.model?.provider ?? "", model: ctx.model?.id ?? "", score: 0, intelligence: 0, reasoning: 0, toolReliability: 0 } as ScoredModel;
				persistTrainingSample(prompt, "user-keep", intent, fakeKeep, top.slice(0, 5), margin);
			}
			(ctx as any).ui.notify(`Keeping current model: ${currentModel}`, "info");
			return;
		}

		// "custom" → open an Input dialog
		if (choice === "custom") {
			const customId = await (ctx as any).ui.custom<string | null>((tui: any, theme: any, _kb: any, done: (v: string | null) => void) => {
				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(theme.fg("accent", theme.bold(" Enter model  (provider/model-id)")), 1, 0));
				const inp = new Input("", 60);
				container.addChild(inp as any);
				container.addChild(new Text(theme.fg("dim", " enter confirm · esc cancel"), 1, 0));
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				return {
					render:      (w: number) => container.render(w),
					invalidate:  () => container.invalidate(),
					handleInput: (data: Uint8Array) => {
						if (matchesKey(data, Key.enter)) { done(inp.getValue().trim() || null); return; }
						if (matchesKey(data, Key.escape)) { done(null); return; }
						inp.handleInput(data);
						tui.requestRender();
					},
				};
			});
			if (!customId) return;
			// Find model in registry
			const found = findModelFromInput(customId, (ctx as any).modelRegistry.getAll() as any);
			if (!found) {
				(ctx as any).ui.notify(`Model not found in registry: ${customId}`, "warning");
				return;
			}
			const ok = await pi.setModel(found as any);
			(ctx as any).ui.notify(`Switched to: ${found.provider}/${found.id}${ok ? "" : " (switch failed)"}`, ok ? "info" : "warning");
			if (config.router.learnEnabled) {
				const custom: ScoredModel = { provider: found.provider, model: found.id, score: 50, intelligence: 50, reasoning: 50, toolReliability: 50 } as ScoredModel;
				persistTrainingSample(prompt, "user-custom", intent, custom, top.slice(0, 5), margin);
				trainPairwiseSelection(config, custom, top.slice(0, 5));
			}
			return;
		}

		// Numeric recommendation pick: "rec:0" … "rec:4"
		const idx = parseInt(choice.replace("rec:", ""), 10);
		const selected = top[idx];
		if (!selected) return;
		const ok = await setCurrentModel(pi, ctx as any, selected);
		(ctx as any).ui.notify(`Routing: ${selected.provider}/${selected.model}${ok ? "" : " (switch failed)"}`, ok ? "info" : "warning");
		if (config.router.learnEnabled) {
			persistTrainingSample(prompt, "user-pick", intent, selected, top.slice(0, 5), margin);
			trainPairwiseSelection(config, selected, top.slice(0, 5));
		}
	});
}
