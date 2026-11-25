import { createRequire } from 'node:module';
import { join } from 'node:path';
import { SUPPORTED_VOICE_VERSION } from './original-model.js';

const REQUIRED_EXTENSIONS = [
  { name: '@juicesharp/rpiv-i18n', entry: '@juicesharp/rpiv-i18n', version: '2.15.0' },
  {
    name: '@juicesharp/rpiv-voice',
    entry: '@juicesharp/rpiv-voice/package.json',
    version: SUPPORTED_VOICE_VERSION,
  },
];

/** Match the backend's resolution context without importing code or initializing audio. */
export function voiceDependencyWarning(agentDir: string): string | undefined {
  const require = createRequire(join(agentDir, 'npm', 'package.json'));
  const missing = REQUIRED_EXTENSIONS.filter(({ entry }) => {
    try {
      require.resolve(entry);
      return false;
    } catch {
      return true;
    }
  });
  if (!missing.length) return undefined;
  return [
    `Push-to-talk requires these Pi extensions, which could not be found: ${missing.map(({ name }) => name).join(', ')}.`,
    'Install them from your terminal:',
    ...missing.map(({ name, version }) => `pi install npm:${name}@${version}`),
    'If already installed, enable them with pi config. Run /reload, then /voice-activate again.',
  ].join('\n');
}
