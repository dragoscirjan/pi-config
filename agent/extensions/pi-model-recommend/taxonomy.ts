import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { getRouterDb } from './learning';
import { clamp } from './profiles';
import type { Taxonomy, RecommendConfig, TaxonomyState } from './types';

function normalizeText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[_/]+/g, ' ')
    .replace(/[^a-z0-9#+\.\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const TRUSTED_ORGS = new Set([
  'meta-llama',
  'mistralai',
  'google',
  'microsoft',
  'anthropic',
  'openai',
  'deepseek-ai',
  'qwen',
  'nousresearch',
  'nexusflow',
  'cohereforai',
  'gradientai',
  'nvidia',
  'apple',
  'unsloth',
  'bartowski',
  'mradermacher',
  'maziyarpanahi',
  'thebloke',
  'lonestriker',
  'm-a-p',
  'lmstudio-community',
]);

export const LANGUAGE_HINTS: Record<string, { aliases: string[]; rarity: number }> = {
  javascript: { aliases: ['javascript', 'js', 'node', 'nodejs'], rarity: 0.1 },
  typescript: { aliases: ['typescript', 'ts'], rarity: 0.2 },
  python: { aliases: ['python', 'py'], rarity: 0.1 },
  java: { aliases: ['java', 'spring', 'springboot', 'jdk'], rarity: 0.2 },
  go: { aliases: ['go', 'golang'], rarity: 0.25 },
  rust: { aliases: ['rust'], rarity: 0.45 },
  csharp: { aliases: ['c#', 'csharp', '.net', 'dotnet'], rarity: 0.25 },
  php: { aliases: ['php', 'laravel', 'symfony'], rarity: 0.25 },
  elixir: { aliases: ['elixir', 'elyxir', 'phoenix', 'beam'], rarity: 0.7 },
  scala: { aliases: ['scala', 'akka'], rarity: 0.7 },
  haskell: { aliases: ['haskell'], rarity: 0.8 },
  gdscript: { aliases: ['godot', 'gdscript'], rarity: 0.55 },
};

export const DEFAULT_CONFIG: RecommendConfig = {
  version: '1.0.0',
  lastUpdated: '',
  aliases: {
    elyxir: ['elixir'],
    authn: ['authentication'],
    authz: ['authorization'],
    arround: ['around'],
    jscript: ['javascript'],
    highlevel: ['high level'],
    hld: ['high level design'],
    quick_sort: ['quicksort'],
  },
  skillWeights: {
    algorithms: { intel: 0.4, speed: 0.3, price: 0.05, context: 0.15 },
    system_design: { intel: 0.5, speed: 0.05, price: 0.0, context: 0.45 },
    security_auth: { intel: 0.45, speed: 0.05, price: 0.0, context: 0.4 },
    cloud_aws: { intel: 0.35, speed: 0.05, price: 0.0, context: 0.5 },
    game_dev: { intel: 0.25, speed: 0.2, price: 0.05, context: 0.5 },
    performance: { intel: 0.15, speed: 0.6, price: 0.05, context: 0.2 },
  },
  liveTaxonomy: {
    enabledSources: ['all'],
    maxTermsPerSource: 180,
    requestTimeoutMs: 4500,
    externalCategoryWeight: 0.2,
    sourceWeights: {
      stack_overflow: 1,
      stackexchange_network: 0.9,
      github_topics: 0.95,
      github_trending: 0.9,
      reddit: 0.7,
      hackernews: 0.85,
      lobsters: 0.75,
      npm: 0.8,
      pypi: 0.8,
      crates: 0.8,
      maven: 0.75,
      awesome_lists: 0.7,
      arxiv: 0.8,
      cloud_changelogs: 0.9,
      cncf_landscape: 0.85,
      job_boards: 0.6,
      google_trends: 0.65,
      gdelt: 0.6,
    },
  },
  router: {
    autoMode: 'off',
    learnEnabled: true,
    minMarginForAutoPick: 6,
    askOutcomeFeedback: false,
    learning: {
      maxAlpha: 0.45,
      alphaWarmupSamples: 200,
      pairwiseStep: 1,
    },
  },
  defaults: {
    minIntelForComplexCheap: 72,
    cheapWeightCap: 1.9,
    freeModelBonusCap: 1.08,
    tieJitterMax: 0.35,
    intentSpread: 1.35,
    externalSignalInferenceWeight: 0.25,
    capabilityDeltaGuard: 0.12,
    capabilityDeltaPenalty: 0.2,
    capabilityDeltaMinComplexity: 55,
  },
};

