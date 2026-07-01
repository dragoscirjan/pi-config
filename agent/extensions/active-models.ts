import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ModelLike = {
	provider: string;
	id: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	cost?: {
		input?: number;
		output?: number;
	};
};

type ParsedArgs = {
	help: boolean;
	providers: string[];
	grep: string;
	limit: number;
	sortBy: "score" | "intelligence" | "speed" | "price" | "context";
	desc: boolean;
	minIntel: number;
	maxIntel: number;
	maxPrice: number;
	minContext: number;
	maxContext: number;
};

type Row = {
	provider: string;
	model: string;
	intel: number;
	speed: number;
	score: number;
	priceInput: number;
	priceOutput: number;
	contextWindow: number;
	maxOut: number;
	thinking: boolean;
	images: boolean;
};

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
		if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
			return t.slice(1, -1);
		}
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
		maxPrice: Number.POSITIVE_INFINITY,
		minContext: 0,
		maxContext: Number.POSITIVE_INFINITY,
	};

	const free: string[] = [];
	const tokens = tokenize(raw);

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		switch (t) {
			case "--help":
			case "-h":
				parsed.help = true;
				break;
			case "--provider":
			case "-p": {
				const v = tokens[++i];
				if (v) parsed.providers.push(v.toLowerCase());
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
				const normalized =
					v === "intel"
						? "intelligence"
						: v === "max-out"
							? "context"
							: v;
				if (["score", "intelligence", "speed", "price", "context"].includes(normalized)) {
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

	if (
		["llama-3.1-70b", "qwen2.5-72b", "deepseek-v2.5", "phi-4"].some((k) => name.includes(k)) &&
		!name.includes("mini")
	)
		return 80;

	if (
		[
			"haiku",
			"flash",
			"lite",
			"mini",
			"8b",
			"llama-3.1-8b",
			"phi-3",
			"nano",
			"nemotron",
		].some((k) => name.includes(k))
	)
		return 55;

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

			if (type === "api_key" && hasApiKey) providers.add(provider);
			else if (type === "oauth" && hasOAuthToken) providers.add(provider);
			else if (hasApiKey || hasOAuthToken) providers.add(provider);
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
		"  --provider, -p <name>     Filter by provider (repeatable)",
		"  --grep, -g <text>         Filter by text (provider/model)",
		"  --limit, -n <int>         Limit rows (0 = all)",
		"  --sort-by <field>         score|intelligence|speed|price|context [asc|desc]",
		"  --desc / --asc            Sort direction",
		"  --min-intel <0..100>",
		"  --max-intel <0..100>",
		"  --max-price <usd>         Max output price per 1M tokens",
		"  --min-context <n|nk|nm>",
		"  --max-context <n|nk|nm>",
		"",
		"Examples:",
		"  /active-models github",
		"  /active-models --provider openrouter --max-price 5 --sort-by price asc",
		"  /active-models --sort-by intelligence desc --limit 20",
	].join("\n");
}

export default function activeModelsExtension(pi: ExtensionAPI) {
	pi.registerCommand("active-models", {
		description: "List models from providers authenticated in agent/auth.json",
		getArgumentCompletions: (prefix) => {
			const opts = [
				"--provider ",
				"--grep ",
				"--limit ",
				"--sort-by ",
				"--desc",
				"--asc",
				"--min-intel ",
				"--max-intel ",
				"--max-price ",
				"--min-context ",
				"--max-context ",
				"--help",
			];
			const items = opts.filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o.trim() }));
			return items.length > 0 ? items : null;
		},
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
				ctx.ui.notify("No authenticated providers found in agent/auth.json", "info");
				return;
			}

			let rows = (ctx.modelRegistry.getAll() as ModelLike[])
				.filter((m) => activeProviders.has(m.provider))
				.map(
					(m): Row => {
						const intel = getIntelHeuristic(m.id);
						const speed = getSpeedHeuristic(m.id);
						const priceInput = Math.max(0, Number(m.cost?.input ?? 0));
						const priceOutput = Math.max(0, Number(m.cost?.output ?? 0));
						const contextWindow = Number(m.contextWindow ?? 0);
						const score = intel * 1.5 + Math.min(speed, 200) * 0.1 + Math.log2(Math.max(8000, contextWindow)) - priceOutput;
						return {
							provider: m.provider,
							model: m.id,
							intel,
							speed,
							score,
							priceInput,
							priceOutput,
							contextWindow,
							maxOut: Number(m.maxTokens ?? 0),
							thinking: Boolean(m.reasoning),
							images: Array.isArray(m.input) && m.input.includes("image"),
						};
					},
				);

			if (parsed.providers.length > 0) {
				rows = rows.filter((r) => parsed.providers.some((p) => r.provider.toLowerCase().includes(p)));
			}
			if (parsed.grep) {
				rows = rows.filter((r) => `${r.provider}/${r.model}`.toLowerCase().includes(parsed.grep));
			}

			rows = rows.filter(
				(r) =>
					r.intel >= parsed.minIntel &&
					r.intel <= parsed.maxIntel &&
					r.priceOutput <= parsed.maxPrice &&
					r.contextWindow >= parsed.minContext &&
					r.contextWindow <= parsed.maxContext,
			);

			if (rows.length === 0) {
				ctx.ui.notify("No active models matched your filters.", "info");
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
					case "speed":
						cmp = a.speed - b.speed;
						break;
					case "price":
						cmp = a.priceOutput - b.priceOutput;
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
				intel: `${Math.round(r.intel)
					.toString()
					.padStart(3, " ")}≈`,
				price: `${formatMoney(r.priceInput)} / ${formatMoney(r.priceOutput)}`,
				context: formatTokenCount(r.contextWindow),
				maxOut: formatTokenCount(r.maxOut),
				thinking: r.thinking ? "yes" : "no",
				images: r.images ? "yes" : "no",
			}));

			const cols = {
				provider: Math.max("provider".length, ...data.map((d) => d.provider.length)),
				model: Math.max("model".length, ...data.map((d) => d.model.length)),
				intel: Math.max("intel".length, ...data.map((d) => d.intel.length)),
				price: Math.max("price (in/out per 1M)".length, ...data.map((d) => d.price.length)),
				context: Math.max("context".length, ...data.map((d) => d.context.length)),
				maxOut: Math.max("max-out".length, ...data.map((d) => d.maxOut.length)),
				thinking: Math.max("thinking".length, ...data.map((d) => d.thinking.length)),
				images: Math.max("images".length, ...data.map((d) => d.images.length)),
			};

			const header =
				pad("provider", cols.provider) +
				"  " +
				pad("model", cols.model) +
				"  " +
				pad("intel", cols.intel) +
				"  " +
				pad("price (in/out per 1M)", cols.price) +
				"  " +
				pad("context", cols.context) +
				"  " +
				pad("max-out", cols.maxOut) +
				"  " +
				pad("thinking", cols.thinking) +
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
					pad(d.price, cols.price) +
					"  " +
					pad(d.context, cols.context) +
					"  " +
					pad(d.maxOut, cols.maxOut) +
					"  " +
					pad(d.thinking, cols.thinking) +
					"  " +
					pad(d.images, cols.images),
			);

			const output = [
				"Columns: provider | model | intel | price(in/out per 1M tokens) | context | max-out | thinking | images",
				"Intel source: ≈ heuristic",
				header,
				"-".repeat(header.length),
				...lines,
			].join("\n");

			if (ctx.hasUI) ctx.ui.notify(output, "info");
			else console.log(output);
		},
	});
}
