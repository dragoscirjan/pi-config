import { writeFileSync } from 'node:fs';
import { type ExtensionAPI, DynamicBorder } from '@mariozechner/pi-coding-agent';
import { Container, type SelectItem, SelectList, Input, Text, Key, matchesKey } from '@mariozechner/pi-tui';
import { getAuthenticatedProvidersFromAuthJson } from './auth';
import { syncBenchmarks, getAllBenchmarks, findBenchmarkForModel } from './benchmarks';
import { analyzeIntent } from './intent';
import {
  getRouterDbPath,
  getRouterSchemaVersion,
  canonicalFamily,
  persistTrainingSample,
  trainPairwiseSelection,
  resetLearningStore,
  getLearningStats,
  applyLearnedAdjustments,
} from './learning';
import { buildCostHintIndex, buildModelProfile } from './model-profile';
import { deriveConstraints, selectStageAFeasible, scoreModel, applyCapabilityDeltaGuard } from './scoring';
import {
  TRUSTED_ORGS,
  ensureTaxonomy,
  ensureRecommendConfig,
  importTaxonomyFromPath,
  mergeTaxonomyFromPath,
  exportTaxonomyToPath,
  getConfigPath,
} from './taxonomy';
import type {
  ModelLike,
  RecommendConfig,
  Intent,
  RecommendOptions,
  TaxonomyState,
  ScoredModel,
  CapabilityConstraints,
} from './types';

const ANSIreset = '\x1b[0m';
const ANSIbold = '\x1b[1m';
const ANSIdim = '\x1b[2m';
const ANSIcyan = '\x1b[36m';
const ANSIgreen = '\x1b[32m';
const ANSImagenta = '\x1b[35m';
const ANSIyellow = '\x1b[33m';

function padCol(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function formatTokenCount(value: number): string {
  if (!value || value <= 0) return '-';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) {
    const k = value / 1_000;
    return Number.isInteger(k) ? `${k}K` : `${k.toFixed(1)}K`;
  }
  return `${value}`;
}

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function tokenize(raw: string): string[] {
  const matches = raw.match(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g) ?? [];
  return matches.map((t) => {
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
    return t;
  });
}

function parseRecommendArgs(raw: string): RecommendOptions {
  const tokens = tokenize(raw);
  const opts: RecommendOptions = {
    task: '',
    rebuildTaxonomy: false,
    liveTaxonomy: false,
    liveSourcesArg: undefined,
    trusted: false,
    providers: [],
    sortBy: 'score',
    sortDir: 'desc',
    strategy: 'cheapest-capable',
    localPrefer: false,
    localOnly: false,
    limit: 10,
    help: false,
    explain: false,
    autoModeArg: undefined,
    learningModeArg: undefined,
    status: false,
    resetLearning: false,
    exportTaxonomyPath: undefined,
    importTaxonomyPath: undefined,
    mergeTaxonomyPath: undefined,
    mergePolicy: 'append',
  };
  const free: string[] = [];
  const pushProviders = (value: string | undefined) => {
    if (!value) return;
    for (const part of value
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean))
      opts.providers.push(part);
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--rebuild-taxonomy':
        opts.rebuildTaxonomy = true;
        break;
      case '--sync-benchmarks':
        opts.syncBenchmarks = true;
        break;
      case '--set-auto': {
        const mode = (tokens[++i] ?? '').toLowerCase();
        if (mode === 'off' || mode === 'suggest' || mode === 'enforce') opts.autoModeArg = mode;
        break;
      }
      case '--set-learning': {
        const mode = (tokens[++i] ?? '').toLowerCase();
        if (mode === 'on' || mode === 'off') opts.learningModeArg = mode;
        break;
      }
      case '--status':
        opts.status = true;
        break;
      case '--reset-learning':
        opts.resetLearning = true;
        break;
      case '--export-taxonomy':
        opts.exportTaxonomyPath = tokens[++i];
        break;
      case '--import-taxonomy':
        opts.importTaxonomyPath = tokens[++i];
        break;
      case '--merge-taxonomy':
        opts.mergeTaxonomyPath = tokens[++i];
        break;
      case '--merge-policy': {
        const policy = (tokens[++i] ?? '').toLowerCase();
        if (policy === 'append' || policy === 'replace' || policy === 'keep') opts.mergePolicy = policy;
        break;
      }
      case '--trusted':
        opts.trusted = true;
        break;
      case '--live-taxonomy':
        opts.liveTaxonomy = true;
        break;
      case '--live-sources':
        opts.liveTaxonomy = true;
        opts.liveSourcesArg = tokens[++i];
        break;
      case '--explain':
        opts.explain = true;
        break;
      case '--provider':
      case '--providers':
        pushProviders(tokens[++i]);
        break;
      case '--grep':
        opts.grep = tokens[++i];
        break;
      case '--sort-by': {
        const rawSort = (tokens[++i] ?? '').toLowerCase();
        const v = rawSort === 'intel' ? 'intelligence' : rawSort;
        if (['score', 'intelligence', 'reasoning', 'reliability', 'speed', 'price', 'context'].includes(v))
          opts.sortBy = v as RecommendOptions['sortBy'];
        const maybeDir = (tokens[i + 1] ?? '').toLowerCase();
        if (maybeDir === 'asc' || maybeDir === 'desc') {
          opts.sortDir = maybeDir;
          i++;
        }
        break;
      }
      case '--strategy': {
        const s = (tokens[++i] ?? '').toLowerCase();
        if (s === 'cheapest-capable' || s === 'capability-first' || s === 'local-first') opts.strategy = s;
        break;
      }
      case '--local-prefer':
        opts.localPrefer = true;
        break;
      case '--local-only':
        opts.localOnly = true;
        break;
      case '--limit': {
        const n = parseInt(tokens[++i] ?? '10', 10);
        if (!Number.isNaN(n) && n > 0) opts.limit = n;
        break;
      }
      default:
        if (!t.startsWith('-')) free.push(t);
    }
  }

  opts.task = free.join(' ').trim();
  return opts;
}

