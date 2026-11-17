import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceController, type ControllerOptions, type Recording } from './controller.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const controllers: VoiceController[] = [];
function fixture(overrides: Partial<ControllerOptions> = {}) {
  const recording = { finish: vi.fn().mockResolvedValue('Hello there.'), cancel: vi.fn() };
  const backend = { start: vi.fn().mockResolvedValue(recording), close: vi.fn() };
  const insert = vi.fn();
  const status = vi.fn();
  const error = vi.fn();
  const canCapture = vi.fn(() => true);
  const controller = new VoiceController({ backend, insert, status, error, canCapture, ...overrides });
  controllers.push(controller);
  return { controller, recording, backend, insert, status, error, canCapture };
}

async function hold(controller: VoiceController) {
  controller.space('press');
  await vi.advanceTimersByTimeAsync(400);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.deactivate();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('hold-to-talk controller', () => {
  it('acknowledges press immediately without claiming the microphone is ready', async () => {
    const f = fixture();
    f.controller.space('press');
    expect(f.status).toHaveBeenLastCalledWith('holding');
    expect(f.backend.start).not.toHaveBeenCalled();
    f.controller.cancel();
    expect(f.status).toHaveBeenLastCalledWith('ready');
  });
  it('does not turn an early observer tick into a false Listening state', async () => {
    const pending = deferred<Recording>();
    let observe!: (text: string, level?: number) => void;
    const start = vi.fn((_signal, preview) => {
      observe = preview;
      return pending.promise;
    });
    const f = fixture({ backend: { start, close: vi.fn() } });
    await hold(f.controller);
    observe('', 0);
    expect(f.status).toHaveBeenLastCalledWith('starting');
    pending.resolve(f.recording);
    await vi.advanceTimersByTimeAsync(0);
    observe('real words', 0.03);
    expect(f.status).toHaveBeenLastCalledWith('listening', 'real words', 0.03);
  });
  it('does not open the microphone merely by activating', () => {
    const f = fixture();
    expect(f.backend.start).not.toHaveBeenCalled();
    expect(f.status).toHaveBeenLastCalledWith('ready');
  });

  it('preserves short Space taps without opening a microphone', async () => {
    const f = fixture();
    f.controller.space('press');
    await vi.advanceTimersByTimeAsync(150);
    f.controller.space('release');
    await vi.advanceTimersByTimeAsync(500);
    expect(f.insert).toHaveBeenCalledExactlyOnceWith(' ');
    expect(f.backend.start).not.toHaveBeenCalled();
  });

  it('does not lose a space if the next character precedes the release', async () => {
    const f = fixture();
    f.controller.space('press');
    f.controller.otherKey();
    await vi.advanceTimersByTimeAsync(500);
    f.controller.space('release');
    expect(f.insert).toHaveBeenCalledExactlyOnceWith(' ');
    expect(f.backend.start).not.toHaveBeenCalled();
  });

  it('does not reset the hold threshold on auto-repeat or repeated raw presses', async () => {
    const f = fixture();
    f.controller.space('press');
    await vi.advanceTimersByTimeAsync(250);
    f.controller.space('repeat');
    f.controller.space('press');
    await vi.advanceTimersByTimeAsync(150);
    expect(f.backend.start).toHaveBeenCalledTimes(1);
    expect(f.insert).not.toHaveBeenCalled();
  });

  it('ignores orphan repeats and releases', async () => {
    const f = fixture();
    f.controller.space('repeat');
    f.controller.space('release');
    await vi.advanceTimersByTimeAsync(500);
    expect(f.insert).not.toHaveBeenCalled();
    expect(f.backend.start).not.toHaveBeenCalled();
  });

  it('records after the threshold and inserts only the final transcript on release', async () => {
    const f = fixture();
    await hold(f.controller);
    expect(f.status).toHaveBeenLastCalledWith('listening');
    expect(f.recording.finish).not.toHaveBeenCalled();
    f.controller.space('release');
    await f.controller.settled();
    expect(f.recording.finish).toHaveBeenCalledTimes(1);
    expect(f.insert).toHaveBeenCalledExactlyOnceWith('Hello there.');
    expect(f.status).toHaveBeenLastCalledWith('ready');
  });

  it('shows live preview without inserting it or changing transcribing back to listening', async () => {
    const f = fixture();
    const result = deferred<string>();
    f.recording.finish.mockReturnValue(result.promise);
    await hold(f.controller);
    const preview = f.backend.start.mock.calls[0]![1] as (text: string) => void;
    preview('partial');
    expect(f.insert).not.toHaveBeenCalled();
    expect(f.status).toHaveBeenLastCalledWith('listening', 'partial', undefined);
    f.controller.space('release');
    await vi.advanceTimersByTimeAsync(0);
    preview('stale partial');
    expect(f.status).toHaveBeenLastCalledWith('transcribing');
    result.resolve('final');
    await f.controller.settled();
    expect(f.insert).toHaveBeenCalledExactlyOnceWith('final');
  });

  it('allows normal spaces but never opens a second mic during finalization', async () => {
    const f = fixture();
    const result = deferred<string>();
    f.recording.finish.mockReturnValue(result.promise);
    await hold(f.controller);
    f.controller.space('release');
    await vi.advanceTimersByTimeAsync(0);
    f.controller.space('press');
    f.controller.space('release');
    expect(f.insert).toHaveBeenCalledExactlyOnceWith(' ');
    expect(f.backend.start).toHaveBeenCalledTimes(1);
    result.resolve('done');
    await f.controller.settled();
    expect(f.recording.finish).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending hold without adding a space', async () => {
    const f = fixture();
    f.controller.space('press');
    expect(f.controller.cancel()).toBe(true);
    f.controller.space('release');
    await vi.advanceTimersByTimeAsync(500);
    expect(f.backend.start).not.toHaveBeenCalled();
    expect(f.insert).not.toHaveBeenCalled();
  });

  it('cancels recording and aborts the upstream pipeline', async () => {
    const f = fixture();
    await hold(f.controller);
    const signal = f.backend.start.mock.calls[0]![0] as AbortSignal;
    expect(f.controller.cancel()).toBe(true);
    await f.controller.settled();
    expect(signal.aborted).toBe(true);
    expect(f.recording.cancel).toHaveBeenCalled();
    expect(f.recording.finish).not.toHaveBeenCalled();
    f.controller.space('release');
    expect(f.insert).not.toHaveBeenCalled();
  });

  it('stops a microphone that finishes opening after the key was released', async () => {
    const f = fixture();
    const startup = deferred<Recording>();
    f.backend.start.mockReturnValue(startup.promise);
    await hold(f.controller);
    f.controller.space('release');
    startup.resolve(f.recording);
    await f.controller.settled();
    expect(f.recording.cancel).toHaveBeenCalledTimes(1);
    expect(f.recording.finish).not.toHaveBeenCalled();
    expect(f.insert).not.toHaveBeenCalled();
  });

  it('deactivates idempotently and discards in-flight transcription', async () => {
    const f = fixture();
    const result = deferred<string>();
    f.recording.finish.mockReturnValue(result.promise);
    await hold(f.controller);
    f.controller.space('release');
    await vi.advanceTimersByTimeAsync(0);
    f.controller.deactivate();
    f.controller.deactivate();
    result.resolve('must not appear');
    await f.controller.settled();
    f.controller.space('press');
    await vi.advanceTimersByTimeAsync(500);
    expect(f.insert).not.toHaveBeenCalled();
    expect(f.backend.close).toHaveBeenCalledTimes(1);
    expect(f.status).toHaveBeenLastCalledWith('off');
  });

  it('deactivates promptly even if a native final decode never resolves', async () => {
    const f = fixture();
    f.recording.finish.mockReturnValue(new Promise<string>(() => {}));
    await hold(f.controller);
    f.controller.space('release');
    await vi.advanceTimersByTimeAsync(0);
    f.controller.deactivate();
    await f.controller.settled();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.insert).not.toHaveBeenCalled();
  });

  it('cancels on editor focus loss and resets a pending Space press', async () => {
    const f = fixture();
    f.controller.space('press');
    f.canCapture.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(500);
    f.canCapture.mockReturnValue(true);
    await hold(f.controller);
    expect(f.backend.start).toHaveBeenCalledTimes(1);
    f.canCapture.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(100);
    await f.controller.settled();
    expect(f.recording.cancel).toHaveBeenCalled();
    expect(f.insert).not.toHaveBeenCalled();
  });

  it('discards a final decode if focus is lost', async () => {
    const f = fixture();
    const result = deferred<string>();
    f.recording.finish.mockReturnValue(result.promise);
    await hold(f.controller);
    f.controller.space('release');
    await vi.advanceTimersByTimeAsync(0);
    f.canCapture.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(100);
    result.resolve('stale');
    await f.controller.settled();
    expect(f.insert).not.toHaveBeenCalled();
  });

  it('reports a failed microphone open and recovers to ready', async () => {
    const f = fixture();
    f.backend.start.mockRejectedValue(new Error('device unavailable'));
    await hold(f.controller);
    await f.controller.settled();
    expect(f.error).toHaveBeenCalledExactlyOnceWith('device unavailable');
    expect(f.status).toHaveBeenLastCalledWith('ready');
  });

  it('handles an asynchronous microphone error while recording', async () => {
    const f = fixture();
    await hold(f.controller);
    const onError = f.backend.start.mock.calls[0]![2] as (error: Error) => void;
    onError(new Error('microphone disconnected'));
    await f.controller.settled();
    expect(f.error).toHaveBeenCalledExactlyOnceWith('microphone disconnected');
    expect(f.recording.cancel).toHaveBeenCalled();
  });

  it('times out a stalled final decode and never pastes its late result', async () => {
    const f = fixture({ drainMs: 200 });
    const result = deferred<string>();
    f.recording.finish.mockReturnValue(result.promise);
    await hold(f.controller);
    f.controller.space('release');
    await vi.advanceTimersByTimeAsync(201);
    await f.controller.settled();
    expect(f.error).toHaveBeenCalledWith(expect.stringContaining('timed out'));
    expect(f.recording.cancel).toHaveBeenCalled();
    result.resolve('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.insert).not.toHaveBeenCalled();
  });

  it('stops recording at the safety limit if the release event is lost', async () => {
    const f = fixture({ maxHoldMs: 1000 });
    await hold(f.controller);
    await vi.advanceTimersByTimeAsync(1000);
    await f.controller.settled();
    expect(f.recording.cancel).toHaveBeenCalled();
    expect(f.error).toHaveBeenCalledWith(expect.stringContaining('Release Space'));
    expect(f.insert).not.toHaveBeenCalled();
  });

  it('skips blank transcripts', async () => {
    const f = fixture();
    f.recording.finish.mockResolvedValue('  ');
    await hold(f.controller);
    f.controller.space('release');
    await f.controller.settled();
    expect(f.insert).not.toHaveBeenCalled();
  });
});
