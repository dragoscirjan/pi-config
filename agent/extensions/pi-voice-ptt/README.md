# Pi voice push-to-talk companion

Adds hold-Space dictation, model selection and verified CPU/GPU routing while reusing the installed **rpiv-voice** session and **rpiv-i18n** language state. It does not patch those packages or replace `/voice` and `/languages`.

## Install

After the first npm release:

```sh
pi install npm:@juicesharp/rpiv-i18n@2.15.0
pi install npm:@juicesharp/rpiv-voice@2.15.0
pi install npm:@dragoscirjan/pi-voice-ptt
```

`/voice-activate` checks for both required upstream packages before preparing voice. If either cannot be found, it shows a warning with the missing package names, exact `pi install` commands, and enable/reload instructions, then stops activation. Dependencies are not checked or installed automatically at startup.

Use either the npm companion or this repository-local companion, not both. `pi config` can disable the local companion before enabling its npm copy. Keep the original voice/i18n packages enabled; npm peers alone do not enable their Pi resources.

Requires **Pi 1.5.0+, Node 22.19+**, the interactive terminal UI and a terminal with Kitty press/repeat/release reporting, such as Ghostty. RPC, Telegram, Slack and terminals without key releases are not supported.

## Commands

| Command                                        | Behavior                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `/voice-activate`                              | Arm hold-to-talk; no microphone or model worker starts just by arming |
| `/voice-deactivate`                            | Cancel capture and stop the owned model worker, freeing its RAM/VRAM  |
| `/voice-model`                                 | Pick `tiny`, `base`, `small` or `medium` on this computer             |
| `/voice-model small`                           | Choose a model directly; confirm a download if necessary              |
| `/voice-device`                                | Pick `auto`, `cpu` or `gpu` on this computer                          |
| `/voice-device gpu`                            | Require initialized hardware GPU support; never silently use CPU      |
| `/voice-model status` / `/voice-device status` | Show saved choices, actual backend state and local storage paths      |

After `/reload`, run `/voice-activate`, hold **Space for about one second**, wait for **Listening**, speak, then release. The accepted final transcript is inserted at the cursor, **not submitted**. Short Space taps still insert spaces. Escape cancels; submission, exit, suspension, session shutdown and loss of focus inside Pi cancel pending dictation.

Selection commands temporarily disarm capture. They confirm downloads and probe the selected backend **without opening a microphone**, then save only on success. Native base/CPU fallback is checked using upstream model-installation and integrity checks, without downloading or opening a microphone; missing models require an explicit `/voice` setup first. If voice was armed, it is rearmed afterward. Cancelling setup leaves it disarmed and preserves the saved choice.

The footer shows the real initialized device (for example `small · GPU Vulkan0`), not merely the requested mode. `not started` means no worker has been initialized yet. `auto` in the language badge means the original i18n/voice flow has no explicit speech-language hint; use the existing `/languages` command to choose English when speaking English.

## Input-native voice rail

The input border acknowledges Space immediately, without claiming the microphone is already listening:

- **Hold Space · mic off** during the one-second hold threshold. Releasing sooner inserts an ordinary space without activating voice.
- **Preparing voice** while the original preflight/model/microphone starts.
- **`⟨▁▂▅▃▆▂▁▁⟩ Listening`** once capture is ready. The wave uses actual recent mic levels, not simulated activity or an animation timer.
- **Decoding** after release, until the accepted final text is ready.

Live words appear at the insertion point as a dim **`⟪provisional dictation⟫`** inside the input. This is render-only: the editor's real text, cursor, undo/history and submitted value never contain unaccepted words. The final accepted transcript is inserted once on release; Escape/cancellation removes the visual draft. Clicking a provisional row in fullscreen mode cancels it before treating that row as a real editing coordinate. Long previews wrap in a bounded, cursor-following input viewport, including narrow terminals and wide Unicode text.

There is no longer a separate voice preview panel above the input.

## Safe defaults and fallback

A fresh computer defaults to **base + auto**. No large model choice is copied from another machine, and no download is started while Space is held.

