import type { DiscoverModels, NormalizedModel, ServerEntry } from "../types.js";
import { resolveHeaders } from "../config.js";
import { logWarn } from "../log.js";

interface OpenAIModelsResponse {
  data?: Array<{ id: string }>;
}

interface LlamaCppPropsResponse {
  default_generation_settings?: { n_ctx?: number };
}

/**
 * Discover models from a llama.cpp server: `GET {url}/v1/models`
 * (OpenAI-compat, list only) + `GET {url}/props` (native, context size).
 * llama.cpp server typically hosts a single loaded model, so the reported
 * `n_ctx` applies to whatever id(s) `/v1/models` lists. Endpoint shapes are
 * unverified against a real running server — must fail gracefully.
 */
export const discoverLlamaCppModels: DiscoverModels = async (server: ServerEntry): Promise<NormalizedModel[]> => {
  const headers = resolveHeaders(server.headers);

  let modelIds: string[];
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${server.url}/v1/models`, { signal: controller.signal, headers });
      if (!response.ok) throw new Error(`llama.cpp HTTP status: ${response.status}`);
      const data = (await response.json()) as OpenAIModelsResponse;
      modelIds = (data.data ?? []).map((m) => m.id);
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    logWarn(`llama.cpp discovery failed for ${server.url}`, error);
    return [];
  }

  if (modelIds.length === 0) return [];

  let contextWindow: number | undefined;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${server.url}/props`, { signal: controller.signal, headers });
      if (response.ok) {
        const props = (await response.json()) as LlamaCppPropsResponse;
        contextWindow = props.default_generation_settings?.n_ctx;
      }
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    logWarn(`llama.cpp /props failed for ${server.url}`, error);
  }

  return modelIds.map((id) => ({
    id,
    displayName: id,
    contextWindow,
    maxTokens: undefined,
    reasoning: undefined,
  }));
};
