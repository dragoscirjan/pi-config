import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { createBackend, type OriginalVoiceCommand, type VoiceHost } from './backend.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
async function tick() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
type Result = { intent: 'commit' | 'cancel'; transcript: string };

function fixture(
  options: {
    text?: string;
    preview?: string;
    preflight?: Promise<void>;
    drain?: Promise<void>;
    command?: OriginalVoiceCommand;
  } = {},
) {
  const ui = { custom: vi.fn(), pasteToEditor: vi.fn(), notify: vi.fn(), setWidget: vi.fn(), theme: {} };
  const context = { ui, hasUI: true, mode: 'tui' } as unknown as ExtensionCommandContext;
  const host = { tui: { requestRender: vi.fn() }, keybindings: {} } as unknown as VoiceHost;
  const lifecycle: string[] = [];
  let locale: string | undefined = 'en';
  const component = {
    render: () => [options.preview ?? 'original voice view', 'Enter to paste · Space to pause'],
    invalidate: vi.fn(),
  };
  const command = vi.fn<OriginalVoiceCommand>(
    options.command ??
      (async (_args, ctx) => {
        lifecycle.push('original-preflight');
        await ctx.ui.custom((_tui, _theme, _keys, done) => {
          void (options.preflight ?? Promise.resolve()).then(() => done(undefined));
          return component;
        });
        const result = await ctx.ui.custom<Result>((tui, theme, keys, _done) => {
          expect(tui).toBe(host.tui);
          expect(theme).toBe(ui.theme);
          expect(keys).toBe(host.keybindings);
          lifecycle.push('original-session');
          return component;
        });
        lifecycle.push(`original-${result.intent}`);
        if (result.intent === 'commit') {
          await options.drain;
          ctx.ui.pasteToEditor(options.text ?? 'Original transcript.');
        }
        lifecycle.push('original-cleanup');
      }),
  );
  const backend = createBackend({ command, context, getHost: () => host, getLocale: () => locale });
  const abort = new AbortController();
  const preview = vi.fn();
  const onError = vi.fn();
  const start = () => backend.start(abort.signal, preview, onError);
  return {
    backend,
    start,
    abort,
    command,
    ui,
    lifecycle,
    preview,
    onError,
    setLocale: (value: string | undefined) => {
      locale = value;
    },
  };
}

