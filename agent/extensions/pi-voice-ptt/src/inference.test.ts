import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InferenceService, type InferenceOptions, type Worker } from './inference.js';
import { MODELS, ModelStore } from './models.js';
import type { VoiceProfile } from './profile.js';

const dirs: string[] = [];
const services: InferenceService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
function worker(device: 'cpu' | 'gpu') {
  const result = {
    alive: true,
    actualDevice: device,
    gpuBackend: device === 'gpu' ? 'Vulkan0' : undefined,
    transcribe: vi.fn<Worker['transcribe']>(async () => 'recognized'),
    stop: vi.fn<Worker['stop']>(async () => {}),
  };
  result.stop.mockImplementation(async () => {
    result.alive = false;
  });
  return result;
}
async function fixture(device: VoiceProfile['device'] = 'auto') {
  const dir = await mkdtemp(join(tmpdir(), 'voice-inference-'));
  dirs.push(dir);
  const bytes = Buffer.from('verified fixture');
  const definitions = {
    ...MODELS,
    small: {
      file: 'ggml-small.bin',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      url: 'https://models.invalid',
    },
  };
  const models = new ModelStore(join(dir, 'models'), definitions, async () => new Response(new Uint8Array(bytes)));
  await models.install('small', new AbortController().signal);
  let profile: VoiceProfile = { version: 1, model: 'small', device };
  const workers: ReturnType<typeof worker>[] = [];
  const start = vi.fn<NonNullable<InferenceOptions['start']>>(async (options) => {
    const w = worker(options.device);
    workers.push(w);
    return w;
  });
  const verifyOriginal = vi.fn<NonNullable<InferenceOptions['verifyOriginal']>>(async () => {});
  const service = new InferenceService({
    paths: { state: dir, profile: join(dir, 'preferences.json'), models: models.directory },
    store: models,
    readProfile: async () => profile,
    find: async () => process.execPath,
    start,
    verifyOriginal,
  });
  services.push(service);
  const abort = new AbortController();
  const notice = vi.fn();
  const fatal = vi.fn();
  const provider = () => service.prepare(abort.signal, notice, fatal);
  return {
    service,
    verifyOriginal,
    start,
    workers,
    provider,
    abort,
    notice,
    fatal,
    profile: (next: VoiceProfile) => {
      profile = next;
    },
  };
}

