import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { loadVoiceBackend, originalVoiceCommand } from './load-backend.js';

const directories: string[] = [];
const context = {} as ExtensionCommandContext;
const host = () => undefined;
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function agentDir() {
  const root = await mkdtemp(join(tmpdir(), 'pi-voice-ptt-test-'));
  directories.push(root);
  return root;
}

describe('private API compatibility guard', () => {
  it('captures the unchanged original command instead of registering a competing /voice', () => {
    const handler = async () => {};
    const command = originalVoiceCommand({
      registerVoiceCommand(api) {
        api.registerCommand('voice', { description: 'Original', handler });
      },
    });
    expect(command).toBe(handler);
  });

  it('refuses an upstream entry point that no longer exposes the original command', () => {
    expect(() => originalVoiceCommand({ registerVoiceCommand() {} })).toThrow('did not expose');
  });
  it('provides an actionable error if the original extension is not installed', async () => {
    await expect(loadVoiceBackend(await agentDir(), context, host)).rejects.toThrow('Install @juicesharp/rpiv-voice');
  });

  it('refuses an untested version before importing any private/native modules', async () => {
    const root = await agentDir();
    const pkg = join(root, 'npm/node_modules/@juicesharp/rpiv-voice');
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@juicesharp/rpiv-voice', version: '99.0.0' }));
    await expect(loadVoiceBackend(root, context, host)).rejects.toThrow('found 99.0.0');
  });
});