export const DEFAULT_TAXONOMY: Taxonomy = {
  version: '2.0.0',
  lastUpdated: '',
  categories: {
    algorithms_data_structures: {
      weight: 1.15,
      concepts: {
        sorting: ['quicksort', 'mergesort', 'heapsort', 'radix sort', 'topological sort'],
        graph: ['dijkstra', 'a*', 'toposort', 'mst', 'floyd-warshall'],
        trees: ['segment tree', 'fenwick', 'hld', 'heavy light decomposition', 'trie', 'suffix tree'],
      },
    },
    architecture_design: {
      weight: 1.2,
      concepts: {
        design: ['hld', 'high level design', 'architecture', 'tradeoff', 'scalability', 'distributed'],
        patterns: ['ddd', 'cqrs', 'event sourcing', 'saga', 'clean architecture', 'hexagonal'],
      },
    },
    auth_identity_security: {
      weight: 1.2,
      concepts: {
        auth: ['authentication', 'authorization', 'rbac', 'abac', 'oauth2', 'oidc', 'jwt', 'mfa'],
        platforms: ['aws cognito', 'cognito', 'auth0', 'keycloak', 'iam'],
        appsec: ['xss', 'csrf', 'ssrf', 'sqli', 'owasp', 'threat model'],
      },
    },
    cloud_infrastructure: {
      weight: 1.05,
      concepts: {
        aws: ['aws', 'lambda', 'dynamodb', 's3', 'cloudfront', 'eventbridge', 'eks', 'rds'],
        devops: ['kubernetes', 'docker', 'terraform', 'pulumi', 'github actions', 'ci/cd'],
      },
    },
    languages_frameworks: {
      weight: 1,
      concepts: {
        languages: [
          'javascript',
          'typescript',
          'python',
          'java',
          'go',
          'rust',
          'elixir',
          'scala',
          'haskell',
          'c#',
          'php',
        ],
        frameworks: ['react', 'vue', 'angular', 'fastapi', 'spring', 'phoenix', 'laravel'],
      },
    },
    game_development: {
      weight: 1.1,
      concepts: {
        engines: ['godot', 'gdscript', 'unity', 'unreal'],
        design: ['card game', 'turn based', 'state machine', 'game loop', 'multiplayer'],
      },
    },
  },
};

export function getTaxonomyPath(): string {
  return join(process.env.HOME ?? '', '.pi', 'model-taxonomy.json');
}

export function getConfigPath(): string {
  return join(getAgentDir(), 'model-recommend-config.json');
}

export function createTaxonomySnapshot(): Taxonomy {
  return {
    ...DEFAULT_TAXONOMY,
    lastUpdated: new Date().toISOString(),
    categories: JSON.parse(JSON.stringify(DEFAULT_TAXONOMY.categories)) as Taxonomy['categories'],
  };
}

export function createConfigSnapshot(): RecommendConfig {
  return {
    ...DEFAULT_CONFIG,
    lastUpdated: new Date().toISOString(),
    aliases: JSON.parse(JSON.stringify(DEFAULT_CONFIG.aliases)) as RecommendConfig['aliases'],
    skillWeights: JSON.parse(JSON.stringify(DEFAULT_CONFIG.skillWeights)) as RecommendConfig['skillWeights'],
    liveTaxonomy: JSON.parse(JSON.stringify(DEFAULT_CONFIG.liveTaxonomy)) as RecommendConfig['liveTaxonomy'],
    router: JSON.parse(JSON.stringify(DEFAULT_CONFIG.router)) as RecommendConfig['router'],
    defaults: JSON.parse(JSON.stringify(DEFAULT_CONFIG.defaults)) as RecommendConfig['defaults'],
  };
}

