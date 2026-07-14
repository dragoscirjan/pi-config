import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAllBenchmarks, findBenchmarkForModel } from './benchmarks';
import { buildModelProfile, buildCostHintIndex, clamp } from './profiles';
import type { ModelLike } from './types';

// ANSI styling helpers
const reset = '\x1b[0m';
const bold = '\x1b[1m';
const dim = '\x1b[2m';
const cyan = '\x1b[36m';
const green = '\x1b[32m';
const yellow = '\x1b[33m';
const magenta = '\x1b[35m';
const blue = '\x1b[34m';

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function parseFloatSafe(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function tokenize(raw: string): string[] {
  const matches = raw.match(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g) ?? [];
  return matches.map((t) => {
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
    return t;
  });
}

export type LocalityFilter = 'all' | 'local' | 'commercial';

export function isModelVisibleByProvider(_provider: string): boolean {
  return true;
}

export function applyLocalityFilter<T extends { isLocal: boolean }>(rows: T[], locality: LocalityFilter): T[] {
  if (locality === 'local') return rows.filter((r) => r.isLocal);
  if (locality === 'commercial') return rows.filter((r) => !r.isLocal);
  return rows;
}

export function registerActiveModelsCommand(pi: ExtensionAPI) {
  pi.registerCommand('active-models', {
    description: 'List and filter active models with capability scoring',
    handler: async (args, ctx) => {
      const tokens = tokenize(args);

      if (args.includes('--help') || args.includes('-h')) {
        const help = [
          `${bold}${cyan}🚀 /active-models${reset} - Model Intelligence Index`,
          `${dim}Find the smartest and cheapest models from your authenticated providers.${reset}`,
          '',
          `${bold}USAGE:${reset} /active-models [options]`,
          '',
          `${bold}OPTIONS:${reset}`,
          `  ${green}--grep, -g <q>${reset}      Search providers/models`,
          `  ${green}--provider, -p <ids>${reset}  Allowlist (csv)`,
          `  ${green}--min-intel <n>${reset}     Min Intelligence (0-100)`,
          `  ${green}--max-price <n>${reset}     Max cost per 1M output tokens`,
          `  ${green}--sort-by <field>${reset}   score, intel, price, context, efficiency`,
          `  ${green}--limit, -n <n>${reset}     Max results (default: 10)`,
          `  ${green}--local${reset}             Show only local providers/models`,
          `  ${green}--commercial${reset}        Show only non-local providers/models`,
          '',
          `${bold}METRICS:${reset}`,
          `  ${magenta}Score${reset}       Balanced capability weight (0-100)`,
          `  ${magenta}Efficiency${reset}  Intelligence-per-dollar (best value)`,
          '',
          `${bold}EXAMPLES:${reset}`,
          `  /active-models --min-intel 90 --sort-by price ${dim}# Cheapest elite models${reset}`,
          `  /active-models -g claude --sort-by efficiency  ${dim}# Best value Anthropic${reset}`,
          '',
        ].join('\n');

        if (ctx.hasUI) ctx.ui.notify(help, 'info');
        else console.log(help);
        return;
      }

      const parsed = {
        grep: '',
        providers: [] as string[],
        sortBy: 'score' as 'score' | 'intel' | 'price' | 'context' | 'efficiency',
        desc: true,
        minIntel: 0,
        maxPrice: Number.POSITIVE_INFINITY,
        limit: 10,
        locality: 'all' as LocalityFilter,
      };

      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === '--grep' || t === '-g') parsed.grep = tokens[++i]?.toLowerCase() ?? '';
        else if (t === '--provider' || t === '-p') parsed.providers.push(...(tokens[++i]?.split(',') ?? []));
        else if (t === '--sort-by') {
          parsed.sortBy = (tokens[++i] as any) ?? 'score';
          const maybeDir = tokens[i + 1]?.toLowerCase();
          if (maybeDir === 'asc' || maybeDir === 'desc') {
            parsed.desc = maybeDir === 'desc';
            i++;
          }
        } else if (t === '--min-intel') parsed.minIntel = parseFloatSafe(tokens[++i], 0);
        else if (t === '--max-price') parsed.maxPrice = parseFloatSafe(tokens[++i], Number.POSITIVE_INFINITY);
        else if (t === '--limit' || t === '-n') parsed.limit = parseInt(tokens[++i] ?? '10', 10);
        else if (t === '--local') parsed.locality = 'local';
        else if (t === '--commercial') parsed.locality = 'commercial';
      }

      if (tokens.includes('--local') && tokens.includes('--commercial')) {
        const message = `${yellow}Use only one of --local or --commercial.${reset}`;
        if (ctx.hasUI) ctx.ui.notify(message, 'warning');
        else console.warn(message);
        return;
      }

      const registryModels = ctx.modelRegistry.getAvailable() as ModelLike[];
      const costHints = buildCostHintIndex(registryModels);

      let rows = registryModels
        .filter((m) => isModelVisibleByProvider(m.provider))
        .map((m) => {
          const benchmarks = getAllBenchmarks();
          const p = buildModelProfile(m, costHints, findBenchmarkForModel(m.id, benchmarks));
          const priceNorm = clamp(1 - Math.log1p(Math.max(0, p.effectivePrice)) / Math.log1p(50), 0, 1);
          const score = p.intel * 0.35 + p.reasoning * 0.2 + p.toolReliability * 0.25 + priceNorm * 20;
          const efficiency = p.intel / (p.effectivePrice + 0.01);
          return { ...p, isLocal: p.isLocal, score, efficiency };
        });

      if (parsed.providers.length > 0)
        rows = rows.filter((r) => parsed.providers.some((p) => r.provider.toLowerCase().includes(p.toLowerCase())));
      if (parsed.grep) rows = rows.filter((r) => `${r.provider}/${r.model}`.toLowerCase().includes(parsed.grep));
      rows = rows.filter((r) => r.intel >= parsed.minIntel && r.costOut <= parsed.maxPrice);
      rows = applyLocalityFilter(rows, parsed.locality);

      rows.sort((a, b) => {
        let cmp = 0;
        switch (parsed.sortBy) {
          case 'score':
            cmp = a.score - b.score;
            break;
          case 'intel':
            cmp = a.intel - b.intel;
            break;
          case 'price':
            cmp = a.costOut - b.costOut;
            break;
          case 'context':
            cmp = a.context - b.context;
            break;
          case 'efficiency':
            cmp = a.efficiency - b.efficiency;
            break;
        }
        return parsed.desc ? -cmp : cmp;
      });

      rows = rows.slice(0, parsed.limit);

      if (rows.length === 0) {
        ctx.ui.notify(`${yellow}No models found matching filters.${reset}`, 'warning');
        return;
      }

      const priceStr = (r: (typeof rows)[0]) =>
        `${formatMoney(r.costIn)} / ${formatMoney(r.costOut)}${r.priceEstimated ? ' ~' : ''}`;

      // Compute column widths from actual data
      const colProvider = Math.max('PROVIDER'.length, ...rows.map((r) => r.provider.length));
      const colModel = Math.max('MODEL'.length, ...rows.map((r) => r.model.length));
      const colIntel = Math.max('INTEL'.length, ...rows.map((r) => Math.round(r.intel).toString().length));
      const colScore = Math.max('SCORE'.length, ...rows.map((r) => r.score.toFixed(1).length));
      const colPrice = Math.max('PRICE (in/out per 1M)'.length, ...rows.map((r) => priceStr(r).length));

      const sep = `${dim}${'-'.repeat(colProvider + colModel + colIntel + colScore + colPrice + 4 * 3 + 10)}${reset}`;

      const header = [
        sep,
        `${bold}${dim}${pad('PROVIDER', colProvider)}   ${pad('MODEL', colModel)}   ${pad('INTEL', colIntel)}   ${pad('SCORE', colScore)}   ${pad('PRICE (in/out per 1M)', colPrice)}   BADGES${reset}`,
        sep,
      ].join('\n');

      const lines = rows.map((r) => {
        const badges: string[] = [];
        if (r.intel >= 90) badges.push(`${magenta}ELITE${reset}`);
        else if (r.intel >= 80) badges.push(`${blue}SMART${reset}`);
        if (r.effectivePrice <= 0.5) badges.push(`${green}CHEAP${reset}`);

        return `${pad(r.provider, colProvider)}   ${cyan}${pad(r.model, colModel)}${reset}   ${pad(Math.round(r.intel).toString(), colIntel)}   ${pad(r.score.toFixed(1), colScore)}   ${pad(priceStr(r), colPrice)}   ${badges.join(' ')}`;
      });

      const output = [header, ...lines, sep].join('\n');

      if (ctx.hasUI) ctx.ui.notify(output, 'info');
      else console.log(output);
    },
  });
}
