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
- **Auto-Routing**: Can intercept prompts to suggest or enforce the best model for the task via the `before_agent_start` hook.
- **Taxonomy Management**: Supports importing, exporting, and merging taxonomies with specific collision policies.
- **Near-Miss Fallback**: Fills recommendation lists with close matches to ensure you always have options.

### `agent/extensions/model-profile.ts`
Shared library that builds unified capability profiles for models, including pricing estimation for providers like GitHub Copilot.

### `agent/model-recommend-config.json`
Tuning configuration for the recommendation engine (strategy, weights, aliases, and auto-routing thresholds).

---

## `/active-models` Usage

```text
/active-models [free-text] [options]
```

**Options:**
- `--provider, -p <name[,name]>`: Filter by provider(s).
- `--grep, -g <text>`: Filter by substring in provider/model name.
- `--limit, -n <n>`: Limit number of results.
- `--sort-by <field> [asc|desc]`: Sort by intelligence, reasoning, reliability, speed, price, or context.
- `--min-intel <n>` / `--max-price <n>`: Capability and cost filters.
- `--min-context <nk|nm>`: Filter by context window size.

---

## `/model-recommend` Usage

```text
/model-recommend <task> [options]
```

**Configuration Flags:**
- `--set-auto <off|suggest|enforce>`: Configure auto-routing behavior.
- `--set-learning <on|off>`: Toggle real-time training from selections.
- `--status`: Show router health, training sample counts, and DB schema info.
- `--reset-learning`: Clear all learned weights and samples.

**Taxonomy Management:**
- `--export-taxonomy <path>`: Export the current SQLite taxonomy to a JSON file.
- `--import-taxonomy <path>`: Replace the current taxonomy (destructive import).
- `--merge-taxonomy <path>`: Merge a JSON taxonomy into the current one.
- `--merge-policy <append|replace|keep>`: Collision policy for merging (default: `append`).
- `--rebuild-taxonomy`: Reset taxonomy to defaults and optionally enrich.
- `--live-taxonomy`: Incremental enrichment from live sources (GitHub topics, HN, etc.).
- `--live-sources <all|csv>`: Override which sources to use for enrichment.

**Recommendation & Filtering:**
- `--strategy <cheapest-capable|capability-first|local-first>`: Ranking bias.
- `--provider <name[,name]>`: Restrict to specific providers.
- `--grep <text>`: Filter models by name.
- `--trusted`: Only show models from trusted authors.
- `--local-prefer` / `--local-only`: Prioritize or restrict to local models.
- `--limit <n>`: Result count (includes `near-miss` models marked with `*`).
- `--explain`: Print a detailed scoring breakdown for candidates.
- `--sort-by <field> [asc|desc]`: Sort the recommendation table.

---

## Online Learning & Auto-Routing

The `/model-recommend` extension features a local learning loop. When you manually select a model (or select "Custom model..."), the router creates a training sample comparing your choice against its top suggestion.

In **`enforce`** mode, the extension will automatically switch your model if the top recommendation's score margin exceeds the `minMarginForAutoPick` threshold defined in `model-recommend-config.json`.

---

## Notes

- **Data Privacy**: All training and taxonomy data stays local in the SQLite DB.
- **Near-Miss**: In the results table, models marked with `*` are "near-miss" fallbacks that didn't strictly meet the StageA constraints but are shown for reference.
- **Price Estimation**: A `~` next to a price indicates it is estimated based on the same model's price on other providers.

---

## Security / Hygiene

- `agent/auth.json` is private and contains your API keys.
- `agent/model-recommend.db` is an operational file; use `--export-taxonomy` if you want to share or backup your taxonomy.
