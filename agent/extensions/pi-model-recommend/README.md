# model-recommend

Intelligent model router and recommendation engine for the Pi coding agent.
Dynamically ranks LLMs by task complexity, live taxonomy, empirical benchmarks, and online learning.

---

## File layout

| File                         | Purpose                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                   | Extension entry point — wires up both commands and the hook                                                          |
| `command-model-recommend.ts` | Core engine: intent analysis, Stage A constraints, relaxation, `/model-recommend` command, `before_agent_start` hook |
| `command-active-models.ts`   | `/active-models` command                                                                                             |
| `benchmarks.ts`              | Sync & query Aider Leaderboard data (edit + refactor pass rates)                                                     |
| `learning.ts`                | SQLite helpers — schema, training samples, pairwise weights                                                          |
| `profiles.ts`                | Capability estimators: Intel, Reasoning, Speed, Reliability (benchmark-first, heuristic fallback)                    |
| `types.ts`                   | Shared TypeScript interfaces                                                                                         |

---

## Commands

### `/model-recommend <task>`

Ranks all authenticated models for the given task description.

```
/model-recommend write a secure auth handler in rust
/model-recommend --strategy capability-first secure multi-tenant auth design
/model-recommend --set-auto suggest          # enable interactive picker
/model-recommend --set-auto enforce          # enable silent auto-routing
/model-recommend --set-auto off              # disable auto-routing
/model-recommend --sync-benchmarks           # fetch latest Aider leaderboard data
/model-recommend --status                    # print router state
```

**Key flags**

| Flag                                     | Description                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `--strategy <cheapest-capable            | capability-first                                                                        | local-first>` | Ranking strategy |
| `--provider, -p <name[,name]>`           | Filter by provider (csv)                                                                |
| `--grep, -g <text>`                      | Filter models by substring                                                              |
| `--sort-by <field> [asc\|desc]`          | Sort output column (score, intelligence, reasoning, reliability, speed, price, context) |
| `--limit, -n <n>`                        | Number of results (default 10)                                                          |
| `--explain`                              | Show per-model score breakdown and relaxation logic                                     |
| `--set-auto <off\|suggest\|enforce>`     | Configure auto-routing mode via `before_agent_start` hook                               |
| `--set-learning <on\|off>`               | Enable/disable online learning from pairwise selections                                 |
| `--reset-learning`                       | Clear all learned weights and historical samples                                        |
| `--sync-benchmarks`                      | Fetch & store Aider leaderboard pass rates for empirical scoring                        |
| `--status`                               | Print router state, database stsats, and training sample counts                         |
| `--rebuild-taxonomy`                     | Reset task-intent taxonomy to defaults                                                  |
| `--export-taxonomy <path>`               | Export current taxonomy to a JSON file                                                  |
| `--import-taxonomy <path>`               | Replace the database taxonomy with a JSON file                                          |
| `--merge-taxonomy <path>`                | Merge a JSON taxonomy into the database                                                 |
| `--merge-policy <append\|replace\|keep>` | Collision policy for merging taxonomies (default: append)                               |
| `--local-prefer`                         | Boost score of local models                                                             |
| `--local-only`                           | Strictly filter output to local models only                                             |

---

### `/active-models`

Lists all models available from your authenticated providers.

```
/active-models
/active-models -g claude --sort-by efficiency
/active-models --min-intel 90 --sort-by price
/active-models -p github-copilot,anthropic -n 20
```

**Key flags**

| Flag                            | Description                                       |
| ------------------------------- | ------------------------------------------------- |
| `--grep, -g <q>`                | Search providers/models                           |
| `--provider, -p <ids>`          | Allowlist providers (csv)                         |
| `--min-intel <n>`               | Minimum Intelligence score (0-100)                |
| `--max-price <n>`               | Maximum cost per 1M output tokens                 |
| `--sort-by <field> [asc\|desc]` | Sort by: score, intel, price, context, efficiency |
| `--limit, -n <n>`               | Maximum results to return (default: 10)           |