function isTrustedAuthor(modelId: string): boolean {
  if (!modelId.includes('/')) return true;
  return TRUSTED_ORGS.has(modelId.split('/')[0].toLowerCase());
}

async function computeRecommendations(
  task: string,
  opts: RecommendOptions,
  ctx: { modelRegistry: { getAll(): unknown[] } },
  config: RecommendConfig,
  includeNearMissFill = false,
): Promise<{
  top: ScoredModel[];
  scored: ScoredModel[];
  stageA: { constraints: CapabilityConstraints; relaxLevel: number };
  intent: Intent;
  taxState: TaxonomyState;
}> {
  const taxState = await ensureTaxonomy(opts.rebuildTaxonomy, opts.liveTaxonomy, config, opts.liveSourcesArg);
  const intent = analyzeIntent(task, taxState.taxonomy, config);
  const registryModels = ctx.modelRegistry.getAll() as ModelLike[];
  const benchmarks = getAllBenchmarks();
  const costHints = buildCostHintIndex(registryModels);
  const activeProviders = getAuthenticatedProvidersFromAuthJson();
  let models = registryModels.filter((m) => activeProviders.has(m.provider));
  if (opts.providers.length > 0)
    models = models.filter((m) => opts.providers.some((p) => m.provider.toLowerCase().includes(p)));
  if (opts.localOnly) models = models.filter((m) => buildModelProfile(m).isLocal);
  if (opts.grep)
    models = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(opts.grep!.toLowerCase()));

  const allCandidates = models
    .map((m): ScoredModel => {
      const p = buildModelProfile(m, costHints, findBenchmarkForModel(m.id, benchmarks));
      return {
        provider: p.provider,
        model: p.model,
        score: 0,
        intelligence: p.intel,
        reasoning: p.reasoning,
        toolReliability: p.toolReliability,
        speed: p.speed,
        inputPrice: p.costIn,
        outputPrice: p.costOut,
        effectivePrice: p.effectivePrice,
        priceEstimated: p.priceEstimated,
        contextWindow: p.context,
        supportsImages: p.supportsImages,
        isLocal: p.isLocal,
        breakdown: {
          normIntel: 0,
          normSpeed: 0,
          normPrice: 0,
          normContext: 0,
          weightedBase: 0,
          affinity: 1,
          tieJitter: 0,
          final: 0,
          weights: { intel: 1, speed: 1, price: 1, context: 1 },
          reasons: [],
        },
      };
    })
    .filter((m) => (opts.trusted ? isTrustedAuthor(m.model) : true));

  if (allCandidates.length === 0)
    return {
      top: [],
      scored: [],
      stageA: { constraints: deriveConstraints(intent, config), relaxLevel: 0 },
      intent,
      taxState,
    };
  const stageA = selectStageAFeasible(allCandidates, intent, config);

  let scored = stageA.feasible.map((m) => ({
    ...m,
    score: scoreModel(m, intent, config, stageA.constraints, stageA.relaxLevel),
  }));
  scored = applyCapabilityDeltaGuard(scored, intent, config);
  scored = applyLearnedAdjustments(scored, config);

  const dir = opts.sortDir === 'asc' ? 1 : -1;
  const compareModels = (a: ScoredModel, b: ScoredModel): number => {
    let cmp = 0;
    switch (opts.sortBy) {
      case 'score':
        if (opts.strategy === 'local-first') {
          cmp = Number(a.isLocal) - Number(b.isLocal);
          if (cmp === 0) cmp = a.score - b.score;
        } else {
          if (opts.localPrefer) {
            cmp = Number(a.isLocal) - Number(b.isLocal);
            if (cmp !== 0) return cmp * dir;
          }
          cmp = a.score - b.score;
        }
        break;
      case 'intelligence':
        cmp = a.intelligence - b.intelligence;
        break;
      case 'reasoning':
        cmp = a.reasoning - b.reasoning;
        break;
      case 'reliability':
        cmp = a.toolReliability - b.toolReliability;
        break;
      case 'speed':
        cmp = a.speed - b.speed;
        break;
      case 'price':
        cmp = a.outputPrice - b.outputPrice;
        break;
      case 'context':
        cmp = a.contextWindow - b.contextWindow;
        break;
    }
    if (cmp === 0) cmp = a.model.localeCompare(b.model);
    return cmp * dir;
  };

  scored.sort(compareModels);

  if (includeNearMissFill && scored.length < Math.max(1, opts.limit)) {
    const feasibleSet = new Set(stageA.feasible.map((m) => `${m.provider}::${m.model}`));
    let nearMiss = allCandidates
      .filter((m) => !feasibleSet.has(`${m.provider}::${m.model}`))
      .map((m) => ({ ...m, score: scoreModel({ ...m }, intent, config, stageA.constraints, stageA.relaxLevel) }));
    nearMiss = applyLearnedAdjustments(nearMiss, config).map((m) => {
      m.breakdown.reasons.push('near-miss: did not satisfy stageA constraints');
      return m;
    });
    nearMiss.sort(compareModels);
    scored = [...scored, ...nearMiss].slice(0, Math.max(1, opts.limit));
  }

  return { top: scored.slice(0, Math.max(1, opts.limit)), scored, stageA, intent, taxState };
}