export const ALL_LIVE_SOURCES = [
  'stack_overflow',
  'stackexchange_network',
  'github_topics',
  'github_trending',
  'reddit',
  'hackernews',
  'lobsters',
  'npm',
  'pypi',
  'crates',
  'maven',
  'awesome_lists',
  'arxiv',
  'cloud_changelogs',
  'cncf_landscape',
  'job_boards',
  'google_trends',
  'gdelt',
] as const;

export type LiveSource = (typeof ALL_LIVE_SOURCES)[number];
type LiveSourceContext = { timeoutMs: number; maxTerms: number };
type LiveFetcher = (ctx: LiveSourceContext) => Promise<string[]>;

export function sanitizeLiveTerms(values: string[], maxTerms = 150): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || normalized.length < 2 || normalized.length > 48) continue;
    if (/^\d+$/.test(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= maxTerms) break;
  }
  return out;
}

function parseRssTitles(xml: string): string[] {
  const cdataTitles = [...xml.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/gis)].map((m) => m[1]);
  const plainTitles = [...xml.matchAll(/<title>(.*?)<\/title>/gis)].map((m) => m[1]);
  return [...cdataTitles, ...plainTitles]
    .map((t) =>
      t
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .trim(),
    )
    .filter(Boolean);
}

async function fetchJson(url: string, headers?: Record<string, string>, timeoutMs = 4000): Promise<any | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, headers?: Record<string, string>, timeoutMs = 4000): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.text();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchStackOverflowTags(ctx: LiveSourceContext): Promise<string[]> {
  const tags: string[] = [];
  for (let page = 1; page <= 2; page++) {
    const url = `https://api.stackexchange.com/2.3/tags?page=${page}&pagesize=100&order=desc&sort=popular&site=stackoverflow`;
    const json = await fetchJson(url, undefined, ctx.timeoutMs);
    if (!json?.items || !Array.isArray(json.items)) break;
    for (const item of json.items) if (typeof item?.name === 'string') tags.push(item.name);
  }
  return sanitizeLiveTerms(tags, ctx.maxTerms);
}

async function fetchStackExchangeNetworkTags(ctx: LiveSourceContext): Promise<string[]> {
  const terms: string[] = [];
  const sites = ['serverfault', 'superuser', 'datascience', 'devops'];
  for (const site of sites) {
    const url = `https://api.stackexchange.com/2.3/tags?page=1&pagesize=60&order=desc&sort=popular&site=${site}`;
    const json = await fetchJson(url, undefined, ctx.timeoutMs);
    if (!json?.items || !Array.isArray(json.items)) continue;
    for (const item of json.items) if (typeof item?.name === 'string') terms.push(item.name);
  }
  return sanitizeLiveTerms(terms, ctx.maxTerms);
}

async function fetchGithubTopics(ctx: LiveSourceContext): Promise<string[]> {
  const url = 'https://api.github.com/search/repositories?q=stars:>5000&sort=updated&order=desc&per_page=100';
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'pi-model-recommend-taxonomy' };
  const json = await fetchJson(url, headers, ctx.timeoutMs);
  if (!json?.items || !Array.isArray(json.items)) return [];
  const topics: string[] = [];
  for (const repo of json.items) {
    for (const topic of repo?.topics ?? []) if (typeof topic === 'string') topics.push(topic);
  }
  return sanitizeLiveTerms(topics, ctx.maxTerms);
}

