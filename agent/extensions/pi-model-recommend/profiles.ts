import type { BenchmarkStats } from './benchmarks';
import type { ModelLike, ModelProfile, CostHintIndex } from './types';

const LOCAL_PROVIDER_HINTS = [
  'ollama',
  'lmstudio',
  'llama.cpp',
  'llamacpp',
  'vllm',
  'local',
  'openwebui',
  'kobold',
  'jan',
];

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return hash;
}

export function isLocalModel(provider: string): boolean {
  const lower = provider.toLowerCase();
  if (lower === 'github-copilot') return false;
  return LOCAL_PROVIDER_HINTS.some((hint) => lower.includes(hint));
}

export function getModelSizeBillionHint(modelId: string): number {
  const lower = modelId.toLowerCase();
  const m = lower.match(/(?:^|[^0-9])(\d{1,4})(?:\.?\d+)?\s*b(?:[^a-z0-9]|$)/i);
  if (!m) return 0;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : 0;
}

export function estimateIntel(model: ModelLike, benchmark?: BenchmarkStats): number {
  if (benchmark?.editPassRate) {
    const normalized = 20 + (benchmark.editPassRate / 85) * 80;
    return clamp(Math.round(normalized), 5, 100);
  }
  const name = model.id.toLowerCase();
  const sizeB = getModelSizeBillionHint(model.id);
  let score = 44;
  if (model.reasoning) score += 16;
  if ((model.contextWindow ?? 0) >= 200_000) score += 11;
  else if ((model.contextWindow ?? 0) >= 128_000) score += 8;
  else if ((model.contextWindow ?? 0) >= 32_000) score += 4;
  if (sizeB >= 400) score += 26;
  else if (sizeB >= 200) score += 22;
  else if (sizeB >= 70) score += 16;
  else if (sizeB >= 30) score += 10;
  else if (sizeB >= 14) score += 6;
  else if (sizeB >= 8) score += 3;
  if (['mini', 'lite', 'flash', 'nano', 'small', 'tiny', '3b'].some((k) => name.includes(k))) score -= 9;
  if (['coder', 'code', 'instruct'].some((k) => name.includes(k))) score += 5;
  if (['reason', 'think', 'r1', 'o1', 'o3'].some((k) => name.includes(k))) score += 7;
  score += (hashString(`${model.provider}/${model.id}`) % 9) / 10;
  return clamp(Math.round(score), 22, 98);
}

export function estimateSpeed(model: ModelLike): number {
  const name = model.id.toLowerCase();
  const sizeB = getModelSizeBillionHint(model.id);
  let score = 55;
  if (['mini', 'lite', 'flash', 'nano', 'small', 'tiny', '8b', '3b'].some((k) => name.includes(k))) score += 36;
  if (sizeB >= 200) score -= 24;
  else if (sizeB >= 70) score -= 16;
  else if (sizeB >= 30) score -= 8;
  if (model.reasoning) score -= 10;
  if ((model.contextWindow ?? 0) >= 200_000) score -= 8;
  score += (hashString(`${model.id}/${model.provider}`) % 7) / 10;
  return clamp(Math.round(score), 12, 170);
}

export function estimateReasoning(model: ModelLike, intel: number, benchmark?: BenchmarkStats): number {
  if (benchmark?.refactorPassRate) {
    const normalized = 20 + (benchmark.refactorPassRate / 78) * 80;
    return clamp(Math.round(normalized), 5, 100);
  } else if (benchmark?.editPassRate && model.reasoning) {
    const normalized = 20 + (benchmark.editPassRate / 85) * 80;
    return clamp(Math.round(normalized), 5, 100);
  }
  const name = model.id.toLowerCase();
  let score = model.reasoning ? 55 : 35;
  if (['reason', 'think', 'r1', 'o1', 'o3', 'chain', 'deliberate'].some((k) => name.includes(k))) score += 20;
  if (['mini', 'flash', 'lite', 'nano'].some((k) => name.includes(k))) score -= 10;
  score += (intel - 50) * 0.2;
  return clamp(Math.round(score), 5, 100);
}

