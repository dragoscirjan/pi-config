import { existsSync, statSync, unlinkSync } from 'node:fs';
import { ModelStore } from './models.js';
import { loadProfile, localPaths, type LocalPaths, type VoiceProfile } from './profile.js';
import type { SessionProvider } from './provider-context.js';
import { findServer, WhisperWorker, type ServerOptions } from './server.js';

export type VoiceNotice = (message: string, level?: 'info' | 'warning' | 'error') => void;
export interface Worker {
  alive: boolean;
  actualDevice: 'cpu' | 'gpu';
  gpuBackend: string | undefined;
  transcribe(samples: Float32Array, rate: number, language: string | undefined, signal: AbortSignal): Promise<string>;
  stop(): Promise<void>;
}
export interface InferenceOptions {
  paths?: LocalPaths;
  store?: ModelStore;
  readProfile?: () => Promise<VoiceProfile>;
  find?: typeof findServer;
  start?: (options: ServerOptions, signal: AbortSignal) => Promise<Worker>;
}

/** One replaceable recognizer provider, not a second microphone or dictation workflow. */
export class InferenceService {
  readonly paths: LocalPaths;
  readonly models: ModelStore;
  private readonly readProfile: () => Promise<VoiceProfile>;
  private readonly find: typeof findServer;
  private readonly start: (options: ServerOptions, signal: AbortSignal) => Promise<Worker>;
  private worker: Worker | undefined;
  private key: string | undefined;
  private boot: { promise: Promise<Worker>; abort: AbortController; key: string } | undefined;
  private selected: VoiceProfile | undefined;
  private closing: Promise<void> | undefined;
  private label = 'base · auto (not started)';
  private nativeNotice: string | undefined;
  private readonly observers = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  }
  private changed(): void {
    for (const listener of this.observers) {
      try {
        listener();
      } catch {
        /* A disposed UI must not break backend cleanup. */
      }
    }
  }
  private setLabel(value: string): void {
    this.label = value;
    this.changed();
  }

  constructor(options: InferenceOptions = {}) {
    this.paths = options.paths ?? localPaths();
    this.models = options.store ?? new ModelStore(this.paths.models);
    this.readProfile = options.readProfile ?? (() => loadProfile(this.paths));
    this.find = options.find ?? findServer;
    this.start = options.start ?? ((config, signal) => WhisperWorker.start(config, signal));
  }

  describe(): string {
    return this.worker && !this.worker.alive ? `${this.selected?.model ?? 'base'} · backend stopped` : this.label;
  }

  async refresh(): Promise<VoiceProfile> {
    const profile = await this.readProfile();
    this.selected = profile;
    if (!this.worker?.alive) this.setLabel(`${profile.model} · ${profile.device} (not started)`);
    return profile;
  }

  async probe(profile: VoiceProfile, signal: AbortSignal, notify: VoiceNotice): Promise<string> {
    try {
      const provider = await this.prepare(signal, notify, () => {}, profile);
      if (provider) {
        const engine = await provider.engine({ ...provider.paths(), numThreads: 4 });
        engine.release();
      }
      signal.throwIfAborted();
      return this.describe();
    } finally {
      await this.close();
    }
  }

  async prepare(
    signal: AbortSignal,
    notify: VoiceNotice,
    onFatal: (error: Error) => void,
    override?: VoiceProfile,
  ): Promise<SessionProvider | undefined> {
    signal.throwIfAborted();
    await this.closing;
    const profile = override ?? (await this.readProfile());
    this.selected = profile;
    if (!this.worker?.alive) this.setLabel(`${profile.model} · ${profile.device} (not started)`);
    const executable = await this.find(profile.serverPath);
    const installed = await this.models.installed(profile.model);
    signal.throwIfAborted();
    // Fresh machines keep the original, already-working base/CPU flow, without a surprise download.
    if (profile.model === 'base' && profile.device !== 'gpu' && (!executable || !installed)) {
      this.setLabel('base · CPU (original)');
      const reason = !executable ? 'whisper-server is unavailable' : 'the GGML base model is not downloaded';
      if (profile.device === 'auto' && this.nativeNotice !== reason) {
        notify(`Voice uses original base/CPU because ${reason}. Use /voice-model to prepare acceleration.`, 'info');
        this.nativeNotice = reason;
      }
      return undefined;
    }
    if (!executable)
      throw new Error('Install whisper-server or set PI_VOICE_WHISPER_SERVER before using a larger model/GPU.');
    if (!installed)
      throw new Error(
        `The verified ${profile.model} GGML model is missing. Run /voice-model ${profile.model} to download it with confirmation.`,
      );
    const modelPath = this.models.path(profile.model);
    let failure: Error | undefined;
    let reported = false;
    const remember = (error: unknown) => {
      failure = error instanceof Error ? error : new Error(String(error));
      return failure;
    };
    return {
      paths: () => ({ encoderPath: modelPath, decoderPath: modelPath, tokensPath: modelPath }),
      installed: () => existsSync(modelPath),
      assertIntact: () => {
        if (statSync(modelPath).size !== this.models.definitions[profile.model].bytes)
          throw new Error('The selected model changed; verify it again with /voice-model.');
      },
      invalidate: () => {
        try {
          unlinkSync(this.models.marker(profile.model));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      },
      error: () => failure,
      engine: async (config) => {
        let worker: Worker;
        try {
          worker = await this.ensure(profile, executable, config.numThreads ?? 4, signal, notify);
        } catch (error) {
          throw remember(error);
        }
        const lease = new AbortController();
        const capture = AbortSignal.any([signal, lease.signal]);
        let fallbackNotice = false;
        return {
          recognize: async (samples, rate) => {
            const attempted = worker;
            try {
              try {
                return await attempted.transcribe(samples, rate, config.language, capture);
              } catch (error) {
                if (capture.aborted || profile.device !== 'auto' || attempted.actualDevice !== 'gpu') throw error;
                if (!fallbackNotice) {
                  notify('GPU inference failed; retrying the same audio on CPU.', 'warning');
                  fallbackNotice = true;
                }
                worker = await this.ensure(profile, executable, config.numThreads ?? 4, signal, notify, true);
                return await worker.transcribe(samples, rate, config.language, capture);
              }
            } catch (error) {
              if (!capture.aborted) {
                const problem = remember(error);
                if (!reported) {
                  reported = true;
                  onFatal(problem);
                }
              }
              throw error;
            }
          },
          // Keep a healthy worker warm while armed; cancel any orphaned partial on release.
          release: () => lease.abort(),
        };
      },
    };
  }

  private async ensure(
    profile: VoiceProfile,
    executable: string,
    threads: number,
    signal: AbortSignal,
    notify: VoiceNotice,
    cpu = false,
  ): Promise<Worker> {
    signal.throwIfAborted();
    if (!Number.isInteger(threads) || threads < 1 || threads > 64)
      throw new Error('Invalid upstream recognition thread count.');
    const key = JSON.stringify([executable, this.models.path(profile.model), profile.device, threads]);
    if (this.worker?.alive && this.key === key && (!cpu || this.worker.actualDevice === 'cpu')) {
      this.setLabel(
        `${profile.model} · ${this.worker.actualDevice === 'gpu' ? `GPU ${this.worker.gpuBackend}` : 'CPU'}`,
      );
      return this.worker;
    }
    if (this.boot) {
      await this.boot.promise;
      return this.ensure(profile, executable, threads, signal, notify, cpu);
    }
    const previous = this.worker;
    this.worker = undefined;
    this.setLabel(`${profile.model} · starting ${cpu || profile.device === 'cpu' ? 'CPU' : profile.device}`);
    const abort = new AbortController();
    const request = AbortSignal.any([signal, abort.signal]);
    const options = { executable, model: this.models.path(profile.model), threads, onExit: () => this.changed() };
    const start = async () => {
      await previous?.stop();
      request.throwIfAborted();
      if (cpu || profile.device === 'cpu') return this.start({ ...options, device: 'cpu' }, request);
      try {
        return await this.start({ ...options, device: 'gpu' }, request);
      } catch (error) {
        request.throwIfAborted();
        if (profile.device === 'gpu') throw error;
        this.setLabel(`${profile.model} · starting CPU`);
        notify(`GPU unavailable; using CPU. ${error instanceof Error ? error.message : String(error)}`, 'warning');
        return this.start({ ...options, device: 'cpu' }, request);
      }
    };
    const promise = start();
    this.boot = { promise, abort, key };
    try {
      const worker = await promise;
      if (request.aborted) {
        await worker.stop();
        request.throwIfAborted();
      }
      this.worker = worker;
      this.key = key;
      this.setLabel(`${profile.model} · ${worker.actualDevice === 'gpu' ? `GPU ${worker.gpuBackend}` : 'CPU'}`);
      return worker;
    } finally {
      if (this.boot?.promise === promise) this.boot = undefined;
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.boot?.abort.abort();
    const boot = this.boot?.promise;
    const worker = this.worker;
    this.worker = undefined;
    this.key = undefined;
    this.setLabel(`${this.selected?.model ?? 'base'} · ${this.selected?.device ?? 'auto'} (not started)`);
    const work = (async () => {
      await worker?.stop();
      if (boot) {
        try {
          await (await boot).stop();
        } catch {
          /* Startup failure/cancellation already surfaced to its caller. */
        }
      }
    })();
    this.closing = work;
    void work.then(
      () => {
        if (this.closing === work) this.closing = undefined;
      },
      () => {
        if (this.closing === work) this.closing = undefined;
      },
    );
    return work;
  }
}