describe('adapter around the unchanged original /voice command', () => {
  it('does not launch a parallel recognizer or original command on activation', () => {
    const f = fixture();
    expect(f.command).not.toHaveBeenCalled();
    expect(f.lifecycle).toEqual([]);
  });

  it('invokes the original preflight/session/drain and captures its final paste', async () => {
    const f = fixture();
    const recording = await f.start();
    expect(f.lifecycle).toEqual(['original-preflight', 'original-session']);
    expect(f.ui.custom).not.toHaveBeenCalled();
    expect(f.ui.setWidget).toHaveBeenCalledWith(expect.stringMatching(/^voice-ptt-session-/u), expect.any(Function));
    expect(await recording.finish()).toBe('Original transcript.');
    expect(f.lifecycle).toEqual(['original-preflight', 'original-session', 'original-commit', 'original-cleanup']);
    expect(f.command).toHaveBeenCalledTimes(1);
    expect(f.ui.pasteToEditor).not.toHaveBeenCalled();
  });

  it('preserves the original view but replaces modal hints with actual push-to-talk controls', async () => {
    const f = fixture();
    const recording = await f.start();
    const factory = f.ui.setWidget.mock.calls.at(-1)![1] as () => { render(width: number): string[] };
    const lines = factory().render(80);
    expect(lines[0]).toBe('original voice view');
    expect(lines.at(-1)).toBe('Release Space: finish · Esc: cancel');
    recording.cancel();
    await tick();
  });

  it('does not let old-session cleanup clear a newer session widget', async () => {
    const old = fixture();
    const next = fixture();
    await old.start();
    await next.start();
    const oldKey = old.ui.setWidget.mock.calls.at(-1)![0];
    const newKey = next.ui.setWidget.mock.calls.at(-1)![0];
    expect(oldKey).not.toBe(newKey);
    old.backend.close();
    await tick();
    expect(old.ui.setWidget.mock.calls.at(-1)![0]).toBe(oldKey);
    expect(next.ui.setWidget.mock.calls.at(-1)![1]).toBeTypeOf('function');
    next.backend.close();
    await tick();
  });

  it('uses the original cancel path rather than a second audio teardown', async () => {
    const f = fixture();
    const recording = await f.start();
    recording.cancel();
    await tick();
    expect(f.lifecycle).toContain('original-cancel');
    expect(f.lifecycle).toContain('original-cleanup');
    expect(f.ui.pasteToEditor).not.toHaveBeenCalled();
  });

  it('cancels the original session as soon as preflight finishes after an early release', async () => {
    const preflight = deferred<void>();
    const f = fixture({ preflight: preflight.promise });
    const starting = f.start();
    await tick();
    f.abort.abort();
    preflight.resolve();
    await starting;
    await tick();
    expect(f.lifecycle).toContain('original-cancel');
    expect(f.lifecycle).toContain('original-cleanup');
    expect(f.lifecycle).not.toContain('original-commit');
  });

  it('does not invoke the command with an already cancelled signal', async () => {
    const f = fixture();
    f.abort.abort();
    await expect(f.start()).rejects.toThrow();
    expect(f.command).not.toHaveBeenCalled();
  });

  it('never runs a second voice command while the first is draining', async () => {
    const drain = deferred<void>();
    const f = fixture({ drain: drain.promise });
    const first = await f.start();
    const finishing = first.finish();
    await tick();
    f.abort.abort();
    const another = new AbortController();
    await expect(f.backend.start(another.signal, f.preview, f.onError)).rejects.toThrow('still stopping');
    drain.resolve();
    expect(await finishing).toBe('');
    expect(f.command).toHaveBeenCalledTimes(1);
  });

  it('reads the existing i18n locale live, not from an activation-time copy', async () => {
    const f = fixture({ text: '日本語の文章を正しく認識します。' });
    expect(f.backend.getLocale?.()).toBe('en');
    f.setLocale('ja');
    expect(f.backend.getLocale?.()).toBe('ja');
    const recording = await f.start();
    expect(await recording.finish()).toBe('日本語の文章を正しく認識します。');
  });

  it('blocks a foreign-script English result before it reaches the editor', async () => {
    const f = fixture({ text: 'English prefix. 日本語の文章を勝手に出力しています。' });
    const recording = await f.start();
    await expect(recording.finish()).rejects.toThrow('inconsistent with English');
    expect(f.ui.pasteToEditor).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
  });

  it('does not display a repetitive foreign-script preview as trusted speech', async () => {
    const f = fixture({ preview: '\u001b[31m' + '日本語の中で、'.repeat(12) + '\u001b[0m' });
    const recording = await f.start();
    const factory = f.ui.setWidget.mock.calls.at(-1)![1] as () => { render(width: number): string[] };
    expect(factory().render(80).join(' ')).toContain('Unreliable voice preview');
    recording.cancel();
    await tick();
  });

  it('blocks the reported mixed-English/Japanese loop', async () => {
    const f = fixture({ text: 'Rade Jumping Walks Runs Like Kiyote ' + '日本語の中で、'.repeat(12) + '日本' });
    const recording = await f.start();
    await expect(recording.finish()).rejects.toThrow('repeated-text loop');
    expect(f.ui.pasteToEditor).not.toHaveBeenCalled();
  });

  it('surfaces original preflight errors instead of starting a separate fallback', async () => {
    const f = fixture({
      command: async (_args, ctx) => {
        ctx.ui.notify('Original mic failure', 'error');
      },
    });
    await expect(f.start()).rejects.toThrow('Original mic failure');
    expect(f.ui.notify).not.toHaveBeenCalled();
    expect(f.command).toHaveBeenCalledTimes(1);
  });

  it('cannot start a closed backend and closes it idempotently', async () => {
    const f = fixture();
    f.backend.close();
    f.backend.close();
    await expect(f.start()).rejects.toThrow('deactivated');
    expect(f.command).not.toHaveBeenCalled();
  });

  it('cancels the original command on close', async () => {
    const f = fixture();
    await f.start();
    f.backend.close();
    await tick();
    expect(f.lifecycle).toContain('original-cancel');
    expect(f.ui.setWidget).toHaveBeenLastCalledWith(expect.stringMatching(/^voice-ptt-session-/u), undefined);
  });
});
