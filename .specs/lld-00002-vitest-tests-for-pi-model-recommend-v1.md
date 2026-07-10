---
id: "00002"
type: lld
title: "Vitest tests for pi-model-recommend"
version: 1
status: draft
opencode-agent: lead-engineer
---

# Vitest tests for pi-model-recommend

## Context

`agent/extensions/pi-model-recommend` currently has no unit tests. We recently refactored model recommendation logic into modular files (`intent.ts`, `scoring.ts`, `learning.ts`, `taxonomy.ts`), which are now suitable for direct unit coverage.

User request: add unit tests using `@templ-project/vitest`, and keep test files at the same level as source files.

## Goals

1. Add Vitest test runner setup in this extension using `@templ-project/vitest`.
2. Add deterministic unit tests for core logic modules (no network, no live DB side effects).
3. Place tests next to source files (`*.test.ts` in the same directory).

## Non-goals

- Do not implement task #4 (caching layer).
- Do not refactor production logic beyond what is required for testability.
- Do not add integration/e2e tests.

## Design

### 1) Test toolchain integration

- Add dev dependencies:
  - `@templ-project/vitest`
  - `typescript` (only if needed by local test run tooling)
- Add scripts in `package.json`:
  - `test`: `vitest run`
  - `test:watch`: `vitest`
- Add `vitest.config.js` at extension root:
  - `import { defineConfig } from "@templ-project/vitest"`
  - Override `include` to support colocated tests: `./*.test.ts`

### 2) Test coverage scope

#### `intent.test.ts`
- `normalizeText` normalizes separators and punctuation.
- `applyAliases` replaces alias tokens and preserves normalized output.
- `analyzeIntent`:
  - detects language aliases (e.g., `ts` -> `typescript`),
  - produces non-empty domains for coding/reasoning prompts,
  - computes bounded complexity `[1,100]`.

#### `scoring.test.ts`
- `deriveConstraints` returns stricter thresholds for high-risk/high-complexity intent.
- `selectStageAFeasible` picks feasible candidates and increases relaxation when needed.
- `applyCapabilityDeltaGuard` penalizes weaker capability candidates only when complexity threshold is met.

#### `learning.test.ts`
- key canonicalization helpers (`canonicalFamily`, `exactKey`, `familyKey`, `providerFamilyKey`) produce expected canonical forms and separators.

#### `taxonomy.test.ts`
- `sanitizeLiveTerms` removes invalid/duplicate tokens and applies max cap.
- `resolveLiveSources` handles `all`, explicit CSV, and fallback behavior.

## Files to add/update

### Update
- `agent/extensions/pi-model-recommend/package.json`
  - add devDependencies and test scripts

### Add
- `agent/extensions/pi-model-recommend/vitest.config.js`
- `agent/extensions/pi-model-recommend/intent.test.ts`
- `agent/extensions/pi-model-recommend/scoring.test.ts`
- `agent/extensions/pi-model-recommend/learning.test.ts`
- `agent/extensions/pi-model-recommend/taxonomy.test.ts`

## Execution order

1. Add Vitest config + package scripts/deps.
2. Add tests for pure helpers first (`learning`, `taxonomy`).
3. Add tests for behavior-heavy modules (`intent`, `scoring`).
4. Run `npm test` and `npm run -s tsc -- --noEmit` in extension directory.

## Risks and mitigations

- **Risk:** flakes due to external state/network in taxonomy/learning modules.
  - **Mitigation:** test only pure exported functions; avoid DB/network paths.
- **Risk:** default `@templ-project/vitest` include patterns miss colocated tests.
  - **Mitigation:** explicitly set `include: ["./*.test.ts"]`.

## Acceptance criteria

1. `npm test` passes in `agent/extensions/pi-model-recommend`.
2. Tests are colocated next to source files.
3. At least one test file exists for each targeted module (`intent`, `scoring`, `learning`, `taxonomy`).
