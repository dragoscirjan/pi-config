---
id: "00001"
type: lld
title: "pi-local-models Multi-Backend Extension"
version: 1
status: draft
opencode-agent: lead-engineer
---

# pi-local-models Multi-Backend Extension

## 1. Overview & Goals

Replace the existing `pi-lmstudio` npm extension (single-file, LM Studio-only, bare-bones model mapping — always zero cost, no compat flags) with a new local, self-contained extension `pi-local-models` that:

- Discovers models from **four** local LLM server backends: **LM Studio**, **Ollama**, **llama.cpp server**, **MLX** (mlx_lm.server / mlx-omni-server).
- Registers each reachable server as a Pi model provider via `pi.registerProvider()`, using the `openai-completions` API type (all four backends are OpenAI-completions-compatible).
- Produces `ProviderModelConfig` entries with proper `contextWindow`/`maxTokens`/`reasoning` — not hardcoded zeros — using auto-detected metadata where the backend exposes it, and a **rule-based tagging system** (regex/string match → property overrides) for backends that don't expose rich metadata (Ollama's Modelfile-derived context, llama.cpp, MLX).
- Does NOT require the user to manually enumerate every model — models are auto-discovered per server; rules only *annotate* detected models.
- Lives at `/home/dragosc/.pi/agent-local/extensions/pi-local-models/` as its own package (sibling to the existing `pi-twig` package at `/home/dragosc/.pi/agent-local/extensions/`), registered via the `extensions` array (absolute path) in `/home/dragosc/.pi/agent-local/settings.json` — NOT published to npm.

Out of scope for v1: cost tracking (always zero, consistent with local/free inference), `compat.*` flags, `thinkingLevelMap`, OAuth, `image` input detection beyond what LM Studio's native API already exposes, context-overflow error rewriting (documented as future work in §10).

## 2. Architecture

```
pi-local-models/
├── package.json          # ESM, "type": "module", deps: @mariozechner/pi-coding-agent ^0.73.1 (matches pi-twig)
├── tsconfig.json          # mirrors pi-twig's tsconfig
├── index.ts               # extension entrypoint: factory, event wiring, orchestration
└── src/
    ├── types.ts            # shared TS interfaces (config shape, normalized model shape, rule shape)
    ├── config.ts            # load/validate ~/.pi/agent/local-models.json, value resolution ($ENV_VAR, literal)
    ├── rules.ts              # rule matching + cascade/merge engine
    ├── sync.ts                # provider registration/reconciliation engine (backend-agnostic)
    └── backends/
        ├── lmstudio.ts         # GET {url}/api/v1/models
        ├── ollama.ts            # GET {url}/api/tags + GET {url}/api/show per model
        ├── llamacpp.ts           # GET {url}/v1/models + GET {url}/props
        └── mlx.ts                # GET {url}/v1/models (minimal)
```

Data flow per sync cycle:

