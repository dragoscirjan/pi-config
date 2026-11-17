import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentProvider, withProvider, type SessionProvider } from './provider-context.js';
import { DRAIN_MS, extendDrainBudget, scopedVoiceCommand } from './scoped-command.js';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
function provider(name: string): SessionProvider {
  return {
    paths: () => ({ encoderPath: name, decoderPath: name, tokensPath: name }),
    installed: () => true,
    assertIntact() {},
    invalidate() {},
    engine: vi.fn(async () => ({ recognize: async () => name, release: vi.fn() })),
  };
}
describe('scoped original-session provider integration', () => {
  it('extends only the known version-checked drain constant', () => {
    const source = 'const COMMIT_DRAIN_TIMEOUT_MS = 10_000;\nconst other = 10_000;';
    expect(extendDrainBudget(source)).toBe(`const COMMIT_DRAIN_TIMEOUT_MS = ${DRAIN_MS};\nconst other = 10_000;`);
    expect(() => extendDrainBudget('different upstream')).toThrow('Unsupported');
    expect(() => extendDrainBudget(source + source)).toThrow('Unsupported');
  });
  it('keeps asynchronous provider contexts separate and fails outside a session', async () => {
    const one = provider('one');
    const two = provider('two');
    const result = await Promise.all(
      [one, two].map((p) =>
        withProvider(p, async () => {
          await Promise.resolve();
          return currentProvider().paths().encoderPath;
        }),
      ),
    );
    expect(result).toEqual(['one', 'two']);
    expect(() => currentProvider()).toThrow('outside');
  });
  it.each([false, true])('observes the original session with native=%s without a second session', async (native) => {
    const dir = await mkdtemp(join(tmpdir(), 'voice-inline-'));
    dirs.push(dir);
    await Promise.all(['command', 'audio', 'state'].map((part) => mkdir(join(dir, part))));
    await writeFile(
      join(dir, 'state/voice-session.ts'),
      `export class VoiceSession { constructor(config) { this.state = { transcript: '', partialTranscript: '', audioLevel: 0 }; } dispatchAction(action) { Object.assign(this.state, action); } }`,
    );
    await writeFile(
      join(dir, 'audio/stt-engine.ts'),
      `export const createSttEngine = async () => ({ recognize: async () => 'native', release() {} });`,
    );
    await writeFile(
      join(dir, 'audio/model-download.ts'),
      `export const getModelPaths = () => ({ encoderPath: 'native', decoderPath: 'native', tokensPath: 'native' });`,
    );
    await writeFile(
      join(dir, 'command/voice-command.ts'),
      `import { VoiceSession } from '../state/voice-session.ts'; import { createSttEngine } from '../audio/stt-engine.ts'; import { getModelPaths } from '../audio/model-download.ts'; const COMMIT_DRAIN_TIMEOUT_MS = 10_000; export function registerVoiceCommand(api) { api.registerCommand('voice', {handler: async () => { const session = new VoiceSession({}); const engine = await createSttEngine(getModelPaths()); session.dispatchAction({ transcript: await engine.recognize(), partialTranscript: 'partial', audioLevel: 0.25 }); engine.release(); }}); }`,
    );
    const command = await scopedVoiceCommand(dir, {}, { native, inline: true });
    const preview = vi.fn();
    const run = () => command('', {} as never, new AbortController().signal, undefined, preview);
    if (native) await run();
    else await withProvider(provider('chosen.ggml'), run);
    expect(preview).toHaveBeenCalledWith(`${native ? 'native' : 'chosen.ggml'} partial`, 0.25);
  });
  it('refuses a changed inline session import before loading or starting a session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'voice-contract-'));
    dirs.push(dir);
    await mkdir(join(dir, 'command'));
    await writeFile(
      join(dir, 'command/voice-command.ts'),
      'const COMMIT_DRAIN_TIMEOUT_MS = 10_000; export function registerVoiceCommand() {}',
    );
    await expect(scopedVoiceCommand(dir, {}, { inline: true })).rejects.toThrow('VoiceSession import contract');
  });
  it('injects only its own command loader and leaves original files/cache untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'voice-upstream-'));
    dirs.push(dir);
    await mkdir(join(dir, 'command'));
    await mkdir(join(dir, 'audio'));
    const source = `import { createSttEngine } from '../audio/stt-engine.ts';
import { getModelPaths } from '../audio/model-download.ts';
const COMMIT_DRAIN_TIMEOUT_MS = 10_000;
export function registerVoiceCommand(api) { api.registerCommand('voice', { description: 'Original', handler: async () => { const engine = await createSttEngine(getModelPaths()); engine.release(); } }); }
`;
    await writeFile(join(dir, 'command/voice-command.ts'), source);
    await writeFile(
      join(dir, 'audio/stt-engine.ts'),
      "export function createSttEngine() { throw new Error('original native sentinel'); }\n",
    );
    await writeFile(
      join(dir, 'audio/model-download.ts'),
      "export const getModelPaths = () => ({ encoderPath: 'native' });\n",
    );
    const handler = await scopedVoiceCommand(dir);
    const chosen = provider('chosen.ggml');
    await withProvider(chosen, () => handler('', {} as never));
    expect(chosen.engine).toHaveBeenCalledWith(chosen.paths());
    expect(await readFile(join(dir, 'command/voice-command.ts'), 'utf8')).toBe(source);
    const normal = createJiti(import.meta.url, { tryNative: false });
    const original = await normal.import<{ createSttEngine(): never }>(join(dir, 'audio/stt-engine.ts'));
    expect(() => original.createSttEngine()).toThrow('original native sentinel');
  });
});
