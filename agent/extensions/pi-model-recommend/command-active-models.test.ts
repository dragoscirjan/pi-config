import { describe, expect, it } from 'vitest';
import { applyLocalityFilter, isModelVisibleByProvider } from './command-active-models';

describe('active-models provider visibility', () => {
  it('includes local providers', () => {
    expect(isModelVisibleByProvider('lmstudio')).toBe(true);
  });

  it('includes custom provider keys for discovery', () => {
    expect(isModelVisibleByProvider('lmstud5o')).toBe(true);
  });

  it('includes commercial providers listed by registry', () => {
    expect(isModelVisibleByProvider('openai')).toBe(true);
    expect(isModelVisibleByProvider('anthropic')).toBe(true);
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
