import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { createBackend, type OriginalVoiceCommand, type VoiceHost } from './backend.js';
import type { VoiceBackend } from './controller.js';
import type { InferenceService } from './inference.js';
import { originalVoiceCommand, type VoiceModule } from './original-command.js';
import { voiceManifest, verifyOriginalModel } from './original-model.js';
import { withProvider } from './provider-context.js';
import { scopedVoiceCommand } from './scoped-command.js';

export { originalVoiceCommand } from './original-command.js';
export { SUPPORTED_VOICE_VERSION } from './original-model.js';
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
  const manifest = await voiceManifest(agentDir);
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
      if (inference) await verifyOriginalModel(agentDir, signal);
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
