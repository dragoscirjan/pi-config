# pi-local-models

Local provider discovery/sync extension for Pi.

It discovers models from configured local backends and registers them as Pi providers.

## Supported backends

- LM Studio
- Ollama
- llama.cpp
- MLX

## Configuration

Main config file: `agent/local-models.json`

Minimal example:

```json
{
  "backends": {
    "lmstudio": { "urls": [{ "url": "http://127.0.0.1:1234" }] },
    "ollama": { "urls": [{ "url": "http://127.0.0.1:11434" }] },
    "llamacpp": { "urls": [{ "url": "http://127.0.0.1:8080" }] }
  },
  "rules": []
}
```

### Rules

Rule matching supports model id/display-name patterns (string/regex) and can annotate discovered models (for example context window, reasoning flag, max tokens) where backend metadata is incomplete.

### Env interpolation

Header/config values support embedded interpolation:

- `$VAR`
- `${VAR}`
- `$$` (literal `$`)

## Runtime behavior

- Performs startup sync so providers are available immediately.
- Re-syncs on session lifecycle events (`session_start`, `message_end` per cycle).
- Handles provider name collisions by suffixing (`~2`, `~3`, ...).
- For LM Studio requests, checks model loaded state and shows `⏳ loading model…` when needed.
  - Includes short TTL cache + in-flight dedupe for loaded-state checks.

## Development

From this extension directory:

- `npm run lint`
- `npm run format`
- `npm run typecheck`
- `npm run test`
