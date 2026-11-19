import { describe, expect, it, vi } from 'vitest';
import { createObservedSession, withSessionView, type ObservedSession } from './session-context.js';
import { VoiceSession } from './session-shim.js';

class OriginalSession implements ObservedSession {
  state = { transcript: '', partialTranscript: '', audioLevel: 0 };
  constructor(readonly config: unknown) {}
  dispatchAction(action: unknown) {
    Object.assign(this.state, action);
  }
}
describe('read-only view of the original session', () => {
  it('returns the original instance and observes its own reduced state', () => {
    const preview = vi.fn();
    const config = { preserved: true };
    const session = withSessionView(
      { Session: OriginalSession, preview },
      () => new VoiceSession(config),
    ) as OriginalSession;
    expect(session).toBeInstanceOf(OriginalSession);
    expect(session.config).toBe(config);
    session.dispatchAction({ transcript: 'committed', partialTranscript: 'in progress', audioLevel: 0.04 });
    expect(preview).toHaveBeenLastCalledWith('committed in progress', 0.04);
    session.dispatchAction({ transcript: 'committed final', partialTranscript: '' });
    expect(preview).toHaveBeenLastCalledWith('committed final', 0.04);
  });
  it('captures the correct observer for callbacks outside the async-local creation scope', () => {
    const first = vi.fn();
    const second = vi.fn();
    const one = withSessionView({ Session: OriginalSession, preview: first }, () => createObservedSession({}));
    const two = withSessionView({ Session: OriginalSession, preview: second }, () => createObservedSession({}));
    one.dispatchAction({ partialTranscript: 'one' });
    two.dispatchAction({ partialTranscript: 'two' });
    expect(first).toHaveBeenLastCalledWith('one', 0);
    expect(second).toHaveBeenLastCalledWith('two', 0);
  });
  it('rejects unknown upstream state and unscoped construction', () => {
    expect(() => createObservedSession({})).toThrow('outside');
    class Unsupported {
      dispatchAction() {}
    }
    expect(() => withSessionView({ Session: Unsupported }, () => createObservedSession({}))).toThrow('state contract');
  });
  it('bounds display-only audio levels and handles non-finite values', () => {
    const preview = vi.fn();
    const session = withSessionView({ Session: OriginalSession, preview }, () => createObservedSession({}));
    session.dispatchAction({ audioLevel: Infinity });
    expect(preview).toHaveBeenLastCalledWith('', 0);
    session.dispatchAction({ audioLevel: 2 });
    expect(preview).toHaveBeenLastCalledWith('', 1);
  });
});
