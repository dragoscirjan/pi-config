import { clamp } from './profiles';
import { LANGUAGE_HINTS } from './taxonomy';
import type { Taxonomy, RecommendConfig, Intent } from './types';

export function normalizeText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[_/]+/g, ' ')
    .replace(/[^a-z0-9#+\.\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function levenshteinDistance(a: string, b: string, maxDistance = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

export function containsTerm(text: string, tokens: string[], term: string): boolean {
  const t = normalizeText(term);
  if (!t) return false;
  if (t.includes(' ')) {
    const re = new RegExp(`(^|\\s)${escapeRegExp(t)}($|\\s)`);
    if (re.test(text)) return true;
  }
  const isShort = t.length <= 3;
  if (tokens.includes(t)) return true;
  if (isShort) return false;

  for (const token of tokens) {
    if (token.length < 4) continue;
    const maxDist = token.length >= 8 ? 2 : 1;
    if (levenshteinDistance(token, t, maxDist) <= maxDist) return true;
  }
  return false;
}

export function hasAny(text: string, tokens: string[], words: string[]): boolean {
  return words.some((w) => containsTerm(text, tokens, w));
}

export function applyAliases(text: string, aliases: Record<string, string[]>): string {
  let out = ` ${normalizeText(text)} `;
  for (const [raw, replacements] of Object.entries(aliases)) {
    const source = normalizeText(raw);
    if (!source) continue;
    const re = new RegExp(`(^|\\s)${escapeRegExp(source)}(?=\\s|$)`, 'g');
    if (!re.test(out)) continue;
    out = out.replace(re, `$1${normalizeText(replacements[0] ?? source)}`);
  }
  return normalizeText(out);
}

export function analyzeIntent(task: string, taxonomy: Taxonomy, config: RecommendConfig): Intent {
  const text = normalizeText(applyAliases(task, config.aliases));
  const tokens = text.split(' ').filter(Boolean);
  const tokenCount = tokens.length;
  const clauseCount =
    (text.match(/[,:;()]/g)?.length ?? 0) + (text.match(/\b(and|with|across|plus|while|where|under)\b/g)?.length ?? 0);
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
        if (categoryName === 'external_signals') externalHits++;
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

  const costSensitivity = hasAny(text, tokens, [
    'cheap',
    'budget',
    'affordable',
    'low cost',
    'free',
    'minimum cost',
    'least expensive',
  ])
    ? 1
    : 0.3;
  const latencySensitivity = hasAny(text, tokens, ['fast', 'quick', 'latency', 'realtime', 'throughput', 'p99', 'p95'])
    ? 0.95
    : 0.25;
  const bestBias = hasAny(text, tokens, [
    'best',
    'top',
    'highest quality',
    'state of the art',
    'most capable',
    'most intelligent',
  ])
    ? 1
    : 0.2;
  const safetyBias = hasAny(text, tokens, ['safety', 'critical', 'secure', 'compliance', 'mission', 'threat', 'hazard'])
    ? 1
    : 0.15;

  const capabilityNeeds = {
    reasoningDepth: clamp(
      (0.12 + taxonomySignal * 0.42 + structureSignal * 0.45 + architectureSignal * 0.28 + securitySignal * 0.26) *
        spread,
      0,
      1,
    ),
    systemBreadth: clamp(
      (0.08 + structureSignal * 0.62 + cloudSignal * 0.28 + architectureSignal * 0.24) * spread,
      0,
      1,
    ),
    correctnessRisk: clamp((0.1 + securitySignal * 0.42 + safetyBias * 0.5 + architectureSignal * 0.22) * spread, 0, 1),
    contextVolume: clamp(
      (0.08 +
        structureSignal * 0.45 +
        cloudSignal * 0.3 +
        architectureSignal * 0.25 +
        (hasAny(text, tokens, ['large', 'huge', 'many', 'massive', 'multi', 'scale', 'millions']) ? 0.3 : 0)) *
        spread,
      0,
      1,
    ),
    safetyCriticality: clamp((0.06 + securitySignal * 0.42 + safetyBias * 0.55) * spread, 0, 1),
    latencySensitivity,
    costSensitivity,
    codingLikelihood: clamp(
      (0.15 + (languages.size > 0 ? 0.55 : 0) + algoSignal * 0.35 + gameSignal * 0.2) * spread,
      0,
      1,
    ),
    designLikelihood: clamp(
      (0.12 +
        architectureSignal * 0.5 +
        cloudSignal * 0.24 +
        securitySignal * 0.24 +
        (hasAny(text, tokens, ['design', 'architecture', 'hld', 'system']) ? 0.25 : 0)) *
        spread,
      0,
      1,
    ),
    bestQualityBias: bestBias,
  };

  const complexity = clamp(
    Math.round(
      8 +
        capabilityNeeds.reasoningDepth * 30 +
        capabilityNeeds.systemBreadth * 20 +
        capabilityNeeds.correctnessRisk * 22 +
        capabilityNeeds.contextVolume * 18 +
        capabilityNeeds.safetyCriticality * 12,
    ),
    1,
    100,
  );

  const domains = new Set<string>();
  if (capabilityNeeds.codingLikelihood >= 0.35) domains.add('coding');
  if (capabilityNeeds.reasoningDepth >= 0.45) domains.add('reasoning');
  if (gameSignal > 0) domains.add('creative');

  return {
    complexity,
    domains,
    matchedTaxonomyCategories,
    matchedTaxonomyConcepts,
    languages,
    capabilityNeeds,
  };
}
