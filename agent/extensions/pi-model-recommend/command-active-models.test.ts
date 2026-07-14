import { describe, expect, it } from 'vitest';
import { applyLocalityFilter, isModelVisibleByProvider } from './command-active-models';

describe('active-models provider visibility', () => {
  it('includes local providers even when not present in auth set', () => {
    const activeProviders = new Set<string>(['openai']);
    expect(isModelVisibleByProvider('lmstudio', activeProviders)).toBe(true);
  });

  it('includes commercial providers only when authenticated', () => {
    const activeProviders = new Set<string>(['openai']);
    expect(isModelVisibleByProvider('openai', activeProviders)).toBe(true);
    expect(isModelVisibleByProvider('anthropic', activeProviders)).toBe(false);
  });
});

describe('active-models locality filters', () => {
  const rows = [
    { model: 'm1', isLocal: true },
    { model: 'm2', isLocal: false },
    { model: 'm3', isLocal: true },
  ];

  it('returns all rows for locality=all', () => {
    expect(applyLocalityFilter(rows, 'all').map((r) => r.model)).toEqual(['m1', 'm2', 'm3']);
  });

  it('returns only local rows for locality=local', () => {
    expect(applyLocalityFilter(rows, 'local').map((r) => r.model)).toEqual(['m1', 'm3']);
  });

  it('returns only commercial rows for locality=commercial', () => {
    expect(applyLocalityFilter(rows, 'commercial').map((r) => r.model)).toEqual(['m2']);
  });
});
