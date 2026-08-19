import { describe, expect, it } from 'vitest';
import { applyRules } from './rules.js';
import type { NormalizedModel, Rule } from './types.js';

const baseModel: NormalizedModel = {
  id: 'qwen2.5-coder:7b',
  displayName: 'Qwen 2.5 Coder 7B',
};

describe('applyRules', () => {
  it('keeps backward compatibility for global-only rules', () => {
    const rules: Rule[] = [
      {
        type: 'string',
        match: ':7b',
        options: { maxTokens: 8192 },
      },
    ];

    const result = applyRules(baseModel, rules);
    expect(result.maxTokens).toBe(8192);
    expect(result.contextWindow).toBe(128000);
    expect(result.reasoning).toBe(false);
  });

  it('applies provider-scoped rules only to matching provider key', () => {
    const rules: Rule[] = [
      {
        type: 'string',
        match: 'qwen',
        options: { contextWindow: 65536 },
      },
      {
        providerKey: 'studio-main',
        type: 'string',
        match: 'qwen',
        options: { contextWindow: 200000, reasoning: true },
      },
    ];

    const matchingProvider = applyRules(baseModel, rules, 'studio-main');
    const otherProvider = applyRules(baseModel, rules, 'studio-remote');

    expect(matchingProvider.contextWindow).toBe(200000);
    expect(matchingProvider.reasoning).toBe(true);

    expect(otherProvider.contextWindow).toBe(65536);
    expect(otherProvider.reasoning).toBe(false);
  });

  it('lets provider-scoped rules override global matches regardless of declaration order', () => {
    const rules: Rule[] = [
      {
        providerKey: 'ollama-lab',
        type: 'string',
        match: 'coder',
        options: { maxTokens: 4096 },
      },
      {
        type: 'string',
        match: 'coder',
        options: { maxTokens: 16384 },
      },
    ];

    const result = applyRules(baseModel, rules, 'ollama-lab');
    expect(result.maxTokens).toBe(4096);
  });

  it('does not re-apply global rules when providerKey is omitted', () => {
    const originalConsoleError = console.error;
    const errors: string[] = [];
    console.error = (message?: unknown) => {
      errors.push(String(message ?? ''));
    };

    try {
      const rules: Rule[] = [
        {
          type: 'regex',
          match: '(',
          options: { maxTokens: 8192 },
        },
      ];

      applyRules(baseModel, rules);
      expect(errors).toHaveLength(1);
    } finally {
      console.error = originalConsoleError;
    }
  });
});