function usageText(): string {
  const reset = '\x1b[0m';
  const bold = '\x1b[1m';
  const dim = '\x1b[2m';
  const cyan = '\x1b[36m';
  const green = '\x1b[32m';
  const yellow = '\x1b[33m';

  return [
    `${bold}${cyan}🧠 /model-recommend <task> [options]${reset}`,
    `${dim}Intelligent model router with taxonomy, live enrichment, and online learning.${reset}`,
    '',
    `${bold}TAXONOMY:${reset}`,
    `  ${green}--rebuild-taxonomy${reset}                     Reset taxonomy in DB to defaults, then optionally enrich`,
    `  ${green}--sync-benchmarks${reset}                      Fetch and update Aider leaderboard dataset into DB`,
    `  ${green}--live-taxonomy${reset}                        Enrich current taxonomy with live sources (no reset)`,
    `  ${green}--live-sources <all|csv>${reset}               Override enabled live sources for this run`,
    `  ${green}--export-taxonomy <path>${reset}               Export taxonomy from DB to JSON file`,
    `  ${green}--import-taxonomy <path>${reset}               Import taxonomy JSON as REPLACE (overwrites DB taxonomy)`,
    `  ${green}--merge-taxonomy <path>${reset}                Merge taxonomy JSON into DB taxonomy`,
    `  ${green}--merge-policy <append|replace|keep>${reset}   Merge policy for --merge-taxonomy (default: append)`,
    '',
    `${bold}ROUTER & LEARNING:${reset}`,
    `  ${green}--set-auto <off|suggest|enforce>${reset}       Auto-routing mode`,
    `  ${green}--set-learning <on|off>${reset}                Enable/disable online learning`,
    `  ${green}--status${reset}                               Print router status, DB schema, sample counts`,
    `  ${green}--reset-learning${reset}                       Clear learned weights and training samples`,
    '',
    `${bold}FILTERS & STRATEGY:${reset}`,
    `  ${green}--provider <name[,name]>${reset}               Filter providers`,
    `  ${green}--grep <text>${reset}                          Filter models by provider/model substring`,
    `  ${green}--trusted${reset}                              Keep only models from trusted org list`,
    `  ${green}--strategy <cheapest-capable|capability-first|local-first>${reset}`,
    `  ${green}--local-prefer${reset}                         Prefer local models when scores are similar`,
    `  ${green}--local-only${reset}                           Only local providers/models`,
    `  ${green}--sort-by <score|intelligence|reasoning|reliability|speed|price|context> [asc|desc]${reset}`,
    `  ${green}--limit <n>${reset}                            Number of models to display`,
    `  ${green}--explain${reset}                              Show per-model score breakdown and reasons`,
    '',
    `${yellow}${dim}Tip: task is positional (no --task needed).${reset}`,
  ].join('\n');
}

