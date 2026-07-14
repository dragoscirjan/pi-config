# Pi Config

Practical Pi agent setup with local extensions for:

- dynamic language-aware coding guidance,
- local model provider discovery,
- model recommendation and auto-routing,
- filesystem issue tracking,
- Twig-based runtime skill rendering.

## Repository layout

- `agent/settings.json` — active Pi package settings (external packages, default model/provider).
- `agent/extensions/` — local extension source code.
- `context-mode/` — local context-mode helper package.
- `setup.sh` — installer/update script for optional modules.
- `.specs/` — implementation/design notes used during this repo evolution.

## Active external packages (from `agent/settings.json`)

- `npm:pi-subagents`
- `npm:pi-mcp-adapter`

## Local extensions

| Extension            | Path                                                                                   | Purpose                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pi-coder`           | [`agent/extensions/pi-coder`](agent/extensions/pi-coder/README.md)                     | Adds `detect_language` tool and language context for coding workflows.                           |
| `pi-local-models`    | [`agent/extensions/pi-local-models`](agent/extensions/pi-local-models/README.md)       | Discovers local backends (LM Studio/Ollama/llama.cpp/MLX) and registers providers.               |
| `pi-model-recommend` | [`agent/extensions/pi-model-recommend`](agent/extensions/pi-model-recommend/README.md) | `/model-recommend` and `/active-models` commands with learning + taxonomy logic.                 |
| `pi-issue-tracking`  | [`agent/extensions/pi-issue-tracking`](agent/extensions/pi-issue-tracking/README.md)   | Filesystem issue management tools (`issue_create`, `issue_list`, `issue_read`, `issue_comment`). |
| `pi-twig`            | [`agent/extensions/pi-twig`](agent/extensions/pi-twig/README.md)                       | Compiles `*.md.twig` skill templates and overrides skill reads with rendered content.            |

## Shared quality tooling

Root scripts in `package.json`:

- `npm run lint`
- `npm run format`
- `npm run dupcheck`
- `npm run fallow:summary`
- `npm run fallow:check`
- `npm run test`
- `npm run typecheck`
- `npm run typecheck:strict`
- `npm run quality`
- `npm run quality:fix`

Extension-level scripts are standardized across extension packages (`lint`, `format`, `test`; and `typecheck` where configured).

## Key runtime files

- `agent/local-models.json` — backend server list + optional model annotation rules for `pi-local-models`.
- `agent/model-recommend.db` — SQLite state for `pi-model-recommend` (settings, weights, samples, taxonomy, benchmarks).
- `agent/model-recommend-config.json` — scoring/taxonomy tuning for `pi-model-recommend`.
- `pi-twig.json` — optional Twig render context values used by `pi-twig`.

## Notes

- This repository currently has **no `agent/mcp.json`** file checked in.
- Some generated artifacts under `tmp/` are produced by local quality hooks/tools (for example jscpd HTML output).
