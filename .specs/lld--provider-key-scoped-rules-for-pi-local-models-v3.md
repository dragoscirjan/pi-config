---
id: ""
type: lld
title: "Provider-key scoped rules for pi-local-models"
version: 3
status: draft
opencode-agent: lead-engineer
---

# Provider-key scoped rules for pi-local-models

## 1. Goal

Extend `pi-local-models` rule matching to support machine/provider-scoped rules using `providerKey`, while keeping existing global rules fully backward-compatible.

Desired behavior:

- Rules with `providerKey` apply only to models discovered under that provider key.
- Rules without `providerKey` remain global and apply to any matching model.

## 2. Scope

### In scope

- Rule schema extension with optional `providerKey`.
- Rule application update to evaluate provider-scoped and global rules together with deterministic precedence.
- Unit tests for matching precedence and backward compatibility.
- README update for `pi-local-models` rule syntax examples.

### Out of scope

- Backend discovery logic changes.
- New regex matching for provider keys (follow-up only if needed).
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
  "providerKey": "lmstu1io",
  "match": "qwen",
  "type": "string",
  "options": { "contextWindow": 65536, "maxTokens": 8192 }
}
```

Semantics:

- `providerKey` omitted -> rule is global.
- `providerKey` present -> rule applies only when discovered provider name equals `providerKey`.

## 4. Precedence and merge order

For one model, process matching rules in this effective order:

1. global matching rules (in declaration order)
2. provider-scoped matching rules for the current provider key (in declaration order)

This ensures provider-specific values override global values while preserving predictable rule ordering inside each scope.

## 5. File changes

1. `agent/extensions/pi-local-models/src/types.ts`
   - Add optional `providerKey?: string` to `Rule`.

2. `agent/extensions/pi-local-models/src/rules.ts`
   - Update `applyRules` signature to accept current `providerKey`.
   - Partition matching rules into global/provider-scoped and apply with precedence above.
   - Keep existing defaults and model/id/displayName matching behavior unchanged.

3. `agent/extensions/pi-local-models/src/sync.ts`
   - Pass each computed `providerName` into `applyRules(...)`.

4. `agent/extensions/pi-local-models/*.test.ts` (new)
   - Add unit tests for:
     - backward compatibility (global rules only),
     - provider-scoped override over global,
     - non-matching providerKey ignored,
     - ordered override behavior remains stable.

5. `agent/extensions/pi-local-models/README.md`
   - Document new `providerKey` field and examples.

## 6. Compatibility

- Existing configs require no change.
- Existing rules keep identical behavior when `providerKey` is absent.

## 7. Validation plan

From `agent/extensions/pi-local-models`:

1. `npm run test`
2. `npm run lint`
3. `npm run format`
4. `npm run typecheck`

Then from repo root:

5. `npm run test`

## 8. Risks / mitigations

1. **Ambiguous provider key expectations**
   - Mitigation: document that `providerKey` matches the registered provider name (e.g. `lmstudio`, `lmstudio/default`, `lmstu1io`).

2. **Unintended precedence regression**
   - Mitigation: explicit unit tests for global vs provider-scoped merge order.
