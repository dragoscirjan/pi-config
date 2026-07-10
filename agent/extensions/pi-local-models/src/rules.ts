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
 * Apply the global `rules[]` list to a single discovered model, cascading
 * matches in array order (later rules override fields set by earlier ones
 * and by auto-detection), then fill in Pi's own defaults for any field
 * still unset. Rule overrides always win over auto-detected values, since
 * rules represent explicit user intent.
 *
 * Match target is both `id` and `displayName` (OR match), regex is
 * case-insensitive.
 */
export function applyRules(model: NormalizedModel, rules: Rule[]): ProviderModelConfig {
  let contextWindow = model.contextWindow;
  let maxTokens = model.maxTokens;
  let reasoning = model.reasoning;

  for (const rule of rules) {
    const matches = ruleMatches(rule, model);
    if (!matches) continue;
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
