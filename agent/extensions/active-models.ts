import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type ModelLike, buildCostHintIndex, buildModelProfile } from "./model-profile";

type ParsedArgs = {
	help: boolean;
	providers: string[];
	grep: string;
	limit: number;
	sortBy: "score" | "intelligence" | "reasoning" | "reliability" | "speed" | "price" | "context";
	desc: boolean;
	minIntel: number;
	maxIntel: number;
	minReasoning: number;
	minReliability: number;
	maxPrice: number;
	minContext: number;
	maxContext: number;
};

type Row = {
	provider: string;
	model: string;
	intel: number;
	reasoning: number;
	reliability: number;
	speed: number;
	score: number;
	priceInput: number;
	priceOutput: number;
	effectivePrice: number;
	contextWindow: number;
	maxOut: number;
	images: boolean;
	priceEstimated: boolean;
};

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function formatMoney(value: number): string {
	return `$${value.toFixed(2)}`;
}

function formatTokenCount(value: number | undefined): string {
	if (!value || value <= 0) return "-";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) {
		const k = value / 1_000;
		return Number.isInteger(k) ? `${k}K` : `${k.toFixed(1)}K`;
	}
	return `${value}`;
}

function parseNumberWithSuffix(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const m = value.trim().toLowerCase().match(/^([0-9]+(?:\.[0-9]+)?)([km])?$/);
	if (!m) return fallback;
	const n = Number(m[1]);
	if (Number.isNaN(n)) return fallback;
	if (m[2] === "k") return Math.round(n * 1_000);
	if (m[2] === "m") return Math.round(n * 1_000_000);
	return Math.round(n);
}

function parseFloatSafe(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function tokenize(raw: string): string[] {
	const matches = raw.match(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g) ?? [];
	return matches.map((t) => {
		if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
		return t;
	});
}

function parseArgs(raw: string): ParsedArgs {
	const parsed: ParsedArgs = {
		help: false,
		providers: [],
		grep: "",
		limit: 0,
		sortBy: "score",
		desc: true,
		minIntel: 0,
		maxIntel: 100,
		minReasoning: 0,
		minReliability: 0,
		maxPrice: Number.POSITIVE_INFINITY,
		minContext: 0,
		maxContext: Number.POSITIVE_INFINITY,
	};

	const free: string[] = [];
	const tokens = tokenize(raw);

	const pushProviders = (raw: string | undefined) => {
		if (!raw) return;
		for (const part of raw.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean)) parsed.providers.push(part);
	};

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		switch (t) {
			case "--help":
			case "-h":
				parsed.help = true;
				break;
			case "--provider":
			case "--providers":
			case "-p": {
				pushProviders(tokens[++i]);
				break;
			}
			case "--grep":
			case "-g": {
				const v = tokens[++i];
				if (v) parsed.grep = v.toLowerCase();
				break;
			}
			case "--limit":
			case "-n": {
				const v = tokens[++i];
				parsed.limit = Math.max(0, parseInt(v ?? "0", 10) || 0);
				break;
			}
			case "--sort":
			case "--sort-by": {
				const v = (tokens[++i] ?? "").toLowerCase();
				const normalized = v === "intel" ? "intelligence" : v === "max-out" ? "context" : v;
				if (["score", "intelligence", "reasoning", "reliability", "speed", "price", "context"].includes(normalized)) {
					parsed.sortBy = normalized as ParsedArgs["sortBy"];
				}
				const maybeDir = (tokens[i + 1] ?? "").toLowerCase();
				if (maybeDir === "asc" || maybeDir === "desc") {
					parsed.desc = maybeDir === "desc";
					i++;
				}
				break;
			}
			case "--desc":
				parsed.desc = true;
				break;
			case "--asc":
				parsed.desc = false;
				break;
			case "--min-intel":
				parsed.minIntel = parseFloatSafe(tokens[++i], parsed.minIntel);
				break;
			case "--max-intel":
				parsed.maxIntel = parseFloatSafe(tokens[++i], parsed.maxIntel);
				break;
			case "--min-reasoning":
				parsed.minReasoning = parseFloatSafe(tokens[++i], parsed.minReasoning);
				break;
			case "--min-reliability":
				parsed.minReliability = parseFloatSafe(tokens[++i], parsed.minReliability);
				break;
			case "--max-price":
				parsed.maxPrice = parseFloatSafe(tokens[++i], parsed.maxPrice);
				break;
			case "--min-context":
				parsed.minContext = parseNumberWithSuffix(tokens[++i], parsed.minContext);
				break;
			case "--max-context":
				parsed.maxContext = parseNumberWithSuffix(tokens[++i], parsed.maxContext);
				break;
			default:
				free.push(t);
		}
	}

	if (!parsed.grep && free.length > 0) parsed.grep = free.join(" ").toLowerCase();
	return parsed;
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
			const hasApiKey = Boolean(cfg.key ?? cfg.apiKey);
			const hasOAuthToken = Boolean(cfg.access ?? cfg.refresh ?? cfg.token);
			if (hasApiKey || hasOAuthToken) providers.add(provider);
		}
		return providers;
	} catch {
		return new Set();
	}
}

