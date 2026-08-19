import type { Api, Model } from '@earendil-works/pi-ai';

export type ModelLike = Model<Api>;

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
    autoMode: 'off' | 'suggest' | 'enforce';
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
  sortBy: 'score' | 'intelligence' | 'reasoning' | 'reliability' | 'speed' | 'price' | 'context';
  sortDir: 'asc' | 'desc';
  strategy: 'cheapest-capable' | 'capability-first' | 'local-first';
  localPrefer: boolean;
  localOnly: boolean;
  limit: number;
  help: boolean;
  explain: boolean;
  autoModeArg?: 'off' | 'suggest' | 'enforce';
  learningModeArg?: 'on' | 'off';
  status: boolean;
  resetLearning: boolean;
  exportTaxonomyPath?: string;
  importTaxonomyPath?: string;
  mergeTaxonomyPath?: string;
  mergePolicy: 'append' | 'replace' | 'keep';
  syncBenchmarks?: boolean;
  failover?: boolean;
};

export type TaxonomyState = {
  taxonomy: Taxonomy;
  rebuilt: boolean;
  enriched: boolean;
  liveSources: string[];
};

export type CapabilityConstraints = {
  minIntel: number;
  minReasoning: number;
  minToolReliability: number;
  minContext: number;
  requireReasoning: boolean;
  maxAffordablePrice: number;
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

export type ScoredModel = {
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

export type StageAResult = {
  feasible: ScoredModel[];
  constraints: CapabilityConstraints;
  relaxLevel: number;
};

export type RecommendationResult = {
  top: ScoredModel[];
  scored: ScoredModel[];
  stageA: StageAResult;
  intent: Intent;
  taxState: TaxonomyState;
};

export type ScoredModelLegacy = ModelProfile & {
  score: number;
  breakdown: ScoreBreakdown;
};
