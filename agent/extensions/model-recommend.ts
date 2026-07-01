import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ModelLike = {
	provider: string;
	id: string;
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input?: number; output?: number };
};

type Taxonomy = {
	version: string;
	lastUpdated: string;
	categories: Record<string, { weight: number; concepts: Record<string, string[]> }>;
};

type Intent = {
	complexity: number;
	domains: Set<string>;
	isCoding: boolean;
	prefersSpeed: boolean;
	prefersCheap: boolean;
	prefersReasoning: boolean;
};

type RecommendOptions = {
	task: string;
	rebuildTaxonomy: boolean;
	trusted: boolean;
	provider?: string;
	grep?: string;
	sortBy: "score" | "intelligence" | "speed" | "price" | "context";
	sortDir: "asc" | "desc";
	limit: number;
	help: boolean;
};

type ScoredModel = {
	provider: string;
	model: string;
	score: number;
	intelligence: number;
	speed: number;
	inputPrice: number;
	outputPrice: number;
	contextWindow: number;
	isLocal: boolean;
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
	coding: ["python", "typescript", "javascript", "js", "ts", "rust", "go", "java", "backend", "frontend", "code", "coding", "api"],
	reasoning: ["logic", "math", "reason", "complex", "solve", "architecture", "analysis"],
	creative: ["story", "write", "creative", "tone", "copywriting"],
};

const COMPLEXITY_TRIGGERS: Record<string, number> = {
	microservice: 25,
	architecture: 30,
	auth: 20,
	distributed: 30,
	optimize: 15,
	refactor: 15,
	migration: 15,
	security: 20,
};

const DEFAULT_TAXONOMY: Taxonomy = {
	version: "1.0.0",
	lastUpdated: "2026-07-02T00:00:00Z",
	categories: {
		software_architecture: {
			weight: 1,
			concepts: {
				design_patterns: ["mvc", "mvvm", "cqrs", "event sourcing", "saga", "clean architecture", "ddd"],
				principles: ["solid", "dry", "kiss", "yagni"],
			},
		},
		languages: {
			weight: 0.9,
			concepts: {
				backend: ["python", "java", "c#", "go", "rust", "php", "elixir"],
				frontend: ["javascript", "typescript", "html", "css", "react", "vue", "angular"],
			},
		},
		infrastructure_devops: {
			weight: 0.9,
			concepts: {
				containers: ["docker", "kubernetes", "helm", "k8s"],
				ci_cd: ["github actions", "gitlab ci", "jenkins", "argo"],
				iac: ["terraform", "pulumi", "ansible", "bicep"],
			},
		},
		artificial_intelligence: {
			weight: 1,
			concepts: {
				frameworks: ["pytorch", "tensorflow", "transformers", "langchain"],
				llm: ["llm", "rag", "embeddings", "quantization", "fine-tuning"],
			},
		},
		security: {
			weight: 0.9,
			concepts: {
				auth: ["oauth2", "oidc", "jwt", "rbac", "mfa"],
				appsec: ["xss", "sqli", "csrf", "ssrf", "owasp"],
			},
		},
	},
};

function pad(value: string, width: number): string {
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
			if (cfg.key || cfg.apiKey || cfg.access || cfg.refresh || cfg.token) providers.add(provider);
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
		trusted: false,
		sortBy: "score",
		sortDir: "desc",
		limit: 10,
		help: false,
	};
	const free: string[] = [];

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
			case "--provider":
				opts.provider = tokens[++i];
				break;
			case "--grep":
				opts.grep = tokens[++i];
				break;
			case "--sort-by": {
				const v = (tokens[++i] ?? "").toLowerCase();
				if (["score", "intelligence", "speed", "price", "context"].includes(v)) opts.sortBy = v as RecommendOptions["sortBy"];
				const maybeDir = (tokens[i + 1] ?? "").toLowerCase();
				if (maybeDir === "asc" || maybeDir === "desc") {
					opts.sortDir = maybeDir;
					i++;
				}
				break;
			}
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

function getIntelHeuristic(modelId: string): number {
	const name = modelId.toLowerCase();
	if (
		[
			"o1",
			"o3",
			"gpt-5",
			"claude-3-5",
			"claude-4",
			"claude-5",
			"fable",
			"gpt-4o",
			"deepseek-v3",
			"deepseek-r1",
			"gemini-2.0",
			"gemini-2.5",
			"gemini-3",
			"opus",
		].some((k) => name.includes(k)) &&
		!["mini", "lite", "flash", "nano", "8b", "nemotron"].some((k) => name.includes(k))
	)
		return 95;
	if (["gpt-4", "llama-3.1-405b", "smaug", "sonnet"].some((k) => name.includes(k))) return 90;
	if (["llama-3.1-70b", "qwen2.5-72b", "deepseek-v2.5", "phi-4"].some((k) => name.includes(k)) && !name.includes("mini")) return 80;
	if (["haiku", "flash", "lite", "mini", "8b", "llama-3.1-8b", "phi-3", "nano", "nemotron"].some((k) => name.includes(k))) return 55;
	if (["coder", "qwen", "gemma"].some((k) => name.includes(k))) return 65;
	return 40;
}

