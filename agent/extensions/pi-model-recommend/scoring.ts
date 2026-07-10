import { clamp } from "./profiles";
import type { ScoredModel, Intent, RecommendConfig, CapabilityConstraints, StageAResult } from "./types";

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
	const minIntel = clamp(Math.round(36 + n.reasoningDepth * 36 + n.correctnessRisk * 22 + n.safetyCriticality * 14 + n.bestQualityBias * 10), 30, 99);
	const minReasoning = clamp(Math.round(18 + n.reasoningDepth * 56 + n.safetyCriticality * 12), 10, 98);
	const minToolReliability = clamp(Math.round(28 + n.correctnessRisk * 36 + n.systemBreadth * 24 + n.safetyCriticality * 10), 20, 99);
	const minContext = n.contextVolume >= 0.9 ? 512_000 : n.contextVolume >= 0.75 ? 256_000 : n.contextVolume >= 0.55 ? 128_000 : n.contextVolume >= 0.35 ? 64_000 : 16_000;
	const requireReasoning = n.reasoningDepth >= 0.76 || n.safetyCriticality >= 0.8;
	const maxAffordablePrice = clamp(18 - n.costSensitivity * 15, 1, 20);
	if (n.costSensitivity >= 0.9 && intent.complexity >= 60) {
		return { minIntel: Math.max(minIntel, config.defaults.minIntelForComplexCheap), minReasoning, minToolReliability, minContext, requireReasoning, maxAffordablePrice };
	}
	return {
		minIntel,
		minReasoning,
		minToolReliability,
		minContext,
		requireReasoning,
		maxAffordablePrice,
	};
}

export function relaxConstraints(base: CapabilityConstraints, level: number): CapabilityConstraints {
	if (level <= 0) return base;
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

export function modelSatisfiesConstraints(model: ScoredModel, c: CapabilityConstraints): boolean {
	return (
		model.intelligence >= c.minIntel &&
		model.reasoning >= c.minReasoning &&
		model.toolReliability >= c.minToolReliability &&
		model.contextWindow >= c.minContext &&
		(!c.requireReasoning || model.reasoning >= 70)
	);
}

export function selectStageAFeasible(models: ScoredModel[], intent: Intent, config: RecommendConfig): StageAResult {
	const base = deriveConstraints(intent, config);
	for (let level = 0; level <= 4; level++) {
		const constraints = relaxConstraints(base, level);
		const feasible = models.filter((m) => modelSatisfiesConstraints(m, constraints));
		if (feasible.length > 0) return { feasible, constraints, relaxLevel: level };
	}
	return { feasible: [...models], constraints: relaxConstraints(base, 4), relaxLevel: 4 };
}

export function scoreModel(model: ScoredModel, intent: Intent, config: RecommendConfig, constraints: CapabilityConstraints, relaxLevel: number): number {
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

export function applyCapabilityDeltaGuard(models: ScoredModel[], intent: Intent, config: RecommendConfig): ScoredModel[] {
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
