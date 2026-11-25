import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { voiceDependencyWarning } from './dependencies.js';

const directories: string[] = [];
const I18N = '@juicesharp/rpiv-i18n';
const VOICE = '@juicesharp/rpiv-voice';

async function fixture(installed: string[]) {
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-voice-dependencies-'));
  directories.push(agentDir);
  for (const name of installed) {
    const root = join(agentDir, 'npm', 'node_modules', name);
    await mkdir(root, { recursive: true });
    const pkg = name === I18N ? { name, exports: { '.': './i18n.ts' } } : { name };
    await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
    // Resolving dependencies must not execute their code or start a microphone/model.
    await writeFile(join(root, 'i18n.ts'), 'throw new Error("Dependency code must not execute");\n');
  }
  return agentDir;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('voice dependency warnings', () => {
  it('lists both missing extensions and their Pi install commands', async () => {
    const warning = voiceDependencyWarning(await fixture([]));
    expect(warning).toContain(`pi install npm:${I18N}@2.15.0`);
    expect(warning).toContain(`pi install npm:${VOICE}@2.15.0`);
    expect(warning).toContain('pi config');
    expect(warning).toContain('/reload');
    expect(warning).toContain('/voice-activate');
  });

  it.each([
    { installed: I18N, missing: VOICE },
    { installed: VOICE, missing: I18N },
  ])('only asks to install $missing when $installed is present', async ({ installed, missing }) => {
    const warning = voiceDependencyWarning(await fixture([installed]));
    expect(warning).toContain(`pi install npm:${missing}@2.15.0`);
    expect(warning).not.toContain(installed);
  });

  it('does not warn or import upstream code when both are installed', async () => {
    expect(voiceDependencyWarning(await fixture([I18N, VOICE]))).toBeUndefined();
  });

  it('resolves the i18n SDK entry even though its package.json is not exported', async () => {
    const agentDir = await fixture([I18N, VOICE]);
    const require = createRequire(join(agentDir, 'npm', 'package.json'));
    expect(() => require.resolve(`${I18N}/package.json`)).toThrow();
    expect(voiceDependencyWarning(agentDir)).toBeUndefined();
  });
});
