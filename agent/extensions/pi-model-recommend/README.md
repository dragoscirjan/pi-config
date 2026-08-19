# pi-model-recommend

Model ranking and routing extension for Pi.

It registers two commands:

- `/model-recommend` — task-aware ranking + optional auto-routing
- `/active-models` — snapshot/listing view of available models from authenticated commercial providers plus local providers

## Entry points

- `index.ts` — registers both commands.
- `command-model-recommend.ts` — main recommendation command + `before_agent_start` auto-routing behavior.
- `command-active-models.ts` — active model inspection command.

## Core modules

- `intent.ts` — prompt intent extraction and task complexity scoring.
- `scoring.ts` — constraint derivation, stage-A filtering, model scoring, capability delta guard.
- `profiles.ts` — model profile heuristics and benchmark-aware capability estimates.
- `benchmarks.ts` — leaderboard synchronization with timeout-protected fetch.
- `learning.ts` — SQLite migrations, pairwise training weights, recommendation adjustments.
- `taxonomy.ts` — taxonomy state/config load-merge-export helpers.
- `auth.ts` — strict auth provider filter from `auth.json`.
- `types.ts` — shared types used by command and modules.

## Runtime data

- DB path: `agent/model-recommend.db`
- Config path: `agent/model-recommend-config.json`

The database stores router settings, learned pairwise weights, training samples, taxonomy state, and benchmark rows.

## Auth behavior (strict)

`auth.ts` treats provider auth type as authoritative:

- `type: "api_key"` -> provider is usable only when API key fields exist.
- `type: "oauth"` -> provider is usable only when OAuth token fields exist.
- Unknown/missing `type` -> provider is ignored with warning.

Both `/model-recommend` and `/active-models` use this same helper.

## Commands (high-level)

`/model-recommend` supports:

- strategy and provider filters,
- local-prefer / local-only toggles,
- auto-routing mode (`off`, `suggest`, `enforce`),
- learning reset/toggle,
- taxonomy import/export/merge/rebuild,
- benchmark sync and status output.

`/active-models` supports list filtering/sorting by provider, text, price/intelligence thresholds, output limits, and locality filtering (`--local` / `--commercial`).

## Development

From this extension directory:

- `npm run lint`
- `npm run format`
- `npm run test`

Colocated tests currently cover intent/scoring/learning/taxonomy modules.
