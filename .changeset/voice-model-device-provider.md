---
"@dragoscirjan/pi-voice-ptt": minor
---

Add machine-local `/voice-model` and `/voice-device` commands with confirmed, checksum-verified GGML downloads. Reuse the original voice/i18n session through an isolated recognizer provider, supporting CPU and verified Vulkan/CUDA/Metal GPU execution, visible automatic CPU fallback, and strict GPU mode. Keep models/preferences outside shared Pi settings and stop owned workers on cancellation or deactivation.
