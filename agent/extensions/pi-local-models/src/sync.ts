import type { ExtensionAPI, ProviderConfig } from '@mariozechner/pi-coding-agent';
import { discoverLlamaCppModels } from './backends/llamacpp.js';
import { discoverLMStudioModels } from './backends/lmstudio.js';
import { discoverMlxModels } from './backends/mlx.js';
import { discoverOllamaModels } from './backends/ollama.js';
import { loadConfig, resolveHeaders } from './config.js';
import { applyRules } from './rules.js';
import type { BackendConfig, BackendName, DiscoverModels, ServerEntry } from './types.js';

/** Maps each supported backend to its discovery function. */
const DISCOVER_BY_BACKEND: Record<BackendName, DiscoverModels> = {
  lmstudio: discoverLMStudioModels,
  ollama: discoverOllamaModels,
  llamacpp: discoverLlamaCppModels,
  mlx: discoverMlxModels,
};

/**
 * Compute the provider name for a server entry, per LLD §6:
 * - Bare `<backend>` when the backend has exactly one server and it has no
 *   explicit `name` (the common single-server case).
 * - `<backend>/<serverName>` otherwise (multiple servers, or an explicitly
 *   named single server).
 */
function providerNameFor(backend: BackendName, server: ServerEntry, totalServers: number): string {
  if (totalServers === 1 && !server.name) return backend;
  return `${backend}/${server.name ?? 'default'}`;
}

/**
 * Build the flat list of { backend, server, providerName } entries to sync,
 * across all configured backends.
 */
function collectServers(backends: {
  lmstudio?: BackendConfig;
  ollama?: BackendConfig;
  llamacpp?: BackendConfig;
  mlx?: BackendConfig;
}): Array<{ backend: BackendName; server: ServerEntry; providerName: string }> {
  const entries: Array<{ backend: BackendName; server: ServerEntry; providerName: string }> = [];

  for (const backend of Object.keys(DISCOVER_BY_BACKEND) as BackendName[]) {
    const config = backends[backend];
    if (!config || !Array.isArray(config.urls) || config.urls.length === 0) continue;

    for (const server of config.urls) {
      entries.push({
        backend,
        server,
        providerName: providerNameFor(backend, server, config.urls.length),
      });
    }
  }

  return entries;
}

/**
 * Create a `syncProviders()` closure bound to a given `pi: ExtensionAPI`.
 * Tracks previously-registered provider names across cycles (in `registered`)
 * so servers that become unreachable are cleanly unregistered — mirrors the
 * original pi-lmstudio's Set-diffing reconciliation, generalized across all
 * 4 backends.
 */
export interface SyncProviders {
  (): Promise<void>;
  /** Look up the backend + server entry a registered provider name maps to. */
  getServer(providerName: string): { backend: BackendName; server: ServerEntry } | undefined;
}

export function createSyncProviders(pi: ExtensionAPI): SyncProviders {
  let registered = new Set<string>();
  let serverByProvider = new Map<string, { backend: BackendName; server: ServerEntry }>();

  const syncProviders = async function syncProviders(): Promise<void> {
    const config = loadConfig();
    const rules = config.rules ?? [];
    const servers = collectServers(config.backends);

    const results = await Promise.allSettled(
      servers.map(async ({ backend, server, providerName }) => {
        const discover = DISCOVER_BY_BACKEND[backend];
        const models = await discover(server);
        return { backend, providerName, server, models };
      }),
    );

    const nowRegistered = new Set<string>();
    const nowServerByProvider = new Map<string, { backend: BackendName; server: ServerEntry }>();

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { backend, providerName, server, models } = result.value;
      if (models.length === 0) continue;

      const providerModels = models.map((model) => applyRules(model, rules));
      const headers = resolveHeaders(server.headers);

      const providerConfig: ProviderConfig = {
        baseUrl: `${server.url}/v1/`,
        api: 'openai-completions',
        models: providerModels,
        // Local servers generally don't require real auth; the backend name
        // is used as a stable placeholder API key. Real auth (if any) is
        // carried entirely via `headers`, resolved from ServerEntry.headers[].
        apiKey: backend,
        authHeader: false,
        headers,
      };

      pi.registerProvider(providerName, providerConfig);
      nowRegistered.add(providerName);
      nowServerByProvider.set(providerName, { backend, server });
    }

    for (const name of registered) {
      if (!nowRegistered.has(name)) {
        pi.unregisterProvider(name);
      }
    }

    registered = nowRegistered;
    serverByProvider = nowServerByProvider;
  } as SyncProviders;

  syncProviders.getServer = (providerName: string) => serverByProvider.get(providerName);

  return syncProviders;
}
