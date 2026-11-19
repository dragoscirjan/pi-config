import { createObservedSession } from './session-context.js';

/** Return the actual upstream instance; no second reducer, microphone or recognizer. */
export class VoiceSession {
  constructor(config: unknown) {
    return createObservedSession(config);
  }
}
