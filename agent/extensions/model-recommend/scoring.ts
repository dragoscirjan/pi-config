import { clamp } from "./profiles";
import type { ScoredModel, Intent, RecommendConfig } from "./types";

export type CapabilityConstraints = {
	minIntel: number;
	minReasoning: number;
	minToolReliability: number;
	minContext: number;
	maxAffordablePrice: number;
};

function hashString(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = (hash << 5) - hash + str.charCodeAt(i);
		hash |= 0;
	}
	return Math.abs(hash);
}

export function deriveConstraints(intent: Intent, config: RecommendConfig): CapabilityConstraints {
	const n = intent.capabilityNeeds;
	const baseIntel = 35 + n.reasoningDepth * 40 + n.correctnessRisk * 15;
	return {
		minIntel: clamp(baseIntel, 0, 100),
		minReasoning: clamp(20 + n.reasoningDepth * 60, 0, 100),
		minToolReliability: clamp(10 + n.correctnessRisk * 70, 0, 100),
		minContext: Math.max(8000, Math.round(n.contextVolume * 100000)),
		maxAffordablePrice: n.costSensitivity > 0.8 ? 5 : 50
	};
}

export function scoreModel(model: ScoredModel, intent: Intent, config: RecommendConfig, constraints: CapabilityConstraints, relaxLevel: number): number {
	const n = intent.capabilityNeeds;
	const intelFit = clamp((model.intel - constraints.minIntel + 34) / 56, 0, 1);
	const reasoningFit = clamp((model.reasoning - constraints.minReasoning + 30) / 50, 0, 1);
	const relFit = clamp((model.toolReliability - constraints.minToolReliability + 34) / 56, 0, 1);
	const ctxFit = clamp((Math.log2(Math.max(8_000, model.context)) - Math.log2(constraints.minContext)) / 3 + 0.55, 0, 1);
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

export function applyCapabilityDeltaGuard(models: ScoredModel[], intent: Intent, config: RecommendConfig): ScoredModel[] {
	if (models.length === 0) return models;
	const guard = config.defaults.capabilityDeltaGuard ?? 0.12;
	const penalty = config.defaults.capabilityDeltaPenalty ?? 0.2;
	const minComp = config.defaults.capabilityDeltaMinComplexity ?? 55;
	if (intent.complexity < minComp) return models;
	
	const bestIntel = Math.max(...models.map(m => m.intel));
	return models.map(m => {
		if (bestIntel - m.intel > guard * 100) {
			m.score *= (1 - penalty);
			m.breakdown.reasons.push(`Capability delta guard: penalizing model due to high task complexity vs intelligence gap.`);
		}
		return m;
	});
}
