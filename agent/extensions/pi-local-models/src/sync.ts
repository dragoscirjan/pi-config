import type { ExtensionAPI, ProviderConfig } from '@mariozechner/pi-coding-agent';
import { discoverLlamaCppModels } from './backends/llamacpp.js';
import { discoverLMStudioModels } from './backends/lmstudio.js';
import { discoverMlxModels } from './backends/mlx.js';
import { discoverOllamaModels } from './backends/ollama.js';
import { loadConfig, resolveHeaders } from './config.js';
import { logWarn } from './log.js';
import { applyRules } from './rules.js';
import type {
  BackendConfig,
  BackendName,
  DiscoverModels,
  LocalModelsConfig,
  ProviderKeyConfig,
  ServerEntry,
} from './types.js';

/** Maps each supported backend to its discovery function. */
const DISCOVER_BY_BACKEND: Record<BackendName, DiscoverModels> = {
  lmstudio: discoverLMStudioModels,
  ollama: discoverOllamaModels,
  llamacpp: discoverLlamaCppModels,
  mlx: discoverMlxModels,
};

function isBackendName(value: string): value is BackendName {
  return value in DISCOVER_BY_BACKEND;
}

/**
 * Resolve which backend adapter should be used for a configured provider key.
 *
 * Priority:
 * 1) explicit `backends.<providerKey>.backend` when present and valid,
 * 2) legacy fixed-key mode where provider key itself is a backend name,
 * 3) default backend `lmstudio` when backend is omitted.
 */
export function resolveBackendForProviderKey(
  providerKey: string,
  config: ProviderKeyConfig | BackendConfig,
): BackendName {
  if ('backend' in config && typeof config.backend === 'string' && isBackendName(config.backend)) {
    return config.backend;
  }
  if (isBackendName(providerKey)) {
    return providerKey;
  }
  return 'lmstudio';
}

/**
 * Compute the provider name for a server entry:
 * - Bare `<providerKey>` when the provider key has exactly one server and it
 *   has no explicit `name`.
 * - `<providerKey>/<serverName|default>` otherwise.
 */
function providerNameFor(providerKey: string, server: ServerEntry, totalServers: number): string {
  if (totalServers === 1 && !server.name) return providerKey;
  return `${providerKey}/${server.name ?? 'default'}`;
}

export interface CollectedServer {
  providerKey: string;
  backend: BackendName;
  server: ServerEntry;
  providerName: string;
}

/**
 * Build the flat list of { providerKey, backend, server, providerName } entries
 * to sync, across all configured provider keys.
 */
export function collectServers(backends: LocalModelsConfig['backends']): CollectedServer[] {
  const entries: CollectedServer[] = [];
  const seenProviderNames = new Set<string>();

  const ensureUniqueProviderName = (candidate: string, server: ServerEntry): string => {
    if (!seenProviderNames.has(candidate)) {
      seenProviderNames.add(candidate);
      return candidate;
    }

    let suffix = 2;
    let next = `${candidate}~${suffix}`;
    while (seenProviderNames.has(next)) {
      suffix++;
      next = `${candidate}~${suffix}`;
    }
    seenProviderNames.add(next);
    logWarn(`provider name collision for '${candidate}', renamed to '${next}' (${server.url})`);
    return next;
  };

  for (const [providerKey, config] of Object.entries(backends ?? {})) {
    if (!config || !Array.isArray(config.urls) || config.urls.length === 0) continue;
    const backend = resolveBackendForProviderKey(providerKey, config);

    for (const server of config.urls) {
      const providerName = ensureUniqueProviderName(providerNameFor(providerKey, server, config.urls.length), server);
      entries.push({
        providerKey,
        backend,
        server,
        providerName,
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
      servers.map(async ({ providerKey, backend, server, providerName }) => {
        const discover = DISCOVER_BY_BACKEND[backend];
        const models = await discover(server);
        return { providerKey, backend, providerName, server, models };
      }),
    );

    const nowRegistered = new Set<string>();
    const nowServerByProvider = new Map<string, { backend: BackendName; server: ServerEntry }>();

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { providerKey, backend, providerName, server, models } = result.value;
      if (models.length === 0) continue;

      const providerModels = models.map((model) => applyRules(model, rules, providerKey));
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
