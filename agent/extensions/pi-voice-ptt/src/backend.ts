import type { ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import type { Recording, VoiceBackend } from './controller.js';
import { transcriptProblem } from './quality.js';
import type { VoicePreview } from './session-context.js';

type CustomFactory = Parameters<ExtensionContext['ui']['custom']>[0];
export interface VoiceHost {
  tui: Parameters<CustomFactory>[0];
  keybindings: Parameters<CustomFactory>[2];
}
export type OriginalVoiceCommand = (
  args: string,
  ctx: ExtensionCommandContext,
  signal?: AbortSignal,
  onFatal?: (error: Error) => void,
  preview?: VoicePreview,
) => void | Promise<void>;

export interface OriginalVoiceAdapter {
  command: OriginalVoiceCommand;
  context: ExtensionCommandContext;
  getHost(): VoiceHost | undefined;
  getLocale(): string | undefined;
  describe?(): string;
  dispose?(): void;
}

type Completion = { intent: 'commit' | 'cancel'; transcript: string };
type DisposableComponent = Component & { dispose?(): void };

/** Drive the original command and its VoiceSession. Own no microphone, recognizer, or i18n state. */
export function createBackend(adapter: OriginalVoiceAdapter): VoiceBackend {
  let busy = false;
  let closed = false;
  let cancelCurrent: (() => void) | undefined;
  return {
    getLocale: adapter.getLocale,
    ...(adapter.describe ? { describe: adapter.describe } : {}),
    async start(signal, preview, onError): Promise<Recording> {
      signal.throwIfAborted();
      if (closed) throw new Error('Voice backend is deactivated.');
      if (busy) throw new Error('The original voice session is still stopping. Please try again in a moment.');
      const host = adapter.getHost();
      if (!host) throw new Error('The main editor is not ready for dictation.');
      busy = true;
      let stage = 0;
      let cancelled = false;
      let committing = false;
      let delivered = false;
      let transcript = '';
      let lastError: string | undefined;
      let completeSession: ((result: Completion) => void) | undefined;
      const locale = adapter.getLocale();
      let ready!: (recording: Recording) => void;
      let fail!: (error: Error) => void;
      const recordingReady = new Promise<Recording>((resolve, reject) => {
        ready = resolve;
        fail = reject;
      });
      const cancel = () => {
        cancelled = true;
        completeSession?.({ intent: 'cancel', transcript: '' });
      };
      cancelCurrent = cancel;
      signal.addEventListener('abort', cancel, { once: true });

      // The original command has two UI interactions: preflight splash, then VoiceSession.
      // Instantiate them for the original lifecycle, but display voice state inside the main editor.
      const custom: ExtensionContext['ui']['custom'] = (factory) =>
        new Promise((resolve, reject) => {
          const interaction = ++stage;
          let settled = false;
          let component: DisposableComponent | undefined;
          const done: Parameters<typeof factory>[3] = (result) => {
            if (settled) return;
            settled = true;
            if (interaction === 2) completeSession = undefined;
            component?.dispose?.();
            resolve(result);
          };
          try {
            Promise.resolve(factory(host.tui, adapter.context.ui.theme, host.keybindings, done))
              .then((created) => {
                if (settled) {
                  created.dispose?.();
                  return;
                }
                component = created;
                if (interaction === 2) {
                  // Complete the original UI with its existing result contract. Its command still
                  // stops/drains the mic, finalizes speech, aborts, releases the engine and pastes.
                  completeSession = (result) => done(result as Parameters<typeof done>[0]);
                  delivered = true;
                  ready({
                    finish() {
                      committing = true;
                      completeSession?.({ intent: 'commit', transcript: '' });
                      return completion.then(() => transcript);
                    },
                    cancel,
                  });
                  if (cancelled || signal.aborted) cancel();
                }
              })
              .catch(reject);
          } catch (error) {
            reject(error);
          }
        });
      const ui = new Proxy(adapter.context.ui, {
        get(target, property) {
          if (property === 'custom') return custom;
          if (property === 'pasteToEditor')
            return (text: string) => {
              if (cancelled || signal.aborted) return;
              const problem = transcriptProblem(text, locale);
              if (problem) throw new Error(problem);
              transcript = text;
            };
          if (property === 'notify')
            return (message: string, level?: 'info' | 'warning' | 'error') => {
              if (level === 'error') lastError = message;
              else target.notify(message, level);
            };
          return Reflect.get(target, property, target);
        },
      });
      const context = new Proxy(adapter.context, {
        get: (target, property) => (property === 'ui' ? ui : Reflect.get(target, property, target)),
      });
      const cleanup = () => {
        signal.removeEventListener('abort', cancel);
        cancelCurrent = undefined;
        busy = false;
      };
      const completion = Promise.resolve().then(() =>
        adapter.command(
          '',
          context,
          signal,
          (error) => {
            if (!cancelled && !signal.aborted) onError(error);
          },
          (text, level) => {
            if (cancelled || signal.aborted || committing) return;
            preview(transcriptProblem(text, locale) ? '' : text, level);
          },
        ),
      );
      completion.then(
        () => {
          cleanup();
          if (!delivered)
            fail(new Error(lastError ?? 'The original /voice command did not start a dictation session.'));
        },
        (error: unknown) => {
          cleanup();
          const failure = error instanceof Error ? error : new Error(String(error));
          if (!delivered) fail(failure);
          else if (!committing && !cancelled) onError(failure);
        },
      );
      return recordingReady;
    },
    close() {
      if (closed) return;
      closed = true;
      cancelCurrent?.();
      adapter.dispose?.();
    },
  };
}