function getSpeedHeuristic(modelId: string): number {
	const name = modelId.toLowerCase();
	if (["mini", "flash", "haiku", "8b", "phi", "nano"].some((k) => name.includes(k))) return 150;
	if (["sonnet", "4o", "70b", "gemini-pro"].some((k) => name.includes(k))) return 70;
	if (["opus", "o1", "405b", "fable"].some((k) => name.includes(k))) return 15;
	return 40;
}

function getTaxonomyPath(): string {
	return join(homedir(), ".pi", "model-taxonomy.json");
}

function createTaxonomySnapshot(): Taxonomy {
	return {
		...DEFAULT_TAXONOMY,
		lastUpdated: new Date().toISOString(),
		categories: JSON.parse(JSON.stringify(DEFAULT_TAXONOMY.categories)) as Taxonomy["categories"],
	};
}

function ensureTaxonomy(rebuild: boolean): { taxonomy: Taxonomy; rebuilt: boolean } {
	const path = getTaxonomyPath();
	let rebuilt = false;

	if (rebuild || !existsSync(path)) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(createTaxonomySnapshot(), null, 2));
		rebuilt = true;
	}

	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Taxonomy;
		if (parsed?.categories) return { taxonomy: parsed, rebuilt };
	} catch {
		// corrupted file fallback below
	}

	const fresh = createTaxonomySnapshot();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(fresh, null, 2));
	return { taxonomy: fresh, rebuilt: true };
}

function analyzeIntent(task: string, taxonomy: Taxonomy): Intent {
	const lower = task.toLowerCase();
	const complexityBase = Object.entries(COMPLEXITY_TRIGGERS).reduce((acc, [k, w]) => (lower.includes(k) ? acc + w : acc), 10);

	let taxScore = 0;
	for (const cat of Object.values(taxonomy.categories ?? {})) {
		for (const concepts of Object.values(cat.concepts ?? {})) {
			for (const concept of concepts) {
				if (lower.includes(concept.toLowerCase())) taxScore += 10 * Number(cat.weight ?? 1);
			}
		}
	}

	const domains = new Set<string>();
	for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
		if (keywords.some((k) => lower.includes(k))) domains.add(domain);
	}

	return {
		complexity: Math.min(100, Math.round(complexityBase + taxScore)),
		domains,
		isCoding: domains.has("coding"),
		prefersSpeed: ["fast", "quick", "realtime", "speed"].some((k) => lower.includes(k)),
		prefersCheap: ["cheap", "budget", "affordable", "free", "low-cost", "lowest"].some((k) => lower.includes(k)),
		prefersReasoning: domains.has("reasoning") || ["deep", "thought", "complex", "logic"].some((k) => lower.includes(k)),
	};
}

function scoreModel(model: ScoredModel, intent: Intent): number {
	const profile = intent.prefersSpeed
		? { intel: 0.5, speed: 2.0, price: 0.8, context: 0.0 }
		: intent.prefersReasoning
			? { intel: 2.0, speed: 0.5, price: 1.0, context: 0.3 }
			: intent.isCoding
				? { intel: 1.5, speed: 0.8, price: 1.0, context: 0.5 }
				: { intel: 1.0, speed: 1.0, price: 1.0, context: 0.0 };

	if (intent.prefersCheap) profile.price += 0.5;

	const normIntel = Math.max(0, Math.min(1, model.intelligence / 100));
	const normSpeed = Math.max(0, Math.min(1, Math.min(model.speed, 200) / 200));
	const normPrice = model.outputPrice <= 0 ? 1 : Math.max(0, Math.min(1, 1 - (Math.log10(Math.max(0.001, model.outputPrice)) + 3) / 6));
	const normContext = Math.max(0, Math.min(1, (Math.log2(Math.max(8000, model.contextWindow)) - 13) / (21 - 13)));

	let score =
		Math.pow(normIntel, profile.intel) *
		Math.pow(normSpeed, profile.speed) *
		Math.pow(normPrice, profile.price) *
		Math.pow(normContext, profile.context);

	const name = model.model.toLowerCase();
	if (intent.isCoding) score *= ["coder", "code"].some((k) => name.includes(k)) ? 1.4 : 1.05;
	if (intent.prefersReasoning && ["o1", "o3", "r1", "reason"].some((k) => name.includes(k))) score *= 1.5;
	if (intent.complexity > 60 && model.intelligence < 80) score *= 0.5;
	if (intent.complexity > 60 && model.intelligence > 90) score *= 1.25;
	if (intent.prefersCheap && model.outputPrice > 10) score *= 0.6;

	return Math.max(0, score * 100);
}