function findModelFromInput(input: string, registryModels: ModelLike[]): ModelLike | undefined {
  const raw = input.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw.includes('/')) {
    const [provider, ...rest] = raw.split('/');
    const id = rest.join('/');
    return registryModels.find((m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === id);
  }
  return (
    registryModels.find((m) => m.id.toLowerCase() === raw) ??
    registryModels.find((m) => canonicalFamily(m.id) === canonicalFamily(raw)) ??
    registryModels.find((m) => `${m.provider}/${m.id}`.toLowerCase().includes(raw))
  );
}

async function setCurrentModel(pi: ExtensionAPI, ctx: any, selected: ScoredModel): Promise<boolean> {
  const model = (ctx.modelRegistry.getAll() as ModelLike[]).find(
    (m) => m.provider === selected.provider && m.id === selected.model,
  );
  if (!model) return false;
  return await pi.setModel(model as any);
}

export default function modelRecommendExtension(pi: ExtensionAPI) {
  pi.registerCommand('model-recommend', {
    description: 'Recommend models for a task using auth-aware model access + local taxonomy scoring',
    handler: async (args, ctx) => {
      const opts = parseRecommendArgs(args);
      if (opts.syncBenchmarks) {
        ctx.ui.notify('Syncing Aider LLM benchmarks...', 'info');
        const count = await syncBenchmarks();
        ctx.ui.notify(`Synced ${count} benchmark entries.`, 'success');
        if (!opts.task) return;
      }

      const existingBenchmarks = getAllBenchmarks();
      if (existingBenchmarks.length === 0) await syncBenchmarks();

      const config = ensureRecommendConfig();
      if (opts.autoModeArg) config.router.autoMode = opts.autoModeArg;
      if (opts.learningModeArg) config.router.learnEnabled = opts.learningModeArg === 'on';
      if (opts.resetLearning) resetLearningStore();

      if (opts.importTaxonomyPath && opts.mergeTaxonomyPath) {
        const msg = 'Use either --import-taxonomy or --merge-taxonomy in one command (not both).';
        if (ctx.hasUI) ctx.ui.notify(msg, 'error');
        else console.log(msg);
        return;
      }

      let taxonomyActionMessage = '';
      const hasTaxonomyRefreshFlags = opts.rebuildTaxonomy || opts.liveTaxonomy || Boolean(opts.liveSourcesArg);
      try {
        if (opts.importTaxonomyPath) {
          const imported = importTaxonomyFromPath(opts.importTaxonomyPath);
          taxonomyActionMessage = `Imported taxonomy (replace) from ${opts.importTaxonomyPath} (categories=${imported.categories}, concepts=${imported.concepts}, terms=${imported.terms})`;
        }
        if (opts.mergeTaxonomyPath) {
          const merged = mergeTaxonomyFromPath(opts.mergeTaxonomyPath, opts.mergePolicy);
          const mergeMsg = `Merged taxonomy from ${opts.mergeTaxonomyPath} policy=${opts.mergePolicy} (categories=${merged.categories}, concepts=${merged.concepts}, terms=${merged.terms})`;
          taxonomyActionMessage = taxonomyActionMessage ? `${taxonomyActionMessage}\n${mergeMsg}` : mergeMsg;
        }
        if (opts.exportTaxonomyPath) {
          const exported = exportTaxonomyToPath(opts.exportTaxonomyPath);
          const exportMsg = `Exported taxonomy to ${opts.exportTaxonomyPath} (categories=${exported.categories}, concepts=${exported.concepts}, terms=${exported.terms})`;
          taxonomyActionMessage = taxonomyActionMessage ? `${taxonomyActionMessage}\n${exportMsg}` : exportMsg;
        }
        if (!opts.task && hasTaxonomyRefreshFlags) {
          const taxState = await ensureTaxonomy(opts.rebuildTaxonomy, opts.liveTaxonomy, config, opts.liveSourcesArg);
          const refreshMsg = `Taxonomy refresh complete: ${taxState.rebuilt ? 'rebuilt' : 'updated'}${taxState.enriched ? ' + live-signals' : ''}${taxState.liveSources.length ? ` (${taxState.liveSources.join(', ')})` : ''}`;
          taxonomyActionMessage = taxonomyActionMessage ? `${taxonomyActionMessage}\n${refreshMsg}` : refreshMsg;
        }
      } catch (error) {
        const msg = `Taxonomy import/export/merge failed: ${(error as Error).message}`;
        if (ctx.hasUI) ctx.ui.notify(msg, 'error');
        else console.log(msg);
        return;
      }

      config.lastUpdated = new Date().toISOString();
      writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));

      if (
        opts.status ||
        opts.autoModeArg ||
        opts.learningModeArg ||
        opts.resetLearning ||
        opts.importTaxonomyPath ||
        opts.mergeTaxonomyPath ||
        opts.exportTaxonomyPath ||
        hasTaxonomyRefreshFlags
      ) {
        const stats = getLearningStats();
        const schemaVersion = getRouterSchemaVersion();
        const text = [
          `Auto mode: ${config.router.autoMode}`,
          `Learning: ${config.router.learnEnabled ? 'on' : 'off'}`,
          `Confidence margin: ${config.router.minMarginForAutoPick}`,
          `SQLite DB: ${getRouterDbPath()}`,
          `DB schema: v${schemaVersion}/${getRouterSchemaVersion()}`,
          `Training samples: ${stats.samples} | Learned weights: ${stats.weights}`,
          taxonomyActionMessage,
        ]
          .filter(Boolean)
          .join('\n');
        if (ctx.hasUI) ctx.ui.notify(text, 'info');
        else console.log(text);
        if (!opts.task) return;
      }

      if (opts.help || !opts.task) {
        const text = usageText();
        if (ctx.hasUI) ctx.ui.notify(text, 'info');
        else console.log(text);
        return;
      }

      const activeProviders = getAuthenticatedProvidersFromAuthJson();
      if (activeProviders.size === 0) {
        const msg = 'No authenticated providers found in agent/auth.json';
        if (ctx.hasUI) ctx.ui.notify(msg, 'warning');
        else console.log(msg);
        return;
      }

      const { top, stageA, intent, taxState } = await computeRecommendations(opts.task, opts, ctx, config, true);
      if (top.length === 0) {
        const msg = 'No models matched your filters.';
        if (ctx.hasUI) ctx.ui.notify(msg, 'warning');
        else console.log(msg);
        return;
      }

      const rows = top.map((m, i) => ({
        m,
        rank: String(i + 1),
        score: m.score.toFixed(1),
        provider: m.provider,
        model: m.model,
        intel: String(Math.round(m.intelligence)),
        reason: String(Math.round(m.reasoning)),
        reliab: String(Math.round(m.toolReliability)),
        speed: `${Math.round(m.speed)} tps`,
        price: `${formatMoney(m.inputPrice)} / ${formatMoney(m.outputPrice)}${m.priceEstimated ? ' ~' : ''}`,
        context: formatTokenCount(m.contextWindow),
        type: m.breakdown.reasons.some((r) => r.startsWith('near-miss:'))
          ? m.isLocal
            ? 'local*'
            : 'commercial*'
          : m.isLocal
            ? 'local'
            : 'commercial',
      }));

      const cRank = Math.max('#'.length, ...rows.map((r) => r.rank.length));
      const cScore = Math.max('SCORE'.length, ...rows.map((r) => r.score.length));
      const cProvider = Math.max('PROVIDER'.length, ...rows.map((r) => r.provider.length));
      const cModel = Math.max('MODEL'.length, ...rows.map((r) => r.model.length));
      const cIntel = Math.max('INTEL'.length, ...rows.map((r) => r.intel.length));
      const cReason = Math.max('REASON'.length, ...rows.map((r) => r.reason.length));
      const cReliab = Math.max('RELIAB'.length, ...rows.map((r) => r.reliab.length));
      const cSpeed = Math.max('SPEED'.length, ...rows.map((r) => r.speed.length));
      const cPrice = Math.max('PRICE (in/out per 1M)'.length, ...rows.map((r) => r.price.length));
      const cContext = Math.max('CONTEXT'.length, ...rows.map((r) => r.context.length));
      const cType = Math.max('TYPE'.length, ...rows.map((r) => r.type.length));

      const totalWidth =
        cRank + cScore + cProvider + cModel + cIntel + cReason + cReliab + cSpeed + cPrice + cContext + cType + 10 * 3;
      const sep = `${ANSIdim}${'─'.repeat(totalWidth)}${ANSIreset}`;
      const hdr = [
        padCol('#', cRank),
        padCol('SCORE', cScore),
        padCol('PROVIDER', cProvider),
        padCol('MODEL', cModel),
        padCol('INTEL', cIntel),
        padCol('REASON', cReason),
        padCol('RELIAB', cReliab),
        padCol('SPEED', cSpeed),
        padCol('PRICE (in/out per 1M)', cPrice),
        padCol('CONTEXT', cContext),
        'TYPE',
      ].join('   ');

      const tableLines = rows.map((r, i) => {
        const isTop = i === 0;
        const isLearned = r.m.breakdown.reasons.some(
          (x) => x.startsWith('learned-bias') && !x.startsWith('learned-bias=0') && !x.includes('=-0'),
        );
        const rankStr = isTop ? `${ANSIgreen}${padCol(r.rank, cRank)}${ANSIreset}` : padCol(r.rank, cRank);
        const learnedMark = isLearned ? ` ${ANSImagenta}★learned${ANSIreset}` : '';
        const typeStr = r.type.includes('*') ? `${ANSIyellow}${r.type}${ANSIreset}` : `${ANSIdim}${r.type}${ANSIreset}`;
        return [
          rankStr,
          padCol(r.score, cScore),
          padCol(r.provider, cProvider),
          `${ANSIcyan}${padCol(r.model, cModel)}${ANSIreset}`,
          padCol(r.intel, cIntel),
          padCol(r.reason, cReason),
          padCol(r.reliab, cReliab),
          padCol(r.speed, cSpeed),
          padCol(r.price, cPrice),
          padCol(r.context, cContext),
          typeStr + learnedMark,
        ].join('   ');
      });

      const needs = intent.capabilityNeeds;
      const preface = [
        `${ANSIbold}Task:${ANSIreset} ${opts.task}`,
        `${ANSIbold}Intent:${ANSIreset} ${Array.from(intent.domains).join('/') || 'general'} | ${ANSIbold}Complexity:${ANSIreset} ${intent.complexity}/100`,
        `${ANSIdim}Needs: reasoning=${needs.reasoningDepth.toFixed(2)} system=${needs.systemBreadth.toFixed(2)} correctness=${needs.correctnessRisk.toFixed(2)} context=${needs.contextVolume.toFixed(2)} safety=${needs.safetyCriticality.toFixed(2)} cost=${needs.costSensitivity.toFixed(2)} latency=${needs.latencySensitivity.toFixed(2)}${ANSIreset}`,
        `${ANSIdim}StageA: intel>=${stageA.constraints.minIntel} reason>=${stageA.constraints.minReasoning} tool>=${stageA.constraints.minToolReliability} context>=${stageA.constraints.minContext} | relax=${stageA.relaxLevel}${ANSIreset}`,
        `${ANSIdim}Taxonomy: ${taxState.rebuilt ? 'rebuilt' : 'ready'}${taxState.enriched ? ' + live-signals' : ''}${ANSIreset}`,
      ].join('\n');

      const output = [
        preface,
        `${ANSIdim}* = near-miss fallback (did not fully satisfy StageA)${ANSIreset}`,
        sep,
        `${ANSIbold}${ANSIdim}${hdr}${ANSIreset}`,
        sep,
        ...tableLines,
        sep,
      ].join('\n');

      let explainBlock = '';
      if (opts.explain) {
        const explainLines: string[] = [`\n${ANSIbold}── Score Breakdown ──${ANSIreset}`];
        for (const r of rows) {
          const b = r.m.breakdown;
          explainLines.push(
            `${ANSIcyan}${r.provider}/${r.model}${ANSIreset}`,
            `  ${ANSIdim}intel-fit=${b.normIntel.toFixed(2)}  speed-fit=${b.normSpeed.toFixed(2)}  price-fit=${b.normPrice.toFixed(2)}  ctx-fit=${b.normContext.toFixed(2)}${ANSIreset}`,
            `  ${ANSIdim}capability=${(b.weightedBase * 100).toFixed(1)}%  affinity=${(b.affinity * 100).toFixed(1)}%  jitter=${b.tieJitter.toFixed(3)}  final=${b.final.toFixed(1)}${ANSIreset}`,
            ...b.reasons.map((reason) => `  ${ANSIdim}· ${reason}${ANSIreset}`),
          );
        }
        explainBlock = explainLines.join('\n');
      }

      const finalOutput = explainBlock ? [output, explainBlock].join('\n') : output;
      if (ctx.hasUI) ctx.ui.notify(finalOutput, 'info');
      else console.log(finalOutput);
    },
  });

  pi.on('before_agent_start', async (event, ctx) => {
    const config = ensureRecommendConfig();
    if (config.router.autoMode === 'off') return;
    const prompt = String((event as any).prompt ?? '').trim();
    if (!prompt || prompt.startsWith('/')) return;

    const opts = parseRecommendArgs('');
    opts.limit = 5;
    const { top, intent } = await computeRecommendations(prompt, opts, ctx as any, config, true);
    if (top.length === 0) return;

    const margin = top.length > 1 ? top[0].score - top[1].score : 100;
    const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : 'current';

    if (config.router.autoMode === 'enforce') {
      const selected = top[0];
      const ok = await setCurrentModel(pi, ctx as any, selected);
      (ctx as any).ui?.notify(
        `Routing: ${selected.provider}/${selected.model}${ok ? '' : ' (switch failed)'}`,
        ok ? 'info' : 'warning',
      );
      if (config.router.learnEnabled) {
        persistTrainingSample(prompt, 'auto-enforce', intent, selected, top.slice(0, 5), margin);
        trainPairwiseSelection(config, selected, top.slice(0, 5));
      }
      return;
    }

    if (!(ctx as any).hasUI) {
      const lines = top
        .slice(0, 5)
        .map(
          (m, i) =>
            `  ${i + 1}. ${m.provider}/${m.model}  score=${m.score.toFixed(1)} reason=${m.reasoning} intel=${m.intelligence}`,
        );
      console.log(
        `\n── Model Suggestions (suggest mode) ─────────────────\n${lines.join('\n')}\n  6. Keep current: ${currentModel}\n─────────────────────────────────────────────────────\n`,
      );
      return;
    }

    const listItems: SelectItem[] = top.slice(0, 5).map((m, i) => ({
      value: `rec:${i}`,
      label: `${m.provider}/${m.model}`,
      description: `score ${m.score.toFixed(1)}  intel ${m.intelligence}  reason ${m.reasoning}  ${formatMoney(m.inputPrice)}/${formatMoney(m.outputPrice)}`,
    }));
    listItems.push({
      value: 'keep',
      label: `⟳  Keep current  (${currentModel})`,
      description: 'Continue with currently active model',
    });
    listItems.push({
      value: 'custom',
      label: '✎  Enter custom model...',
      description: 'Type provider/model-id manually',
    });

    const choice = await (ctx as any).ui.custom<string | null>(
      (tui: any, theme: any, _kb: any, done: (v: string | null) => void) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
        container.addChild(new Text(theme.fg('accent', theme.bold(' Model Suggestions')), 1, 0));
        container.addChild(
          new Text(
            theme.fg(
              'dim',
              ` Task intent: ${Array.from(intent.domains).join('/') || 'general'} · complexity ${intent.complexity}/100`,
            ),
            1,
            0,
          ),
        );
        container.addChild(new Text('', 0, 0));

        class AutoWidthSelectList extends SelectList {
          getPrimaryColumnWidth() {
            return Math.max(20, ...this.filteredItems.map((i: any) => (i.label ? i.label.length : 0))) + 2;
          }
          truncatePrimary(item: any) {
            return item.label || item.value;
          }
        }
        const selectList = new AutoWidthSelectList(listItems, Math.min(listItems.length, 10), {
          selectedPrefix: (t: string) => theme.fg('accent', t),
          selectedText: (t: string) => theme.fg('accent', t),
          description: (t: string) => theme.fg('dim', t),
          scrollInfo: (t: string) => theme.fg('dim', t),
          noMatch: (t: string) => theme.fg('warning', t),
        });
        selectList.onSelect = (item: SelectItem) => done(item.value as string);
        selectList.onCancel = () => done(null);
        container.addChild(selectList);
        container.addChild(new Text(theme.fg('dim', ' ↑↓ navigate · enter select · esc keep current'), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: Uint8Array) => {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      },
    );

    if (choice === null) return;
    if (choice === 'keep') {
      if (config.router.learnEnabled) {
        const fakeKeep = {
          provider: ctx.model?.provider ?? '',
          model: ctx.model?.id ?? '',
          score: 0,
          intelligence: 0,
          reasoning: 0,
          toolReliability: 0,
        } as ScoredModel;
        persistTrainingSample(prompt, 'user-keep', intent, fakeKeep, top.slice(0, 5), margin);
      }
      (ctx as any).ui.notify(`Keeping current model: ${currentModel}`, 'info');
      return;
    }

    if (choice === 'custom') {
      const customId = await (ctx as any).ui.custom<string | null>(
        (tui: any, theme: any, _kb: any, done: (v: string | null) => void) => {
          const container = new Container();
          container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
          container.addChild(new Text(theme.fg('accent', theme.bold(' Enter model  (provider/model-id)')), 1, 0));
          const inp = new Input('', 60);
          container.addChild(inp as any);
          container.addChild(new Text(theme.fg('dim', ' enter confirm · esc cancel'), 1, 0));
          container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
          return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: Uint8Array) => {
              if (matchesKey(data, Key.enter)) {
                done(inp.getValue().trim() || null);
                return;
              }
              if (matchesKey(data, Key.escape)) {
                done(null);
                return;
              }
              inp.handleInput(data);
              tui.requestRender();
            },
          };
        },
      );
      if (!customId) return;
      const found = findModelFromInput(customId, (ctx as any).modelRegistry.getAll() as any);
      if (!found) {
        (ctx as any).ui.notify(`Model not found in registry: ${customId}`, 'warning');
        return;
      }
      const ok = await pi.setModel(found as any);
      (ctx as any).ui.notify(
        `Switched to: ${found.provider}/${found.id}${ok ? '' : ' (switch failed)'}`,
        ok ? 'info' : 'warning',
      );
      if (config.router.learnEnabled) {
        const custom: ScoredModel = {
          provider: found.provider,
          model: found.id,
          score: 50,
          intelligence: 50,
          reasoning: 50,
          toolReliability: 50,
        } as ScoredModel;
        persistTrainingSample(prompt, 'user-custom', intent, custom, top.slice(0, 5), margin);
        trainPairwiseSelection(config, custom, top.slice(0, 5));
      }
      return;
    }

    const idx = parseInt(choice.replace('rec:', ''), 10);
    const selected = top[idx];
    if (!selected) return;
    const ok = await setCurrentModel(pi, ctx as any, selected);
    (ctx as any).ui.notify(
      `Routing: ${selected.provider}/${selected.model}${ok ? '' : ' (switch failed)'}`,
      ok ? 'info' : 'warning',
    );
    if (config.router.learnEnabled) {
      persistTrainingSample(prompt, 'user-pick', intent, selected, top.slice(0, 5), margin);
      trainPairwiseSelection(config, selected, top.slice(0, 5));
    }
  });
}
