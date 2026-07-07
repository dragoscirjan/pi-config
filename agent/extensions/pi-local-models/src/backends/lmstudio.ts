import type { DiscoverModels, NormalizedModel, ServerEntry } from "../types.js";
import { resolveHeaders } from "../config.js";
import { logWarn } from "../log.js";

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

/**
 * Discover models from an LM Studio server via its native API.
 * `GET {url}/api/v1/models` — carried over from the original pi-lmstudio
 * extension (known-good). Never throws; returns `[]` on any failure.
 */
export const discoverLMStudioModels: DiscoverModels = async (server: ServerEntry): Promise<NormalizedModel[]> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  const headers = resolveHeaders(server.headers);

  try {
    const response = await fetch(`${server.url}/api/v1/models`, { signal: controller.signal, headers });
    if (!response.ok) throw new Error(`LM Studio HTTP status: ${response.status}`);

    const data = (await response.json()) as { models?: LMStudioModel[] };
    const models = (data.models ?? []).filter((m) => m.type === "llm");

    return models.map((m) => ({
      id: m.key,
      displayName: m.display_name,
      contextWindow: m.loaded_instances?.[0]?.config.context_length ?? m.max_context_length,
      maxTokens: m.max_context_length,
      reasoning: m.capabilities?.reasoning !== undefined,
      vision: m.capabilities?.vision,
    }));
  } catch (error) {
    logWarn(`LM Studio discovery failed for ${server.url}`, error);
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
};
