import { AsyncLocalStorage } from 'node:async_hooks';

export interface RecognizerConfig {
  encoderPath: string;
  decoderPath: string;
  tokensPath: string;
  language?: string;
  numThreads?: number;
}
export interface Recognizer {
  recognize(samples: Float32Array, sampleRate: number): Promise<string>;
  release(): void;
}
export interface ModelPaths {
  encoderPath: string;
  decoderPath: string;
  tokensPath: string;
}
export interface SessionProvider {
  paths(): ModelPaths;
  installed(): boolean;
  assertIntact(): void;
  invalidate(): void;
  engine(config: RecognizerConfig): Promise<Recognizer>;
  error?(): Error | undefined;
}

// Own context only: never replace an upstream export or change its global module cache.
// The anchor also shares the context with the isolated TS loader's copy of our shim.
const KEY = Symbol.for('@dragoscirjan/pi-voice-ptt/provider-context:v1');
const globals = globalThis as unknown as { [key: symbol]: AsyncLocalStorage<SessionProvider> | undefined };
const storage = globals[KEY] ?? (globals[KEY] = new AsyncLocalStorage<SessionProvider>());
export function withProvider<T>(provider: SessionProvider, work: () => T): T {
  return storage.run(provider, work);
}
export function currentProvider(): SessionProvider {
  const provider = storage.getStore();
  if (!provider) throw new Error('Voice model provider was invoked outside its isolated session.');
  return provider;
}
