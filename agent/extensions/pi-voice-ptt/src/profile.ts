import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, posix, win32 } from 'node:path';

export const MODEL_NAMES = ['tiny', 'base', 'small', 'medium'] as const;
export type ModelName = (typeof MODEL_NAMES)[number];
export const DEVICE_MODES = ['auto', 'cpu', 'gpu'] as const;
export type DeviceMode = (typeof DEVICE_MODES)[number];
export interface VoiceProfile {
  version: 1;
  model: ModelName;
  device: DeviceMode;
  serverPath?: string;
}
export interface LocalPaths {
  state: string;
  models: string;
  profile: string;
}
export const DEFAULT_PROFILE: VoiceProfile = { version: 1, model: 'base', device: 'auto' };

export function localPaths(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): LocalPaths {
  const path = platform === 'win32' ? win32 : posix;
  const absolute = (value: string | undefined, fallback: string) =>
    value && path.isAbsolute(value) ? value : fallback;
  const state =
    platform === 'win32'
      ? path.join(absolute(env.LOCALAPPDATA, path.join(home, 'AppData', 'Local')), 'pi-voice-ptt')
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'pi-voice-ptt')
        : path.join(absolute(env.XDG_STATE_HOME, path.join(home, '.local', 'state')), 'pi-voice-ptt');
  const cache =
    platform === 'win32'
      ? path.join(state, 'cache')
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Caches', 'pi-voice-ptt')
        : path.join(absolute(env.XDG_CACHE_HOME, path.join(home, '.cache')), 'pi-voice-ptt');
  return { state, models: path.join(cache, 'models'), profile: path.join(state, 'preferences.json') };
}

export function validateProfile(value: unknown): VoiceProfile {
  const p = value as Partial<VoiceProfile> | null;
  if (
    !p ||
    p.version !== 1 ||
    !MODEL_NAMES.includes(p.model as ModelName) ||
    !DEVICE_MODES.includes(p.device as DeviceMode) ||
    (p.serverPath !== undefined &&
      (typeof p.serverPath !== 'string' || !p.serverPath.trim() || p.serverPath.includes('\0')))
  ) {
    throw new Error('Invalid local voice profile. Fix or remove preferences.json; shared Pi settings are not used.');
  }
  return { version: 1, model: p.model!, device: p.device!, ...(p.serverPath ? { serverPath: p.serverPath } : {}) };
}

export async function loadProfile(paths = localPaths()): Promise<VoiceProfile> {
  try {
    return validateProfile(JSON.parse(await readFile(paths.profile, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_PROFILE };
    throw new Error(
      `Could not read local voice preferences at ${paths.profile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.partial`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function saveProfile(profile: VoiceProfile, paths = localPaths()): Promise<void> {
  await atomicJson(paths.profile, validateProfile(profile));
}
