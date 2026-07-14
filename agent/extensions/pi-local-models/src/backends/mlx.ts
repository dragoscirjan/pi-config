import { resolveHeaders } from '../config.js';
import { logWarn } from '../log.js';
import type { DiscoverModels, NormalizedModel, ServerEntry } from '../types.js';

interface OpenAIModelsResponse {
  data?: Array<{ id: string }>;
}

/**
 * Discover models from an MLX server (mlx_lm.server / mlx-omni-server):
 * `GET {url}/v1/models` (OpenAI-compat only) — no richer metadata is
 * available from either server implementation. This backend relies almost
 * entirely on `rules[]` for accurate contextWindow/maxTokens/reasoning,
 * which is explicitly acceptable per the rule-based-tagging design. Must
 * fail gracefully; never throws.
 */
export const discoverMlxModels: DiscoverModels = async (server: ServerEntry): Promise<NormalizedModel[]> => {
  const headers = resolveHeaders(server.headers);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${server.url}/v1/models`, { signal: controller.signal, headers });
      if (!response.ok) throw new Error(`MLX HTTP status: ${response.status}`);
      const data = (await response.json()) as OpenAIModelsResponse;
      return (data.data ?? []).map((m) => ({
        id: m.id,
        displayName: m.id,
        contextWindow: undefined,
        maxTokens: undefined,
        reasoning: undefined,
      }));
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    logWarn(`MLX discovery failed for ${server.url}`, error);
    return [];
  }
};
