import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ALL_LIVE_SOURCES,
  DEFAULT_CONFIG,
  createConfigSnapshot,
  createTaxonomySnapshot,
  resolveLiveSources,
  sanitizeLiveTerms,
} from './taxonomy';

async function loadTaxonomyWithTempAgentDir(tempAgentDir: string): Promise<typeof import('./taxonomy')> {
  vi.resetModules();
  vi.doMock('@mariozechner/pi-coding-agent', () => ({
    getAgentDir: () => tempAgentDir,
  }));
  return await import('./taxonomy');
}

describe('taxonomy', () => {
  it('create snapshots deep-clone mutable objects', () => {
    const tax = createTaxonomySnapshot();
    tax.categories.languages_frameworks.concepts.languages.push('nim');
    expect(createTaxonomySnapshot().categories.languages_frameworks.concepts.languages).not.toContain('nim');

    const cfg = createConfigSnapshot();
    cfg.aliases.custom = ['x'];
    expect(createConfigSnapshot().aliases.custom).toBeUndefined();
  });

  it('sanitizeLiveTerms normalizes and deduplicates terms', () => {
    const terms = sanitizeLiveTerms([' TypeScript ', 'typescript', '1234', 'A', 'Very$Valid/Term'], 10);
    expect(terms).toContain('typescript');
    expect(terms).toContain('very valid term');
    expect(terms).not.toContain('1234');
    expect(terms).not.toContain('a');
    expect(new Set(terms).size).toBe(terms.length);
  });

  it('resolveLiveSources supports all, explicit override, and fallback', () => {
    const all = resolveLiveSources(DEFAULT_CONFIG, 'all');
    expect(all).toEqual([...ALL_LIVE_SOURCES]);

    const subset = resolveLiveSources(DEFAULT_CONFIG, 'reddit,hackernews,unknown');
    expect(subset).toEqual(['reddit', 'hackernews']);

    const fallbackToAll = resolveLiveSources(DEFAULT_CONFIG, 'unknown');
    expect(fallbackToAll).toEqual([...ALL_LIVE_SOURCES]);
  });

  it('ensureRecommendConfig writes and merges config file in temp agent dir', async () => {
    const tempAgentDir = mkdtempSync(join(tmpdir(), 'pi-model-recommend-taxonomy-config-'));
    const taxonomy = await loadTaxonomyWithTempAgentDir(tempAgentDir);
    const first = taxonomy.ensureRecommendConfig();
    expect(first.version).toBe('1.0.0');

    const configPath = taxonomy.getConfigPath();
    const fs = await import('node:fs');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    parsed.aliases.added_alias = ['added'];
    delete parsed.router.learning;
    fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2));

    const merged = taxonomy.ensureRecommendConfig();
    expect(merged.aliases.added_alias).toEqual(['added']);
    expect(merged.router.learning).toBeDefined();
  });
});