- If whisper-server or a verified GGML base model is absent, base/auto or base/cpu can use the **existing original base/CPU recognizer**. Prepare that upstream model with `/voice` once first; the companion will not trigger its automatic installer during a hold.
- With GGML prepared, `auto` tries an initialized hardware GPU, then visibly falls back to CPU. A GPU inference failure retries the same audio on CPU rather than silently dropping it.
- `cpu` passes `--no-gpu`; `gpu` rejects a CPU-only build, GPU initialization failure, or unverified/software GPU routing.
- Explicit GPU mode and larger models require a working whisper-server and the chosen verified GGML file. The model is never silently downgraded to base.

**These choices affect companion hold-to-talk only.** Standalone `/voice` keeps its upstream base/CPU behavior. Both paths use the existing i18n locale, and the companion forwards the original command's language/thread settings rather than maintaining a second language configuration.

## Models and machine-local storage

The picker offers official multilingual whisper.cpp GGML weights:

| Model  | Approximate download | Trade-off                                               |
| ------ | -------------------- | ------------------------------------------------------- |
| tiny   | 74 MiB               | Fastest, least accurate                                 |
| base   | 141 MiB              | Conservative default                                    |
| small  | 465 MiB              | First accuracy upgrade to try                           |
| medium | 1463 MiB             | More accuracy potential, substantially more compute/RAM |

The UI rounds download sizes up. GPU acceleration improves speed; model choice primarily affects recognition accuracy. A 20 GB GPU is **not** a requirement for this feature.

Downloads are pinned to a Hugging Face revision and SHA256/size, streamed to private temporary files, verified, then atomically installed. Cancellation or checksum failure never replaces an existing model. Verification markers are bound to the hashed file's device/inode, size and high-resolution modification/change timestamps, not a later replacement. Modified cache files require re-verification. Old marker formats are safely rehashed once without downloads or preference changes. ONNX weights from rpiv-voice are not interchangeable with GGML weights.

Nothing below is stored in shared `agent/settings.json` or committed to this repo:

| OS      | Preferences                                                                   | Model cache                                                   |
| ------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Linux   | `$XDG_STATE_HOME/pi-voice-ptt/preferences.json`, default `~/.local/state/...` | `$XDG_CACHE_HOME/pi-voice-ptt/models`, default `~/.cache/...` |
| macOS   | `~/Library/Application Support/pi-voice-ptt/preferences.json`                 | `~/Library/Caches/pi-voice-ptt/models`                        |
| Windows | `%LOCALAPPDATA%\pi-voice-ptt\preferences.json`                                | `%LOCALAPPDATA%\pi-voice-ptt\cache\models`                    |

Relative/empty XDG overrides are ignored. The optional local `serverPath` preference or `PI_VOICE_WHISPER_SERVER` environment variable selects an executable; the environment override takes priority. Otherwise `whisper-server` (`whisper-server.exe` on Windows) is discovered on PATH. Paths are passed directly to the process, never through a shell. Common API/token, Pi, npm, SSH and proxy credential variables are stripped from the backend's environment; OS/GPU driver variables are preserved.

## GPU/backend setup across operating systems

Install a trusted **whisper.cpp whisper-server 1.8.3+** build. Native executables and GPU drivers are not bundled or downloaded automatically by this npm package.

| Hardware/platform              | Backend to build/install       |
| ------------------------------ | ------------------------------ |
| Linux/Windows AMD or Intel GPU | Vulkan                         |
| Linux/Windows NVIDIA GPU       | CUDA; Vulkan is another option |
| macOS Apple Silicon            | Metal                          |
| No usable GPU                  | CPU                            |

