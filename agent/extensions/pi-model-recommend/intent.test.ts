import { describe, expect, it } from 'vitest';
import { analyzeIntent, applyAliases, containsTerm, levenshteinDistance, normalizeText } from './intent';
import { DEFAULT_CONFIG, DEFAULT_TAXONOMY } from './taxonomy';

describe('intent', () => {
  it('normalizeText normalizes separators and punctuation', () => {
    expect(normalizeText('Hello_/World!!! C#')).toBe('hello world c#');
  });

  it('levenshteinDistance short-circuits beyond max distance', () => {
    expect(levenshteinDistance('kitten', 'sitting', 1)).toBe(2);
    expect(levenshteinDistance('auth', 'auth', 1)).toBe(0);
  });

  it('containsTerm supports fuzzy matching for longer tokens', () => {
    const text = normalizeText('Need secure authentication for api');
    const tokens = text.split(' ').filter(Boolean);
    expect(containsTerm(text, tokens, 'autentication')).toBe(true);
    expect(containsTerm(text, tokens, 'rb')).toBe(false);
  });

  it('applyAliases replaces configured aliases', () => {
    expect(applyAliases('Need HLD for authn', DEFAULT_CONFIG.aliases)).toContain('high level design');
    expect(applyAliases('Need HLD for authn', DEFAULT_CONFIG.aliases)).toContain('authentication');
  });

  it('analyzeIntent detects categories, languages, and complexity signals', () => {
    const intent = analyzeIntent(
      'Design HLD for secure authentication with AWS Cognito in TypeScript',
      DEFAULT_TAXONOMY,
      DEFAULT_CONFIG,
    );

    expect(intent.complexity).toBeGreaterThan(30);
    expect(intent.matchedTaxonomyCategories.has('auth_identity_security')).toBe(true);
    expect(intent.languages.has('typescript')).toBe(true);
    expect(intent.domains.has('reasoning')).toBe(true);
    expect(intent.capabilityNeeds.correctnessRisk).toBeGreaterThan(0.3);
  });
});
