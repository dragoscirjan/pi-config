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
- prints a table with score/intelligence/speed/price/context/thinking/images

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

### `agent/sessions/`

Pi session history files.

---

## `/active-models` Usage

```text
/active-models [free-text] [options]
```

Options:

- `--provider, -p <name>`
- `--grep, -g <text>`
- `--limit, -n <int>`
- `--sort-by <score|intelligence|speed|price|context> [asc|desc]`
- `--desc` / `--asc`
- `--min-intel <0..100>`
- `--max-intel <0..100>`
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
- `--trusted`
- `--provider <name>`
- `--grep <text>`
- `--sort-by <score|intelligence|speed|price|context> [asc|desc]`
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
- No separate taxonomy build command is used in this setup.

---

## Security / Hygiene

- `agent/auth.json` contains sensitive credentials and must remain private.
- Session files may include sensitive project context.
