import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { OriginalVoiceCommand } from './backend.js';

export interface VoiceModule {
  registerVoiceCommand(api: Pick<ExtensionAPI, 'registerCommand'>): void;
}
/** Capture upstream's handler, without registering or overriding /voice. */
export function originalVoiceCommand(module: VoiceModule): OriginalVoiceCommand {
  let handler: OriginalVoiceCommand | undefined;
  module.registerVoiceCommand({
    registerCommand(name, options) {
      if (name === 'voice') handler = options.handler;
    },
  });
  if (!handler) throw new Error('The original voice extension did not expose its command implementation.');
  return handler;
}
