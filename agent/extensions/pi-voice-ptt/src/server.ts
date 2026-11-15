import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { Agent, request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function backendEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !/token|secret|password|credential|api_?key|access_key|private_key|authorization|cookie/iu.test(key) &&
        !/^(?:PI_|OPENAI_|ANTHROPIC_|AWS_|AZURE_|NPM_|SSH_|GPG_|NODE_OPTIONS$|NIX_CONFIG$|HTTPS?_PROXY$|ALL_PROXY$)/iu.test(
          key,
        ),
    ),
  );
}

export async function findServer(override?: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const explicit = env.PI_VOICE_WHISPER_SERVER?.trim() ? env.PI_VOICE_WHISPER_SERVER : override;
  const candidates = explicit
    ? [resolve(explicit)]
    : (env.PATH ?? env.Path ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => resolve(directory, process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'));
  for (const path of candidates) {
    try {
      await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return path;
    } catch {
      /* Try the next PATH entry. An explicit override never silently falls through. */
    }
  }
  if (explicit) throw new Error(`Configured whisper-server was not executable: ${explicit}`);
  return undefined;
}

/** Require evidence of a selected, initialized GPU, not merely a GPU-capable build or use_gpu=1. */
export function initializedGpu(log: string): string | undefined {
  const matches = [...log.matchAll(/whisper_backend_init_gpu:\s+using (.+?) backend/gu)];
  const backend = matches.at(-1)?.[1];
  if (!backend || /^(cpu|blas)/iu.test(backend) || /whisper_backend_init_gpu:\s+failed to initialize/iu.test(log))
    return undefined;
  const index = /^Vulkan(\d+)$/iu.exec(backend)?.[1];
  if (index) {
    const device = new RegExp(`ggml_vulkan:\\s*${index}\\s*=([^\\n]+)`, 'iu').exec(log)?.[1] ?? '';
    if (/llvmpipe|lavapipe|swiftshader|software rasterizer/iu.test(device)) return undefined;
  }
  return backend;
}

export function wavBuffer(samples: Float32Array, sampleRate: number): Buffer {
  if (sampleRate !== 16000 || samples.length > 30 * sampleRate)
    throw new Error('Voice provider requires at most 30 seconds of 16 kHz mono audio.');
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    if (!Number.isFinite(sample)) throw new Error('Non-finite microphone sample; refusing corrupted audio.');
    const clamped = Math.max(-1, Math.min(1, sample));
    buffer.writeInt16LE(Math.round(clamped * (clamped < 0 ? 32768 : 32767)), 44 + i * 2);
  }
  return buffer;
}

async function localPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a local voice port.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

export interface ServerOptions {
  executable: string;
  model: string;
  device: 'cpu' | 'gpu';
  threads: number;
  startupMs?: number;
  requestMs?: number;
  onExit?(): void;
  /** Internal test seam only, never read from user input or a shared Pi setting. */
  prefixArgs?: string[];
}

export class WhisperWorker {
  private readonly child: ChildProcess;
  private readonly closed = new AbortController();
  private readonly agent = new Agent({ keepAlive: true, proxyEnv: {} });
  private readonly exited: Promise<void>;
  private stopPromise: Promise<void> | undefined;
  private queue = Promise.resolve();
  private dead = false;
  private failure: Error | undefined;
  private startupLog = '';
  private ready = false;
  readonly endpoint: string;
  actualDevice: 'cpu' | 'gpu' = 'cpu';
  gpuBackend: string | undefined;

  private constructor(
    private readonly options: ServerOptions,
    port: number,
  ) {
    const prefix = `/voice-${randomUUID()}`;
    this.endpoint = `http://127.0.0.1:${port}${prefix}`;
    const args = [
      ...(options.prefixArgs ?? []),
      '--model',
      options.model,
      '--threads',
      String(options.threads),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--request-path',
      prefix,
      '--no-timestamps',
    ];
    if (options.device === 'cpu') args.push('--no-gpu');
    this.child = spawn(options.executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: backendEnvironment(),
    });
    const collect = (chunk: Buffer) => {
      // Never retain native inference/transcript logs after startup; continue draining both pipes.
      if (!this.ready) this.startupLog = (this.startupLog + chunk.toString()).slice(-65536);
    };
    this.child.stdout?.on('data', collect);
    this.child.stderr?.on('data', collect);
    this.exited = new Promise((resolveExit) => {
      this.child.once('error', (error) => {
        this.failure = error;
        this.dead = true;
        resolveExit();
        this.options.onExit?.();
      });
      this.child.once('close', () => {
        this.dead = true;
        resolveExit();
        this.options.onExit?.();
      });
    });
  }

  static async start(options: ServerOptions, signal: AbortSignal): Promise<WhisperWorker> {
    signal.throwIfAborted();
    if (!isAbsolute(options.executable)) throw new Error('whisper-server must resolve to an absolute executable path.');
    const worker = new WhisperWorker(options, await localPort());
    try {
      await worker.waitReady(signal);
      return worker;
    } catch (error) {
      await worker.stop();
      throw error;
    }
  }

  get alive(): boolean {
    return !this.dead && !this.closed.signal.aborted;
  }

  private json(
    path: string,
    signal: AbortSignal,
    body?: Buffer,
    contentType?: string,
  ): Promise<{ status: number; data: { status?: string; text?: unknown } }> {
    const url = new URL(this.endpoint + path);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:')
      throw new Error('Voice inference must stay on loopback.');
    return new Promise((resolveResponse, reject) => {
      const req = httpRequest(
        url,
        {
          method: body ? 'POST' : 'GET',
          agent: this.agent,
          signal,
          ...(body ? { headers: { 'content-type': contentType!, 'content-length': String(body.length) } } : {}),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let length = 0;
          response.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > 2_000_000) {
              response.destroy(new Error('Local voice response is too large.'));
              return;
            }
            chunks.push(chunk);
          });
          response.once('error', reject);
          response.once('end', () => {
            const status = response.statusCode ?? 0;
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
              if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid response shape.');
              resolveResponse({ status, data });
            } catch {
              if (status < 200 || status >= 300) resolveResponse({ status, data: {} });
              else reject(new Error('Invalid local backend JSON response.'));
            }
          });
        },
      );
      req.once('error', reject);
      req.end(body);
    });
  }

  private async waitReady(signal: AbortSignal): Promise<void> {
    const startup = AbortSignal.any([
      signal,
      this.closed.signal,
      AbortSignal.timeout(this.options.startupMs ?? 120_000),
    ]);
    while (true) {
      startup.throwIfAborted();
      if (this.dead)
        throw new Error(`whisper-server exited during initialization: ${this.failure?.message ?? this.startupError()}`);
      try {
        const response = await this.json('/health', AbortSignal.any([startup, AbortSignal.timeout(1000)]));
        if (response.status === 200 && response.data.status === 'ok') break;
      } catch {
        startup.throwIfAborted();
      }
      await delay(50, undefined, { signal: startup });
    }
    this.gpuBackend = initializedGpu(this.startupLog);
    this.actualDevice = this.gpuBackend ? 'gpu' : 'cpu';
    if (this.options.device === 'gpu' && !this.gpuBackend)
      throw new Error(
        'whisper-server did not initialize a hardware GPU backend. Install a Vulkan/CUDA/Metal-enabled build.',
      );
    if (this.options.device === 'cpu' && this.gpuBackend)
      throw new Error('whisper-server ignored CPU-only mode; refusing misleading device status.');
    this.ready = true;
    this.startupLog = '';
  }

  private startupError(): string {
    return (
      this.startupLog
        .split('\n')
        .filter((line) => /error|failed|exception/iu.test(line))
        .slice(-3)
        .join(' ')
        .slice(0, 700) || 'check the backend build and selected model'
    );
  }

  async transcribe(
    samples: Float32Array,
    sampleRate: number,
    language: string | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    if (!samples.length) return '';
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    const cancel = () => {
      void this.stop();
    };
    try {
      signal.throwIfAborted();
      if (!this.alive) throw new Error('The local voice backend stopped. Try another hold or reactivate voice.');
      signal.addEventListener('abort', cancel, { once: true });
      const request = AbortSignal.any([
        signal,
        this.closed.signal,
        AbortSignal.timeout(this.options.requestMs ?? 120_000),
      ]);
      const form = new FormData();
      form.set(
        'file',
        new Blob([new Uint8Array(wavBuffer(samples, sampleRate))], { type: 'audio/wav' }),
        'dictation.wav',
      );
      form.set('language', language ?? 'auto');
      form.set('response_format', 'json');
      form.set('temperature', '0');
      form.set('temperature_inc', '0');
      form.set('translate', 'false');
      // Request serializes multipart only; native HTTP uses a private, proxy-free loopback agent.
      const encoded = new Request(`${this.endpoint}/inference`, { method: 'POST', body: form });
      const body = Buffer.from(await encoded.arrayBuffer());
      const response = await this.json('/inference', request, body, encoded.headers.get('content-type')!);
      if (response.status < 200 || response.status >= 300)
        throw new Error(`Local voice inference failed (HTTP ${response.status}).`);
      const result = response.data;
      if (typeof result.text !== 'string' || result.text.length > 100000)
        throw new Error('Invalid whisper-server transcription response.');
      return result.text.trim();
    } catch (error) {
      // Timeout/error can leave native work running. Stop our owned worker rather than queue behind it.
      await this.stop();
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      release();
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.closed.abort();
    this.agent.destroy();
    if (!this.dead) this.child.kill('SIGTERM');
    this.stopPromise = (async () => {
      const kill = setTimeout(() => {
        if (!this.dead) this.child.kill('SIGKILL');
      }, 1000);
      kill.unref();
      try {
        await Promise.race([this.exited, delay(2000, undefined, { ref: false })]);
      } finally {
        clearTimeout(kill);
      }
    })();
    return this.stopPromise;
  }
}
