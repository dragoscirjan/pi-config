# pi-model-recommend

Model recommendation and routing extension for Pi.

It exposes two commands and an optional auto-routing hook:

- `/model-recommend`
- `/active-models`
- `before_agent_start` routing in suggest/enforce modes

## Command overview

### `/model-recommend`

Task-aware ranking pipeline:

1. parse args/options
2. ensure config + taxonomy state
3. analyze intent/capability needs
4. filter models by authenticated providers + optional filters
5. run stage-A constraints + relaxation
6. score + capability guard + learned adjustments
7. render ranked table (+ explain mode)

Supports router controls (`--set-auto`, `--set-learning`, `--reset-learning`), taxonomy operations (rebuild/import/export/merge), benchmark sync, and status output.

### `/active-models`

Model inventory/triage view for authenticated providers with filtering, sorting, badges, and pricing/intelligence context.

## Core modules

- `command-model-recommend.ts` — primary command + `before_agent_start` suggest/enforce flow.
- `command-active-models.ts` — active model listing command.
- `intent.ts` — tokenization/alias/fuzzy term detection and intent capability profile.
- `scoring.ts` — constraints, feasible set selection, model scoring, penalty guard.
- `profiles.ts` — normalized profile estimation (intel/reasoning/reliability/speed/cost/context/locality).
- `benchmarks.ts` — Aider leaderboard sync + lookup; fetch calls guarded by timeout/abort.
- `learning.ts` — SQLite schema migrations, weights, samples, learned bias application.
- `taxonomy.ts` — defaults, config snapshots, live-source enrichment plumbing, import/export/merge helpers.
- `auth.ts` — strict provider auth filter used by both commands.
- `types.ts` — shared interfaces across command/modules.

## Auth policy (strict)

Providers are considered active only if `agent/auth.json` entry type and credential shape match:

- `type: "api_key"` requires API key fields.
- `type: "oauth"` requires OAuth token fields.
- Missing/unsupported `type` is ignored (warned), not auto-inferred.

This prevents permissive fallback behavior and keeps provider gating deterministic.

## Data and persistence

- DB: `agent/model-recommend.db`
- config: `agent/model-recommend-config.json`

SQLite data includes:

- router settings (`router_settings`)
- pairwise weights (`router_weights`)
- user training samples (`router_samples`)
- taxonomy categories/terms (`router_taxonomy_*`)
- benchmark rows (`model_benchmarks`)
- migration tracking (`router_migrations`)

## Auto-routing modes

Configured through `/model-recommend --set-auto <mode>`:

- `off` — no automatic model change
- `suggest` — shows ranked picker (with keep/custom paths)
- `enforce` — switches to top recommendation automatically

When learning is enabled, selections/choices feed pairwise learning and future ranking bias.

## Benchmarks

`benchmarks.ts` synchronizes Aider leaderboard YAML sources and stores edit/refactor pass-rate data locally.

- network calls use `AbortController` timeout
- sync failures are non-fatal
- scoring falls back to heuristics when no benchmark hit is available

## Taxonomy + live signals

`taxonomy.ts` provides:

- default taxonomy and config snapshots
- persisted taxonomy DB IO
- import/export/merge operations
- optional live-source enrichment controls from config/runtime flags

## Development

From `agent/extensions/pi-model-recommend`:

- `npm run lint`
- `npm run format`
- `npm run test`

Current colocated tests cover `intent`, `scoring`, `learning`, and `taxonomy` modules.
