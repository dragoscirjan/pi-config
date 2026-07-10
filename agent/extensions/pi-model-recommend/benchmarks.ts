import { getRouterDb } from './learning';

export interface BenchmarkStats {
  model: string;
  editPassRate: number | null;
  refactorPassRate: number | null;
}

export async function syncBenchmarks(): Promise<number> {
  const editUrl = 'https://raw.githubusercontent.com/paul-gauthier/aider/main/aider/website/_data/edit_leaderboard.yml';
  const refactorUrl =
    'https://raw.githubusercontent.com/paul-gauthier/aider/main/aider/website/_data/refactor_leaderboard.yml';

  const db = getRouterDb();

  let editCount = 0;
  try {
    const res = await fetch(editUrl);
    if (res.ok) {
      const text = await res.text();
      const blocks = text.split('\n- dirname:');
      for (const block of blocks.slice(1)) {
        const model = block
          .match(/model:\s*(.*)/)?.[1]
          ?.trim()
          ?.replace(/^"|"$/g, '');
        const passStr = block.match(/pass_rate_2:\s*(.*)/)?.[1];
        if (model && passStr) {
          const pass = parseFloat(passStr);
          if (!isNaN(pass)) {
            db.prepare(
              `
                            INSERT INTO model_benchmarks (model, pass_rate_edit, updated_at) 
                            VALUES (?, ?, ?) 
                            ON CONFLICT(model) DO UPDATE SET pass_rate_edit=excluded.pass_rate_edit, updated_at=excluded.updated_at
                        `,
            ).run(model, pass, Date.now());
            editCount++;
          }
        }
      }
    }
  } catch (e) {
    console.error('Failed to sync edit benchmarks:', e);
  }

  let refactorCount = 0;
  try {
    const res = await fetch(refactorUrl);
    if (res.ok) {
      const text = await res.text();
      const blocks = text.split('\n- dirname:');
      for (const block of blocks.slice(1)) {
        const model = block
          .match(/model:\s*(.*)/)?.[1]
          ?.trim()
          ?.replace(/^"|"$/g, '');
        const passStr = block.match(/pass_rate_1:\s*(.*)/)?.[1];
        if (model && passStr) {
          const pass = parseFloat(passStr);
          if (!isNaN(pass)) {
            db.prepare(
              `
                            INSERT INTO model_benchmarks (model, pass_rate_refactor, updated_at) 
                            VALUES (?, ?, ?) 
                            ON CONFLICT(model) DO UPDATE SET pass_rate_refactor=excluded.pass_rate_refactor, updated_at=excluded.updated_at
                        `,
            ).run(model, pass, Date.now());
            refactorCount++;
          }
        }
      }
    }
  } catch (e) {
    console.error('Failed to sync refactor benchmarks:', e);
  }

  return editCount + refactorCount;
}

export function getAllBenchmarks(): BenchmarkStats[] {
  try {
    return getRouterDb()
      .prepare(
        'SELECT model, pass_rate_edit as editPassRate, pass_rate_refactor as refactorPassRate FROM model_benchmarks',
      )
      .all() as BenchmarkStats[];
  } catch {
    return [];
  }
}

function normalizeId(id: string): string {
  return id
    .toLowerCase()
    .replace(/^(openrouter\/|github-copilot\/|anthropic\/|openai\/|google\/|meta\/|mistralai\/|deepseek\/|qwen\/)/, '')
    .replace(/[^a-z0-9]/g, '');
}

export function findBenchmarkForModel(modelId: string, benchmarks: BenchmarkStats[]): BenchmarkStats | undefined {
  const normalized = normalizeId(modelId);

  const exact = benchmarks.find((b) => normalizeId(b.model) === normalized);
  if (exact) return exact;

  let bestMatch: BenchmarkStats | undefined;
  let maxLen = 0;

  for (const b of benchmarks) {
    const nBench = normalizeId(b.model);
    const nBenchNoDate = nBench.replace(/202[45]\d{4}/, '');

    if ((normalized.includes(nBenchNoDate) || nBenchNoDate.includes(normalized)) && nBenchNoDate.length > 5) {
      if (nBenchNoDate.length > maxLen) {
        maxLen = nBenchNoDate.length;
        bestMatch = b;
      }
    }
  }

  return bestMatch;
}
