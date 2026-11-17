import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { isKittyProtocolActive } from '@earendil-works/pi-tui';
import type { VoiceHost } from './src/backend.js';
import { VoiceController, type VoicePhase } from './src/controller.js';
import { HoldToTalkEditor } from './src/editor.js';
import { InferenceService } from './src/inference.js';
import { loadVoiceBackend } from './src/load-backend.js';
import { registerSettingsCommands } from './src/settings-commands.js';

const STATUS_KEY = 'voice-ptt';
const LABELS: Record<Exclude<VoicePhase, 'off'>, string> = {
  ready: 'Voice armed · hold Space to talk',
  holding: 'Voice hold Space · microphone off',
  starting: 'Voice starting · wait for Listening',
  listening: 'Voice listening · release Space to insert',
  transcribing: 'Voice transcribing…',
  stopping: 'Voice stopping…',
};

/** Keep upstream /voice and /languages intact; add gestures and a scoped inference provider. */
export default function (pi: ExtensionAPI): void {
  const inference = new InferenceService();
  let controller: VoiceController | undefined;
  let ownedEditorFactory: Parameters<ExtensionContext['ui']['setEditorComponent']>[0];
  let preparing = false;
  let unsubscribe: (() => void) | undefined;
  let generation = 0;
  let setup = { cancel() {}, dispose() {} };

  const deactivate = async (ctx: ExtensionContext, cancelSetup = true): Promise<void> => {
    generation++;
    preparing = false;
    if (cancelSetup) setup.cancel();
    unsubscribe?.();
    unsubscribe = undefined;
    controller?.deactivate();
    controller = undefined;
    if (ownedEditorFactory && ctx.ui.getEditorComponent() === ownedEditorFactory) ctx.ui.setEditorComponent(undefined);
    ownedEditorFactory = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(STATUS_KEY, undefined);
    await inference.close();
  };

  const activate = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (!ctx.hasUI || ('mode' in ctx && ctx.mode !== 'tui')) {
      ctx.ui.notify('Push-to-talk requires the interactive terminal UI.', 'error');
      return;
    }
    if (!isKittyProtocolActive()) {
      ctx.ui.notify('Push-to-talk needs key-release reporting, such as Ghostty or Kitty.', 'error');
      return;
    }
    if (controller || preparing) {
      ctx.ui.notify('Push-to-talk is already active or preparing.', 'info');
      return;
    }
    if (ctx.ui.getEditorComponent()) {
      ctx.ui.notify('Push-to-talk cannot be combined with another custom editor. Disable that editor first.', 'error');
      return;
    }
    preparing = true;
    const activation = ++generation;
    ctx.ui.setStatus(STATUS_KEY, 'Voice preparing · microphone off');
    try {
      await inference.refresh();
      let voiceHost: VoiceHost | undefined;
      const backend = await loadVoiceBackend(getAgentDir(), ctx, () => voiceHost, inference);
      if (activation !== generation) {
        backend.close();
        return;
      }
      if (ctx.ui.getEditorComponent()) {
        backend.close();
        throw new Error('Another extension installed a custom editor while push-to-talk was preparing.');
      }
      let editor: HoldToTalkEditor | undefined;
      let currentPhase: VoicePhase = 'ready';
      const renderStatus = () => {
        const details = backend.describe?.();
        ctx.ui.setStatus(
          STATUS_KEY,
          currentPhase === 'off'
            ? undefined
            : `${LABELS[currentPhase]} [${backend.getLocale?.() ?? 'auto'}]${details ? ` · ${details}` : ''}`,
        );
      };
      controller = new VoiceController({
        backend,
        drainMs: 185_000,
        canCapture: () => editor?.focused === true,
        insert: (text) => editor?.insertDictation(text),
        status: (phase, preview, audioLevel) => {
          currentPhase = phase;
          renderStatus();
          editor?.setVoiceState(phase, preview, audioLevel);
        },
        error: (message) => ctx.ui.notify(`Push-to-talk: ${message}`, 'error'),
      });
      unsubscribe = inference.subscribe(() => {
        if (activation === generation && controller) renderStatus();
      });
      const active = controller;
      ownedEditorFactory = (tui, theme, keybindings) => {
        voiceHost = { tui, keybindings };
        editor = new HoldToTalkEditor([tui, theme, keybindings], active, () => tui.requestRender());
        editor.setVoiceState(currentPhase);
        return editor;
      };
      ctx.ui.setEditorComponent(ownedEditorFactory);
      ctx.ui.notify(
        'Push-to-talk enabled. Hold Space (~400 ms), wait for Listening, speak, then release. /voice-model and /voice-device configure this computer.',
        'info',
      );
    } catch (error) {
      if (activation !== generation) return;
      await deactivate(ctx);
      ctx.ui.notify(
        `Could not enable push-to-talk: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    } finally {
      if (activation === generation) preparing = false;
    }
  };

  pi.registerCommand('voice-activate', {
    description: 'Enable hold-Space dictation without changing /voice',
    handler: async (_args, ctx) => activate(ctx),
  });
  pi.registerCommand('voice-deactivate', {
    description: 'Disable hold-Space dictation and stop its microphone/model worker',
    handler: async (_args, ctx) => {
      await deactivate(ctx);
      ctx.ui.notify('Push-to-talk disabled. The original /voice command is unchanged.', 'info');
    },
  });
  setup = registerSettingsCommands(pi, {
    inference,
    stop: async (ctx) => {
      const wasActive = !!controller || preparing;
      await deactivate(ctx, false);
      return wasActive;
    },
    start: activate,
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    setup.dispose();
    await deactivate(ctx);
  });
}
