---
id: "00012"
type: task
title: "Register extension in settings.json + manual verification checklist"
status: done
parent: "00001"
depends: ["00011"]
opencode-agent: lead-engineer
---

# Register extension in settings.json + manual verification checklist

Registered `pi-local-models` in `/home/dragosc/.pi/agent-local/settings.json` via the `extensions` array (absolute path to `index.ts`).

Created live config at `~/.pi/agent/local-models.json` with `lmstudio` and `ollama` backends pointing at locally running servers (127.0.0.1:1234 and 127.0.0.1:11434, both confirmed reachable in this environment).

## Verification performed

- `npm install` inside the package: own `node_modules/`, 188 packages, resolves `@mariozechner/pi-coding-agent@0.73.1` cleanly.
- `npx tsc --noEmit`: passes with zero errors (after two `exactOptionalPropertyTypes` fixes: `NormalizedModel` optional fields widened to `| undefined`, and `sync.ts` `apiKey` derived from `backend` instead of a splittable string).
- Live discovery test (ad-hoc script, removed after use) against the two running servers:
  - LM Studio (`GET /api/v1/models`): 4 models returned correctly, including `contextWindow`/`maxTokens`/`reasoning`/`vision` fields matching the raw JSON (e.g. `qwen/qwen3.6-27b` → contextWindow 262144, reasoning true, vision true).
  - Ollama (`GET /api/tags` + `GET /api/show`): 6 models returned, `contextWindow` correctly extracted via family-prefixed `model_info["qwen2.context_length"]` (131072/262144/32768/2048 all matched actual model_info values).
  - llama.cpp / MLX (no server running on the test ports): both gracefully returned `[]` with a logged `console.error`, never threw.
- Rules engine (`applyRules`) ad-hoc test: cascading string-match rules correctly overrode `maxTokens`/`contextWindow` in array order.
- Full `sync.ts` end-to-end test with a mock `pi.registerProvider`/`unregisterProvider`: bare provider names `lmstudio`/`ollama` (single unnamed server, per LLD §6 naming convention), full `ProviderModelConfig` objects with Pi-default fallback (`maxTokens: 16384`) applied where the backend didn't expose that metadata (Ollama), and a second sync call proved idempotent (no unregisters, no duplicate/missing entries).

## Not verified (no test environment available)

- llama.cpp `/props` context-length extraction and MLX `/v1/models` mapping — no real llama.cpp or MLX server running in this environment. Logic mirrors the same patterns validated against LM Studio/Ollama and degrades gracefully (returns `[]`) when unreachable, per LLD §4.3/§4.4.
- Actual `/model` picker UI behavior inside a live Pi session (requires restarting Pi with the new `extensions` entry and manually opening `/model`) — deferred to the user for final interactive confirmation.


## Comments
