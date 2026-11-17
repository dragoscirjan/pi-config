export type VoicePhase = 'ready' | 'holding' | 'starting' | 'listening' | 'transcribing' | 'stopping' | 'off';
export type SpaceEvent = 'press' | 'repeat' | 'release';

export interface Recording {
  finish(): Promise<string>;
  cancel(): void;
}

export interface VoiceBackend {
  getLocale?(): string | undefined;
  describe?(): string;
  start(
    signal: AbortSignal,
    preview: (text: string, audioLevel?: number) => void,
    onError: (error: Error) => void,
  ): Promise<Recording>;
  close(): void;
}

export interface ControllerOptions {
  backend: VoiceBackend;
  insert: (text: string) => void;
  status: (phase: VoicePhase, preview?: string, audioLevel?: number) => void;
  error: (message: string) => void;
  canCapture: () => boolean;
  holdMs?: number;
  maxHoldMs?: number;
  drainMs?: number;
}

interface Attempt {
  abort: AbortController;
  released: Promise<void>;
  release: () => void;
  recording?: Recording;
  finishing: boolean;
  limit: ReturnType<typeof setTimeout>;
}

/** Input/lifecycle logic is independent of Pi and native audio for deterministic tests. */
export class VoiceController {
  private active = true;
  private pressed = false;
  private suppressed = false;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt: Attempt | undefined;
  private task: Promise<void> | undefined;
  private readonly focusWatchdog: ReturnType<typeof setInterval>;

  constructor(private readonly options: ControllerOptions) {
    this.options.status('ready');
    this.focusWatchdog = setInterval(() => {
      if (this.options.canCapture()) return;
      this.cancel();
      this.pressed = false;
      this.suppressed = false;
    }, 100);
  }

  space(event: SpaceEvent): void {
    if (!this.active) return;
    if (event === 'release') {
      if (!this.pressed) return;
      this.pressed = false;
      this.clearHoldTimer();
      if (!this.suppressed) this.options.insert(' ');
      this.suppressed = false;
      const attempt = this.attempt;
      if (!attempt) this.options.status('ready');
      if (attempt && !attempt.abort.signal.aborted) {
        if (!attempt.recording) {
          // Upstream mic initialization is asynchronous. Never begin a fresh capture after release.
          this.cancel();
        } else if (!attempt.finishing) {
          attempt.finishing = true;
          clearTimeout(attempt.limit);
          attempt.release();
          this.options.status('transcribing');
        }
      }
      return;
    }
    // Ignore orphan auto-repeats, e.g. after a dialog closes while Space is still held.
    if (event === 'repeat' || this.pressed) return;
    this.pressed = true;
    this.suppressed = false;
    if (this.attempt) return; // A short tap still inserts a space while a previous decode drains.
    this.options.status('holding');
    this.holdTimer = setTimeout(() => {
      this.holdTimer = undefined;
      if (!this.options.canCapture()) {
        this.suppressed = true;
        this.options.status('ready');
        return;
      }
      this.suppressed = true;
      this.begin();
    }, this.options.holdMs ?? 400);
  }

  /** Preserve rapid typing when the next character arrives before Space's release. */
  otherKey(): void {
    if (!this.pressed || this.suppressed) return;
    this.clearHoldTimer();
    this.suppressed = true;
    this.options.insert(' ');
    this.options.status('ready');
  }

  cancel(): boolean {
    const hadWork = this.holdTimer !== undefined || this.attempt !== undefined;
    this.clearHoldTimer();
    if (this.pressed) this.suppressed = true;
    const attempt = this.attempt;
    if (attempt) clearTimeout(attempt.limit);
    if (!attempt && hadWork) this.options.status(this.active ? 'ready' : 'off');
    if (attempt && !attempt.abort.signal.aborted) {
      attempt.abort.abort();
      attempt.release();
      this.options.status(this.active ? 'stopping' : 'off');
      try {
        attempt.recording?.cancel();
      } catch (error) {
        this.options.error(`Could not stop microphone: ${errorMessage(error)}`);
      }
    }
    return hadWork;
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.focusWatchdog);
    this.cancel();
    this.options.status('off');
    this.options.backend.close();
  }

  async settled(): Promise<void> {
    await this.task;
  }

  private clearHoldTimer(): void {
    clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
  }

  private begin(): void {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempt: Attempt = {
      abort: new AbortController(),
      released,
      release,
      finishing: false,
      limit: setTimeout(() => {
        this.options.error('Voice capture cancelled after two minutes. Release Space and try again.');
        this.cancel();
      }, this.options.maxHoldMs ?? 120_000),
    };
    this.attempt = attempt;
    this.options.status('starting');
    this.task = this.run(attempt);
  }

  private async run(attempt: Attempt): Promise<void> {
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const recording = await this.options.backend.start(
        attempt.abort.signal,
        (text, audioLevel) => {
          if (attempt.recording && !attempt.abort.signal.aborted && !attempt.finishing && this.active)
            this.options.status('listening', text, audioLevel);
        },
        (error) => {
          if (attempt.abort.signal.aborted) return;
          this.options.error(errorMessage(error));
          this.cancel();
        },
      );
      attempt.recording = recording;
      if (attempt.abort.signal.aborted) {
        recording.cancel();
        return;
      }
      this.options.status('listening');
      await attempt.released;
      if (attempt.abort.signal.aborted) return;
      // Stop capture synchronously on release, before awaiting the final decode.
      const finishing = recording.finish();
      const timeout = new Promise<never>((_resolve, reject) => {
        drainTimer = setTimeout(
          () => reject(new Error('Voice transcription timed out; recording cancelled.')),
          this.options.drainMs ?? 10_000,
        );
      });
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error('Voice capture cancelled.'));
        attempt.abort.signal.addEventListener('abort', onAbort, { once: true });
        if (attempt.abort.signal.aborted) onAbort();
      });
      const text = await Promise.race([finishing, timeout, cancelled]);
      if (!attempt.abort.signal.aborted && this.active && this.options.canCapture() && text.trim()) {
        this.options.insert(text.trim());
      }
    } catch (error) {
      if (!attempt.abort.signal.aborted) {
        this.options.error(errorMessage(error));
        this.cancel();
      }
    } finally {
      if (onAbort) attempt.abort.signal.removeEventListener('abort', onAbort);
      clearTimeout(drainTimer);
      clearTimeout(attempt.limit);
      if (this.attempt === attempt) this.attempt = undefined;
      if (this.active) this.options.status('ready');
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
