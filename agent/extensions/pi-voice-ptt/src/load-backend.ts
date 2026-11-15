import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { createBackend, type OriginalVoiceCommand, type VoiceHost } from './backend.js';
import type { VoiceBackend } from './controller.js';
import type { InferenceService } from './inference.js';
import { originalVoiceCommand, type VoiceModule } from './original-command.js';
import { withProvider } from './provider-context.js';
import { scopedVoiceCommand } from './scoped-command.js';

export { originalVoiceCommand } from './original-command.js';
export const SUPPORTED_VOICE_VERSION = '2.15.0';
interface I18nSDK {
  getActiveLocale(): string | undefined;
  applyLocale(locale: string | undefined): void;
}

export async function loadVoiceBackend(
  agentDir: string,
  context: ExtensionCommandContext,
  getHost: () => VoiceHost | undefined,
  inference?: InferenceService,
  loadScoped: typeof scopedVoiceCommand = scopedVoiceCommand,
): Promise<VoiceBackend> {
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
  let sdkPath: string;
  try {
    sdkPath = require.resolve('@juicesharp/rpiv-i18n');
  } catch {
    throw new Error('Install and enable @juicesharp/rpiv-i18n before enabling push-to-talk.');
  }
  const existing = (globalThis as { [key: symbol]: { locale: string | undefined } | undefined })[
    Symbol.for('rpiv-i18n')
  ];
  const [voice, sdk] = await Promise.all([
    import(pathToFileURL(join(dirname(manifest), 'command/voice-command.ts')).href) as Promise<VoiceModule>,
    import(pathToFileURL(sdkPath).href) as Promise<I18nSDK>,
  ]);
  if (existing && sdk.getActiveLocale() !== existing.locale) sdk.applyLocale(existing.locale);
  const normal = originalVoiceCommand(voice);
  let isolated: Promise<OriginalVoiceCommand> | undefined;
  let used = false;
  const command: OriginalVoiceCommand = async (
    args,
    ctx,
    signal = new AbortController().signal,
    onFatal = () => {},
  ) => {
    used = true;
    const provider = await inference?.prepare(signal, (message, level) => context.ui.notify(message, level), onFatal);
    if (!provider) {
      if (inference) {
        const model = (await import(pathToFileURL(join(dirname(manifest), 'audio/model-download.ts')).href)) as {
          isModelDownloaded(): boolean;
        };
        if (!model.isModelDownloaded())
          throw new Error(
            'The original base model is not installed. Run /voice once, or use /voice-model base with whisper-server. Downloads never start while Space is held.',
          );
      }
      return normal(args, ctx);
    }
    const locale = sdk.getActiveLocale();
    isolated ??= loadScoped(dirname(manifest));
    const original = await isolated;
    if (sdk.getActiveLocale() !== locale) sdk.applyLocale(locale);
    signal.throwIfAborted();
    await withProvider(provider, () => original(args, ctx));
    const failure = provider.error?.();
    if (failure && !signal.aborted) throw failure;
  };
  return createBackend({
    command,
    context,
    getHost,
    getLocale: () => sdk.getActiveLocale(),
    describe: () => inference?.describe() ?? 'base · CPU (original)',
    dispose: () => {
      if (!used) return;
      void inference
        ?.close()
        .catch((error: unknown) => context.ui.notify(`Could not stop voice backend: ${String(error)}`, 'error'));
    },
  });
}
