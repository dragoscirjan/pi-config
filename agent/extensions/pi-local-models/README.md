# pi-local-models

`pi-local-models` discovers models from local inference servers and registers them as Pi providers.

It is designed for mixed local stacks and normalizes backend differences behind one provider sync pipeline.

## Backends supported

- `lmstudio`
- `ollama`
- `llamacpp`
- `mlx`

Backends are discovered independently, then merged into a single provider set via set-diff reconciliation (register current, unregister stale).

## Config file

Path resolution follows Pi profile semantics:

- `PI_CODING_AGENT_DIR/local-models.json` if `PI_CODING_AGENT_DIR` is set
- otherwise `~/.pi/agent/local-models.json`

Example (arbitrary provider keys):

```json
{
  "backends": {
    "studio-main": {
      "urls": [{ "url": "http://127.0.0.1:1234" }]
    },
    "studio-remote": {
      "backend": "lmstudio",
      "urls": [{ "url": "http://192.168.86.38:1234", "name": "gpu-a" }]
    },
    "ollama-lab": {
      "backend": "ollama",
      "urls": [{ "url": "http://127.0.0.1:11434" }]
    },
    "llama-gateway": {
      "backend": "llamacpp",
      "urls": [{ "url": "http://127.0.0.1:8080", "name": "gpu-a" }]
    },
    "mlx-edge": {
      "backend": "mlx",
      "urls": [{ "url": "http://127.0.0.1:8000", "headers": ["Authorization: Bearer $MLX_TOKEN"] }]
    }
  },
  "rules": [
    {
      "type": "regex",
      "match": "(qwen|deepseek).*(coder|instruct)",
      "options": { "reasoning": true, "contextWindow": 131072 }
    },
    {
      "type": "string",
      "match": ":7b",
      "options": { "maxTokens": 8192 }
    }
  ]
}
```

## Discovery behavior by backend

### LM Studio

- Endpoint: `GET /api/v1/models`
- Uses native LM Studio fields:
  - context from `loaded_instances[0].config.context_length` (fallback `max_context_length`)
  - reasoning/vision from capability metadata
- Also used for loaded-model checks on request hot path.

### Ollama

- Endpoints:
  - `GET /api/tags` (model list)
  - `POST /api/show` (per-model metadata)
- Adds payload-shape guards before parsing tags payload.
- Extracts context length from family-specific or `*.context_length` keys when present.

### llama.cpp

- Endpoints:
  - `GET /v1/models`
  - `GET /props`
- Applies `props.default_generation_settings.n_ctx` context across discovered model ids.

### MLX

- Endpoint: `GET /v1/models`
- Only id-level metadata is usually available.
- This backend commonly relies on `rules[]` to provide `contextWindow`, `maxTokens`, and `reasoning` annotations.

All backend discovery calls are timeout-bound and fail gracefully (return empty list for that backend/server instead of crashing extension init).

## Rule engine (important)

Rules are applied in-order to each discovered model.

Rule scope supports both global and provider-key-specific behavior:

- `providerKey` omitted -> global rule (all providers)
- `providerKey` set -> only applies to that exact configured provider key

Backend mapping per provider key:

- if `backend` is explicitly set and valid, use it,
- else if provider key itself is a known backend key (`lmstudio`, `ollama`, `llamacpp`, `mlx`), use that (legacy mode),
- else default to `lmstudio`.

Precedence is always:

1. global matches (declaration order)
2. provider-scoped matches for the current provider key (declaration order)

This lets you define baseline capability annotations globally, then override for specific machines/providers.

- Match target: **both** `id` and `displayName` (OR semantics).
- Rule types:
  - `regex` (case-insensitive)
  - `string` (substring contains)
- Cascade behavior: later rules override fields from earlier rules.
- Precedence: explicit rule values override backend auto-detected values.

Rule options currently supported:

- `contextWindow`
- `maxTokens`
- `reasoning`

### Provider-key examples

```json
{
  "rules": [
    {
      "type": "regex",
      "match": "(qwen|deepseek).*(coder|instruct)",
      "options": { "reasoning": true, "contextWindow": 131072 }
    },
    {
      "providerKey": "studio-remote",
      "type": "string",
      "match": "qwen2.5-coder:32b",
      "options": { "maxTokens": 32768 }
    },
    {
      "providerKey": "ollama-lab",
      "type": "string",
      "match": ":7b",
      "options": { "maxTokens": 4096 }
    }
  ]
}
```

In this example:

- global reasoning/context defaults apply everywhere,
- `studio-remote` gets a larger `maxTokens` override for one model,
- `ollama-lab` applies a tighter cap for `:7b` variants.

If still unset after discovery + rules, Pi-compatible defaults are applied:

- `contextWindow: 128000`
- `maxTokens: 16384`
- `reasoning: false`
- `input: ["text"]` (or `['text','image']` if backend reports vision)

## Headers and env interpolation

Per-server header lines (`"Name: Value"`) are converted to provider headers.

Supported interpolation in header values:

- `$VAR`
- `${VAR}`
- `$$` -> literal `$`

Invalid header lines (missing `:` or empty name) are skipped with warnings.

## Provider naming and collision handling

Provider naming policy:

- single unnamed server for a provider key -> `<providerKey>`
- otherwise -> `<providerKey>/<serverName|default>`

If two servers resolve to same provider name, suffixes are appended automatically:

- `name`, `name~2`, `name~3`, ...

## Lifecycle and sync strategy

- Initial silent sync at extension load (covers non-interactive listing paths).
- `session_start`: notifier is attached to `ctx.ui.notify`; sync runs with visible warnings.
- `agent_start`: resets cycle gate.
- `message_end` (assistant only): one silent re-sync per turn.

Internally, sync uses set-diff reconciliation:

- registers all currently discovered providers,
- unregisters providers missing from current cycle.

## LM Studio loaded-state UX

On `before_provider_request`, for LM Studio providers only:

- checks whether selected model is loaded,
- if not loaded, sets working message `⏳ loading model…`.

Optimization:

- short TTL cache (5s)
- in-flight promise deduplication per `serverUrl::modelId`

After response (`after_provider_response`), working message is cleared.

The underlying loaded check is fail-open: on timeout/error it assumes "loaded" to avoid misleading perpetual loading indicators.

## Development

From `agent/extensions/pi-local-models`:

- `npm run lint`
- `npm run format`
- `npm run typecheck`
- `npm run test`
