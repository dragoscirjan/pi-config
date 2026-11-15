import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SUPPORTED_VOICE_VERSION = '2.15.0';
interface OriginalModel {
  isModelDownloaded(): boolean;
  assertModelIntact(): void;
}
type ModelLoader = (url: string) => Promise<OriginalModel>;

export async function voiceManifest(agentDir: string): Promise<string> {
  const require = createRequire(join(agentDir, 'npm', 'package.json'));
  let manifest: string;
  try {
    manifest = require.resolve('@juicesharp/rpiv-voice/package.json');
  } catch {
    throw new Error('Install @juicesharp/rpiv-voice with Pi before enabling push-to-talk.');
  }
  const pkg = JSON.parse(await readFile(manifest, 'utf8')) as { version: string };
  if (pkg.version !== SUPPORTED_VOICE_VERSION)
    throw new Error(
      `Push-to-talk supports rpiv-voice ${SUPPORTED_VOICE_VERSION}; found ${pkg.version}. Check adapter compatibility before upgrading.`,
    );
  return manifest;
}

/** Read-only upstream validation: never downloads a model or opens a microphone. */
export async function verifyOriginalModel(
  agentDir: string,
  signal: AbortSignal,
  load: ModelLoader = async (url) => (await import(url)) as OriginalModel,
): Promise<void> {
  signal.throwIfAborted();
  const manifest = await voiceManifest(agentDir);
  signal.throwIfAborted();
  const model = await load(pathToFileURL(join(dirname(manifest), 'audio/model-download.ts')).href);
  signal.throwIfAborted();
  if (!model.isModelDownloaded())
    throw new Error(
      'The original base model is not installed. Run /voice once, or use /voice-model base with whisper-server. Downloads never start from a probe or while Space is held.',
    );
  try {
    model.assertModelIntact();
  } catch (error) {
    throw new Error(
      'The original base model is incomplete or corrupt. Run /voice once to repair it before selecting original base/CPU.',
      { cause: error },
    );
  }
  signal.throwIfAborted();
}
