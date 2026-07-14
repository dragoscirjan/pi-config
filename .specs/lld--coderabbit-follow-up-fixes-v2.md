---
id: ""
type: lld
title: "CodeRabbit follow-up fixes"
version: 2
status: draft
opencode-agent: lead-engineer
---

# CodeRabbit follow-up fixes

## Goal

Close the remaining unresolved CodeRabbit comments on PR #11 with minimal, low-risk code changes.

## Scope

### In scope

1. `agent/extensions/pi-issue-tracking/index.ts`
   - Ensure atomic-create path cleans up partially written files when write fails for non-`EEXIST` errors.

2. `agent/extensions/pi-model-recommend/auth.ts`
   - Remove mixed auth logic ambiguity by implementing explicit policy:
     - If `type === "api_key"`: require API key field.
     - If `type === "oauth"`: require OAuth token field.
     - If `type` missing/unknown: allow legacy fallback (`api key OR oauth token`) for backward compatibility.
   - Log parse/read failures with actionable context instead of silent catch.

### Out of scope

- Any refactor outside these three unresolved comments.
- Behavioral changes to recommendation/scoring flow.

## Implementation plan

1. Patch `index.ts` atomic create catch branch to:
   - close descriptor if open,
   - unlink temp/target file best-effort when a non-`EEXIST` write failure occurs,
   - rethrow original error.

2. Patch `auth.ts` provider inclusion logic:
   - normalize `type` once,
   - branch explicitly by type,
   - keep legacy fallback only for missing/unknown type.

3. Patch `auth.ts` catch block:
   - emit warning log including file path and error message,
   - return empty set as safe fallback.

## Validation

- `npm run lint`
- `npm run format`
- `npm run test`
- `npm run typecheck:strict` (report-only if existing unrelated TS debt persists)

## Risk

- Low. Changes are localized and defensive. Legacy compatibility for untyped auth entries is preserved.
