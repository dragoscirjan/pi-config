import { createHash } from 'node:crypto';
import { readdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODELS, ModelStore } from './models.js';
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
  it('re-verifies legacy metadata without downloading or changing model preferences', async () => {
    const f = await fixture();
    await writeFile(f.store.path('small'), f.bytes);
    await writeFile(
      f.store.marker('small'),
      JSON.stringify({
        sha256: f.store.definitions.small.sha256,
        bytes: f.bytes.length,
        mtimeMs: (await stat(f.store.path('small'))).mtimeMs,
      }),
    );
    expect(await f.store.installed('small')).toBe(true);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(f.store.marker('small'), 'utf8'))).toMatchObject({
      version: 2,
      identity: expect.any(String),
    });
  });
  it('does not migrate a legacy marker attached to corrupt bytes', async () => {
    const f = await fixture();
    await writeFile(f.store.path('small'), Buffer.alloc(f.bytes.length));
    await writeFile(
      f.store.marker('small'),
      JSON.stringify({ sha256: f.store.definitions.small.sha256, bytes: f.bytes.length, mtimeMs: 0 }),
    );
    expect(await f.store.installed('small')).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('does not mark a same-size replacement made after the hash as verified', async () => {
    const f = await fixture();
    await writeFile(f.store.path('small'), f.bytes);
    const hash = createHash('sha256');
    const digest = hash.digest.bind(hash);
    vi.spyOn(hash, 'digest').mockImplementationOnce((encoding) => {
      const value = digest(encoding);
      const replacement = join(f.dir, 'replacement.bin');
      writeFileSync(replacement, Buffer.alloc(f.bytes.length));
      // Windows cannot overwrite an open destination; keep its descriptor open under another name.
      renameSync(f.store.path('small'), join(f.dir, 'hashed-original.bin'));
      renameSync(replacement, f.store.path('small'));
      return value;
    });
    vi.mocked(createHash).mockReturnValueOnce(hash);
    await expect(f.store.install('small', new AbortController().signal)).rejects.toThrow('changed during verification');
    expect(await f.store.installed('small')).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('does not mark in-place mutations made after hashing as verified', async () => {
    const f = await fixture();
    await writeFile(f.store.path('small'), f.bytes);
    const hash = createHash('sha256');
    const digest = hash.digest.bind(hash);
    vi.spyOn(hash, 'digest').mockImplementationOnce((encoding) => {
      const value = digest(encoding);
      writeFileSync(f.store.path('small'), Buffer.alloc(f.bytes.length));
      return value;
    });
    vi.mocked(createHash).mockReturnValueOnce(hash);
    await expect(f.store.install('small', new AbortController().signal)).rejects.toThrow('changed during verification');
    expect(await f.store.installed('small')).toBe(false);
  });
  it('verifies actual downloaded disk bytes before replacing any previous file', async () => {
    const f = await fixture();
    await writeFile(f.store.path('small'), 'previous');
    await expect(
      f.store.install('small', new AbortController().signal, () => {
        const temporary = readdirSync(f.dir).find((file) => file.endsWith('.partial'))!;
        writeFileSync(join(f.dir, temporary), Buffer.alloc(f.bytes.length));
      }),
    ).rejects.toThrow('verification failed on disk');
    expect(await readFile(f.store.path('small'), 'utf8')).toBe('previous');
    expect(await f.store.installed('small')).toBe(false);
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