function usageText(): string {
	return [
		"/model-recommend <task> [options]",
		"",
		"Options:",
		"  --rebuild-taxonomy",
		"  --trusted",
		"  --provider <name>",
		"  --grep <text>",
		"  --sort-by <score|intelligence|speed|price|context> [asc|desc]",
		"  --limit <n>",
		"  --help",
		"",
		"Notes:",
		"  - Taxonomy is always stored at ~/.pi/model-taxonomy.json",
		"  - If taxonomy is missing, it is auto-built on first run",
	].join("\n");
}

export default function modelRecommendExtension(pi: ExtensionAPI) {
	pi.registerCommand("model-recommend", {
		description: "Recommend models for a task using auth-aware model access + local taxonomy scoring",
		handler: async (args, ctx) => {
			const opts = parseRecommendArgs(args);
			if (opts.help || !opts.task) {
				const text = usageText();
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

			const taxState = ensureTaxonomy(opts.rebuildTaxonomy);
			const intent = analyzeIntent(opts.task, taxState.taxonomy);

			let models = (ctx.modelRegistry.getAll() as ModelLike[]).filter((m) => activeProviders.has(m.provider));
			if (opts.provider) models = models.filter((m) => m.provider.toLowerCase().includes(opts.provider!.toLowerCase()));
			if (opts.grep) models = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(opts.grep!.toLowerCase()));

			let scored = models
				.map(
					(m): ScoredModel => ({
						provider: m.provider,
						model: m.id,
						score: 0,
						intelligence: getIntelHeuristic(m.id),
						speed: getSpeedHeuristic(m.id),
						inputPrice: Math.max(0, Number(m.cost?.input ?? 0)),
						outputPrice: Math.max(0, Number(m.cost?.output ?? 0)),
						contextWindow: Number(m.contextWindow ?? 0),
						isLocal: isLocalModel(m.provider),
					}),
				)
				.filter((m) => (opts.trusted ? isTrustedAuthor(m.model) : true));

			if (scored.length === 0) {
				const msg = "No models matched your filters.";
				if (ctx.hasUI) ctx.ui.notify(msg, "warning");
				else console.log(msg);
				return;
			}

			scored = scored.map((m) => ({ ...m, score: scoreModel(m, intent) }));

			const dir = opts.sortDir === "desc" ? -1 : 1;
			scored.sort((a, b) => {
				let cmp = 0;
				switch (opts.sortBy) {
					case "score":
						cmp = a.score - b.score;
						break;
					case "intelligence":
						cmp = a.intelligence - b.intelligence;
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
			});

			const top = scored.slice(0, Math.max(1, opts.limit));
			const rows = top.map((m, i) => ({
				rank: String(i + 1),
				score: m.score.toFixed(1),
				provider: m.provider,
				model: m.model,
				intel: String(Math.round(m.intelligence)),
				speed: `${Math.round(m.speed)} tps`,
				price: `${formatMoney(m.inputPrice)} / ${formatMoney(m.outputPrice)}`,
				context: formatTokenCount(m.contextWindow),
				type: m.isLocal ? "local" : "commercial",
			}));

			const w = {
				rank: Math.max(4, ...rows.map((r) => r.rank.length)),
				score: Math.max(5, ...rows.map((r) => r.score.length)),
				provider: Math.max(8, ...rows.map((r) => r.provider.length)),
				model: Math.max(5, ...rows.map((r) => r.model.length)),
				intel: Math.max(5, ...rows.map((r) => r.intel.length)),
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
					pad(r.speed, w.speed) +
					"  " +
					pad(r.price, w.price) +
					"  " +
					pad(r.context, w.context) +
					"  " +
					pad(r.type, w.type),
			);

			const preface = [
				`Task: ${opts.task}`,
				`Intent: ${Array.from(intent.domains).join("/") || "general"} | Complexity: ${intent.complexity}/100`,
				`Taxonomy: ${taxState.rebuilt ? "rebuilt" : "ready"}`,
				"",
			].join("\n");

			const output = [preface, header, "-".repeat(header.length), ...lines].join("\n");
			if (ctx.hasUI) ctx.ui.notify(output, "info");
			else console.log(output);
		},
	});
}
