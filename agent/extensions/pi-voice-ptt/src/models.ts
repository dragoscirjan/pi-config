import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
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

  async installed(name: ModelName): Promise<boolean> {
    try {
      const file = await stat(this.path(name));
      const verified = JSON.parse(await readFile(this.marker(name), 'utf8')) as {
        sha256: string;
        bytes: number;
        mtimeMs: number;
      };
      const expected = this.definitions[name];
      if (!verified || typeof verified !== 'object') return false;
      return (
        file.isFile() &&
        file.size === expected.bytes &&
        verified.bytes === file.size &&
        verified.sha256 === expected.sha256 &&
        verified.mtimeMs === file.mtimeMs
      );
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
    if (await this.installed(name)) return this.path(name);
    const expected = this.definitions[name];
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // An existing manually downloaded official file can be verified without downloading it again.
    try {
      const existing = await stat(this.path(name));
      if (existing.size === expected.bytes) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(this.path(name))) {
          signal.throwIfAborted();
          hash.update(chunk);
        }
        if (hash.digest('hex') === expected.sha256) {
          await this.markVerified(name);
          return this.path(name);
        }
      }
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
      const output = await open(temporary, 'wx', 0o600);
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
        await output.close();
      }
      downloadSignal.throwIfAborted();
      if (received !== expected.bytes || hash.digest('hex') !== expected.sha256)
        throw new Error('Model checksum/size verification failed; the download was not installed.');
      await rename(temporary, this.path(name));
      await this.markVerified(name);
      return this.path(name);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async markVerified(name: ModelName): Promise<void> {
    const file = await stat(this.path(name));
    await atomicJson(this.marker(name), {
      sha256: this.definitions[name].sha256,
      bytes: file.size,
      mtimeMs: file.mtimeMs,
    });
  }
}
