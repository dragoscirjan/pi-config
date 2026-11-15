import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, type ModelName } from './profile.js';

export interface ModelDefinition {
  file: string;
  bytes: number;
  sha256: string;
  url: string;
}
const REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
const model = (name: ModelName, bytes: number, sha256: string): ModelDefinition => ({
  file: `ggml-${name}.bin`,
  bytes,
  sha256,
  url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${REVISION}/ggml-${name}.bin`,
});
/** Official multilingual GGML weights; sizes/SHA256 are pinned Hugging Face LFS metadata. */
export const MODELS: Record<ModelName, ModelDefinition> = {
  tiny: model('tiny', 77691713, 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21'),
  base: model('base', 147951465, '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'),
  small: model('small', 487601967, '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'),
  medium: model('medium', 1533763059, '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208'),
};
export const modelSize = (bytes: number) => `${Math.ceil(bytes / 1024 ** 2)} MiB`;
const identity = (file: BigIntStats): string => [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':');

export class ModelStore {
  constructor(
    readonly directory: string,
    readonly definitions = MODELS,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  path(name: ModelName): string {
    return join(this.directory, this.definitions[name].file);
  }
  marker(name: ModelName): string {
    return `${this.path(name)}.verified.json`;
  }

  async installed(name: ModelName, signal = new AbortController().signal): Promise<boolean> {
    signal.throwIfAborted();
    try {
      const file = await stat(this.path(name), { bigint: true });
      const verified = JSON.parse(await readFile(this.marker(name), 'utf8')) as {
        version?: number;
        sha256: string;
        bytes: number;
        identity?: string;
      };
      signal.throwIfAborted();
      const expected = this.definitions[name];
      if (
        !verified ||
        typeof verified !== 'object' ||
        !file.isFile() ||
        file.size !== BigInt(expected.bytes) ||
        verified.bytes !== expected.bytes ||
        verified.sha256 !== expected.sha256
      )
        return false;
      if (verified.version === 2) return verified.identity === identity(file);
      if (verified.version !== undefined) return false;
      // Legacy markers cannot prove file identity. Rehash once, never download or change preferences.
      return await this.verifyExisting(name, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return false;
      throw error;
    }
  }

  async install(
    name: ModelName,
    signal: AbortSignal,
    progress: (bytes: number, total: number) => void = () => {},
  ): Promise<string> {
    signal.throwIfAborted();
    if (await this.installed(name, signal)) return this.path(name);
    const expected = this.definitions[name];
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Verify manually supplied official files without downloading them again.
    try {
      if (await this.verifyExisting(name, signal)) return this.path(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temporary = `${this.path(name)}.${randomUUID()}.partial`;
    const timeout = AbortSignal.timeout(30 * 60_000);
    const downloadSignal = AbortSignal.any([signal, timeout]);
    try {
      const response = await this.fetcher(expected.url, { signal: downloadSignal });
      if (!response.ok || !response.body) throw new Error(`Model download failed (HTTP ${response.status}).`);
      if (response.url && !response.url.startsWith('https://')) throw new Error('Model download must remain on HTTPS.');
      const output = await open(temporary, 'wx+', 0o600);
      try {
        const hash = createHash('sha256');
        let received = 0;
        const reader = response.body.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            downloadSignal.throwIfAborted();
            received += value.byteLength;
            if (received > expected.bytes) throw new Error('Downloaded model is larger than its pinned size.');
            hash.update(value);
            let offset = 0;
            while (offset < value.length) {
              const written = await output.write(value, offset, value.length - offset);
              if (!written.bytesWritten) throw new Error('Could not write the model download.');
              offset += written.bytesWritten;
            }
            progress(received, expected.bytes);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        downloadSignal.throwIfAborted();
        if (received !== expected.bytes || hash.digest('hex') !== expected.sha256)
          throw new Error('Model checksum/size verification failed; the download was not installed.');
        await output.sync();
      } finally {
        await output.close();
      }
      const staged = await open(temporary, 'r');
      try {
        if (!(await this.verifyFile(name, staged, downloadSignal, temporary)))
          throw new Error('Model checksum/size verification failed on disk.');
      } finally {
        await staged.close();
      }
      downloadSignal.throwIfAborted();
      await rename(temporary, this.path(name));
      if (!(await this.verifyExisting(name, downloadSignal)))
        throw new Error('Model checksum/size verification failed on disk.');
      return this.path(name);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** Hash the descriptor and bind its unchanged metadata to the current destination. */
  private async verifyFile(
    name: ModelName,
    file: FileHandle,
    signal: AbortSignal,
    destinationPath = this.path(name),
  ): Promise<string | undefined> {
    signal.throwIfAborted();
    const before = await file.stat({ bigint: true });
    const expected = this.definitions[name];
    if (!before.isFile() || before.size !== BigInt(expected.bytes)) return undefined;
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) {
      signal.throwIfAborted();
      hash.update(chunk);
    }
    const digest = hash.digest('hex');
    signal.throwIfAborted();
    const after = await file.stat({ bigint: true });
    const destination = await stat(destinationPath, { bigint: true });
    if (identity(before) !== identity(after) || identity(after) !== identity(destination))
      throw new Error('Model changed during verification; retry after other model operations finish.');
    return digest === expected.sha256 ? identity(after) : undefined;
  }

  private async verifyExisting(name: ModelName, signal: AbortSignal): Promise<boolean> {
    const file = await open(this.path(name), 'r');
    try {
      const verified = await this.verifyFile(name, file, signal);
      if (!verified) return false;
      await this.markVerified(name, verified, signal);
      return true;
    } finally {
      await file.close();
    }
  }

  private async markVerified(name: ModelName, verified: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (identity(await stat(this.path(name), { bigint: true })) !== verified)
      throw new Error('Model changed before verification could be recorded; retry.');
    await atomicJson(this.marker(name), {
      version: 2,
      sha256: this.definitions[name].sha256,
      bytes: this.definitions[name].bytes,
      identity: verified,
    });
    signal.throwIfAborted();
  }
}
