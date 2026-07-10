import { describe, expect, it } from 'vitest';
import { analyzeIntent } from './intent';
import {
  applyCapabilityDeltaGuard,
  deriveConstraints,
  modelSatisfiesConstraints,
  relaxConstraints,
  scoreModel,
  selectStageAFeasible,
} from './scoring';
import { DEFAULT_CONFIG, DEFAULT_TAXONOMY } from './taxonomy';
import type { ScoredModel } from './types';

function baseModel(overrides: Partial<ScoredModel> = {}): ScoredModel {
  return {
    provider: 'openai',
    model: 'gpt-test',
    score: 0,
    intelligence: 80,
    reasoning: 78,
    toolReliability: 82,
    speed: 90,
    inputPrice: 1,
    outputPrice: 3,
    effectivePrice: 3.35,
    priceEstimated: false,
    contextWindow: 128_000,
    supportsImages: false,
    isLocal: false,
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
      reasons: [],
    },
    ...overrides,
  };
}

describe('scoring', () => {
  it('deriveConstraints and relaxConstraints produce bounded values', () => {
    const intent = analyzeIntent('secure architecture hld for auth and cloud', DEFAULT_TAXONOMY, DEFAULT_CONFIG);
    const constraints = deriveConstraints(intent, DEFAULT_CONFIG);
    const relaxed = relaxConstraints(constraints, 2);

    expect(constraints.minIntel).toBeGreaterThanOrEqual(30);
    expect(relaxed.minIntel).toBeLessThanOrEqual(constraints.minIntel);
    expect(relaxed.minContext).toBeLessThanOrEqual(constraints.minContext);
  });

  it('modelSatisfiesConstraints respects required reasoning', () => {
    const model = baseModel({ reasoning: 69 });
    expect(
      modelSatisfiesConstraints(model, {
        minIntel: 30,
        minReasoning: 10,
        minToolReliability: 20,
        minContext: 8_000,
        requireReasoning: true,
        maxAffordablePrice: 20,
      }),
    ).toBe(false);
  });

  it('selectStageAFeasible returns feasible set with relaxation fallback', () => {
    const intent = analyzeIntent('complex secure system design', DEFAULT_TAXONOMY, DEFAULT_CONFIG);
    const weak = baseModel({ intelligence: 20, reasoning: 20, toolReliability: 20, contextWindow: 8000 });
    const result = selectStageAFeasible([weak], intent, DEFAULT_CONFIG);
    expect(result.feasible.length).toBe(1);
    expect(result.relaxLevel).toBe(4);
  });

  it('scoreModel mutates breakdown and returns bounded score', () => {
    const intent = analyzeIntent('build typescript api with auth', DEFAULT_TAXONOMY, DEFAULT_CONFIG);
    const constraints = deriveConstraints(intent, DEFAULT_CONFIG);
    const model = baseModel();
    const score = scoreModel(model, intent, DEFAULT_CONFIG, constraints, 0);

    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(model.breakdown.reasons.length).toBeGreaterThan(0);
    expect(model.breakdown.final).toBeGreaterThanOrEqual(0);
  });

  it('applyCapabilityDeltaGuard penalizes lower-capability models on complex intents', () => {
    const intent = analyzeIntent(
      'secure distributed architecture with compliance and risk',
      DEFAULT_TAXONOMY,
      DEFAULT_CONFIG,
    );
    const high = baseModel({
      model: 'high',
      score: 90,
      breakdown: { ...baseModel().breakdown, weightedBase: 0.95, final: 90, reasons: [] },
    });
    const low = baseModel({
      model: 'low',
      score: 90,
      breakdown: { ...baseModel().breakdown, weightedBase: 0.3, final: 90, reasons: [] },
    });

    const out = applyCapabilityDeltaGuard([high, low], intent, DEFAULT_CONFIG);
    const penalized = out.find((m) => m.model === 'low')!;
    expect(penalized.score).toBeLessThan(90);
    expect(penalized.breakdown.reasons.some((r) => r.includes('capability-delta-guard'))).toBe(true);
  });
});
