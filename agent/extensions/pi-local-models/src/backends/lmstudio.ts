import { resolveHeaders } from '../config.js';
import { logWarn } from '../log.js';
import type { DiscoverModels, NormalizedModel, ServerEntry } from '../types.js';

interface LMStudioModel {
  type: string;
  key: string;
  display_name: string;
  max_context_length: number;
  capabilities?: {
    vision?: boolean;
    reasoning?: { allowed_options: string[]; default: string };
  };
  loaded_instances?: Array<{ config: { context_length: number } }>;
}

interface LMStudioNativeResponse {
  models?: LMStudioModel[];
}

interface OpenAICompatModelsResponse {
  data?: Array<{ id: string }>;
}

async function fetchJsonWithTimeout(url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) throw new Error(`HTTP status: ${response.status}`);
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timeoutId);
  }
}

function mapNativeModels(models: LMStudioModel[]): NormalizedModel[] {
  return models.map((m) => ({
    id: m.key,
    displayName: m.display_name,
    contextWindow: m.loaded_instances?.[0]?.config.context_length ?? m.max_context_length,
    maxTokens: m.max_context_length,
    reasoning: m.capabilities?.reasoning !== undefined,
    vision: m.capabilities?.vision,
  }));
}

function mapOpenAIModels(data: OpenAICompatModelsResponse): NormalizedModel[] {
  return (data.data ?? []).map((m) => ({
    id: m.id,
    displayName: m.id,
    contextWindow: undefined,
    maxTokens: undefined,
    reasoning: undefined,
    vision: undefined,
  }));
}

/**
 * Discover models from an LM Studio server via its native API.
 * `GET {url}/api/v1/models` — carried over from the original pi-lmstudio
 * extension (known-good). Never throws; returns `[]` on any failure.
 */
export const discoverLMStudioModels: DiscoverModels = async (server: ServerEntry): Promise<NormalizedModel[]> => {
  const headers = resolveHeaders(server.headers);

  try {
    // 1) Native LM Studio endpoint shape: { models: [...] }
    try {
      const nativeResponse = (await fetchJsonWithTimeout(
        `${server.url}/api/v1/models`,
        headers,
      )) as LMStudioNativeResponse;
      const nativeModels = (nativeResponse.models ?? []).filter((m) => m.type === 'llm');
      if (nativeModels.length > 0) return mapNativeModels(nativeModels);
    } catch {
      // fall through to OpenAI-compat fallback
    }

    // 2) OpenAI-compatible endpoint shape: { data: [...] }
    const openAiResponse = (await fetchJsonWithTimeout(
      `${server.url}/v1/models`,
      headers,
    )) as OpenAICompatModelsResponse;
    const openAiModels = mapOpenAIModels(openAiResponse);
    if (openAiModels.length > 0) return openAiModels;

    logWarn(`LM Studio discovery returned no models for ${server.url}`);
    return [];
  } catch (error) {
    logWarn(`LM Studio discovery failed for ${server.url}`, error);
    return [];
  }
};
