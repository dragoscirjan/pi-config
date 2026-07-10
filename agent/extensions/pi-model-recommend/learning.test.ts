import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Intent, RecommendConfig, ScoredModel } from './types';

async function loadLearningWithTempAgentDir(tempAgentDir: string): Promise<typeof import('./learning')> {
  vi.resetModules();
  vi.doMock('@mariozechner/pi-coding-agent', () => ({
    getAgentDir: () => tempAgentDir,
  }));
  return await import('./learning');
}

function sampleIntent(): Intent {
  return {
    complexity: 60,
    domains: new Set(['reasoning']),
    matchedTaxonomyCategories: new Set(['architecture_design']),
    matchedTaxonomyConcepts: new Set(['design']),
    languages: new Set(['typescript']),
    capabilityNeeds: {
      reasoningDepth: 0.8,
      systemBreadth: 0.7,
      correctnessRisk: 0.6,
      contextVolume: 0.5,
      safetyCriticality: 0.6,
      latencySensitivity: 0.2,
      costSensitivity: 0.3,
      codingLikelihood: 0.6,
      designLikelihood: 0.7,
      bestQualityBias: 0.5,
    },
  };
}

function sampleModel(overrides: Partial<ScoredModel> = {}): ScoredModel {
  return {
    provider: 'openai',
    model: 'gpt-4.1',
    score: 70,
    intelligence: 85,
    reasoning: 80,
    toolReliability: 85,
    speed: 60,
    inputPrice: 2,
    outputPrice: 8,
    effectivePrice: 8.7,
    priceEstimated: false,
    contextWindow: 128_000,
    supportsImages: true,
    isLocal: false,
    breakdown: {
      normIntel: 0.8,
      normSpeed: 0.6,
      normPrice: 0.4,
      normContext: 0.9,
      weightedBase: 0.75,
      affinity: 0,
      tieJitter: 0,
      final: 70,
      weights: { intel: 1, speed: 1, price: 1, context: 1 },
      reasons: [],
    },
    ...overrides,
  };
}

const aggressiveLearningConfig = {
  router: {
    learning: {
      pairwiseStep: 2,
      alphaWarmupSamples: 1,
      maxAlpha: 0.9,
    },
  },
} as unknown as RecommendConfig;

describe('learning', () => {
  it('builds canonical keys consistently', async () => {
    const learning = await loadLearningWithTempAgentDir(
      mkdtempSync(join(tmpdir(), 'pi-model-recommend-learning-keys-')),
    );
    expect(learning.canonicalFamily('openai/gpt-4.1:thinking')).toBe('openaigpt-4.1');
    expect(learning.exactKey({ provider: 'OpenAI', model: 'gpt-4.1:thinking' })).toBe('openai::gpt-4.1');
    expect(learning.familyKey({ model: 'gpt-4.1:thinking' })).toBe('gpt-4.1');
    expect(learning.providerFamilyKey({ provider: 'OpenAI', model: 'gpt-4.1:thinking' })).toBe('openai::gpt-4.1');
  });

  it('stores training samples and reports stats', async () => {
    const learning = await loadLearningWithTempAgentDir(
      mkdtempSync(join(tmpdir(), 'pi-model-recommend-learning-samples-')),
    );
    learning.resetLearningStore();

    const selected = sampleModel();
    const offered = [selected, sampleModel({ provider: 'anthropic', model: 'claude-3.7' })];
    learning.persistTrainingSample('secure auth architecture', 'user-pick', sampleIntent(), selected, offered, 6.5);

    const stats = learning.getLearningStats();
    expect(stats.samples).toBe(1);
    expect(stats.weights).toBe(0);
  });

  it('learns pairwise weights and applies learned adjustment', async () => {
    const learning = await loadLearningWithTempAgentDir(
      mkdtempSync(join(tmpdir(), 'pi-model-recommend-learning-adjust-')),
    );
    learning.resetLearningStore();

    const selected = sampleModel();
    const rejected = sampleModel({
      provider: 'meta',
      model: 'llama-3.3',
      score: 68,
      breakdown: { ...sampleModel().breakdown, final: 68 },
    });
    const offered = [selected, rejected];

    learning.persistTrainingSample(
      'implement oauth with policy checks',
      'user-pick',
      sampleIntent(),
      selected,
      offered,
      4,
    );
    learning.trainPairwiseSelection(aggressiveLearningConfig, selected, offered);

    const adjusted = learning.applyLearnedAdjustments(
      [
        sampleModel({ score: 70, breakdown: { ...sampleModel().breakdown, final: 70, reasons: [] } }),
        sampleModel({
          provider: 'meta',
          model: 'llama-3.3',
          score: 70,
          breakdown: { ...sampleModel().breakdown, final: 70, reasons: [] },
        }),
      ],
      aggressiveLearningConfig,
    );

    const preferred = adjusted.find((m) => m.provider === 'openai')!;
    const nonPreferred = adjusted.find((m) => m.provider === 'meta')!;
    expect(preferred.score).toBeGreaterThan(nonPreferred.score);
    expect(preferred.breakdown.reasons.some((r) => r.includes('learned-bias'))).toBe(true);
  });
});
