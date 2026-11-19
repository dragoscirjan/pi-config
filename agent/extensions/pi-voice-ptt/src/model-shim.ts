import { currentProvider } from './provider-context.js';

export class ModelInstallError extends Error {
  constructor(
    readonly stage: string,
    cause: unknown,
  ) {
    super('Selected voice model is unavailable.', { cause });
  }
}
export const isModelDownloaded = () => currentProvider().installed();
export const getModelPaths = () => currentProvider().paths();
export const assertModelIntact = () => currentProvider().assertIntact();
export const removeModelInstall = () => currentProvider().invalidate();
export async function ensureModelDownloaded() {
  // Downloads are explicitly confirmed in /voice-model, never started while a key is held.
  try {
    assertModelIntact();
    return getModelPaths();
  } catch (error) {
    throw new ModelInstallError('download', error);
  }
}
