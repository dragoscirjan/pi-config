import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import register from '../index.js';
import type { VoiceBackend } from './controller.js';

const { load, kitty } = vi.hoisted(() => ({ load: vi.fn(), kitty: vi.fn(() => true) }));
vi.mock('./load-backend.js', () => ({ loadVoiceBackend: load }));
vi.mock('./inference.js', () => ({
  InferenceService: class {
    paths = { state: '/test/state', models: '/test/models', profile: '/test/preferences.json' };
    models = {};
    refresh = vi.fn(async () => ({ version: 1, model: 'base', device: 'auto' }));
    close = vi.fn(async () => {});
    describe = () => 'base · auto (not started)';
    subscribe = () => () => {};
  },
}));
vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/test/agent',
  CustomEditor: class {
    focused = true;
  },
}));
vi.mock('@earendil-works/pi-tui', () => ({
  isKittyProtocolActive: kitty,
  truncateToWidth: (text: string) => text,
}));

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<unknown>;
type Shutdown = (event: { type: 'session_shutdown' }, ctx: ExtensionContext) => Promise<unknown>;

const cleanups: Array<() => Promise<unknown>> = [];
function fixture(mode = 'tui') {
  const commands = new Map<string, { handler: Handler }>();
  let shutdown!: Shutdown;
  const pi = {
    registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
    on: (_event: string, handler: Shutdown) => {
      shutdown = handler;
    },
  };
  let editorFactory: ((tui: unknown, theme: unknown, keys: unknown) => unknown) | undefined;
  const ui = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    getEditorComponent: vi.fn(() => editorFactory),
    setEditorComponent: vi.fn((factory?: (tui: unknown, theme: unknown, keys: unknown) => unknown) => {
      editorFactory = factory;
      factory?.({ requestRender: vi.fn() }, {}, {});
    }),
  };
  const ctx = { hasUI: true, mode, ui } as unknown as ExtensionCommandContext;
  register(pi as unknown as ExtensionAPI);
  const run = (name: string) => commands.get(name)!.handler('', ctx);
  cleanups.push(() => shutdown({ type: 'session_shutdown' }, ctx));
  return { commands, ctx, ui, run, shutdown };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  kitty.mockReturnValue(true);
  load.mockResolvedValue({ start: vi.fn(), close: vi.fn() } satisfies VoiceBackend);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('additive extension commands', () => {
  it('registers only the new commands and does not initialize audio on load', () => {
    const f = fixture();
    expect([...f.commands.keys()]).toEqual(['voice-activate', 'voice-deactivate', 'voice-model', 'voice-device']);
    expect(load).not.toHaveBeenCalled();
    expect(f.ui.setEditorComponent).not.toHaveBeenCalled();
  });

  it('activates once and restores the normal editor on deactivate', async () => {
    const f = fixture();
    await f.run('voice-activate');
    await f.run('voice-activate');
    expect(load).toHaveBeenCalledExactlyOnceWith('/test/agent', f.ctx, expect.any(Function), expect.any(Object));
    expect(f.ui.setEditorComponent).toHaveBeenCalledTimes(1);
    await f.run('voice-deactivate');
    expect(f.ui.setEditorComponent).toHaveBeenLastCalledWith(undefined);
    expect(f.ui.setStatus).toHaveBeenLastCalledWith('voice-ptt', undefined);
  });

  it('refuses unsupported terminals and non-TUI sessions', async () => {
    const terminal = fixture();
    kitty.mockReturnValue(false);
    await terminal.run('voice-activate');
    kitty.mockReturnValue(true);
    const rpc = fixture('rpc');
    await rpc.run('voice-activate');
    expect(load).not.toHaveBeenCalled();
    expect(terminal.ui.notify).toHaveBeenCalledWith(expect.stringContaining('key-release'), 'error');
    expect(rpc.ui.notify).toHaveBeenCalledWith(expect.stringContaining('interactive'), 'error');
  });

  it('does not replace an unrelated editor when deactivated before activation', async () => {
    const f = fixture();
    await f.run('voice-deactivate');
    expect(f.ui.setEditorComponent).not.toHaveBeenCalled();
  });

  it('refuses activation instead of replacing an existing custom editor', async () => {
    const f = fixture();
    const foreignEditor = () => ({});
    f.ui.setEditorComponent(foreignEditor);
    await f.run('voice-activate');
    expect(load).not.toHaveBeenCalled();
    expect(f.ui.getEditorComponent()).toBe(foreignEditor);
    expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining('another custom editor'), 'error');
  });

  it('leaves a custom editor installed later by another extension untouched', async () => {
    const f = fixture();
    await f.run('voice-activate');
    const foreignEditor = () => ({});
    f.ui.setEditorComponent(foreignEditor);
    await f.run('voice-deactivate');
    expect(f.ui.getEditorComponent()).toBe(foreignEditor);
  });

  it('can deactivate while the model is preparing without installing a late editor', async () => {
    const f = fixture();
    let resolve!: (backend: VoiceBackend) => void;
    load.mockReturnValue(
      new Promise<VoiceBackend>((res) => {
        resolve = res;
      }),
    );
    const activating = f.run('voice-activate');
    await f.run('voice-deactivate');
    const backend = { start: vi.fn(), close: vi.fn() };
    resolve(backend);
    await activating;
    expect(backend.close).toHaveBeenCalledTimes(1);
    expect(f.ui.setEditorComponent).not.toHaveBeenCalled();
  });

  it('reports initialization errors without replacing the original editor', async () => {
    const f = fixture();
    load.mockRejectedValue(new Error('unsupported voice version'));
    await f.run('voice-activate');
    expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining('unsupported voice version'), 'error');
    expect(f.ui.setEditorComponent).not.toHaveBeenCalled();
  });

  it('cleans up the editor, engine and status on session shutdown or reload', async () => {
    const f = fixture();
    const backend = { start: vi.fn(), close: vi.fn() };
    load.mockResolvedValue(backend);
    await f.run('voice-activate');
    await f.shutdown({ type: 'session_shutdown' }, f.ctx);
    expect(backend.close).toHaveBeenCalledTimes(1);
    expect(f.ui.setEditorComponent).toHaveBeenLastCalledWith(undefined);
    expect(f.ui.setWidget).toHaveBeenLastCalledWith('voice-ptt', undefined);
  });
});