describe('model/device provider policy', () => {
  it('does not spawn a model worker merely by construction/refresh', async () => {
    const f = await fixture();
    await f.service.refresh();
    expect(f.start).not.toHaveBeenCalled();
  });
  it('keeps native base/CPU as the no-download default', async () => {
    const f = await fixture();
    f.profile({ version: 1, model: 'base', device: 'auto' });
    expect(await f.provider()).toBeUndefined();
    expect(f.service.describe()).toContain('CPU (original)');
    expect(f.start).not.toHaveBeenCalled();
  });
  it('verifies native fallback before reporting successful setup', async () => {
    const f = await fixture();
    f.profile({ version: 1, model: 'base', device: 'cpu' });
    const profile = await f.service.refresh();
    expect(await f.service.probe(profile, f.abort.signal, f.notice)).toContain('CPU (original)');
    expect(f.verifyOriginal).toHaveBeenCalledWith(f.abort.signal);
    expect(f.start).not.toHaveBeenCalled();
  });
  it('rejects missing original models during native setup without starting a worker', async () => {
    const f = await fixture();
    f.profile({ version: 1, model: 'base', device: 'auto' });
    f.verifyOriginal.mockRejectedValue(new Error('Run /voice once'));
    await expect(f.service.probe(await f.service.refresh(), f.abort.signal, f.notice)).rejects.toThrow('/voice');
    expect(f.start).not.toHaveBeenCalled();
  });
  it('passes original language/thread settings into a CPU provider', async () => {
    const f = await fixture('cpu');
    const p = (await f.provider())!;
    p.assertIntact();
    const e = await p.engine({ ...p.paths(), numThreads: 7, language: 'ru' });
    expect(f.start.mock.calls[0]![0]).toMatchObject({ device: 'cpu', threads: 7 });
    const audio = new Float32Array([0]);
    expect(await e.recognize(audio, 16000)).toBe('recognized');
    expect(f.workers[0]!.transcribe).toHaveBeenCalledWith(audio, 16000, 'ru', expect.any(AbortSignal));
    e.release();
  });
  it('uses auto GPU fallback visibly and keeps CPU warm across holds', async () => {
    const f = await fixture();
    f.start.mockImplementation(async (options) => {
      if (options.device === 'gpu') throw new Error('No GPU');
      const w = worker('cpu');
      f.workers.push(w);
      return w;
    });
    const p = (await f.provider())!;
    const first = await p.engine({ ...p.paths() });
    first.release();
    const next = (await f.provider())!;
    (await next.engine({ ...next.paths() })).release();
    expect(f.start).toHaveBeenCalledTimes(2);
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('using CPU'), 'warning');
    expect(f.service.describe()).toBe('small · CPU');
  });
  it('never falls back from explicit GPU to CPU', async () => {
    const f = await fixture('gpu');
    f.start.mockRejectedValue(new Error('GPU unavailable'));
    const p = (await f.provider())!;
    await expect(p.engine({ ...p.paths() })).rejects.toThrow('GPU unavailable');
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(p.error?.()?.message).toBe('GPU unavailable');
  });
  it('retries the exact same audio on CPU after auto GPU inference fails', async () => {
    const f = await fixture();
    const p = (await f.provider())!;
    const engine = await p.engine({ ...p.paths(), language: 'en' });
    f.workers[0]!.transcribe.mockRejectedValueOnce(new Error('GPU allocation failed'));
    const samples = new Float32Array([0.1, 0.2]);
    expect(await engine.recognize(samples, 16000)).toBe('recognized');
    expect(f.workers[1]!.actualDevice).toBe('cpu');
    expect(f.workers[1]!.transcribe.mock.calls[0]![0]).toBe(samples);
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('same audio'), 'warning');
    engine.release();
  });
  it('recovers a delayed second GPU failure after another decode already switched to CPU', async () => {
    const f = await fixture();
    const p = (await f.provider())!;
    const engine = await p.engine({ ...p.paths() });
    let reject!: (error: Error) => void;
    const late = new Promise<string>((_resolve, fail) => {
      reject = fail;
    });
    f.workers[0]!.transcribe.mockRejectedValueOnce(new Error('first GPU failure')).mockReturnValueOnce(late);
    const first = engine.recognize(new Float32Array([0.1]), 16000);
    const second = engine.recognize(new Float32Array([0.2]), 16000);
    expect(await first).toBe('recognized');
    reject(new Error('late GPU failure'));
    expect(await second).toBe('recognized');
    expect(f.fatal).not.toHaveBeenCalled();
    expect(f.workers).toHaveLength(2);
  });
  it('reports inference failure once and never silently changes a strict device', async () => {
    const f = await fixture('gpu');
    const p = (await f.provider())!;
    const engine = await p.engine({ ...p.paths() });
    f.workers[0]!.transcribe.mockRejectedValue(new Error('GPU failed'));
    await expect(engine.recognize(new Float32Array([0]), 16000)).rejects.toThrow('GPU failed');
    await expect(engine.recognize(new Float32Array([0]), 16000)).rejects.toThrow();
    expect(f.fatal).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it('notifies observers when actual GPU inference falls back to CPU', async () => {
    const f = await fixture();
    const labels: string[] = [];
    const off = f.service.subscribe(() => labels.push(f.service.describe()));
    const p = (await f.provider())!;
    const engine = await p.engine({ ...p.paths() });
    f.workers[0]!.transcribe.mockRejectedValueOnce(new Error('GPU error'));
    await engine.recognize(new Float32Array([0]), 16000);
    expect(labels).toContain('small · GPU Vulkan0');
    expect(labels.at(-1)).toBe('small · CPU');
    off();
  });
  it('keeps the actual warm device visible while preparing another capture', async () => {
    const f = await fixture();
    const p = (await f.provider())!;
    const engine = await p.engine({ ...p.paths() });
    await f.provider();
    expect(f.service.describe()).toBe('small · GPU Vulkan0');
    engine.release();
  });

  it('requires explicit installation instead of downloading while a key is held', async () => {
    const f = await fixture();
    f.profile({ version: 1, model: 'medium', device: 'auto' });
    await expect(f.provider()).rejects.toThrow('/voice-model medium');
    expect(f.start).not.toHaveBeenCalled();
  });
  it('shares one startup between concurrent recognizer factories', async () => {
    const f = await fixture('cpu');
    const p = (await f.provider())!;
    const engines = await Promise.all([p.engine({ ...p.paths() }), p.engine({ ...p.paths() })]);
    expect(f.start).toHaveBeenCalledTimes(1);
    engines.forEach((engine) => engine.release());
  });
  it('cleans up a backend whose startup finishes after close', async () => {
    const f = await fixture('cpu');
    let finish!: (w: Worker) => void;
    f.start.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const p = (await f.provider())!;
    const engine = p.engine({ ...p.paths() });
    const rejected = expect(engine).rejects.toThrow();
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
    const closing = f.service.close();
    const late = worker('cpu');
    finish(late);
    await closing;
    await rejected;
    expect(late.alive).toBe(false);
  });
  it('probes a profile without opening a microphone or keeping a worker alive', async () => {
    const f = await fixture('gpu');
    const result = await f.service.probe({ version: 1, model: 'small', device: 'gpu' }, f.abort.signal, f.notice);
    expect(result).toBe('small · GPU Vulkan0');
    expect(f.workers[0]!.alive).toBe(false);
  });
});