async function fetchGithubTrending(ctx: LiveSourceContext): Promise<string[]> {
  const html = await fetchText(
    'https://github.com/trending?since=daily',
    { 'User-Agent': 'pi-model-recommend-taxonomy' },
    ctx.timeoutMs,
  );
  if (!html) return [];
  const repos = [...html.matchAll(/href="\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
  return sanitizeLiveTerms(repos, ctx.maxTerms);
}

async function fetchReddit(ctx: LiveSourceContext): Promise<string[]> {
  const subs = ['programming', 'webdev', 'MachineLearning', 'devops'];
  const terms: string[] = [];
  for (const sub of subs) {
    const url = `https://www.reddit.com/r/${sub}/hot.json?limit=40`;
    const json = await fetchJson(url, { 'User-Agent': 'pi-model-recommend-taxonomy' }, ctx.timeoutMs);
    for (const child of json?.data?.children ?? []) {
      const title = child?.data?.title;
      if (typeof title === 'string') terms.push(title);
    }
  }
  return sanitizeLiveTerms(terms, ctx.maxTerms);
}

async function fetchHackerNews(ctx: LiveSourceContext): Promise<string[]> {
  const url = 'https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=100';
  const json = await fetchJson(url, undefined, ctx.timeoutMs);
  const terms = (json?.hits ?? []).map((h: any) => h?.title).filter((t: any) => typeof t === 'string') as string[];
  return sanitizeLiveTerms(terms, ctx.maxTerms);
}

async function fetchLobsters(ctx: LiveSourceContext): Promise<string[]> {
  const xml = await fetchText('https://lobste.rs/rss', undefined, ctx.timeoutMs);
  if (!xml) return [];
  return sanitizeLiveTerms(parseRssTitles(xml), ctx.maxTerms);
}

async function fetchNpm(ctx: LiveSourceContext): Promise<string[]> {
  const url = 'https://registry.npmjs.org/-/v1/search?text=keywords:typescript+OR+keywords:javascript&size=100';
  const json = await fetchJson(url, undefined, ctx.timeoutMs);
  const terms: string[] = [];
  for (const obj of json?.objects ?? []) {
    const pkg = obj?.package;
    if (typeof pkg?.name === 'string') terms.push(pkg.name);
    if (Array.isArray(pkg?.keywords)) terms.push(...pkg.keywords.filter((k: any) => typeof k === 'string'));
  }
  return sanitizeLiveTerms(terms, ctx.maxTerms);
}

async function fetchPypi(ctx: LiveSourceContext): Promise<string[]> {
  const url = 'https://hugovk.github.io/top-pypi-packages/top-pypi-packages-30-days.min.json';
  const json = await fetchJson(url, undefined, ctx.timeoutMs);
  const terms = (json?.rows ?? []).map((r: any) => r?.project).filter((t: any) => typeof t === 'string') as string[];
  return sanitizeLiveTerms(terms, ctx.maxTerms);
}

async function fetchCrates(ctx: LiveSourceContext): Promise<string[]> {
  const url = 'https://crates.io/api/v1/crates?page=1&per_page=100&sort=downloads';
  const json = await fetchJson(url, undefined, ctx.timeoutMs);
  const terms: string[] = [];
  for (const c of json?.crates ?? []) {
    if (typeof c?.name === 'string') terms.push(c.name);
    if (Array.isArray(c?.keywords)) terms.push(...c.keywords.filter((k: any) => typeof k === 'string'));
  }
  return sanitizeLiveTerms(terms, ctx.maxTerms);
}

async function fetchMaven(ctx: LiveSourceContext): Promise<string[]> {
  const url = 'https://search.maven.org/solrsearch/select?q=*:*&rows=100&wt=json';
  const json = await fetchJson(url, undefined, ctx.timeoutMs);
  const terms: string[] = [];
  for (const d of json?.response?.docs ?? []) {
    if (typeof d?.a === 'string') terms.push(d.a);
    if (typeof d?.g === 'string') terms.push(d.g);
  }
  return sanitizeLiveTerms(terms, ctx.maxTerms);
}

async function fetchAwesomeLists(ctx: LiveSourceContext): Promise<string[]> {
  const url = 'https://raw.githubusercontent.com/sindresorhus/awesome/main/readme.md';
  const text = await fetchText(url, undefined, ctx.timeoutMs);
  if (!text) return [];
  const terms = [...text.matchAll(/^\s*[-*]\s+\[([^\]]+)\]/gm)].map((m) => m[1]);
  return sanitizeLiveTerms(terms, ctx.maxTerms);
}

async function fetchArxiv(ctx: LiveSourceContext): Promise<string[]> {
  const url =
    'https://export.arxiv.org/api/query?search_query=cat:cs.LG+OR+cat:cs.SE+OR+cat:cs.DC&start=0&max_results=80';
  const xml = await fetchText(url, undefined, ctx.timeoutMs);
  if (!xml) return [];
  const titles = [...xml.matchAll(/<title>(.*?)<\/title>/gis)].map((m) => m[1]);
  return sanitizeLiveTerms(titles, ctx.maxTerms);
}

async function fetchCloudChangelogs(ctx: LiveSourceContext): Promise<string[]> {
  const urls = [
    'https://aws.amazon.com/about-aws/whats-new/recent/feed/',
    'https://cloud.google.com/feeds/release-notes.xml',
    'https://azurecomcdn.azureedge.net/en-us/updates/feed/',
  ];
  const terms: string[] = [];
  for (const url of urls) {
    const xml = await fetchText(url, undefined, ctx.timeoutMs);
    if (!xml) continue;
    terms.push(...parseRssTitles(xml));
  }
  return sanitizeLiveTerms(terms, ctx.maxTerms);
}

async function fetchCNCFLandscape(ctx: LiveSourceContext): Promise<string[]> {
  const url = 'https://raw.githubusercontent.com/cncf/landscape/master/landscape.yml';
  const text = await fetchText(url, undefined, ctx.timeoutMs);
  if (!text) return [];
  const names = [...text.matchAll(/^\s*name:\s*['"]?([^'"\n]+)['"]?/gm)].map((m) => m[1]);
  return sanitizeLiveTerms(names, ctx.maxTerms);
}

async function fetchJobBoards(ctx: LiveSourceContext): Promise<string[]> {
  const json = await fetchJson(
    'https://remoteok.com/api',
    { 'User-Agent': 'pi-model-recommend-taxonomy' },
    ctx.timeoutMs,
  );
  const terms: string[] = [];
  if (Array.isArray(json)) {
    for (const job of json.slice(0, 120)) {
      if (typeof job?.position === 'string') terms.push(job.position);
      if (Array.isArray(job?.tags)) terms.push(...job.tags.filter((t: any) => typeof t === 'string'));
    }
  }
  return sanitizeLiveTerms(terms, ctx.maxTerms);
}

async function fetchGoogleTrends(ctx: LiveSourceContext): Promise<string[]> {
  const rssUrl = 'https://trends.google.com/trends/trendingsearches/daily/rss?geo=US';
  const xml = await fetchText(rssUrl, { 'User-Agent': 'pi-model-recommend-taxonomy' }, ctx.timeoutMs);
  if (!xml) return [];
  const titles = parseRssTitles(xml).filter((t) => !/daily search trends/i.test(t));
  return sanitizeLiveTerms(titles, ctx.maxTerms);
}

async function fetchGdelt(ctx: LiveSourceContext): Promise<string[]> {
  const url =
    'https://api.gdeltproject.org/api/v2/doc/doc?query=technology%20OR%20software&mode=ArtList&format=json&maxrecords=100&sort=datedesc';
  const json = await fetchJson(url, undefined, ctx.timeoutMs);
  const terms = (json?.articles ?? []).map((a: any) => a?.title).filter((t: any) => typeof t === 'string') as string[];
  return sanitizeLiveTerms(terms, ctx.maxTerms);
}

const LIVE_FETCHERS: Record<LiveSource, LiveFetcher> = {
  stack_overflow: fetchStackOverflowTags,
  stackexchange_network: fetchStackExchangeNetworkTags,
  github_topics: fetchGithubTopics,
  github_trending: fetchGithubTrending,
  reddit: fetchReddit,
  hackernews: fetchHackerNews,
  lobsters: fetchLobsters,
  npm: fetchNpm,
  pypi: fetchPypi,
  crates: fetchCrates,
  maven: fetchMaven,
  awesome_lists: fetchAwesomeLists,
  arxiv: fetchArxiv,
  cloud_changelogs: fetchCloudChangelogs,
  cncf_landscape: fetchCNCFLandscape,
  job_boards: fetchJobBoards,
  google_trends: fetchGoogleTrends,
  gdelt: fetchGdelt,
};

export function resolveLiveSources(config: RecommendConfig, override?: string): LiveSource[] {
  const raw = (override ?? '').trim();
  const fromConfig = config.liveTaxonomy.enabledSources ?? ['all'];
  const sourceList =
    raw.length > 0
      ? raw
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : fromConfig;
  if (sourceList.includes('all')) return [...ALL_LIVE_SOURCES];
  const known = new Set<LiveSource>(ALL_LIVE_SOURCES);
  const resolved = sourceList.filter((s): s is LiveSource => known.has(s as LiveSource));
  return resolved.length > 0 ? resolved : [...ALL_LIVE_SOURCES];
}

export async function enrichTaxonomyWithLiveSignals(
  taxonomy: Taxonomy,
  config: RecommendConfig,
  sourceOverride?: string,
): Promise<{ taxonomy: Taxonomy; liveSources: string[]; enriched: boolean }> {
  const selectedSources = resolveLiveSources(config, sourceOverride);
  const copy = JSON.parse(JSON.stringify(taxonomy)) as Taxonomy;
  if (!copy.categories.external_signals) {
    copy.categories.external_signals = { weight: config.liveTaxonomy.externalCategoryWeight, concepts: {} };
  }
  copy.categories.external_signals.weight = config.liveTaxonomy.externalCategoryWeight;

  const ctx: LiveSourceContext = {
    timeoutMs: config.liveTaxonomy.requestTimeoutMs,
    maxTerms: config.liveTaxonomy.maxTermsPerSource,
  };
  const results = await Promise.all(
    selectedSources.map(async (source) => {
      const weight = Number(config.liveTaxonomy.sourceWeights[source] ?? 1);
      const sourceCap = clamp(Math.round(ctx.maxTerms * clamp(weight, 0.2, 1.5)), 30, ctx.maxTerms);
      const terms = await LIVE_FETCHERS[source](ctx);
      return { source, terms: sanitizeLiveTerms(terms, sourceCap) };
    }),
  );

  const liveSources: string[] = [];
  for (const result of results) {
    if (result.terms.length === 0) continue;
    copy.categories.external_signals.concepts[result.source] = result.terms;
    liveSources.push(`${result.source}:${result.terms.length}`);
  }

  copy.lastUpdated = new Date().toISOString();
  return { taxonomy: copy, liveSources, enriched: liveSources.length > 0 };
}

function isTaxonomyEmptyInDb(): boolean {
  const row = getRouterDb().prepare('SELECT COUNT(*) AS c FROM router_taxonomy_categories').get() as
    { c?: number } | undefined;
  return Number(row?.c ?? 0) === 0;
}

export function writeTaxonomyToDb(taxonomy: Taxonomy): void {
  const db = getRouterDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM router_taxonomy_terms').run();
    db.prepare('DELETE FROM router_taxonomy_categories').run();
    const insertCategory = db.prepare('INSERT INTO router_taxonomy_categories(name, weight) VALUES(?, ?)');
    const insertTerm = db.prepare(
      'INSERT INTO router_taxonomy_terms(category_name, concept_name, term) VALUES(?, ?, ?)',
    );
    for (const [categoryName, category] of Object.entries(taxonomy.categories ?? {})) {
      insertCategory.run(categoryName, Number(category.weight ?? 1));
      for (const [conceptName, terms] of Object.entries(category.concepts ?? {})) {
        for (const term of terms ?? []) {
          const normalized = normalizeText(term);
          if (!normalized) continue;
          insertTerm.run(categoryName, conceptName, normalized);
        }
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function readTaxonomyFromDb(): Taxonomy {
  const db = getRouterDb();
  const categoriesRows = db
    .prepare('SELECT name, weight FROM router_taxonomy_categories ORDER BY name')
    .all() as Array<{ name: string; weight: number }>;
  const termRows = db
    .prepare(
      'SELECT category_name, concept_name, term FROM router_taxonomy_terms ORDER BY category_name, concept_name, term',
    )
    .all() as Array<{ category_name: string; concept_name: string; term: string }>;
  const categories: Taxonomy['categories'] = {};
  for (const row of categoriesRows) categories[row.name] = { weight: Number(row.weight ?? 1), concepts: {} };
  for (const row of termRows) {
    if (!categories[row.category_name]) categories[row.category_name] = { weight: 1, concepts: {} };
    if (!categories[row.category_name].concepts[row.concept_name])
      categories[row.category_name].concepts[row.concept_name] = [];
    categories[row.category_name].concepts[row.concept_name].push(row.term);
  }
  return { version: DEFAULT_TAXONOMY.version, lastUpdated: new Date().toISOString(), categories };
}

function loadLegacyTaxonomyFromJsonIfPresent(): Taxonomy | undefined {
  const legacyPath = getTaxonomyPath();
  if (!existsSync(legacyPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(legacyPath, 'utf-8')) as Taxonomy;
    if (parsed?.categories && typeof parsed.categories === 'object') return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

function ensureTaxonomySeeded(): { rebuilt: boolean } {
  if (!isTaxonomyEmptyInDb()) return { rebuilt: false };
  const legacy = loadLegacyTaxonomyFromJsonIfPresent();
  const seed = legacy ?? createTaxonomySnapshot();
  writeTaxonomyToDb(seed);
  return { rebuilt: true };
}

export async function ensureTaxonomy(
  rebuild: boolean,
  liveTaxonomy: boolean,
  config: RecommendConfig,
  liveSourceOverride?: string,
): Promise<TaxonomyState> {
  let rebuilt = false;
  if (rebuild) {
    writeTaxonomyToDb(createTaxonomySnapshot());
    rebuilt = true;
  } else {
    const seedState = ensureTaxonomySeeded();
    rebuilt = seedState.rebuilt;
  }

  let taxonomy = readTaxonomyFromDb();
  const shouldLiveEnrich = liveTaxonomy || rebuild || process.env.PI_MODEL_RECOMMEND_LIVE_TAXONOMY === '1';
  if (shouldLiveEnrich) {
    const enriched = await enrichTaxonomyWithLiveSignals(taxonomy, config, liveSourceOverride);
    taxonomy = enriched.taxonomy;
    writeTaxonomyToDb(taxonomy);
    return { taxonomy, rebuilt, enriched: enriched.enriched, liveSources: enriched.liveSources };
  }

  return { taxonomy, rebuilt, enriched: false, liveSources: [] };
}

function taxonomyStats(taxonomy: Taxonomy): { categories: number; concepts: number; terms: number } {
  let concepts = 0;
  let terms = 0;
  for (const category of Object.values(taxonomy.categories)) {
    concepts += Object.keys(category.concepts ?? {}).length;
    for (const conceptTerms of Object.values(category.concepts ?? {})) terms += conceptTerms.length;
  }
  return { categories: Object.keys(taxonomy.categories).length, concepts, terms };
}

function parseTaxonomyFromPath(path: string): Taxonomy {
  const inPath = path.trim();
  if (!inPath) throw new Error('Missing taxonomy path');
  const raw = readFileSync(inPath, 'utf-8');
  const parsed = JSON.parse(raw) as Taxonomy;
  if (!parsed?.categories || typeof parsed.categories !== 'object')
    throw new Error('Invalid taxonomy JSON: missing categories object');
  const normalized: Taxonomy = {
    version: parsed.version ?? DEFAULT_TAXONOMY.version,
    lastUpdated: new Date().toISOString(),
    categories: {},
  };
  for (const [categoryName, category] of Object.entries(parsed.categories)) {
    if (!category || typeof category !== 'object') continue;
    const conceptsObj = (category as any).concepts;
    if (!conceptsObj || typeof conceptsObj !== 'object') continue;
    normalized.categories[categoryName] = { weight: Number((category as any).weight ?? 1), concepts: {} };
    for (const [conceptName, values] of Object.entries(conceptsObj as Record<string, unknown>)) {
      if (!Array.isArray(values)) continue;
      normalized.categories[categoryName].concepts[conceptName] = values
        .map((v) => normalizeText(String(v)))
        .filter((v) => v.length > 0);
    }
  }
  if (Object.keys(normalized.categories).length === 0)
    throw new Error('Invalid taxonomy JSON: no categories after normalization');
  return normalized;
}

export function exportTaxonomyToPath(path: string): { categories: number; concepts: number; terms: number } {
  const taxonomy = readTaxonomyFromDb();
  const outPath = path.trim();
  if (!outPath) throw new Error('Missing export path');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(taxonomy, null, 2));
  return taxonomyStats(taxonomy);
}

export function importTaxonomyFromPath(path: string): { categories: number; concepts: number; terms: number } {
  const normalized = parseTaxonomyFromPath(path);
  writeTaxonomyToDb(normalized);
  return taxonomyStats(normalized);
}

export function mergeTaxonomyFromPath(
  path: string,
  policy: 'append' | 'replace' | 'keep',
): { categories: number; concepts: number; terms: number } {
  const incoming = parseTaxonomyFromPath(path);
  const existing = readTaxonomyFromDb();
  const merged: Taxonomy = JSON.parse(JSON.stringify(existing));

  for (const [categoryName, incomingCategory] of Object.entries(incoming.categories)) {
    const existingCategory = merged.categories[categoryName];
    if (!existingCategory) {
      merged.categories[categoryName] = JSON.parse(JSON.stringify(incomingCategory));
      continue;
    }
    if (policy === 'replace') {
      existingCategory.weight = incomingCategory.weight;
    } else if (policy === 'append') {
      existingCategory.weight = (Number(existingCategory.weight ?? 1) + Number(incomingCategory.weight ?? 1)) / 2;
    }
    for (const [conceptName, incomingTerms] of Object.entries(incomingCategory.concepts ?? {})) {
      const existingTerms = existingCategory.concepts[conceptName] ?? [];
      if (policy === 'replace') {
        existingCategory.concepts[conceptName] = [...incomingTerms];
        continue;
      }
      if (policy === 'keep') {
        if (!existingCategory.concepts[conceptName]) existingCategory.concepts[conceptName] = [...incomingTerms];
        continue;
      }
      const union = new Set<string>([...existingTerms, ...incomingTerms]);
      existingCategory.concepts[conceptName] = [...union];
    }
  }

  writeTaxonomyToDb(merged);
  return taxonomyStats(merged);
}

export function ensureRecommendConfig(): RecommendConfig {
  const path = getConfigPath();
  const fallback = createConfigSnapshot();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(fallback, null, 2));
    return fallback;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<RecommendConfig>;
    const merged: RecommendConfig = {
      ...fallback,
      ...(parsed as any),
      aliases: { ...fallback.aliases, ...(parsed?.aliases ?? {}) },
      skillWeights: { ...fallback.skillWeights, ...(parsed?.skillWeights ?? {}) },
      liveTaxonomy: {
        ...fallback.liveTaxonomy,
        ...(parsed?.liveTaxonomy ?? {}),
        sourceWeights: { ...fallback.liveTaxonomy.sourceWeights, ...(parsed?.liveTaxonomy?.sourceWeights ?? {}) },
      },
      router: {
        ...fallback.router,
        ...(parsed?.router ?? {}),
        learning: { ...fallback.router.learning, ...(parsed?.router?.learning ?? {}) },
      },
      defaults: { ...fallback.defaults, ...(parsed?.defaults ?? {}) },
    };
    writeFileSync(path, JSON.stringify(merged, null, 2));
    return merged;
  } catch {
    writeFileSync(path, JSON.stringify(fallback, null, 2));
    return fallback;
  }
}

export class TaxonomyManager {
  private taxonomyPath = join(getAgentDir(), 'model-recommend-taxonomy.json');
  private configPath = join(getAgentDir(), 'model-recommend-config.json');

  public getTaxonomy(): Taxonomy {
    if (existsSync(this.taxonomyPath)) {
      try {
        return JSON.parse(readFileSync(this.taxonomyPath, 'utf-8'));
      } catch {
        return DEFAULT_TAXONOMY;
      }
    }
    return DEFAULT_TAXONOMY;
  }

  public getConfig(): RecommendConfig {
    if (existsSync(this.configPath)) {
      try {
        return JSON.parse(readFileSync(this.configPath, 'utf-8'));
      } catch {
        return DEFAULT_CONFIG;
      }
    }
    return DEFAULT_CONFIG;
  }

  public saveTaxonomy(taxonomy: Taxonomy) {
    taxonomy.lastUpdated = new Date().toISOString();
    writeFileSync(this.taxonomyPath, JSON.stringify(taxonomy, null, 2));
  }

  public saveConfig(config: RecommendConfig) {
    config.lastUpdated = new Date().toISOString();
    writeFileSync(this.configPath, JSON.stringify(config, null, 2));
  }
}
