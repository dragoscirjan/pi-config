import { resolveHeaders } from '../config.js';
import { logWarn } from '../log.js';
import type { DiscoverModels, NormalizedModel, ServerEntry } from '../types.js';

interface OllamaTagsResponse {
  models?: Array<{
    name: string;
    model: string;
    size?: number;
    digest?: string;
    details?: { family?: string; parameter_size?: string; quantization_level?: string };
  }>;
}

interface OllamaTagModel {
  name: string;
  model?: string;
  size?: number;
  digest?: string;
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
}

interface OllamaShowResponse {
  model_info?: Record<string, unknown>;
  details?: { family?: string };
}

/** Extract context length from an Ollama `/api/show` response. The exact
 * key is family-prefixed (e.g. "llama.context_length"); unverified against
 * a real running server, so any lookup failure just leaves contextWindow
 * undefined (rules/Pi-defaults apply). */
function extractContextLength(show: OllamaShowResponse): number | undefined {
  const info = show.model_info;
  if (!info) return undefined;

  const family = show.details?.family;
  if (family) {
    const keyed = info[`${family}.context_length`];
    if (typeof keyed === 'number') return keyed;
  }

  // Fallback: scan for any "*.context_length" key.
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith('.context_length') && typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

function readTagModels(payload: unknown): OllamaTagModel[] {
  if (!payload || typeof payload !== 'object') return [];
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];

  return models
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
    .map((entry) => ({
      name: typeof entry.name === 'string' ? entry.name : '',
      model: typeof entry.model === 'string' ? entry.model : undefined,
      size: typeof entry.size === 'number' ? entry.size : undefined,
      digest: typeof entry.digest === 'string' ? entry.digest : undefined,
      details:
        entry.details && typeof entry.details === 'object'
          ? {
              family:
                typeof (entry.details as { family?: unknown }).family === 'string'
                  ? (entry.details as { family: string }).family
                  : undefined,
              parameter_size:
                typeof (entry.details as { parameter_size?: unknown }).parameter_size === 'string'
                  ? (entry.details as { parameter_size: string }).parameter_size
                  : undefined,
              quantization_level:
                typeof (entry.details as { quantization_level?: unknown }).quantization_level === 'string'
                  ? (entry.details as { quantization_level: string }).quantization_level
                  : undefined,
            }
          : undefined,
    }))
    .filter((entry) => entry.name.length > 0);
}

/**
 * Discover models from an Ollama server via its native API:
 * `GET {url}/api/tags` for the model list, then `POST {url}/api/show` per
 * model for context-length metadata. Endpoint shapes are unverified against
 * a real running server — must fail gracefully. Never throws.
 */
export const discoverOllamaModels: DiscoverModels = async (server: ServerEntry): Promise<NormalizedModel[]> => {
  const headers = resolveHeaders(server.headers);

  let tagsPayload: unknown;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${server.url}/api/tags`, { signal: controller.signal, headers });
      if (!response.ok) throw new Error(`Ollama HTTP status: ${response.status}`);
      tagsPayload = (await response.json()) as OllamaTagsResponse;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    logWarn(`Ollama discovery failed for ${server.url}`, error);
    return [];
  }

  const entries = readTagModels(tagsPayload);
  const results = await Promise.allSettled(
    entries.map(async (entry): Promise<NormalizedModel> => {
      let contextWindow: number | undefined;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        try {
          const response = await fetch(`${server.url}/api/show`, {
            method: 'POST',
            signal: controller.signal,
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: entry.name }),
          });
          if (response.ok) {
            const show = (await response.json()) as OllamaShowResponse;
            contextWindow = extractContextLength(show);
          }
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        logWarn(`Ollama /api/show failed for ${entry.name}`, error);
      }

      return {
        id: entry.name,
        displayName: entry.name,
        contextWindow,
        maxTokens: undefined,
        reasoning: undefined,
      };
    }),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<NormalizedModel> => r.status === 'fulfilled')
    .map((r) => r.value);
};
