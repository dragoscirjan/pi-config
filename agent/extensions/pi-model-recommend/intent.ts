import { clamp } from "./profiles";
import { LANGUAGE_HINTS } from "./taxonomy";
import type { Taxonomy, RecommendConfig, Intent } from "./types";

function normalizeText(text: string): string {
	return text.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

function applyAliases(text: string, aliases: Record<string, string[]>): string {
	let out = text;
	for (const [canonical, syns] of Object.entries(aliases)) {
		for (const s of syns) {
			const regex = new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
			out = out.replace(regex, canonical);
		}
	}
	return out;
}

function containsTerm(text: string, tokens: string[], term: string): boolean {
	if (term.includes(" ")) return text.includes(term.toLowerCase());
	return tokens.includes(term.toLowerCase());
}

function hasAny(text: string, tokens: string[], terms: string[]): boolean {
	return terms.some(t => containsTerm(text, tokens, t));
}

export function analyzeIntent(task: string, taxonomy: Taxonomy, config: RecommendConfig): Intent {
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

	return {
		complexity: clamp(taxonomySignal * 45 + structureSignal * 55, 0, 100),
		domains: matchedTaxonomyCategories,
		matchedTaxonomyCategories,
		matchedTaxonomyConcepts,
		languages,
		capabilityNeeds: {
			reasoningDepth: clamp((0.12 + taxonomySignal * 0.42 + structureSignal * 0.45 + architectureSignal * 0.28 + securitySignal * 0.26) * spread, 0, 1),
			systemBreadth: clamp((0.08 + structureSignal * 0.62 + cloudSignal * 0.28 + architectureSignal * 0.24) * spread, 0, 1),
			correctnessRisk: clamp((0.15 + algoSignal * 0.45 + securitySignal * 0.38 + safetyBias * 0.35) * spread, 0, 1),
			contextVolume: clamp((0.05 + structureSignal * 0.55 + cloudSignal * 0.22) * spread, 0, 1),
			safetyCriticality: safetyBias,
			latencySensitivity,
			costSensitivity,
			codingLikelihood: clamp((languages.size > 0 ? 0.85 : 0.1) + algoSignal * 0.3, 0, 1),
			designLikelihood: architectureSignal,
			bestQualityBias: bestBias
		}
	};
}
