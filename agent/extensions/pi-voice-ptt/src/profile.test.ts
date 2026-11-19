import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE, loadProfile, localPaths, saveProfile, validateProfile } from './profile.js';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function paths() {
  const dir = await mkdtemp(join(tmpdir(), 'voice-profile-'));
  dirs.push(dir);
  return { state: dir, models: join(dir, 'models'), profile: join(dir, 'preferences.json') };
}
describe('machine-local profiles', () => {
  it('uses safe base/auto defaults without creating a file', async () => {
    const p = await paths();
    expect(await loadProfile(p)).toEqual(DEFAULT_PROFILE);
    expect(await readdir(p.state)).toEqual([]);
  });
  it('round-trips a local choice atomically', async () => {
    const p = await paths();
    await saveProfile({ version: 1, model: 'small', device: 'gpu', serverPath: '/local/whisper-server' }, p);
    expect((await loadProfile(p)).model).toBe('small');
    expect(await readdir(p.state)).toEqual(['preferences.json']);
  });
  it('rejects corrupt or unknown preferences rather than selecting a big model', async () => {
    const p = await paths();
    await writeFile(p.profile, '{bad');
    await expect(loadProfile(p)).rejects.toThrow('Could not read');
    expect(await readFile(p.profile, 'utf8')).toBe('{bad');
    for (const value of [
      null,
      {},
      { version: 1, model: 'huge', device: 'auto' },
      { version: 1, model: 'base', device: 'cuda' },
    ])
      expect(() => validateProfile(value)).toThrow();
  });
  it('honors absolute XDG directories and ignores relative ones', () => {
    expect(localPaths('linux', { XDG_STATE_HOME: '/state', XDG_CACHE_HOME: '/cache' }, '/home/test').profile).toBe(
      '/state/pi-voice-ptt/preferences.json',
    );
    expect(localPaths('linux', { XDG_STATE_HOME: 'repo', XDG_CACHE_HOME: '' }, '/home/test').models).toBe(
      '/home/test/.cache/pi-voice-ptt/models',
    );
  });
  it('uses native macOS and Windows locations independently of Pi settings', () => {
    expect(localPaths('darwin', {}, '/Users/test').profile).toBe(
      '/Users/test/Library/Application Support/pi-voice-ptt/preferences.json',
    );
    const win = localPaths('win32', { LOCALAPPDATA: 'C:\\Local' }, 'C:\\Users\\test');
    expect(win.profile).toBe('C:\\Local\\pi-voice-ptt\\preferences.json');
  });
});
