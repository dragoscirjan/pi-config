import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPackageDir } from '@earendil-works/pi-coding-agent';
import { createJiti } from 'jiti';
import type { OriginalVoiceCommand } from './backend.js';
import { originalVoiceCommand, type VoiceModule } from './original-command.js';
import { withSessionView, type SessionConstructor } from './session-context.js';

export interface ScopedOptions {
  native?: boolean;
  inline?: boolean;
}

export const DRAIN_MS = 180_000;
export function extendDrainBudget(source: string): string {
  const original = 'const COMMIT_DRAIN_TIMEOUT_MS = 10_000;';
  if (source.split(original).length !== 2)
    throw new Error('Unsupported upstream voice timeout contract; refusing to alter its workflow.');
  return source.replace(original, `const COMMIT_DRAIN_TIMEOUT_MS = ${DRAIN_MS};`);
}

/** testAliases is an internal fixture seam; production never overrides microphone capture. */
export async function scopedVoiceCommand(
  upstreamRoot: string,
  testAliases: Record<string, string> = {},
  options: ScopedOptions = {},
): Promise<OriginalVoiceCommand> {
  const entry = join(upstreamRoot, 'command', 'voice-command.ts');
  const hostResolver = createJiti(join(getPackageDir(), 'package.json'), { tryNative: false });
  const hostPath = (name: string) => {
    const value = hostResolver.esmResolve(name);
    return value.startsWith('file:') ? fileURLToPath(value) : value;
  };
  const engine = fileURLToPath(new URL('./engine-shim.ts', import.meta.url));
  const model = fileURLToPath(new URL('./model-shim.ts', import.meta.url));
  const session = fileURLToPath(new URL('./session-shim.ts', import.meta.url));
  const alias = {
    '@earendil-works/pi-coding-agent': hostPath('@earendil-works/pi-coding-agent'),
    '@earendil-works/pi-tui': hostPath('@earendil-works/pi-tui'),
    ...(!options.native
      ? {
          [join(upstreamRoot, 'audio', 'stt-engine.ts')]: engine,
          [join(upstreamRoot, 'audio', 'model-download.ts')]: model,
          '../audio/stt-engine.ts': engine,
          '../audio/model-download.ts': model,
        }
      : {}),
    ...(options.inline ? { '../state/voice-session.ts': session } : {}),
    ...testAliases,
  };
  // No process-global module-cache writes or shared transpile-cache poisoning.
  const loader = createJiti(import.meta.url, { alias, moduleCache: false, fsCache: false, tryNative: false });
  const source = extendDrainBudget(await readFile(entry, 'utf8'));
  if (options.inline && !source.includes('../state/voice-session.ts'))
    throw new Error('Unsupported upstream VoiceSession import contract; refusing an unreliable inline preview.');
  // Absolute import bypasses the relative UI alias and gives the unmodified original constructor.
  const Session = options.inline
    ? (await loader.import<{ VoiceSession: SessionConstructor }>(join(upstreamRoot, 'state', 'voice-session.ts')))
        .VoiceSession
    : undefined;
  const module = (await loader.evalModule(source, {
    filename: entry,
    async: true,
    forceTranspile: true,
  })) as VoiceModule;
  const command = originalVoiceCommand(module);
  return Session
    ? (args, ctx, signal, onFatal, preview) =>
        withSessionView({ Session, preview }, () => command(args, ctx, signal, onFatal))
    : command;
}
