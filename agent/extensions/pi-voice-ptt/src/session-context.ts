import { AsyncLocalStorage } from 'node:async_hooks';

export type VoicePreview = (text: string, audioLevel: number) => void;
export interface ObservedSession {
  dispatchAction(action: unknown): void;
  state?: { transcript: string; partialTranscript: string; audioLevel: number };
}
export type SessionConstructor = new (config: unknown) => ObservedSession;
interface SessionView {
  Session: SessionConstructor;
  preview?: VoicePreview | undefined;
}
const KEY = Symbol.for('@dragoscirjan/pi-voice-ptt/session-view:v1');
const globals = globalThis as unknown as { [key: symbol]: AsyncLocalStorage<SessionView> | undefined };
const storage = globals[KEY] ?? (globals[KEY] = new AsyncLocalStorage<SessionView>());
export function withSessionView<T>(view: SessionView, work: () => T): T {
  return storage.run(view, work);
}
export function createObservedSession(config: unknown): ObservedSession {
  const view = storage.getStore();
  if (!view) throw new Error('Voice view was invoked outside its isolated session.');
  const session = new view.Session(config);
  const publish = () => {
    const state = session.state;
    if (
      !state ||
      typeof state.transcript !== 'string' ||
      typeof state.partialTranscript !== 'string' ||
      typeof state.audioLevel !== 'number'
    )
      throw new Error('Unsupported upstream voice state contract; refusing an unreliable inline preview.');
    view.preview?.(
      [state.transcript, state.partialTranscript].filter(Boolean).join(' '),
      Number.isFinite(state.audioLevel) ? Math.max(0, Math.min(1, state.audioLevel)) : 0,
    );
  };
  const dispatch = session.dispatchAction.bind(session);
  session.dispatchAction = (action) => {
    dispatch(action);
    publish();
  };
  publish();
  return session;
}