Follow [upstream build instructions](https://github.com/ggml-org/whisper.cpp). Typical CMake selections are:

```sh
# Choose ONE suitable backend, with its SDK/driver installed:
cmake -B build -DGGML_VULKAN=ON
# or: cmake -B build -DGGML_CUDA=ON
# or, Apple Silicon: cmake -B build -DGGML_METAL=ON
cmake --build build --config Release --target whisper-server -j
```

Use the actual output executable from your generator, for example:

```sh
export PI_VOICE_WHISPER_SERVER=/path/to/whisper.cpp/build/bin/whisper-server
```

PowerShell example:

```powershell
$env:PI_VOICE_WHISPER_SERVER = 'C:\tools\whisper.cpp\build\bin\Release\whisper-server.exe'
```

On NixOS, plain `whisper-cpp` may be CPU-only. A `whisper-cpp.override { vulkanSupport = true; }` build enables Vulkan; a user-local build/root can be used without changing the system or shell profile. A GPU mode flag cannot turn a CPU-only executable into a GPU-enabled build.

The adapter checks actual native GPU initialization messages after model health is ready; a `use_gpu=1` flag or GPU listing alone is not accepted as acceleration. Actual GPU/CPU inference has been exercised on Linux/AMD Vulkan here. Linux/macOS/Windows are included in the software CI matrix; physical GPU/microphone paths on macOS/Windows still require hardware validation.

## How this extends the original workflow

The existing original command owns microphone capture, resampling/VAD, its `VoiceSession`, partial/final decoding and commit/cancel cleanup. Its UI factories still run for that lifecycle, but no modal or above-input voice panel is displayed. A scoped observer reads the original session's already-reduced transcript/partial text and audio level, then updates the main input. The original session instance and reducer remain the sole owners of voice state; the companion does not create a second capture/recognition workflow or parse screen text.

For selected GGML inference, an isolated Jiti loader supplies **model and recognizer factories** through an async-local provider context. It does not mutate upstream exports, installed files, or shared module/transpile caches. The same command/session code runs with the selected provider. The version-checked adapter also extends the original fixed 10-second commit-drain budget to 180 seconds for slower large-model CPU decoding; the controller remains cancellable and bounded. Unexpected upstream contracts fail closed.

One local whisper-server worker is kept warm while armed; it is not another capture pipeline. It starts only when needed, serializes inference, passes language per request, and is stopped on deactivation, selection changes or failures. A healthy worker can retain RAM/VRAM between holds, even though the microphone is off.

Audio stays in memory and is sent only to a nonce-prefixed `127.0.0.1` endpoint. Native HTTP uses an owned proxy-free agent, never an environment/global fetch proxy or redirect. No extra audio recordings or transcript logs are written; native inference logs are drained without retaining transcript output.

The upstream API is private, so **rpiv-voice 2.15.0** is checked explicitly. Review/retest the adapter before upgrading that package. rpiv-i18n's live SDK state and runtime locale overrides are preserved across lazy loading.

## Transcript safeguards and limits

The original filter misses unspaced Japanese/Chinese repetition after a prefix. Additional Unicode-loop checks reject that known failure in previews/final output. English script-consistency checks apply only when English is explicitly selected; an unset locale keeps automatic language detection and permits valid non-Latin speech. Rejected text is discarded with a visible error, not silently rewritten, translated or submitted. Short foreign names and normal speech in another selected language remain supported. A larger model still does not guarantee perfect dictation.

Capture has a two-minute maximum hold. Original preflight microphone initialization has no immediate abort API; release during that stage is cancelled as soon as the original session becomes available. Backend startup is cancellable before microphone opening. Final decoding and HTTP requests have bounded timeouts; Escape/deactivation cancels pending results and stops native work.

Focus cancellation covers dialogs/overlays inside Pi, not guaranteed desktop-window focus reporting. Release Space before switching applications. Another custom main editor cannot be combined with this one; activation refuses to silently replace it.

## Development and releases

From the repository root:

```sh
npm test --workspace @dragoscirjan/pi-voice-ptt
npm run typecheck --workspace @dragoscirjan/pi-voice-ptt
npm run release:verify
```

Automated tests use byte-sized fake downloads, fake HTTP workers and isolated provider fixtures—no model downloads, GPU or microphone required. Real integration checks use the bundled English audio fixture, never a hardware microphone. See the repository's `RELEASING.md` for scoped independent npm releases; models, preferences, executables and test fixtures are excluded from the npm artifact.
