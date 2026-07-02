import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
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

async function ensureTaxonomy(rebuild: boolean, liveTaxonomy: boolean, config: RecommendConfig, liveSourceOverride?: string): Promise<TaxonomyState> {
	const path = getTaxonomyPath();
	let rebuilt = false;

	if (rebuild || !existsSync(path)) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(createTaxonomySnapshot(), null, 2));
		rebuilt = true;
	}

	let taxonomy: Taxonomy;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Taxonomy;
		taxonomy = parsed?.categories && typeof parsed.categories === "object" ? parsed : createTaxonomySnapshot();
	} catch {
		taxonomy = createTaxonomySnapshot();
		rebuilt = true;
	}

	const shouldLiveEnrich = liveTaxonomy || rebuild || process.env.PI_MODEL_RECOMMEND_LIVE_TAXONOMY === "1";
	if (shouldLiveEnrich) {
		const enriched = await enrichTaxonomyWithLiveSignals(taxonomy, config, liveSourceOverride);
		taxonomy = enriched.taxonomy;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(taxonomy, null, 2));
		return { taxonomy, rebuilt, enriched: enriched.enriched, liveSources: enriched.liveSources };
	}

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(taxonomy, null, 2));
	return { taxonomy, rebuilt, enriched: false, liveSources: [] };
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
			defaults: { ...fallback.defaults, ...(parsed?.defaults ?? {}) },
		};
		writeFileSync(path, JSON.stringify(merged, null, 2));
		return merged;
	} catch {
		writeFileSync(path, JSON.stringify(fallback, null, 2));
		return fallback;
	}
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
	return {
		minIntel: clamp(base.minIntel - level * 7, 26, 99),
		minReasoning: clamp(base.minReasoning - level * 8, 8, 99),
		minToolReliability: clamp(base.minToolReliability - level * 7, 14, 99),
		minContext: Math.max(8_000, Math.round(base.minContext / Math.pow(1.85, level))),
		requireReasoning: level >= 2 ? false : base.requireReasoning,
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

function usageText(): string {
	return [
		"/model-recommend <task> [options]",
		"",
		"Options:",
		"  --rebuild-taxonomy",
		"  --trusted",
		"  --live-taxonomy",
		"  --live-sources <all|csv>",
		"  --provider <name[,name]>   Repeatable; supports comma-separated values",
		"  --grep <text>",
		"  --strategy <cheapest-capable|capability-first|local-first>",
		"  --local-prefer",
		"  --local-only",
		"  --sort-by <score|intelligence|reasoning|reliability|speed|price|context> [asc|desc]",
		"  --limit <n>",
		"  --explain",
		"  --help",
		"",
		"Notes:",
		"  - Taxonomy is stored at ~/.pi/model-taxonomy.json",
		"  - Recommendation tuning config is stored at agent/model-recommend-config.json",
		"  - Live taxonomy sources are configurable in config.liveTaxonomy.enabledSources",
		"  - Use --live-sources all to force all available sources",
		"  - --provider accepts repeated flags and comma-separated providers",
		"  - If either file is missing, it is auto-built on first run", 
	].join("\n");
}

export default function modelRecommendExtension(pi: ExtensionAPI) {
	pi.registerCommand("model-recommend", {
		description: "Recommend models for a task using auth-aware model access + local taxonomy scoring",
		handler: async (args, ctx) => {
			const opts = parseRecommendArgs(args);
			if (process.env.PI_MODEL_RECOMMEND_DEBUG === "1") {
				const dbg = `[model-recommend debug]\nrawArgs=${JSON.stringify(args)}\nparsedTask=${JSON.stringify(opts.task)}\nproviders=${JSON.stringify(opts.providers)}\nstrategy=${opts.strategy}\nlimit=${opts.limit}`;
				if (ctx.hasUI) ctx.ui.notify(dbg, "info");
				else console.log(dbg);
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

			const config = ensureRecommendConfig();
			const taxState = await ensureTaxonomy(opts.rebuildTaxonomy, opts.liveTaxonomy, config, opts.liveSourcesArg);
			const intent = analyzeIntent(opts.task, taxState.taxonomy, config);

			const registryModels = ctx.modelRegistry.getAll() as ModelLike[];
			const costHints = buildCostHintIndex(registryModels);
			let models = registryModels.filter((m) => activeProviders.has(m.provider));
			if (opts.providers.length > 0) models = models.filter((m) => opts.providers.some((p) => m.provider.toLowerCase().includes(p)));
			if (opts.localOnly) models = models.filter((m) => buildModelProfile(m).isLocal);
			if (opts.grep) models = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(opts.grep!.toLowerCase()));

			let scored = models
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

			if (scored.length === 0) {
				const msg = "No models matched your filters.";
				if (ctx.hasUI) ctx.ui.notify(msg, "warning");
				else console.log(msg);
				return;
			}

			const stageA = selectStageAFeasible(scored, intent, config);
			scored = stageA.feasible.map((m) => ({ ...m, score: scoreModel(m, intent, config, stageA.constraints, stageA.relaxLevel) }));
			scored = applyCapabilityDeltaGuard(scored, intent, config);

			const dir = opts.sortDir === "desc" ? -1 : 1;
			scored.sort((a, b) => {
				let cmp = 0;
				switch (opts.sortBy) {
					case "score": {
						if (opts.strategy === "local-first") {
							cmp = Number(a.isLocal) - Number(b.isLocal);
							if (cmp === 0) cmp = a.breakdown.weightedBase - b.breakdown.weightedBase;
							if (cmp === 0) cmp = b.effectivePrice - a.effectivePrice;
						} else if (opts.strategy === "capability-first") {
							cmp = a.breakdown.weightedBase - b.breakdown.weightedBase;
							if (cmp === 0) cmp = b.effectivePrice - a.effectivePrice;
						} else {
							if (opts.localPrefer) {
								cmp = Number(a.isLocal) - Number(b.isLocal);
								if (cmp !== 0) break;
							}
							cmp = b.effectivePrice - a.effectivePrice;
							if (cmp === 0) cmp = a.breakdown.weightedBase - b.breakdown.weightedBase;
						}
						if (cmp === 0) cmp = a.score - b.score;
						break;
					}
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
						cmp = a.effectivePrice - b.effectivePrice;
						break;
					case "context":
						cmp = a.contextWindow - b.contextWindow;
						break;
				}
				if (cmp === 0) cmp = a.model.localeCompare(b.model) * -1;
				return cmp * dir;
			});

			const top = scored.slice(0, Math.max(1, opts.limit));
			const rows = top.map((m, i) => ({
				rank: String(i + 1),
				score: m.score.toFixed(1),
				provider: m.provider,
				model: m.model,
				intel: String(Math.round(m.intelligence)),
				reason: String(Math.round(m.reasoning)),
				reliab: String(Math.round(m.toolReliability)),
				speed: `${Math.round(m.speed)} tps`,
				price: `${formatMoney(m.inputPrice)} / ${formatMoney(m.outputPrice)}${m.priceEstimated ? " ~" : ""}`,
				context: formatTokenCount(m.contextWindow),
				type: m.isLocal ? "local" : "commercial",
			}));

			const w = {
				rank: Math.max(4, ...rows.map((r) => r.rank.length)),
				score: Math.max(5, ...rows.map((r) => r.score.length)),
				provider: Math.max(8, ...rows.map((r) => r.provider.length)),
				model: Math.max(5, ...rows.map((r) => r.model.length)),
				intel: Math.max(5, ...rows.map((r) => r.intel.length)),
				reason: Math.max(6, ...rows.map((r) => r.reason.length)),
				reliab: Math.max(6, ...rows.map((r) => r.reliab.length)),
				speed: Math.max(5, ...rows.map((r) => r.speed.length)),
				price: Math.max(21, ...rows.map((r) => r.price.length)),
				context: Math.max(7, ...rows.map((r) => r.context.length)),
				type: Math.max(4, ...rows.map((r) => r.type.length)),
			};

			const header =
				pad("rank", w.rank) +
				"  " +
				pad("score", w.score) +
				"  " +
				pad("provider", w.provider) +
				"  " +
				pad("model", w.model) +
				"  " +
				pad("intel", w.intel) +
				"  " +
				pad("reason", w.reason) +
				"  " +
				pad("reliab", w.reliab) +
				"  " +
				pad("speed", w.speed) +
				"  " +
				pad("price(in/out per 1M)", w.price) +
				"  " +
				pad("context", w.context) +
				"  " +
				pad("type", w.type);

			const lines = rows.map(
				(r) =>
					pad(r.rank, w.rank) +
					"  " +
					pad(r.score, w.score) +
					"  " +
					pad(r.provider, w.provider) +
					"  " +
					pad(r.model, w.model) +
					"  " +
					pad(r.intel, w.intel) +
					"  " +
					pad(r.reason, w.reason) +
					"  " +
					pad(r.reliab, w.reliab) +
					"  " +
					pad(r.speed, w.speed) +
					"  " +
					pad(r.price, w.price) +
					"  " +
					pad(r.context, w.context) +
					"  " +
					pad(r.type, w.type),
			);

			const needs = intent.capabilityNeeds;
			const preface = [
				`Task: ${opts.task}`,
				`Intent: ${Array.from(intent.domains).join("/") || "general"} | Complexity: ${intent.complexity}/100`,
				`Languages: ${Array.from(intent.languages).join(", ") || "-"} | Taxonomy categories: ${Array.from(intent.matchedTaxonomyCategories).join(", ") || "-"}`,
				`Needs: reasoning=${needs.reasoningDepth.toFixed(2)} system=${needs.systemBreadth.toFixed(2)} correctness=${needs.correctnessRisk.toFixed(2)} context=${needs.contextVolume.toFixed(2)} safety=${needs.safetyCriticality.toFixed(2)} cost=${needs.costSensitivity.toFixed(2)} latency=${needs.latencySensitivity.toFixed(2)}`,
				`StageA: intel>=${stageA.constraints.minIntel} reason>=${stageA.constraints.minReasoning} tool>=${stageA.constraints.minToolReliability} context>=${stageA.constraints.minContext} | relax=${stageA.relaxLevel}`,
				`Taxonomy matches: concepts=${intent.matchedTaxonomyConcepts.size}`,
				`Strategy: ${opts.strategy}${opts.localPrefer ? " + local-prefer" : ""}${opts.localOnly ? " + local-only" : ""} | Providers: ${opts.providers.join(",") || "all-authenticated"}`,
				`Taxonomy: ${taxState.rebuilt ? "rebuilt" : "ready"}${taxState.enriched ? " + live-signals" : ""}${taxState.liveSources.length ? ` (${taxState.liveSources.join(", ")})` : ""} | Config: ${getConfigPath()}`,
				"Price marker: '~' means estimated from other providers for same model id",
				"",
			].join("\n");

			const explainEnabled = opts.explain || process.env.PI_MODEL_RECOMMEND_EXPLAIN === "1";
			const explainBlock = explainEnabled
				? [
					"",
					"Score breakdown (top models):",
					...top.map((m, i) => {
						const b = m.breakdown;
						return [
							`${i + 1}. ${m.provider}/${m.model}`,
							`   base=${(b.weightedBase * 100).toFixed(1)} | affinity=${b.affinity.toFixed(2)} | jitter=${b.tieJitter.toFixed(2)} | final=${b.final.toFixed(1)}`,
							`   norms intel=${b.normIntel.toFixed(2)} speed=${b.normSpeed.toFixed(2)} price=${b.normPrice.toFixed(2)} context=${b.normContext.toFixed(2)}`,
							`   weights intel=${b.weights.intel.toFixed(2)} speed=${b.weights.speed.toFixed(2)} price=${b.weights.price.toFixed(2)} context=${b.weights.context.toFixed(2)}`,
							`   reasons: ${b.reasons.join("; ") || "none"}`,
						].join("\n");
					}),
				].join("\n")
				: "";

			const output = [preface, header, "-".repeat(header.length), ...lines, explainBlock].join("\n");
			if (ctx.hasUI) ctx.ui.notify(output, "info");
			else console.log(output);
		},
	});
}
