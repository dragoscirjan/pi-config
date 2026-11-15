import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceService } from './inference.js';
import { MODELS, modelSize } from './models.js';
import { loadProfile } from './profile.js';
import { registerSettingsCommands } from './settings-commands.js';
const { find } = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock('./server.js', () => ({ findServer: find }));
const dirs: string[] = [];
const disposals: Array<() => void> = [];
beforeEach(() => {
  find.mockReset().mockResolvedValue(process.execPath);
});
afterEach(async () => {
  disposals.splice(0).forEach((f) => f());
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<unknown>;
async function fixture(wasActive = false) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-selection-'));
  dirs.push(dir);
  const paths = { state: dir, models: join(dir, 'models'), profile: join(dir, 'preferences.json') };
  const probe = vi.fn(async () => 'small · GPU Vulkan0');
  const models = { installed: vi.fn(async () => true), install: vi.fn(async () => '/verified/model') };
  const inference = {
    paths,
    models,
    probe,
    refresh: async () => loadProfile(paths),
    close: vi.fn(async () => {}),
    describe: () => 'not started',
  } as unknown as InferenceService;
  const commands = new Map<string, { handler: Handler }>();
  const api = { registerCommand: (name: string, options: { handler: Handler }) => commands.set(name, options) };
  let cancelNext = false;
  const ui = {
    notify: vi.fn(),
    confirm: vi.fn(async () => true),
    select: vi.fn(async () => 'small — installed'),
    custom: vi.fn(
      (
        factory: (
          t: unknown,
          theme: unknown,
          keys: unknown,
          done: (value: unknown) => void,
        ) => { handleInput(data: string): void },
      ) =>
        new Promise((resolve) => {
          const component = factory({ requestRender() {} }, {}, {}, resolve);
          if (cancelNext) {
            cancelNext = false;
            queueMicrotask(() => component.handleInput('\x1b'));
          }
        }),
    ),
  };
  const ctx = { hasUI: true, mode: 'tui', ui } as unknown as ExtensionCommandContext;
  const stop = vi.fn(async () => wasActive);
  const start = vi.fn(async () => {});
  const control = registerSettingsCommands(api as unknown as ExtensionAPI, { inference, stop, start });
  disposals.push(control.dispose);
  return {
    paths,
    models,
    probe,
    ui,
    stop,
    start,
    control,
    run: (name: string, arg = '') => commands.get(name)!.handler(arg, ctx),
    cancelNext: () => {
      cancelNext = true;
    },
  };
}

describe('machine-local model/device commands', () => {
  it('shows status without loading a model, downloading, or stopping dictation', async () => {
    const f = await fixture();
    await f.run('voice-device', 'status');
    expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining(f.paths.profile), 'info');
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.probe).not.toHaveBeenCalled();
  });
  it('saves model selection only after a successful no-microphone probe', async () => {
    const f = await fixture(true);
    let resolve!: (value: string) => void;
    f.probe.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const choosing = f.run('voice-model', 'small');
    await vi.waitFor(() => expect(f.probe).toHaveBeenCalled());
    expect((await loadProfile(f.paths)).model).toBe('base');
    resolve('small · GPU Vulkan0');
    await choosing;
    expect((await loadProfile(f.paths)).model).toBe('small');
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it('does not download anything if confirmation is declined', async () => {
    const f = await fixture();
    f.models.installed.mockResolvedValue(false);
    f.ui.confirm.mockResolvedValue(false);
    await f.run('voice-model', 'small');
    expect(f.models.install).not.toHaveBeenCalled();
    expect(f.probe).not.toHaveBeenCalled();
    expect((await loadProfile(f.paths)).model).toBe('base');
  });
  it('requires confirmation before installing a selected model', async () => {
    const f = await fixture();
    f.models.installed.mockResolvedValue(false);
    await f.run('voice-model', 'small');
    expect(f.ui.confirm).toHaveBeenCalledWith(
      expect.stringContaining(modelSize(MODELS.small.bytes)),
      expect.any(String),
    );
    expect(f.models.install).toHaveBeenCalledWith('small', expect.any(AbortSignal), expect.any(Function));
    expect((await loadProfile(f.paths)).model).toBe('small');
  });
  it('does not save strict GPU when its actual backend probe fails', async () => {
    const f = await fixture();
    f.probe.mockRejectedValue(new Error('No initialized GPU'));
    await f.run('voice-device', 'gpu');
    expect((await loadProfile(f.paths)).device).toBe('auto');
    expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining('No initialized GPU'), 'error');
  });
  it('cancels setup without changing preferences or rearming', async () => {
    const f = await fixture(true);
    f.models.installed.mockResolvedValue(false);
    f.models.install.mockImplementation(async (...args: unknown[]) => {
      const signal = args[1] as AbortSignal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
      );
    });
    f.cancelNext();
    await f.run('voice-model', 'small');
    expect((await loadProfile(f.paths)).model).toBe('base');
    expect(f.start).not.toHaveBeenCalled();
    expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining('cancelled'), 'info');
  });
  it('refuses invalid command arguments before changing mode', async () => {
    const f = await fixture();
    await f.run('voice-model', 'huge');
    await f.run('voice-device', 'cuda');
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.models.install).not.toHaveBeenCalled();
  });
  it('does not revive an old picker after session disposal', async () => {
    const f = await fixture();
    let select!: (value: string) => void;
    f.ui.select.mockReturnValue(
      new Promise((resolve) => {
        select = resolve;
      }),
    );
    const choosing = f.run('voice-model');
    await vi.waitFor(() => expect(f.ui.select).toHaveBeenCalled());
    f.control.dispose();
    select('small — installed');
    await choosing;
    expect(f.stop).not.toHaveBeenCalled();
    expect((await loadProfile(f.paths)).model).toBe('base');
  });
});
