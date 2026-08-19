---
id: "00003"
type: lld
title: "Root quality tooling for extensions"
version: 2
status: draft
opencode-agent: lead-engineer
---

# Root quality tooling for extensions

## v2 Delta (references v1)

This document is a **delta** over:

- `.specs/lld-00003-root-quality-tooling-for-extensions-v1.md`

All v1 decisions remain valid unless explicitly changed below.

## Change driver

Upstream package migration:

- old: `@mariozechner/pi-coding-agent`
- new: `@earendil-works/pi-coding-agent`

The migration must be applied as a **full sweep** to prevent mixed imports/runtime mismatch across extensions.

## Scope changes from v1

### In scope (added)

1. Update extension source imports from old package name to new package name.
2. Update extension test mocks/stubs referencing old package name.
3. Update all extension `package.json` dependencies to new package name.
4. Regenerate or update lockfiles impacted by dependency rename.
5. Update setup/bootstrap/docs references that include old package import/dependency strings.
6. Validate extension runtime compatibility after rename.

### Out of scope (unchanged)

- Functional redesign of extension features.
- Non-migration refactors unrelated to package rename.

## Target files (delta)

### Code and types

- `agent/extensions/pi-coder/**`
- `agent/extensions/pi-issue-tracking/**`
- `agent/extensions/pi-local-models/**`
- `agent/extensions/pi-model-recommend/**`
- `agent/extensions/pi-twig/**`

Primary expected touchpoints:

- `index.ts` / command modules / helper modules importing `ExtensionAPI`, `getAgentDir`, UI helpers, and model types.
- test files using `vi.doMock('@mariozechner/pi-coding-agent', ...)`.

### Package manifests / locks

- Root `package-lock.json` (if affected)
- Extension-level `package.json` and `package-lock.json` files under `agent/extensions/*`

### Bootstrap / docs

- `setup.sh`
- README/spec references that explicitly mention old package name where behavior/docs would be misleading.

## Implementation notes

1. Perform literal import/dependency rename first.
2. Run installs only where lock updates are required.
3. Keep PR focused on migration mechanics; no feature changes.
4. Preserve currently known baseline issues that are unrelated to migration.

## Validation (delta)

Minimum required checks:

1. Per changed extension:
   - `npm run test`
   - `npm run lint`
   - `npm run format`
2. Root aggregate:
   - `npm run test`
3. Sanity grep:
   - no remaining runtime/import/package references to `@mariozechner/pi-coding-agent` in active extension code/manifests.

## Risks and mitigations (delta)

1. **API drift between packages**
   - Mitigation: compile/test each extension and patch import/type usages where symbol names changed.

2. **Partial migration (mixed old/new deps)**
   - Mitigation: full-repo grep before final commit; update lockfiles in same PR.

3. **Hook-generated noise in commit scope**
   - Mitigation: stage explicit file set and re-check `git diff --cached --name-only` before commit.
