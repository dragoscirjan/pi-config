import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyOriginalModel } from './original-model.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const agent = await mkdtemp(join(tmpdir(), 'voice-native-'));
  dirs.push(agent);
  const root = join(agent, 'npm/node_modules/@juicesharp/rpiv-voice');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '2.15.0' }));
  const model = { isModelDownloaded: vi.fn(() => true), assertModelIntact: vi.fn(), ensureModelDownloaded: vi.fn() };
  const load = vi.fn(async (_url: string) => model);
  return { agent, model, load };
}
describe('read-only original base model validation', () => {
  it('uses upstream installation/integrity checks without its installer or microphone', async () => {
    const f = await fixture();
    await verifyOriginalModel(f.agent, new AbortController().signal, f.load);
    expect(f.load).toHaveBeenCalledWith(expect.stringContaining('audio/model-download.ts'));
    expect(f.model.assertModelIntact).toHaveBeenCalledTimes(1);
    expect(f.model.ensureModelDownloaded).not.toHaveBeenCalled();
  });
  it('rejects a missing original model with an explicit manual setup instruction', async () => {
    const f = await fixture();
    f.model.isModelDownloaded.mockReturnValue(false);
    await expect(verifyOriginalModel(f.agent, new AbortController().signal, f.load)).rejects.toThrow('Run /voice once');
    expect(f.model.assertModelIntact).not.toHaveBeenCalled();
    expect(f.model.ensureModelDownloaded).not.toHaveBeenCalled();
  });
  it('rejects an incomplete original model rather than reporting setup success', async () => {
    const f = await fixture();
    f.model.assertModelIntact.mockImplementation(() => {
      throw new Error('Missing encoder');
    });
    await expect(verifyOriginalModel(f.agent, new AbortController().signal, f.load)).rejects.toThrow(
      'incomplete or corrupt',
    );
    expect(f.model.ensureModelDownloaded).not.toHaveBeenCalled();
  });
  it('does nothing after cancellation', async () => {
    const f = await fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(verifyOriginalModel(f.agent, abort.signal, f.load)).rejects.toThrow();
    expect(f.load).not.toHaveBeenCalled();
  });
  it('does not validate a late module after cancellation', async () => {
    const f = await fixture();
    const abort = new AbortController();
    let loaded!: (model: typeof f.model) => void;
    f.load.mockReturnValue(
      new Promise((resolve) => {
        loaded = resolve;
      }),
    );
    const pending = verifyOriginalModel(f.agent, abort.signal, f.load);
    await vi.waitFor(() => expect(f.load).toHaveBeenCalled());
    abort.abort();
    loaded(f.model);
    await expect(pending).rejects.toThrow();
    expect(f.model.isModelDownloaded).not.toHaveBeenCalled();
  });
});
