import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendEnvironment, initializedGpu, wavBuffer, WhisperWorker } from './server.js';
const workers: WhisperWorker[] = [];
const fixture = fileURLToPath(new URL('./__fixtures__/server.mjs', import.meta.url));
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});
async function start(model: string, device: 'cpu' | 'gpu' = 'cpu', signal = new AbortController().signal) {
  const worker = await WhisperWorker.start(
    {
      executable: process.execPath,
      prefixArgs: [fixture],
      model,
      device,
      threads: 4,
      startupMs: 3000,
      requestMs: 1000,
    },
    signal,
  );
  workers.push(worker);
  return worker;
}
describe('portable local whisper-server worker', () => {
  it('requires initialized hardware GPU evidence, not a build flag', () => {
    expect(initializedGpu('use gpu = 1; found GPU device 0')).toBeUndefined();
    expect(initializedGpu('whisper_backend_init_gpu: using Vulkan0 backend')).toBe('Vulkan0');
    expect(initializedGpu('whisper_backend_init_gpu: using Metal backend')).toBe('Metal');
    expect(
      initializedGpu(
        'whisper_backend_init_gpu: using CUDA0 backend\nwhisper_backend_init_gpu: failed to initialize CUDA0 backend',
      ),
    ).toBeUndefined();
    expect(
      initializedGpu('ggml_vulkan: 0 = llvmpipe\nwhisper_backend_init_gpu: using Vulkan0 backend'),
    ).toBeUndefined();
  });
  it('does not give the backend API credentials or proxy secrets', () => {
    expect(
      backendEnvironment({
        PATH: '/bin',
        SystemRoot: 'C:\\Windows',
        VK_DRIVER_FILES: '/driver.json',
        GGML_VK_VISIBLE_DEVICES: '0',
        LD_LIBRARY_PATH: '/libs',
        PI_TELEGRAM_TOKEN: 'secret',
        OPENAI_API_KEY: 'secret',
        AWS_ACCESS_KEY_ID: 'secret',
        HTTPS_PROXY: 'http://user:secret@proxy',
        SSH_AUTH_SOCK: '/agent',
        NPM_TOKEN: 'secret',
      }),
    ).toEqual({
      PATH: '/bin',
      SystemRoot: 'C:\\Windows',
      VK_DRIVER_FILES: '/driver.json',
      GGML_VK_VISIBLE_DEVICES: '0',
      LD_LIBRARY_PATH: '/libs',
    });
  });
  it('encodes finite 16kHz mono samples correctly', () => {
    const wav = wavBuffer(new Float32Array([-1, 0, 1]), 16000);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readInt16LE(44)).toBe(-32768);
    expect(wav.readInt16LE(48)).toBe(32767);
    expect(() => wavBuffer(new Float32Array([NaN]), 16000)).toThrow('Non-finite');
    expect(() => wavBuffer(new Float32Array(1), 48000)).toThrow('16 kHz');
  });
  it('sends in-memory WAV and original language over a nonce-prefixed loopback route', async () => {
    const w = await start('cpu');
    expect(w.actualDevice).toBe('cpu');
    const response = await w.transcribe(new Float32Array([-1, 0]), 16000, 'en', new AbortController().signal);
    expect(response).toBe('en|RIFF|16000|-32768|active=1');
    expect((await fetch(new URL('/health', w.endpoint))).status).toBe(404);
  });
  it('never routes private audio through global fetch/proxy configuration', async () => {
    const blocked = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('global network forbidden'));
    try {
      const w = await start('cpu');
      expect(await w.transcribe(new Float32Array([0]), 16000, 'en', new AbortController().signal)).toContain('en|RIFF');
      expect(blocked).not.toHaveBeenCalled();
    } finally {
      blocked.mockRestore();
    }
  });
  it('strict GPU never accepts a CPU-only server', async () => {
    await expect(start('cpu', 'gpu')).rejects.toThrow('did not initialize');
  });
  it('CPU mode never silently accepts GPU execution', async () => {
    await expect(start('ignore-cpu', 'cpu')).rejects.toThrow('ignored CPU-only');
  });
  it('reports a verified GPU and serializes concurrent decodes', async () => {
    const w = await start('gpu', 'gpu');
    expect(w.gpuBackend).toBe('Vulkan0');
    const result = await Promise.all([
      w.transcribe(new Float32Array([0]), 16000, 'en', new AbortController().signal),
      w.transcribe(new Float32Array([0]), 16000, 'ja', new AbortController().signal),
    ]);
    expect(result[0]).toContain('en|');
    expect(result[1]).toContain('ja|');
    expect(result.every((s) => s.endsWith('active=1'))).toBe(true);
  });
  it('stops a worker on inference failure', async () => {
    const w = await start('http-error');
    await expect(w.transcribe(new Float32Array([0]), 16000, 'en', new AbortController().signal)).rejects.toThrow(
      'HTTP 500',
    );
    expect(w.alive).toBe(false);
  });
  it('rejects invalid server responses', async () => {
    const w = await start('bad-json');
    await expect(w.transcribe(new Float32Array([0]), 16000, 'en', new AbortController().signal)).rejects.toThrow(
      'Invalid',
    );
  });
  it('cancels startup and active requests with process cleanup', async () => {
    await expect(start('slow', 'cpu', AbortSignal.timeout(50))).rejects.toThrow();
    const w = await start('hang');
    const c = new AbortController();
    const promise = w.transcribe(new Float32Array([0]), 16000, 'en', c.signal);
    c.abort();
    await expect(promise).rejects.toThrow();
    expect(w.alive).toBe(false);
  });
});
