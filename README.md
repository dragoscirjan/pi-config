# Pi Config (Current Setup)

This repository is a customized Pi setup featuring optimized model routing and profile visualization extensions.

- `/active-models`
- `/model-recommend`

## Table of Contents

- [Goal](#goal)
- [Active Files](#active-files)
- [`/active-models` Usage](#active-models-usage)
- [`/model-recommend` Usage](#model-recommend-usage)
- [Online Learning & Auto-Routing](#online-learning--auto-routing)
- [Notes](#notes)
- [Security / Hygiene](#security--hygiene)

## Goal

Keep Pi lightweight, but add:

1. **Visibility**: Real-time triage of available models from authenticated providers.
2. **Optimization**: Task-aware model recommendations that learn from your preferences to save 70-85% on API costs.

---

## Active Files

### `agent/settings.json`
Main configuration for Pi. It registers the extensions and sets default models.

### `agent/extensions/active-models.ts`
Registers `/active-models`. It provides a detailed profile of available models (intelligence, reasoning, speed, price, context) across all authenticated providers.

### `agent/extensions/model-recommend.ts`
Registers `/model-recommend`. A sophisticated local model router that:
- **SQLite Backend**: Stores taxonomy and training data in `agent/model-recommend.db`.
- **Online Learning**: Refines weights in real-time based on your model selections.
- **Auto-Routing**: Can intercept prompts to suggest or enforce the best model for the task.
- **Taxonomy management**: Supports importing, exporting, and merging taxonomies with specific collision policies.

### `agent/extensions/model-profile.ts`
Shared library that builds unified capability profiles for models, including pricing estimation for providers that don't expose it (like GitHub Copilot).

### `agent/model-recommend-config.json`
Tuning configuration for the recommendation engine (strategy, weights, aliases, and auto-routing thresholds).

### `AGENTS.md`
Configures MCP tool preferences and behavior rules for the agent.

---

## `/active-models` Usage

```text
/active-models [free-text] [options]
```

**Options:**
- `--provider <name>`: Filter by provider.
- `--grep <text>`: Filter by substring.
- `--sort-by <field> [asc|desc]`: Sort by score, price, intel, etc.
- `--min-intel <n>` / `--max-price <n>`: Capability filters.

---

## `/model-recommend` Usage

```text
/model-recommend <task> [options]
```

**Configuration Flags:**
- `--set-auto <off|suggest|enforce>`: Set auto-routing mode.
- `--set-learning <on|off>`: Toggle real-time training.
- `--status`: Show router stats, sample counts, and DB health.
- `--reset-learning`: Clear all learned data.

**Taxonomy Management:**
- `--export-taxonomy <path>`: Export current DB taxonomy to JSON.
- `--import-taxonomy <path>`: Replace DB taxonomy with a JSON file.
- `--merge-taxonomy <path>`: Merge JSON taxonomy into the DB.
- `--merge-policy <append|replace|keep>`: Default is `append`.
- `--rebuild-taxonomy`: Reset to defaults and refresh from live sources.

**Recommendation Flags:**
- `--strategy <cheapest-capable|capability-first|local-first>`: Ranking priority.
- `--explain`: Print a detailed scoring breakdown for the top models.
- `--limit <n>`: Number of results to show (will fill with `near-miss` models if needed).

---

## Online Learning & Auto-Routing

The `/model-recommend` extension features a local learning loop. When you manually select a model (or select "Custom model..."), the router creates a training sample comparing your choice against its top suggestion.

In **`enforce`** mode, the extension will automatically switch your model if the top recommendation's score margin exceeds the `minMarginForAutoPick` threshold defined in `model-recommend-config.json`.

---

## Notes

- **Data Privacy**: All training and taxonomy data stays local in the SQLite DB.
- **Near-Miss**: In the results table, models marked with `*` are "near-miss" fallbacks that didn't strictly meet the task requirements but were the next best options.
- **Price Estimation**: A `~` next to a price indicates it is estimated based on the same model's price on other providers.

---

## Security / Hygiene

- `agent/auth.json` is private and contains your API keys.
- `agent/model-recommend.db` is an operational file; use `--export-taxonomy` if you want to share or backup your taxonomy.