---

## Auto-routing modes (`--set-auto`)

### `off` (default)

No automatic routing. Model stays as-is for every prompt.

### `suggest`

Before **every** non-command prompt, the extension:

1. Runs the full recommendation algorithm on your prompt text.
2. Shows an **interactive picker** (powered by `SelectList`):
   - **5 ranked recommendations** with score, intel, reasoning and price.
   - **Keep current model** — no switch; if learning is on, records that you preferred the current model.
   - **Enter custom model** — opens an `Input` dialog; type `provider/model-id` to switch to any registry model; learning records the choice.
3. Esc / selecting "keep" leaves the model unchanged.
4. Any selection (including keep/custom) feeds the **online learning** system so future suggestions for similar tasks improve over time.

### `enforce`

Before every non-command prompt, silently switches to the top-ranked model with no user interaction.

---

## Scoring & benchmarks

### Stage A constraints

For each prompt, the engine derives minimum thresholds:

- `minIntel`, `minReasoning`, `minToolReliability`, `minContext`
- `requireReasoning` (true when complexity ≥ 80 and reasoning need ≥ 0.8)

If no model satisfies all constraints at `relax=0`, the engine relaxes up to 6 times.
**Critical rule**: if `requireReasoning` is `true`, the `minReasoning` threshold drops by at most `1.5 × level` per step (vs. `8 × level` normally), forcing genuinely capable models to the top regardless of context window or price.

### Benchmark-first scoring

`profiles.ts` queries `model_benchmarks` (populated by `--sync-benchmarks`) before falling back to heuristics:

```
Aider edit pass rate   → estimateIntel()
Aider refactor rate    → estimateReasoning()
Both combined          → estimateToolReliability()
```

Normalisation: Aider max edit pass rate ≈ 84 %. Scores are mapped to a 20–100 scale:

```typescript
const normalised = 20 + (passRate / 85) * 80;
```

Models not yet in the Aider dataset fall back to heuristics. The heuristic `reasoning` base for `model.reasoning = true` is intentionally conservative (`55`, not `75`) to prevent providers from inflating scores via a boolean flag.

---

## Database

`~/.pi/agent/model-recommend.db` (SQLite)

| Table               | Contents                                                              |
| ------------------- | --------------------------------------------------------------------- |
| `router_settings`   | Persisted auto-mode, learning toggle, and schema versions             |
| `router_weights`    | Pairwise affinity weights (`scope`, `key`, `weight`, `updates`)       |
| `router_samples`    | Historical events (`mode`, `selected_exact`, `prompt_hash`, `margin`) |
| `router_taxonomy_*` | Task-intent taxonomy categories and terms                             |
| `model_benchmarks`  | Aider leaderboard pass rates (`pass_rate_edit`, `pass_rate_refactor`) |

---

## Online learning

When learning is enabled (`--set-learning on`), every user choice in `suggest` mode writes two records:

- A **training sample** (prompt × chosen model × alternatives).
- **Pairwise weights** (Bradley-Terry style): chosen model gains weight vs. each rejected alternative.

Future `--set-auto suggest` runs use these weights as an additive affinity bonus in the final composite score.

### Inspecting what the system learned

You can check the high-level counts directly in Pi using `/model-recommend --status`.
To see the exact decisions and weights applied to your models, you can query the local SQLite database via Node:

```javascript
node -e "
const db = new (require('node:sqlite').DatabaseSync)('~/.pi/agent/model-recommend.db');
console.table(db.prepare('SELECT mode, selected_exact FROM router_samples ORDER BY ts DESC LIMIT 5').all());
console.table(db.prepare('SELECT key, weight FROM router_weights WHERE scope=\'exact\' ORDER BY weight DESC LIMIT 5').all());
"
```

_Note: Escaping the picker logs as `user-keep`, while typing a custom model logs as `user-custom`. Both events apply weights to future suggestions._

If you want to wipe the history and start fresh, run `/model-recommend --reset-learning`.
