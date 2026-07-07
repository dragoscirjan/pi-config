import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createSyncProviders } from "./src/sync.js";
import { setNotifier, runSilently } from "./src/log.js";
import { isLMStudioModelLoaded } from "./src/loading-check.js";

/**
 * pi-local-models: registers LM Studio, Ollama, llama.cpp, and MLX local
 * model servers as Pi providers, with rule-based (regex/string) annotation
 * of contextWindow/maxTokens/reasoning for backends with limited discovery
 * metadata. See `~/.pi/agent/local-models.json` for configuration and
 * `.specs/lld-00001-pi-local-models-multi-backend-extension-v1.md` for the
 * full design.
 */
export default async function (pi: ExtensionAPI): Promise<void> {
  const syncProviders = createSyncProviders(pi);

  // Initial sync at extension load, so models are available immediately
  // (including for `pi --list-models`, which never fires `session_start`).
  // Runs silently: in an interactive session, `session_start` below fires
  // moments later and re-syncs with a real `ctx.ui.notify`, so logging here
  // too would just be a duplicate of the same warning.
  await runSilently(() => syncProviders());

  // Re-sync at most once per agent turn: reset the flag when a new turn
  // starts, then run the sync once the assistant's message for that turn
  // finishes. Mirrors the original pi-lmstudio extension's event wiring.
  let fetchedThisCycle = false;

  // Re-sync immediately on session start (covers `/reload`, which does not
  // fire agent_start/message_end), and wire up ctx.ui.notify so warnings
  // show up in the UI instead of only going to a console nobody watches.
  pi.on("session_start", async (_event, ctx) => {
    setNotifier(ctx.hasUI ? (message, type) => ctx.ui.notify(message, type) : undefined);
    await syncProviders();
  });

  pi.on("agent_start", () => {
    fetchedThisCycle = false;
  });

  // Re-sync at most once per agent turn to pick up newly-available models
  // mid-session. Runs silently: `session_start` already surfaced any
  // connection problems once (at startup/reload), so repeating the same
  // warning on every single prompt would just be noise.
  pi.on("message_end", async (event) => {
    if (event.message.role === "assistant" && !fetchedThisCycle) {
      fetchedThisCycle = true;
      await runSilently(() => syncProviders());
    }
  });

  // Show a lightweight "loading model" indicator when the target LM Studio
  // model isn't loaded into memory yet (cold requests can take a while).
  // No progress % is available from any backend's API, so this is just a
  // static working-message override, restored once the response starts.
  pi.on("before_provider_request", async (_event, ctx) => {
    const model = ctx.model;
    if (!model) return;

    const entry = syncProviders.getServer(model.provider);
    if (!entry || entry.backend !== "lmstudio") return;

    const loaded = await isLMStudioModelLoaded(entry.server, model.id);
    if (!loaded) {
      ctx.ui.setWorkingMessage("⏳ loading model…");
    }
  });

  pi.on("after_provider_response", (_event, ctx) => {
    ctx.ui.setWorkingMessage();
  });
}
