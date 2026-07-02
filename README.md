# Pi Config (Current Setup)

This repository is a mostly-bare Pi setup with two custom Pi extensions:

- `/active-models`
- `/model-recommend`

## Table of Contents

- [Goal](#goal)
- [Active Files](#active-files)
  - [`agent/settings.json`](#agentsettingsjson)
  - [`agent/extensions/active-models.ts`](#agentextensionsactive-modelsts)
  - [`agent/extensions/model-recommend.ts`](#agentextensionsmodel-recommendts)
  - [`agent/auth.json`](#agentauthjson)
  - [`agent/sessions/`](#agentsessions)
- [`/active-models` Usage](#active-models-usage)
- [`/model-recommend` Usage](#model-recommend-usage)
- [Notes](#notes)
- [`agent/model-recommend-config.json`](#agentmodel-recommend-configjson)
- [Security / Hygiene](#security--hygiene)

## Goal

Keep Pi lightweight, but add:

1. visibility into currently available models from authenticated providers
2. task-aware model recommendations

Both commands are scoped by authenticated providers from `agent/auth.json`.

---

## Active Files

### `agent/settings.json`

```json
{
  "extensions": [
    "./extensions/active-models.ts",
    "./extensions/model-recommend.ts"
  ],
  "defaultProvider": "github-copilot",
  "defaultModel": "gpt-5.3-codex"
}
```

### `agent/extensions/active-models.ts`

Registers `/active-models`.

It:

- reads authenticated providers from `agent/auth.json`
- filters Pi model registry to those providers
- supports filtering/sorting/limits
- builds a capability profile per model (`intel`, `reasoning`, `tool reliability`, `speed`, `cost`, `context`)
- estimates missing prices (e.g. GitHub Copilot models) from other providers when possible
- prints a profile table for quick model triage

### `agent/extensions/model-recommend.ts`

Registers `/model-recommend`.

It:

- reads authenticated providers from `agent/auth.json`
- auto-builds taxonomy on first use if missing
- stores taxonomy at: `~/.pi/model-taxonomy.json`
- supports explicit taxonomy rebuild via `--rebuild-taxonomy`
- computes intent + complexity from task text and taxonomy concepts
- ranks candidate models and prints a recommendation table

### `agent/auth.json`

Authentication source of truth used by both commands.

### `agent/model-recommend-config.json`

Tuning file for `/model-recommend` (auto-created if missing).

It controls:

- typo aliases (e.g. `elyxir -> elixir`)
- live taxonomy source config (`enabledSources`, timeouts, caps)
- source weights / external-signal weight
- complexity + pricing guardrails
- tie-break jitter range

### `agent/sessions/`

Pi session history files.

---

## `/active-models` Usage

```text
/active-models [free-text] [options]
```

Options:

- `--provider, --providers, -p <name[,name]>`
- `--grep, -g <text>`
- `--limit, -n <int>`
- `--sort-by <score|intelligence|reasoning|reliability|speed|price|context> [asc|desc]`
- `--desc` / `--asc`
- `--min-intel <0..100>`
- `--max-intel <0..100>`
- `--min-reasoning <0..100>`
- `--min-reliability <0..100>`
- `--max-price <usd>`
- `--min-context <n|nk|nm>`
- `--max-context <n|nk|nm>`
- `--help`

Examples:

```text
/active-models github
/active-models --provider openrouter --sort-by price asc --limit 20
/active-models --sort-by intelligence desc --min-intel 85
```

---

## `/model-recommend` Usage

```text
/model-recommend <task> [options]
```

Options:

- `--rebuild-taxonomy`
- `--live-taxonomy`
- `--live-sources <all|csv>`
- `--trusted`
- `--provider <name[,name]>`
- `--grep <text>`
- `--strategy <cheapest-capable|capability-first|local-first>`
- `--local-prefer`
- `--local-only`
- `--sort-by <score|intelligence|reasoning|reliability|speed|price|context> [asc|desc]`
- `--limit <n>`
- `--help`

Examples:

```text
/model-recommend "implement JWT auth in FastAPI"
/model-recommend "refactor CI pipeline" --provider openrouter --sort-by price asc --limit 5
/model-recommend "deep architecture review" --rebuild-taxonomy
```

---

## Notes

- Taxonomy is always global: `~/.pi/model-taxonomy.json`.
- If taxonomy file is missing, `/model-recommend` creates it automatically.
- On taxonomy rebuild (or when `--live-taxonomy` is passed), `/model-recommend` will attempt best-effort live enrichment from configured sources.
- Default live source set supports: Stack Overflow, StackExchange network, GitHub topics, GitHub trending, Reddit, Hacker News, Lobsters, npm, PyPI, crates.io, Maven Central, Awesome Lists, arXiv, cloud changelogs, CNCF landscape, job boards, Google Trends, and GDELT.
- Use `--live-sources all` to force all supported sources, or pass CSV (e.g. `--live-sources stack_overflow,github_topics,google_trends`).
- Recommendation tuning config is local to the agent dir: `agent/model-recommend-config.json`.
- If tuning config is missing, `/model-recommend` creates it automatically.
- In both commands, a `~` marker after price means the value was estimated from matching model prices on other providers (useful for providers like GitHub Copilot that may not expose token prices directly).
- No separate taxonomy build command is used in this setup.

---

## Security / Hygiene

- `agent/auth.json` contains sensitive credentials and must remain private.
- Session files may include sensitive project context.