export function estimateToolReliability(
  model: ModelLike,
  intel: number,
  reasoning: number,
  benchmark?: BenchmarkStats,
): number {
  if (benchmark?.editPassRate) {
    const normalized = 20 + (benchmark.editPassRate / 85) * 80;
    return clamp(Math.round(normalized), 5, 100);
  }
  const name = model.id.toLowerCase();
  let score = 40;
  score += intel * 0.35;
  score += reasoning * 0.2;
  if ((model.contextWindow ?? 0) >= 128_000) score += 8;
  if (['instruct', 'chat', 'assistant', 'coder'].some((k) => name.includes(k))) score += 7;
  if (['preview', 'experimental', 'beta'].some((k) => name.includes(k))) score -= 6;
  if (isLocalModel(model.provider)) score -= 4;
  return clamp(Math.round(score), 10, 100);
}

function canonicalModelId(id: string): string {
  const lower = id.toLowerCase().trim();
  const parts = lower.split('/');
  const tail = parts.length > 1 ? parts[parts.length - 1] : lower;
  const tagMatch = tail.match(/:([^/]+)$/);
  if (!tagMatch || !tagMatch[1]) return tail;

  const tag = tagMatch[1];
  // Preserve size-bearing tags like ":7b" / ":70b" because they are model
  // identity, but strip mutable/runtime tags (e.g. ":latest", ":thinking").
  const looksLikeSizeTag = /^\d+(?:\.\d+)?b(?:-[a-z0-9._-]+)?$/i.test(tag);
  if (looksLikeSizeTag) return tail;
  return tail.slice(0, tail.length - tag.length - 1);
}

function addHint(index: CostHintIndex, key: string, input: number, output: number): void {
  if (!key) return;
  const prev = index.get(key);
  if (!prev) {
    index.set(key, { input, output, count: 1 });
    return;
  }
  const count = prev.count + 1;
  index.set(key, {
    input: (prev.input * prev.count + input) / count,
    output: (prev.output * prev.count + output) / count,
    count,
  });
}

export function buildCostHintIndex(models: ModelLike[]): CostHintIndex {
  const index: CostHintIndex = new Map();
  for (const model of models) {
    const input = Math.max(0, Number(model.cost?.input ?? 0));
    const output = Math.max(0, Number(model.cost?.output ?? 0));
    if (input <= 0 && output <= 0) continue;
    const exact = model.id.toLowerCase().trim();
    const canonical = canonicalModelId(model.id);
    addHint(index, exact, input, output);
    addHint(index, canonical, input, output);
  }
  return index;
}

function resolveCost(model: ModelLike, hints?: CostHintIndex): { input: number; output: number; estimated: boolean } {
  const nativeIn = Math.max(0, Number(model.cost?.input ?? 0));
  const nativeOut = Math.max(0, Number(model.cost?.output ?? 0));
  if (nativeIn > 0 || nativeOut > 0) return { input: nativeIn, output: nativeOut, estimated: false };
  if (!hints) return { input: nativeIn, output: nativeOut, estimated: false };
  const exact = hints.get(model.id.toLowerCase().trim());
  if (exact) return { input: exact.input, output: exact.output, estimated: true };
  const canonical = hints.get(canonicalModelId(model.id));
  if (canonical) return { input: canonical.input, output: canonical.output, estimated: true };
  return { input: nativeIn, output: nativeOut, estimated: false };
}

export function buildModelProfile(
  model: ModelLike,
  costHints?: CostHintIndex,
  benchmark?: BenchmarkStats,
): ModelProfile {
  const intel = estimateIntel(model, benchmark);
  const speed = estimateSpeed(model);
  const reasoning = estimateReasoning(model, intel, benchmark);
  const toolReliability = estimateToolReliability(model, intel, reasoning, benchmark);
  const cost = resolveCost(model, costHints);
  const costIn = cost.input;
  const costOut = cost.output;
  const effectivePrice = costOut + costIn * 0.35;
  return {
    provider: model.provider,
    model: model.id,
    intel,
    reasoning,
    context: Math.max(0, Number(model.contextWindow ?? 0)),
    speed,
    toolReliability,
    costIn,
    costOut,
    effectivePrice,
    priceEstimated: cost.estimated,
    supportsImages: (model.input ?? []).includes('image'),
    isLocal: isLocalModel(model.provider),
  };
}
