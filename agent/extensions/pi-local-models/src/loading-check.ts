import type { ServerEntry } from "./types.js";
import { resolveHeaders } from "./config.js";

interface LMStudioModelsResponse {
  models?: Array<{ key: string; loaded_instances?: unknown[] }>;
}

/**
 * Checks whether a given LM Studio model id is currently loaded into memory,
 * via the same native `/api/v1/models` endpoint used for discovery.
 *
 * Fails open (returns `true`, i.e. "assume loaded") on any error — a false
 * negative here would just skip showing the loading indicator, whereas a
 * false positive would incorrectly show it forever, so failing open is the
 * safer default. Uses a short timeout since this runs on the hot path of
 * every request.
 */
export async function isLMStudioModelLoaded(server: ServerEntry, modelId: string): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);

  try {
    const headers = resolveHeaders(server.headers);
    const response = await fetch(`${server.url}/api/v1/models`, { signal: controller.signal, headers });
    if (!response.ok) return true;

    const data = (await response.json()) as LMStudioModelsResponse;
    const model = (data.models ?? []).find((m) => m.key === modelId);
    if (!model) return true;

    return (model.loaded_instances?.length ?? 0) > 0;
  } catch {
    return true;
  } finally {
    clearTimeout(timeoutId);
  }
}
