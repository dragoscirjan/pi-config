---
id: ""
type: lld
title: "Provider-key scoped rules and backend mapping for pi-local-models"
version: 3
status: draft
opencode-agent: lead-engineer
---

# Provider-key scoped rules and backend mapping for pi-local-models

## 1. Goal

Extend `pi-local-models` to support:

1. provider-key-scoped rules (already introduced in v3), and
2. arbitrary provider keys in `backends` mapped to concrete backend adapters.

New hard requirement:

- If `backend` is omitted for a provider key, default backend is `lmstudio`.

## 2. Scope

### In scope

- Rule schema extension with optional `providerKey`.
- Rule application update to evaluate provider-scoped and global rules together with deterministic precedence.
- `backends` schema support for arbitrary provider keys.
- Backend resolver logic: explicit backend -> legacy fixed-key fallback -> default `lmstudio`.
- Provider naming updates keyed by provider key (not backend key) with existing collision suffix behavior.
- Unit tests for matching precedence and backward compatibility.
- Unit tests for backend mapping/default behavior.
- README update for `pi-local-models` rule syntax examples.

### Out of scope

- New backend adapters (still limited to `lmstudio|ollama|llamacpp|mlx`).
- Cross-extension changes.

## 3. Proposed rule contract

Current rule shape:

```json
{
  "match": "qwen",
  "type": "string",
  "options": { "contextWindow": 131072 }
}
```

Extended rule shape:

```json
{
  "providerKey": "studio-remote",
  "match": "qwen",
  "type": "string",
  "options": { "contextWindow": 65536, "maxTokens": 8192 }
}
```

Semantics:

- `providerKey` omitted -> rule is global.
- `providerKey` present -> rule applies only when configured provider key equals `providerKey`.

## 4. Backend/provider-key contract

Current (legacy fixed-key shape):

```json
{
  "backends": {
    "lmstudio": { "urls": [{ "url": "http://127.0.0.1:1234" }] },
    "ollama": { "urls": [{ "url": "http://127.0.0.1:11434" }] }
  }
}
```

Extended shape (arbitrary provider keys):

```json
{
  "backends": {
    "studio-main": {
      "urls": [{ "url": "http://127.0.0.1:1234" }]
    },
    "studio-remote": {
      "backend": "lmstudio",
      "urls": [{ "url": "http://192.168.86.38:1234" }]
    },
    "ollama-lab": {
      "backend": "ollama",
      "urls": [{ "url": "http://127.0.0.1:11434" }]
    }
  }
}
```

Resolution semantics per provider key:

1. valid explicit `backend` -> use it,
2. else if provider key itself is a known backend name -> use that (legacy compatibility),
3. else -> default to `lmstudio`.

Provider registration names derive from **provider key**:

- single unnamed server: `<providerKey>`
- otherwise: `<providerKey>/<serverName|default>`

## 5. Precedence and merge order

For one model, process matching rules in this effective order:

1. global matching rules (in declaration order)
2. provider-scoped matching rules for the current provider key (in declaration order)

This ensures provider-specific values override global values while preserving predictable rule ordering inside each scope.

## 6. File changes

1. `agent/extensions/pi-local-models/src/types.ts`
   - Keep optional `providerKey?: string` in `Rule`.
   - Change `backends` from fixed keys to `Record<string, ProviderKeyConfig | BackendConfig>`.
   - Add optional `backend?: BackendName` to provider-key config with documented default `lmstudio`.

2. `agent/extensions/pi-local-models/src/rules.ts`
   - Update `applyRules` signature to accept current `providerKey`.
   - Partition matching rules into global/provider-scoped and apply with precedence above.
   - Keep existing defaults and model/id/displayName matching behavior unchanged.

3. `agent/extensions/pi-local-models/src/sync.ts`
   - Pass each configured `providerKey` into `applyRules(...)`.
   - Add backend resolver for arbitrary provider keys.
   - Refactor server collection to iterate all provider keys, not just fixed backend names.
   - Keep collision suffixing (`~2`, `~3`, ...).

4. `agent/extensions/pi-local-models/src/*.test.ts` (new/updated)
   - Add unit tests for:
     - backward compatibility (global rules only),
     - provider-scoped override over global,
     - non-matching providerKey ignored,
      - ordered override behavior remains stable.
      - backend resolution priority and default-to-lmstudio behavior.
      - provider-key-based naming and collision behavior.

5. `agent/extensions/pi-local-models/README.md`
   - Document new `providerKey` field and examples.

## 7. Compatibility

- Existing fixed-key backend configs continue to work unchanged.
- Existing rules keep identical behavior when `providerKey` is absent.
- Unknown provider keys without explicit backend now map to `lmstudio` by default.

## 8. Validation plan

From `agent/extensions/pi-local-models`:

1. `npm run test`
2. `npm run lint`
3. `npm run format`
4. `npm run typecheck`

Then from repo root:

5. `npm run test`

## 9. Risks / mitigations

1. **Ambiguous provider key expectations**
   - Mitigation: document that `providerKey` matches the configured provider key (for example `studio-main`, `studio-remote`, `ollama-lab`), not derived provider names.

2. **Unintended precedence regression**
   - Mitigation: explicit unit tests for global vs provider-scoped merge order.

3. **Unexpected backend defaulting for typoed provider keys**
   - Mitigation: document default behavior clearly and encourage explicit `backend` for non-LMStudio providers.
