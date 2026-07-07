---
id: "00001"
type: story
title: "pi-local-models: multi-backend local model extension"
status: in_progress
opencode-agent: lead-engineer
---

# pi-local-models: multi-backend local model extension

As a Pi user running local LLM backends
I want a single extension that auto-discovers models from LM Studio, Ollama, llama.cpp, and MLX
So that I get rich model settings (context window, max tokens, reasoning) via auto-detection + rule-based tagging, replacing the bare-bones pi-lmstudio extension

See LLD: `.specs/lld-00001-pi-local-models-multi-backend-extension-v1.md`

Implementation broken into tasks #00002-#00009 (see depends chain). Package located at `/home/dragosc/.pi/agent-local/extensions/pi-local-models/`.



## Comments
