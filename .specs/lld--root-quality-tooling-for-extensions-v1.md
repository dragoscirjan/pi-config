---
id: ""
type: lld
title: "Root quality tooling for extensions"
version: 1
status: draft
opencode-agent: lead-engineer
---

# Root quality tooling for extensions

## 1. Goal

Provide a unified quality-tooling setup for all extension packages under `agent/extensions/*` that supports:

- **root-level execution** (single command from repo root), and
- **extension-level execution** (run inside each extension package directly).

This rollout should use the root-installed tooling (`@templ-project/eslint`, `@templ-project/prettier`, `jscpd`, `fallow`, and `@templ-project/vitest` where applicable) without duplicating unnecessary per-package dependency trees.

## 2. Recommendation

### Chosen approach: **npm workspaces** (primary) + package-local scripts (secondary)

Reasoning:

1. Workspaces are native npm behavior and reduce custom orchestration glue.
2. They provide deterministic package discovery for `agent/extensions/*`.
3. They work cleanly with per-package scripts, preserving local dev ergonomics.
4. They avoid extra runner coupling (`npm-run-all2`) unless there is a specific sequencing pattern that workspaces cannot express.

`npm-run-all2` remains optional for future complex command chains, but is not required for baseline quality tooling rollout.

## 3. Scope

### In scope

- Root workspace configuration for all extension packages.
- Shared root quality config files for ESLint/Prettier and duplicate/dead-code checks.
- Standardized scripts added to each extension package:
  - `lint`
  - `format`
  - `format:check`
  - `typecheck` (where TS is used)
  - `test` / `test:watch` (only where tests/config exist)
- Root aggregator scripts to run extension scripts through npm workspaces.

### Out of scope

- Functional refactors of extension source logic.
- Introducing CI workflows in this change (can be follow-up).
- Task #4 caching feature work in `pi-model-recommend`.

## 4. Target packages

- `agent/extensions/pi-local-models`
- `agent/extensions/pi-model-recommend`
- `agent/extensions/pi-issue-tracking`
- `agent/extensions/pi-twig`

## 5. File-level design

### 5.1 Root files

1. **`/package.json`**
   - Add `workspaces` targeting `agent/extensions/*`.
   - Add aggregate scripts such as:
     - `quality:lint`
     - `quality:format`
     - `quality:format:check`
     - `quality:typecheck`
     - `quality:test`
     - `quality:dup`
     - `quality:dead`
     - `quality:all`

2. **`/.eslintrc.*` or equivalent templ-project config entrypoint**
   - Root shared ESLint config used by all extensions.
   - TS-aware parser/options for extension TS files.

3. **`/.prettierrc.*` (+ optional `.prettierignore`)**
   - Root shared Prettier config.

4. **`/jscpd.*` config**
   - Configure duplicate scanning paths for extensions.
   - Exclude generated/vendor/build artifacts.

5. **`/fallow.*` config (if needed)**
   - Configure dead-code/import analysis boundaries for extension packages.

### 5.2 Extension package files

For each `agent/extensions/*/package.json`, add/normalize scripts:

- `lint`: run ESLint against local TS/JS files.
- `format`: run Prettier write mode locally.
- `format:check`: run Prettier check mode locally.
- `typecheck`: `tsc --noEmit` when TS project config exists.
- `test`: run Vitest if the extension has tests/config; otherwise lightweight no-op pattern is acceptable (to keep root aggregate robust).

## 6. Execution model

### Root-level examples

- `npm run quality:lint`
- `npm run quality:typecheck`
- `npm run quality:test`
- `npm run quality:all`

### Extension-level examples

- `cd agent/extensions/pi-model-recommend && npm run lint`
- `cd agent/extensions/pi-twig && npm run typecheck`

## 7. Validation plan

After implementation:

1. Run root aggregate commands and ensure all workspace packages execute correctly.
2. Run at least one local script per extension to verify package-local ergonomics.
3. Confirm existing Vitest suite in `pi-model-recommend` still passes.
4. Confirm no unintended source changes outside tooling/config/scripts.

## 8. Risks and mitigations

1. **Script mismatch across packages**
   - Mitigation: standardize script names and provide safe defaults.

2. **Tool config incompatibility in one extension**
   - Mitigation: allow scoped overrides in that package while keeping root baseline.

3. **Workspace command failures due to missing scripts**
   - Mitigation: ensure each targeted package defines required script keys.

## 9. Rollout order

1. Root workspace + root shared configs.
2. Per-extension script normalization.
3. Root aggregate scripts wired to workspace runs.
4. Validation and final report.
