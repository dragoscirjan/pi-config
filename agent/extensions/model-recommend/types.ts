import type { ModelLike as RegistryModelLike } from "@mariozechner/pi-coding-agent";

export type ModelLike = RegistryModelLike & { maxTokens?: number };

export type ModelProfile = {
	provider: string;
	model: string;
	intel: number;
	reasoning: number;
	context: number;
	speed: number;
	toolReliability: number;
	costIn: number;
	costOut: number;
	effectivePrice: number;
	priceEstimated: boolean;
	supportsImages: boolean;
	isLocal: boolean;
};

export type CostHint = { input: number; output: number; count: number };
export type CostHintIndex = Map<string, CostHint>;

export type Taxonomy = {
	version: string;
	lastUpdated: string;
	categories: Record<string, { weight: number; concepts: Record<string, string[]> }>;
};

export type RecommendConfig = {
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

export type Intent = {
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
    previousTurnFailed?: boolean;
};

export type RecommendOptions = {
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
    failover?: boolean;
};

export type ScoreBreakdown = {
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

export type ScoredModel = ModelProfile & {
	score: number;
	breakdown: ScoreBreakdown;
};
