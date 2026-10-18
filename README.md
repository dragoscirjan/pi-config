# Pi Config

Practical Pi agent setup with local extensions for:

- local model provider discovery,
- model recommendation and auto-routing,
- native MCP integrations and context-aware memory tooling.

## Repository layout

- `agent/settings.json` — active Pi package settings (external packages, default model/provider).
- `agent/mcp.example.json` — versioned native Pi MCP configuration template with environment-variable placeholders.
- `agent/extensions/` — local extension source code.
- `.specs/` — implementation/design notes used during this repo evolution.

## Active external packages (from `agent/settings.json`)

- `npm:pi-subagents@0.79.1`
- `npm:context-mode@1.0.169`
- `npm:@juicesharp/rpiv-ask-user-question@2.13.9`
- `npm:@llblab/pi-telegram@0.57.1`
- `npm:pi-slack-bridge@0.3.0`

## Local extensions

| Extension            | Path                                                                                   | Purpose                                                                            |
| -------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `herdr-agent-state`  | [`agent/extensions/herdr-agent-state.ts`](agent/extensions/herdr-agent-state.ts)       | Reports session state to Herdr when its integration environment is enabled.        |
| `pi-local-models`    | [`agent/extensions/pi-local-models`](agent/extensions/pi-local-models/README.md)       | Discovers local backends (LM Studio/Ollama/llama.cpp/MLX) and registers providers. |
| `pi-model-recommend` | [`agent/extensions/pi-model-recommend`](agent/extensions/pi-model-recommend/README.md) | `/model-recommend` and `/active-models` commands with learning + taxonomy logic.   |

## Shared quality tooling

Root scripts in `package.json`:

- `npm run commitlint -- --edit <message-file>`
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

Extension-level scripts are standardized across extension packages (`lint`, `format`, `test`; and `typecheck` where configured). Husky's `commit-msg` hook validates Conventional Commit messages through `@tempel/commitlint`.

## Key runtime files

- `agent/mcp.json` — native Pi MCP server configuration, created locally from `agent/mcp.example.json`.
- `agent/local-models.json` — backend server list + optional model annotation rules for `pi-local-models`.
- `agent/model-recommend.db` — SQLite state for `pi-model-recommend` (settings, weights, samples, taxonomy, benchmarks).
- `agent/model-recommend-config.json` — scoring/taxonomy tuning for `pi-model-recommend`.

## Native MCP setup

Pi's built-in MCP extension reads `agent/mcp.json`; this file is not associated with the removed legacy MCP adapter. Create the local configuration from the tracked, secret-free template:

```sh
cp agent/mcp.example.json agent/mcp.json
chmod 600 agent/mcp.json
pi mcp list
```

The template uses environment-variable placeholders for credentials and machine-specific paths.

## Notes

- Machine-specific runtime files such as `agent/mcp.json`, `agent/telegram.json`, `agent/trust.json`, and `agent/models-store.json` are ignored and must not be committed.
- MCP servers are managed by Pi's native `builtin:mcp` extension through `agent/mcp.json`.
- Some generated artifacts under `tmp/` are produced by local quality hooks/tools (for example jscpd HTML output).
