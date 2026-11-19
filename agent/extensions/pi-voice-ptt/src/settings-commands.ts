import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import type { InferenceService } from './inference.js';
import { MODELS, modelSize } from './models.js';
import {
  DEVICE_MODES,
  MODEL_NAMES,
  loadProfile,
  saveProfile,
  type DeviceMode,
  type ModelName,
  type VoiceProfile,
} from './profile.js';
import { findServer } from './server.js';

interface Controls {
  inference: InferenceService;
  stop(ctx: ExtensionCommandContext): Promise<boolean>;
  start(ctx: ExtensionCommandContext): Promise<void>;
}
const terminal = (ctx: ExtensionCommandContext) => ctx.hasUI && (!('mode' in ctx) || ctx.mode === 'tui');

export function registerSettingsCommands(pi: ExtensionAPI, controls: Controls): { cancel(): void; dispose(): void } {
  let operation: AbortController | undefined;
  let revision = 0;
  let disposed = false;
  const cancel = () => {
    revision++;
    operation?.abort();
  };
  const { inference } = controls;

  const status = async (ctx: ExtensionCommandContext) => {
    const profile = await inference.refresh();
    ctx.ui.notify(
      `Voice model: ${profile.model}; device: ${profile.device}. Backend: ${inference.describe()}.\nLocal preferences: ${inference.paths.profile}\nModels: ${inference.paths.models}`,
      'info',
    );
  };

  const cancellable = async <T>(
    ctx: ExtensionCommandContext,
    signal: AbortSignal,
    title: string,
    work: (update: (message: string) => void) => Promise<T>,
  ): Promise<T> => {
    signal.throwIfAborted();
    type Result = { ok: true; value: T } | { ok: false; error: unknown };
    const result = await ctx.ui.custom<Result>((tui, _theme, _keys, done) => {
      let message = title;
      void work((text) => {
        message = text;
        tui.requestRender();
      }).then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({ ok: false, error }),
      );
      return {
        render: (width: number) => [
          truncateToWidth(message, width),
          truncateToWidth('Esc cancels · selection is saved only after verification', width),
        ],
        invalidate() {},
        handleInput(data: string) {
          if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) operation?.abort();
        },
      };
    });
    signal.throwIfAborted();
    if (!result.ok) throw result.error;
    return result.value;
  };

  const ensureModel = async (
    ctx: ExtensionCommandContext,
    profile: VoiceProfile,
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    const executable = await findServer(profile.serverPath);
    signal.throwIfAborted();
    if (!executable) {
      if (profile.model === 'base' && profile.device !== 'gpu') return true; // Original base/CPU remains available.
      throw new Error(
        'Install a current whisper-server build, or set PI_VOICE_WHISPER_SERVER, before choosing this model/device.',
      );
    }
    const installed = await inference.models.installed(profile.model);
    signal.throwIfAborted();
    if (installed) return true;
    const definition = MODELS[profile.model];
    const accepted = await ctx.ui.confirm(
      `Download ${profile.model} (${modelSize(definition.bytes)})?`,
      `Official multilingual GGML model, verified by pinned SHA256. Stored only on this computer at ${inference.paths.models}.`,
    );
    signal.throwIfAborted();
    if (!accepted) return false;
    await cancellable(ctx, signal, `Preparing ${profile.model} model…`, async (update) =>
      inference.models.install(profile.model, signal, (bytes, total) => {
        update(
          `Downloading ${profile.model}: ${Math.floor((bytes / total) * 100)}% (${modelSize(bytes)} / ${modelSize(total)})`,
        );
      }),
    );
    return true;
  };

  const change = async (ctx: ExtensionCommandContext, update: (profile: VoiceProfile) => VoiceProfile) => {
    if (operation) {
      ctx.ui.notify('A voice setup operation is already running. Esc cancels it.', 'warning');
      return;
    }
    const selectedAt = revision;
    const abort = new AbortController();
    operation = abort;
    let wasActive = false;
    try {
      wasActive = await controls.stop(ctx);
      abort.signal.throwIfAborted();
      if (disposed || revision !== selectedAt) return;
      const next = update(await loadProfile(inference.paths));
      abort.signal.throwIfAborted();
      if (!(await ensureModel(ctx, next, abort.signal))) return;
      const description = await cancellable(
        ctx,
        abort.signal,
        `Verifying ${next.model}/${next.device} (microphone off)…`,
        async () => inference.probe(next, abort.signal, (message, level) => ctx.ui.notify(message, level)),
      );
      abort.signal.throwIfAborted();
      await saveProfile(next, inference.paths);
      if (!disposed) ctx.ui.notify(`Saved on this computer: ${description}.`, 'info');
    } catch (error) {
      if (disposed) return;
      if (abort.signal.aborted) ctx.ui.notify('Voice setup cancelled; saved selection was not changed.', 'info');
      else
        ctx.ui.notify(`Voice selection unchanged: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      try {
        await inference.close();
        if (wasActive && !abort.signal.aborted && !disposed) await controls.start(ctx);
      } finally {
        if (operation === abort) operation = undefined;
      }
    }
  };

  pi.registerCommand('voice-model', {
    description: 'Choose a machine-local Whisper model; confirm verified downloads',
    getArgumentCompletions: (prefix) =>
      [...MODEL_NAMES, 'status'].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (!terminal(ctx)) {
        ctx.ui.notify('Voice model selection requires the interactive terminal UI.', 'error');
        return;
      }
      try {
        const argument = args.trim();
        if (argument === 'status') {
          await status(ctx);
          return;
        }
        const selectedAt = revision;
        let name = argument;
        if (!name) {
          const choices = await Promise.all(
            MODEL_NAMES.map(
              async (model) =>
                `${model} — ${modelSize(MODELS[model].bytes)} — ${(await inference.models.installed(model)) ? 'installed' : 'not downloaded'}`,
            ),
          );
          const selected = await ctx.ui.select('Whisper model (saved on this computer only)', choices);
          if (!selected) return;
          name = selected.split(' ')[0]!;
        }
        if (disposed || revision !== selectedAt) return;
        if (!MODEL_NAMES.includes(name as ModelName)) {
          ctx.ui.notify('Usage: /voice-model tiny|base|small|medium|status', 'error');
          return;
        }
        await change(ctx, (profile) => ({ ...profile, model: name as ModelName }));
      } catch (error) {
        if (!disposed) ctx.ui.notify(String(error), 'error');
      }
    },
  });
  pi.registerCommand('voice-device', {
    description: 'Choose auto, CPU, or strict GPU mode on this computer',
    getArgumentCompletions: (prefix) =>
      [...DEVICE_MODES, 'status'].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (!terminal(ctx)) {
        ctx.ui.notify('Voice device selection requires the interactive terminal UI.', 'error');
        return;
      }
      try {
        const selectedAt = revision;
        let value = args.trim();
        if (value === 'status') {
          await status(ctx);
          return;
        }
        if (!value) {
          const selected = await ctx.ui.select('Recognition device (saved on this computer only)', [
            'auto — verified GPU when available; otherwise CPU',
            'cpu — force CPU',
            'gpu — require initialized hardware GPU; never silently fall back',
          ]);
          if (!selected) return;
          value = selected.split(' ')[0]!;
        }
        if (disposed || revision !== selectedAt) return;
        if (!DEVICE_MODES.includes(value as DeviceMode)) {
          ctx.ui.notify('Usage: /voice-device auto|cpu|gpu|status', 'error');
          return;
        }
        await change(ctx, (profile) => ({ ...profile, device: value as DeviceMode }));
      } catch (error) {
        if (!disposed) ctx.ui.notify(String(error), 'error');
      }
    },
  });
  return {
    cancel,
    dispose: () => {
      disposed = true;
      cancel();
    },
  };
}