1. `index.ts` loads config (`config.ts`) — re-read on every sync cycle (mirrors pi's own `models.json` hot-reload behavior, no restart needed for config edits).
2. For each backend × each configured server (`urls[]` entry), call that backend's `discoverModels(server): Promise<NormalizedModel[]>` in parallel (`Promise.allSettled`).
3. Each `NormalizedModel` (id, displayName, contextWindow?, maxTokens?, reasoning?, vision?) is passed through `rules.ts` → `applyRules(model, rules): ProviderModelConfig` to produce the final `ProviderModelConfig`, merging auto-detected values with rule-based overrides (rule overrides win over auto-detected values, since rules represent explicit user intent).
4. `sync.ts` registers/unregisters providers per backend/server based on reachability, using the same Set-diffing reconciliation pattern as the original `pi-lmstudio`.

Each backend module exports one function with an identical signature so `sync.ts` stays backend-agnostic:

```typescript
export interface NormalizedModel {
  id: string;              // model identifier to send to the API
  displayName: string;     // human label (falls back to id if backend has no better name)
  contextWindow?: number;  // undefined if backend can't expose it (e.g. MLX, most llama.cpp) — rules/defaults fill the gap
  maxTokens?: number;
  reasoning?: boolean;
  vision?: boolean;        // maps to input: ["text","image"] when true
}

export type DiscoverModels = (server: ServerEntry) => Promise<NormalizedModel[]>;
```

## 3. Config Schema

File: `~/.pi/agent/local-models.json`. Reloaded on every sync cycle (no restart required, mirrors Pi's own `models.json` behavior).

```typescript
interface ServerEntry {
  name: string;         // required only when multiple servers configured for a backend; "default" if omitted and only one entry
  url: string;           // e.g. "http://127.0.0.1:1234"
  headers?: string[];     // optional raw header lines, e.g. ["Authorization: Bearer $MY_TOKEN", "X-Gateway-Key: $GW_KEY"]
                          // each entry is "Name: Value"; value portion supports $ENV_VAR interpolation.
                          // Lets gateways/proxies that need more than a single bearer token (e.g. multiple
                          // custom headers) be configured, not just LM-Studio-style single-token auth.
}

interface BackendConfig {
  urls: ServerEntry[];
}

interface Rule {
  match: string;               // regex pattern or literal string, per `type`
  type: "regex" | "string";
  options: {
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
  };
}

interface LocalModelsConfig {
  backends: {
    lmstudio?: BackendConfig;
    ollama?: BackendConfig;
    llamacpp?: BackendConfig;
    mlx?: BackendConfig;
  };
  rules?: Rule[];
}
```

Example:

```jsonc
{
  "backends": {
    "lmstudio": { "urls": [{ "name": "default", "url": "http://127.0.0.1:1234" }] },
    "ollama":   { "urls": [{ "name": "default", "url": "http://127.0.0.1:11434" }] },
    "llamacpp": { "urls": [{ "name": "default", "url": "http://127.0.0.1:8080" }] },
    "mlx":      { "urls": [{ "name": "default", "url": "http://127.0.0.1:8000" }] }
  },
  "rules": [
    { "match": "gemma|qwen.*coder", "type": "regex",  "options": { "contextWindow": 100000, "maxTokens": 20000 } },
    { "match": "llama-3.1-8b",      "type": "string", "options": { "contextWindow": 128000, "maxTokens": 8192, "reasoning": false } }
  ]
}
```

Value resolution for each `headers[]` entry's value portion (after `Name: `) reuses the same syntax as Pi's own `apiKey`/`headers` resolution (`$ENV_VAR` / `${ENV_VAR}` interpolation, `$$`→`$` escape; literal otherwise). Each raw string is split on the first `:` into `Name`/`Value`, trimmed, resolved, and collected into a `Record<string,string>` for `ProviderConfig.headers`. Malformed entries (no `:`) are skipped with a warning. Shell-command (`!command`) resolution is explicitly OUT of scope for v1 headers (adds complexity with no clear local-server use case; can be added later if needed).

## 4. Per-Backend Discovery Modules

All endpoint assumptions below are **unverified against real running servers** — user confirmed "we will have to test." Each module must fail gracefully (return `[]` / mark server unreachable) on any fetch/parse error, never throw uncaught.

### 4.1 `lmstudio.ts` (carried over from existing pi-lmstudio, known-good)
- `GET {url}/api/v1/models` — native LM Studio API. 5s timeout via `AbortController`.
- Filter `type === "llm"`.
- Map: `id=key`, `displayName=display_name`, `contextWindow=loaded_instances[0]?.config.context_length ?? max_context_length`, `maxTokens=max_context_length`, `reasoning=capabilities?.reasoning!==undefined`, `vision=capabilities?.vision`.

### 4.2 `ollama.ts` (new — needs verification)
- `GET {url}/api/tags` → list of `{ name, model, size, digest, details: { family, parameter_size, quantization_level } }`.
- For each model, `POST {url}/api/show` with `{ name }` body → expect `{ model_info: { "<family>.context_length": number }, details, parameters }`. The exact key for context length is family-prefixed (e.g. `llama.context_length`) per Ollama's native API — **must be verified during implementation**; if unavailable, `contextWindow` stays `undefined` and rules/Pi-defaults apply.
- Map: `id=name` (the tag, e.g. `llama3.1:8b`), `displayName=name`, `contextWindow=<derived or undefined>`, `maxTokens=undefined` (Ollama has no separate max-output-tokens concept exposed; rules/Pi-defaults apply), `reasoning=undefined` (no capability flag; rely on rules).

### 4.3 `llamacpp.ts` (new — needs verification)
- `GET {url}/v1/models` (OpenAI-compat) → list of `{ id }` only, minimal.
- `GET {url}/props` (native) → `{ default_generation_settings: { n_ctx, ... }, total_slots, ... }` — llama.cpp server typically hosts a **single** loaded model, so `n_ctx` applies to whatever `id` is listed.
- Map: `id` from `/v1/models`, `displayName=id`, `contextWindow=props.default_generation_settings?.n_ctx`, `maxTokens=undefined` (rules/Pi-defaults apply), `reasoning=undefined`.

### 4.4 `mlx.ts` (new — needs verification)
- `GET {url}/v1/models` (OpenAI-compat only) → `{ id }` list, no richer metadata available from mlx_lm.server or mlx-omni-server.
- Map: `id`, `displayName=id`, `contextWindow=undefined`, `maxTokens=undefined`, `reasoning=undefined` — this backend relies almost entirely on `rules[]` for accurate settings, which is explicitly acceptable per user's rule-based-tagging requirement.

## 5. Rule Engine (`rules.ts`)

```typescript
function applyRules(model: NormalizedModel, rules: Rule[]): ProviderModelConfig {
  // Start from auto-detected values (or Pi's own defaults, left undefined so Pi applies
  // its built-in defaults: contextWindow 128000, maxTokens 16384, reasoning false, input ["text"])
  let result: Partial<ProviderModelConfig> = {
    id: model.id,
    name: model.displayName,
    ...(model.contextWindow !== undefined && { contextWindow: model.contextWindow }),
    ...(model.maxTokens !== undefined && { maxTokens: model.maxTokens }),
    ...(model.reasoning !== undefined && { reasoning: model.reasoning }),
    ...(model.vision && { input: ["text", "image"] }),
  };

  // Cascade: rules applied in array order; later matching rules override
  // fields set by earlier ones (and by auto-detection) — lets users define
  // a broad default rule followed by specific exceptions.
  for (const rule of rules) {
    const matches = rule.type === "regex"
      ? new RegExp(rule.match, "i").test(model.id) || new RegExp(rule.match, "i").test(model.displayName)
      : model.id.includes(rule.match) || model.displayName.includes(rule.match);
    if (matches) {
      result = { ...result, ...rule.options };
    }
  }

  return result as ProviderModelConfig; // fields left undefined are simply omitted; Pi applies its own defaults
}
```

Design decisions embedded above (see §8 for confirmation status):
- Rules are **global** (not nested per-backend) — a single `rules[]` list applies across all four backends, since the same model (e.g. `qwen2.5-coder`) can appear on multiple servers.
- Match target is **both** `id` and `displayName` (an OR match) — some backends only have opaque IDs, others have friendlier names.
- **Cascade/merge** semantics, not first-match-wins — rule array order matters; put general rules first, specific overrides later.
- Regex match is case-insensitive by default (`i` flag) since model naming conventions vary in casing across backends.
- Unmatched or partially-matched fields are left `undefined` in the final config so Pi's own built-in defaults apply (extension does not duplicate/hardcode Pi's defaults, avoiding drift if Pi changes them).

## 6. Provider Registration & Sync Engine (`sync.ts`)

Generalized from the original `pi-lmstudio` reconciliation logic, extended to 4 backends:

- **Naming convention:** if a backend has exactly one server entry AND it's named `"default"` (or unnamed), register as bare `<backend>` (e.g. `ollama`). If multiple entries, or a single entry with a custom name, register as `<backend>/<serverName>` (e.g. `ollama/gpu-box`, `lmstudio/laptop`). This mirrors the original pi-lmstudio single-vs-multi convention, applied uniformly to all 4 backends.
- **Reconciliation:** maintain one `Set<string>` of currently-registered provider names (across all backends) from the previous cycle. Each cycle:
  1. Run all backends' `discoverModels()` for all configured servers in parallel via `Promise.allSettled`.
  2. For each server that resolved successfully with ≥1 model, compute its provider name, run `applyRules()` on each model, resolve `server.headers[]` into a `Record<string,string>` (see §3), call `pi.registerProvider(name, { baseUrl: <server.url>/v1/, api: "openai-completions", models, apiKey: "<backend>", headers: resolvedHeaders, authHeader: false })`, add name to new registered set.
  3. For any name in the previous set but not in the new set (server now unreachable, returned zero models, or removed from config), call `pi.unregisterProvider(name)`.
  4. Replace the tracked set with the new one.
- **Keyless auth placeholder:** all servers get `apiKey: "<backend>"` (literal placeholder string, e.g. `"ollama"`) so Pi's auth-presence check doesn't hide the provider from `/model`; actual authentication (if any) is carried entirely via `headers[]` (e.g. an `Authorization: Bearer $TOKEN` entry), not via `apiKey`/`authHeader`. This is more flexible than the old single-bearer-token model — gateways/proxies needing multiple custom headers (API keys, tenant IDs, etc.) are now supported.
- **Event wiring** (unchanged from original pi-lmstudio): top-level `await syncProviders()` once at extension load; `pi.on("agent_start", ...)` resets a `fetchedThisCycle` flag; `pi.on("message_end", ...)` triggers one `syncProviders()` per turn (only for assistant messages, only once per cycle) so model lists (and newly loaded-model context sizes) stay current without excessive polling.

## 7. File List

| File | Purpose |
|---|---|
| `pi-local-models/package.json` | Package manifest (ESM, deps on `@mariozechner/pi-coding-agent`) |
| `pi-local-models/tsconfig.json` | TS config, mirrors `pi-twig` |
| `pi-local-models/index.ts` | Extension factory entrypoint; event wiring (`agent_start`, `message_end`); calls `syncProviders()` |
| `pi-local-models/src/types.ts` | `ServerEntry`, `BackendConfig`, `Rule`, `LocalModelsConfig`, `NormalizedModel`, `DiscoverModels` interfaces |
| `pi-local-models/src/config.ts` | Load/parse/validate `~/.pi/agent/local-models.json`; value resolution for `headers[]` entries |
| `pi-local-models/src/rules.ts` | `applyRules()` cascade/merge engine |
| `pi-local-models/src/sync.ts` | `syncProviders()` — orchestrates discovery across backends, naming, registration/reconciliation |
| `pi-local-models/src/backends/lmstudio.ts` | LM Studio discovery (`/api/v1/models`) |
| `pi-local-models/src/backends/ollama.ts` | Ollama discovery (`/api/tags` + `/api/show`) |
| `pi-local-models/src/backends/llamacpp.ts` | llama.cpp discovery (`/v1/models` + `/props`) |
| `pi-local-models/src/backends/mlx.ts` | MLX discovery (`/v1/models` only) |

## 8. Decisions Requiring User Confirmation

The following defaults were chosen by the lead engineer during drafting (based on prior discussion) and should be explicitly confirmed or amended:

1. **Rule scope:** global `rules[]` (not nested per-backend). *Confirm or request per-backend override capability.*
2. **Multiple rule matches:** cascade/merge in array order, later rules win per-field (not first-match-wins). *Confirm.*
3. **Match target:** rule pattern tested against both `id` and `displayName` (OR match), case-insensitive for regex. *Confirm.*
4. **Unmatched models:** left undefined so Pi's built-in defaults apply (128000/16384/false/["text"]) rather than the extension hardcoding its own copy of those defaults. *Confirm this is preferred over explicit hardcoding.*
5. **v1 rule `options` scope:** `contextWindow`, `maxTokens`, `reasoning` only — `cost`/`compat`/`thinkingLevelMap`/`input` explicitly deferred to a future version. *Confirm.*
6. **Provider naming convention:** bare `<backend>` for single default server, `<backend>/<serverName>` for multi-server — applied uniformly across all 4 backends (extending the original LM Studio-only convention). *Confirm.*
7. **Header value resolution:** only `$ENV_VAR`/literal supported for v1 (per `headers[]` entry); `!command` shell resolution deferred.
8. **Location & packaging:** local-only extension under `~/.pi/agent-local/extensions/pi-local-models/`, registered via `settings.json` `extensions` array (not published to npm, unlike old `pi-lmstudio`). *Confirm this is final, not an interim step toward npm publishing.*

## 9. Testing / Verification Strategy

- No running local LLM servers are guaranteed to be available in the dev environment — implementation must be tested incrementally as each backend server becomes available (per user: "we will have to test").
- Each backend module must degrade gracefully: fetch timeout/connection-refused/malformed-JSON → treated as "server unreachable this cycle," logged via `ctx.ui.notify` (or console warning), and excluded from registration (existing provider unregistered if it was previously registered).
- Manual verification checklist per backend (to run once each server is available locally):
  - Start server, confirm extension registers expected provider name(s) in `/model` picker.
  - Confirm `contextWindow`/`maxTokens` values match rule expectations or backend-reported values.
  - Stop server mid-session, confirm next sync cycle unregisters the provider without crashing the agent.
  - Add a `rules[]` entry matching a currently-loaded model, confirm the override takes effect on next `/model` reload.
- No automated test suite planned for v1 (network-dependent, local-only extension); revisit if this extension is later published/shared.

## 10. Migration Note

Once `pi-local-models` is validated against at least LM Studio (feature-parity check vs. old extension) and one additional backend:
- Remove `"npm:pi-lmstudio"` from `packages` in `/home/dragosc/.pi/agent-local/settings.json`.
- Remove/archive `~/.pi/agent-local/lmstudio.json` (superseded by `~/.pi/agent/local-models.json`).
- Add `pi-local-models`'s path to the `extensions` array in `settings.json`.

This migration is a manual, explicit step for the user to perform after validation — not automated as part of this implementation.

**Future work (explicitly out of scope for v1):** `cost` tracking, `compat.*` flags (e.g. `supportsReasoningEffort` for reasoning-heavy local models like `qwq`/`deepseek-r1` variants), `thinkingLevelMap`, per-backend rule overrides, `!command` token resolution, context-overflow error message rewriting (per pi.dev's custom-provider overflow-recovery mechanism) for backends that return non-standard overflow errors.

