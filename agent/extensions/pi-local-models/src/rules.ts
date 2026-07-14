import { logWarn } from './log.js';
import type { NormalizedModel, ProviderModelConfig, Rule } from './types.js';

/** Pi's own documented built-in defaults, used only because the installed
 * `ProviderModelConfig` TypeScript interface requires these fields to be
 * concrete (non-optional) values. Kept in sync with Pi's documented
 * defaults (see pi.dev/docs/latest/models) so we never silently diverge
 * from what Pi would apply on our behalf if these were omitted. */
const PI_DEFAULT_CONTEXT_WINDOW = 128_000;
const PI_DEFAULT_MAX_TOKENS = 16_384;
const PI_DEFAULT_REASONING = false;
const PI_DEFAULT_INPUT: ('text' | 'image')[] = ['text'];
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Apply `rules[]` to a single discovered model.
 *
 * Precedence model:
 * 1) global rules (without `providerKey`) in declaration order
 * 2) provider-scoped rules (matching current `providerKey`) in declaration order
 *
 * Later matches override earlier matches and backend auto-detected values,
 * then Pi defaults are filled for any remaining unset fields.
 *
 * Match target is both `id` and `displayName` (OR match), regex is
 * case-insensitive.
 */
export function applyRules(model: NormalizedModel, rules: Rule[], providerKey?: string): ProviderModelConfig {
  let contextWindow = model.contextWindow;
  let maxTokens = model.maxTokens;
  let reasoning = model.reasoning;

  const normalizedProviderKey = typeof providerKey === 'string' ? providerKey.trim() : '';
  const hasScopedProvider = normalizedProviderKey.length > 0;

  const globalRules = rules.filter((rule) => !rule.providerKey);
  const scopedRules = hasScopedProvider
    ? rules.filter((rule) => typeof rule.providerKey === 'string' && rule.providerKey === normalizedProviderKey)
    : [];

  for (const rule of [...globalRules, ...scopedRules]) {
    if (!ruleMatches(rule, model)) continue;
    if (rule.options.contextWindow !== undefined) contextWindow = rule.options.contextWindow;
    if (rule.options.maxTokens !== undefined) maxTokens = rule.options.maxTokens;
    if (rule.options.reasoning !== undefined) reasoning = rule.options.reasoning;
  }

  return {
    id: model.id,
    name: model.displayName,
    reasoning: reasoning ?? PI_DEFAULT_REASONING,
    input: model.vision ? ['text', 'image'] : PI_DEFAULT_INPUT,
    cost: ZERO_COST,
    contextWindow: contextWindow ?? PI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: maxTokens ?? PI_DEFAULT_MAX_TOKENS,
  };
}

function ruleMatches(rule: Rule, model: NormalizedModel): boolean {
  if (rule.type === 'regex') {
    let re: RegExp;
    try {
      re = new RegExp(rule.match, 'i');
    } catch (error) {
      logWarn(`invalid regex rule '${rule.match}', skipping`, error);
      return false;
    }
    return re.test(model.id) || re.test(model.displayName);
  }
  return model.id.includes(rule.match) || model.displayName.includes(rule.match);
}
