# Pi Config (Current Setup)

This repository is a customized Pi setup featuring optimized model routing, profile visualization extensions, and a high-performance MCP toolset.

## Table of Contents

- [Goal](#goal)
- [Extensions](#extensions)
  - [model-recommend](#model-recommend)
  - [context-mode](#context-mode)
  - [pi-mcp-adapter](#pi-mcp-adapter)
- [MCP Servers](#mcp-servers)
  - [memory_context (context-mode)](#memory_context-context-mode)
  - [codeindex_gitnexus](#codeindex_gitnexus)
  - [sequential_thinking](#sequential_thinking)
  - [webcrawl_searchable_web](#webcrawl_searchable_web)
  - [docs_context7 & docs_github_grep](#docs_context7--docs_github_grep)
- [Shared Components & Config](#shared-components--config)
- [/active-models Usage](#active-models-usage)
- [/model-recommend Usage](#model-recommend-usage)
- [Online Learning & Auto-Routing](#online-learning--auto-routing)
- [Security & Hygiene](#security--hygiene)

---

## Goal

Keep Pi lightweight, but add:

1. **Visibility**: Real-time triage of available models from authenticated providers.
2. **Optimization**: Task-aware model recommendations that learn from your preferences to save 70-85% on API costs.
3. **Efficiency**: Context-aware tool usage through specialized MCP servers to handle large-scale codebase analysis and data processing.

---

## Extensions

The following extensions and packages are actively installed and configured in `agent/settings.json`:

### `model-recommend`
**Location**: `agent/extensions/model-recommend/`
A sophisticated, modular "trained" model router that optimizes model choice based on task complexity and user preference. It registers two main commands:
- `/active-models`: Triage, visualize, and estimate pricing for all available models from authenticated providers.
- `/model-recommend`: Rank models, learn from pairwise preferences, and optionally auto-route prompts (via `before_agent_start` hook) using a concept-based taxonomy.

### `context-mode`
**Location**: `agent/extensions/context-mode/`
A local bootstrap extension (installed via `install-context-mode.sh`) that integrates the `memory_context` MCP server directly into Pi's lifecycle.

### `pi-mcp-adapter`
**Package**: `git:github.com/nicobailon/pi-mcp-adapter`
An external community package that provides advanced protocol bridging and lifecycle management for MCP servers in Pi.

---

## MCP Servers

The setup leverages several MCP servers (configured in `agent/mcp.json`) to extend agent capabilities while maintaining a slim context window.

### `memory_context` (context-mode)
**Primary Role**: Context window protection and session continuity.
- **Think in Code**: Encourages the agent to write scripts for data analysis locally instead of reading massive files into the LLM context.
- **Persistent Memory**: Uses FTS5 indexing to store and retrieve session events, allowing for continuity across chat compactions.
- **Savings**: Reduces token usage by up to 98% for heavy data operations.

### `codeindex_gitnexus`
**Primary Role**: Large-scale codebase understanding.
- **Structural Analysis**: Performs deep symbol lookups, cross-reference tracking, and impact analysis.
- **Execution Flows**: Traces how code functions together across the entire repository.

### `sequential_thinking`
**Primary Role**: Planning and multi-step reasoning.
- **Process Management**: Helps the agent break down complex tasks into manageable steps with built-in reflection and course correction.

### `webcrawl_searchable_web`
**Primary Role**: High-fidelity web discovery.
- **Markdown Conversion**: Fetches web content and converts it to Markdown for better LLM readability.

### `docs_context7` & `docs_github_grep`
**Primary Role**: Knowledge retrieval.
- **Context7**: Access to up-to-date documentation for thousands of libraries.
- **GitHub Grep**: Searches real-world usage patterns across millions of public repositories.

---

## Shared Components & Config

### `agent/mcp.json`
Central configuration for all MCP servers. Defines commands, arguments, and environment variables for external tools.

### `agent/extensions/model-recommend/profiles.ts`
A shared library inside the router package that builds the unified capability profiles used by both `/active-models` and `/model-recommend`.

### `agent/model-recommend.db` (SQLite)
The operational database for the router. It stores:
- **Taxonomy**: Categories, concepts, and terms.
- **Learning Data**: Pairwise training samples and calculated weights.
- **Settings**: Persistent router settings and database migrations.

### `agent/model-recommend-config.json`
Human-editable tuning for the router, including:
- Capability thresholds and relaxation logic.
- Cost/Speed weights for different ranking strategies.
- Auto-routing confidence margins.

### `agent/settings.json`
Registers the extensions and sets the global default model/provider for the agent.

---

## `/active-models` Usage

```text
/active-models [free-text] [options]
```

**Common Options:**
- `--provider, -p <name[,name]>`: Filter by provider(s).
- `--grep, -g <text>`: Filter by name substring.
- `--sort-by <field> [asc|desc]`: Sort by intelligence, reasoning, reliability, speed, price, or context.
- `--min-intel <n>` / `--max-price <n>`: Filter by minimum capability or maximum cost.

---

## `/model-recommend` Usage

```text
/model-recommend <task> [options]
```

**Router Control:**
- `--set-auto <off|suggest|enforce>`: Configure how the router intercepts prompts.
- `--set-learning <on|off>`: Enable or disable real-time training.
- `--status`: Display router health, training counts, and DB info.
- `--reset-learning`: Wipe all learned weights and start over.

**Taxonomy & Portability:**
- `--export-taxonomy <path>`: Export current taxonomy to a JSON file.
- `--import-taxonomy <path>`: Replace the database taxonomy with a JSON file.
- `--merge-taxonomy <path>`: Merge a JSON taxonomy into the database.
- `--merge-policy <append|replace|keep>`: Collision policy (default: `append`).
- `--rebuild-taxonomy`: Clean reset to defaults followed by live enrichment.

**Recommendation Logic:**
- `--strategy <cheapest-capable|capability-first|local-first>`: Choose ranking bias.
- `--explain`: See a detailed breakdown of how each model was scored.
- `--limit <n>`: Show top $n$ models (includes `near-miss` models marked with `*`).

---

## Online Learning & Auto-Routing

THE router implements a **"Train as you go"** strategy:
1. **Analyze**: It identifies task requirements (StageA constraints).
2. **Suggest**: It recommends the best model.
3. **Learn**: When you pick a model, it logs a "win" for that model's features in that context.
4. **Enforce**: Once it has enough samples, in `enforce` mode, it will auto-pick models when the score margin is high enough.

---

## Security & Hygiene

- **Privacy**: All training data, weights, and taxonomy samples are stored **locally** in `agent/model-recommend.db`. No data is sent to external routing services.
- **API Keys**: Stored in `agent/auth.json`. Never commit this file.
- **Estimated Prices**: Prices marked with `~` are estimates based on cross-provider matching.