function usageText(): string {
	return [
		"/active-models [free-text] [options]",
		"",
		"Options:",
		"  --provider, --providers, -p <name[,name]>   Filter by provider (repeatable; comma-separated supported)",
		"  --grep, -g <text>             Filter by text (provider/model)",
		"  --limit, -n <int>             Limit rows (0 = all)",
		"  --sort-by <field>             score|intelligence|reasoning|reliability|speed|price|context [asc|desc]",
		"  --desc / --asc                Sort direction",
		"  --min-intel <0..100>",
		"  --max-intel <0..100>",
		"  --min-reasoning <0..100>",
		"  --min-reliability <0..100>",
		"  --max-price <usd>             Max output price per 1M tokens",
		"  --min-context <n|nk|nm>",
		"  --max-context <n|nk|nm>",
	].join("\n");
}

export default function activeModelsExtension(pi: ExtensionAPI) {
	pi.registerCommand("active-models", {
		description: "List models from authenticated providers using capability profiles (intel/reasoning/context/reliability/cost/speed)",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args);
			if (parsed.help) {
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

			const registryModels = ctx.modelRegistry.getAll() as ModelLike[];
			const costHints = buildCostHintIndex(registryModels);
			let rows = registryModels
				.filter((m) => activeProviders.has(m.provider))
				.map((m): Row => {
					const p = buildModelProfile(m, costHints);
					const priceNorm = clamp(1 - Math.log1p(Math.max(0, p.effectivePrice)) / Math.log1p(50), 0, 1);
					const ctxNorm = clamp((Math.log2(Math.max(8_000, p.context)) - 13) / 7, 0, 1);
					const score = p.intel * 0.35 + p.reasoning * 0.2 + p.toolReliability * 0.25 + p.speed * 0.1 + priceNorm * 8 + ctxNorm * 8;
					return {
						provider: p.provider,
						model: p.model,
						intel: p.intel,
						reasoning: p.reasoning,
						reliability: p.toolReliability,
						speed: p.speed,
						score,
						priceInput: p.costIn,
						priceOutput: p.costOut,
						effectivePrice: p.effectivePrice,
						contextWindow: p.context,
						maxOut: Number(m.maxTokens ?? 0),
						images: p.supportsImages,
						priceEstimated: p.priceEstimated,
					};
				});

			if (parsed.providers.length > 0) rows = rows.filter((r) => parsed.providers.some((p) => r.provider.toLowerCase().includes(p)));
			if (parsed.grep) rows = rows.filter((r) => `${r.provider}/${r.model}`.toLowerCase().includes(parsed.grep));

			rows = rows.filter(
				(r) =>
					r.intel >= parsed.minIntel &&
					r.intel <= parsed.maxIntel &&
					r.reasoning >= parsed.minReasoning &&
					r.reliability >= parsed.minReliability &&
					r.priceOutput <= parsed.maxPrice &&
					r.contextWindow >= parsed.minContext &&
					r.contextWindow <= parsed.maxContext,
			);

			if (rows.length === 0) {
				const msg = "No active models matched your filters.";
				if (ctx.hasUI) ctx.ui.notify(msg, "warning");
				else console.log(msg);
				return;
			}

			rows.sort((a, b) => {
				let cmp = 0;
				switch (parsed.sortBy) {
					case "score":
						cmp = a.score - b.score;
						break;
					case "intelligence":
						cmp = a.intel - b.intel;
						break;
					case "reasoning":
						cmp = a.reasoning - b.reasoning;
						break;
					case "reliability":
						cmp = a.reliability - b.reliability;
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
				if (cmp === 0) cmp = a.model.localeCompare(b.model);
				return parsed.desc ? -cmp : cmp;
			});

			if (parsed.limit > 0) rows = rows.slice(0, parsed.limit);

			const data = rows.map((r) => ({
				provider: r.provider,
				model: r.model,
				intel: `${Math.round(r.intel)}`,
				reasoning: `${Math.round(r.reasoning)}`,
				reliability: `${Math.round(r.reliability)}`,
				speed: `${Math.round(r.speed)} tps`,
				price: `${formatMoney(r.priceInput)} / ${formatMoney(r.priceOutput)}${r.priceEstimated ? " ~" : ""}`,
				context: formatTokenCount(r.contextWindow),
				maxOut: formatTokenCount(r.maxOut),
				score: r.score.toFixed(1),
				images: r.images ? "yes" : "no",
			}));

			const cols = {
				provider: Math.max("provider".length, ...data.map((d) => d.provider.length)),
				model: Math.max("model".length, ...data.map((d) => d.model.length)),
				intel: Math.max("intel".length, ...data.map((d) => d.intel.length)),
				reasoning: Math.max("reason".length, ...data.map((d) => d.reasoning.length)),
				reliability: Math.max("reliab".length, ...data.map((d) => d.reliability.length)),
				speed: Math.max("speed".length, ...data.map((d) => d.speed.length)),
				price: Math.max("price (in/out per 1M)".length, ...data.map((d) => d.price.length)),
				context: Math.max("context".length, ...data.map((d) => d.context.length)),
				maxOut: Math.max("max-out".length, ...data.map((d) => d.maxOut.length)),
				score: Math.max("score".length, ...data.map((d) => d.score.length)),
				images: Math.max("images".length, ...data.map((d) => d.images.length)),
			};

			const header =
				pad("provider", cols.provider) +
				"  " +
				pad("model", cols.model) +
				"  " +
				pad("intel", cols.intel) +
				"  " +
				pad("reason", cols.reasoning) +
				"  " +
				pad("reliab", cols.reliability) +
				"  " +
				pad("speed", cols.speed) +
				"  " +
				pad("price (in/out per 1M)", cols.price) +
				"  " +
				pad("context", cols.context) +
				"  " +
				pad("max-out", cols.maxOut) +
				"  " +
				pad("score", cols.score) +
				"  " +
				pad("images", cols.images);

			const lines = data.map(
				(d) =>
					pad(d.provider, cols.provider) +
					"  " +
					pad(d.model, cols.model) +
					"  " +
					pad(d.intel, cols.intel) +
					"  " +
					pad(d.reasoning, cols.reasoning) +
					"  " +
					pad(d.reliability, cols.reliability) +
					"  " +
					pad(d.speed, cols.speed) +
					"  " +
					pad(d.price, cols.price) +
					"  " +
					pad(d.context, cols.context) +
					"  " +
					pad(d.maxOut, cols.maxOut) +
					"  " +
					pad(d.score, cols.score) +
					"  " +
					pad(d.images, cols.images),
			);

			const output = [
				"Columns: provider | model | intel | reason | reliab | speed | price(in/out per 1M) | context | max-out | score | images",
				"Price marker: '~' means estimated from other providers for the same model id", 
				header,
				"-".repeat(header.length),
				...lines,
			].join("\n");

			if (ctx.hasUI) ctx.ui.notify(output, "info");
			else console.log(output);
		},
	});
}
