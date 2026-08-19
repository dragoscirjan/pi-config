---
id: "00002"
type: lld
title: "Vitest tests for pi-model-recommend"
version: 2
status: draft
opencode-agent: lead-engineer
---

# Vitest tests for pi-model-recommend

## Delta from v1

Reference baseline: `.specs/lld-00002-vitest-tests-for-pi-model-recommend-v1.md`.

This v2 adds only `/active-models` behavior changes:

1. **Local provider visibility fix**
   - `/active-models` must include local providers (`lmstudio`, `ollama`, `llamacpp`, `mlx`) even when they are not listed in `auth.json`.
   - Auth filtering remains strict for commercial providers via existing `auth.ts` logic.

2. **New filters in `/active-models`**
   - `--local`: include only local providers.
   - `--commercial`: include only non-local providers.
   - If both are passed, return a clear user-facing error.

3. **Implementation scope**
   - `agent/extensions/pi-model-recommend/command-active-models.ts`
   - Optional shared helper extraction only if needed; avoid unrelated refactors.

4. **Validation updates**
   - Add/extend tests for local/commercial filtering and local visibility behavior.
   - Run extension-level checks: `npm run test`, `npm run lint`, `npm run format`.

## Non-goals

- No changes to `/model-recommend` command behavior in this delta.
- No schema/data migration changes.
