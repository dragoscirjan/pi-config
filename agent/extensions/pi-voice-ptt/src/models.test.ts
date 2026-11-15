import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODELS, ModelStore } from './models.js';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture(bytes = Buffer.from('test-model')) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-models-'));
  dirs.push(dir);
  const definitions = {
    ...MODELS,
    small: {
      file: 'ggml-small.bin',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      url: 'https://models.invalid/model',
    },
  };
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(bytes)));
  return { dir, bytes, fetcher, store: new ModelStore(dir, definitions, fetcher) };
}
describe('verified opt-in model installation', () => {
  it('downloads once, verifies SHA256 and installs atomically', async () => {
    const f = await fixture();
    const progress = vi.fn();
    await f.store.install('small', new AbortController().signal, progress);
    expect(await f.store.installed('small')).toBe(true);
    expect(await readFile(f.store.path('small'))).toEqual(f.bytes);
    await f.store.install('small', new AbortController().signal);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalled();
    expect((await readdir(f.dir)).some((n) => n.endsWith('.partial'))).toBe(false);
  });
  it('verifies an existing official file without another download', async () => {
    const f = await fixture();
    await writeFile(f.store.path('small'), f.bytes);
    await f.store.install('small', new AbortController().signal);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(await f.store.installed('small')).toBe(true);
  });
  it('does not trust stale verification metadata after modification', async () => {
    const f = await fixture();
    await f.store.install('small', new AbortController().signal);
    await utimes(f.store.path('small'), new Date(), new Date(Date.now() + 5000));
    expect(await f.store.installed('small')).toBe(false);
    await writeFile(f.store.marker('small'), 'null');
    expect(await f.store.installed('small')).toBe(false);
  });
  it('rejects checksum failure and preserves any previous file', async () => {
    const f = await fixture();
    await writeFile(f.store.path('small'), 'previous');
    f.fetcher.mockResolvedValue(new Response(new Uint8Array(Buffer.alloc(f.bytes.length))));
    await expect(f.store.install('small', new AbortController().signal)).rejects.toThrow('checksum');
    expect(await readFile(f.store.path('small'), 'utf8')).toBe('previous');
    expect(await f.store.installed('small')).toBe(false);
    expect((await readdir(f.dir)).some((n) => n.endsWith('.partial'))).toBe(false);
  });
  it('rejects truncated or oversized responses', async () => {
    const f = await fixture();
    f.fetcher.mockResolvedValueOnce(new Response(new Uint8Array([1])));
    await expect(f.store.install('small', new AbortController().signal)).rejects.toThrow('verification');
    f.fetcher.mockResolvedValueOnce(new Response(new Uint8Array(100)));
    await expect(f.store.install('small', new AbortController().signal)).rejects.toThrow('larger');
  });
  it('does not fetch after cancellation', async () => {
    const f = await fixture();
    const c = new AbortController();
    c.abort();
    await expect(f.store.install('small', c.signal)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('cleans partial data when cancelled mid-download', async () => {
    const f = await fixture();
    const c = new AbortController();
    f.fetcher.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
              c.abort();
              controller.close();
            },
          }),
        ),
    );
    await expect(f.store.install('small', c.signal)).rejects.toThrow();
    expect((await readdir(f.dir)).some((n) => n.endsWith('.partial'))).toBe(false);
    expect(await f.store.installed('small')).toBe(false);
  });
});
