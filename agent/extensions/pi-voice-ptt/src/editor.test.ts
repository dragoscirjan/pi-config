import { stripVTControlCharacters } from 'node:util';
import type { CustomEditor } from '@earendil-works/pi-coding-agent';
import { CURSOR_MARKER, visibleWidth } from '@earendil-works/pi-tui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceController } from './controller.js';
import { HoldToTalkEditor } from './editor.js';

const { forwarded } = vi.hoisted(() => ({ forwarded: vi.fn() }));
vi.mock('@earendil-works/pi-coding-agent', () => ({
  CustomEditor: class {
    text = '';
    cursor = 0;
    focused = true;
    borderColor = (text: string) => text;
    getPaddingX() {
      return 0;
    }
    render(width: number) {
      return ['─'.repeat(width), this.text, '─'.repeat(width)];
    }
    handleMouse() {
      return undefined;
    }
    invalidate() {}
    handleInput(data: string) {
      forwarded(data);
    }
    getCursor() {
      const parts = this.text.slice(0, this.cursor).split('\n');
      return { line: parts.length - 1, col: parts.at(-1)!.length };
    }
    getLines() {
      return this.text.split('\n');
    }
    setText(text: string) {
      this.text = text;
      this.cursor = text.length;
    }
    getText() {
      return this.text;
    }
    insertTextAtCursor(text: string) {
      this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
      this.cursor += text.length;
    }
  },
}));

function fixture() {
  const controller = { space: vi.fn(), otherKey: vi.fn(), cancel: vi.fn(() => false) };
  const refresh = vi.fn();
  const editor = new HoldToTalkEditor(
    [] as unknown as ConstructorParameters<typeof CustomEditor>,
    controller as unknown as VoiceController,
    refresh,
  );
  return { controller, editor, refresh };
}

beforeEach(() => vi.clearAllMocks());

describe('main-editor input integration', () => {
  it('shows truthful hold/warmup/listen/decoding states inside the input border', () => {
    const f = fixture();
    for (const [phase, label] of [
      ['holding', 'Hold Space'],
      ['starting', 'Preparing voice'],
      ['listening', 'Listening'],
      ['transcribing', 'Decoding'],
    ] as const) {
      f.editor.setVoiceState(phase);
      expect(stripVTControlCharacters(f.editor.render(80)[0]!)).toContain(label);
    }
  });
  it('draws a waveform from actual audio levels, not a timer', () => {
    const f = fixture();
    f.editor.setVoiceState('listening', '', 0);
    const quiet = f.editor.render(80)[0];
    f.editor.setVoiceState('listening', '', 0.25);
    const speech = f.editor.render(80)[0];
    expect(speech).not.toBe(quiet);
    expect(speech).toContain('▇');
    expect(f.editor.render(80)[0]).toBe(speech);
  });
  it('renders live words at the cursor without altering text or cursor', () => {
    const f = fixture();
    f.editor.setText('Before after');
    (f.editor as unknown as { cursor: number }).cursor = 7;
    const cursor = f.editor.getCursor();
    f.editor.setVoiceState('listening', 'spoken words', 0.04);
    const view = f.editor.render(80).map(stripVTControlCharacters).join('\n');
    expect(view).toMatch(/Before ⟪spoken words.*⟫.*after/u);
    expect(f.editor.getText()).toBe('Before after');
    expect(f.editor.getCursor()).toEqual(cursor);
    expect(f.editor.render(80).join('')).toContain(CURSOR_MARKER);
  });
  it('keeps provisional words while decoding and removes them on cancellation', () => {
    const f = fixture();
    f.editor.setText('Keep this');
    f.editor.setVoiceState('listening', 'provisional');
    f.editor.setVoiceState('transcribing');
    expect(f.editor.render(60).join('')).toContain('provisional');
    f.editor.setVoiceState('stopping');
    expect(f.editor.render(60).join('')).not.toContain('provisional');
    expect(f.editor.getText()).toBe('Keep this');
  });
  it.each([1, 2, 8, 20, 40])('bounds wide/long multilingual previews at width %i', (width) => {
    const f = fixture();
    f.editor.setText('prefix\n東京 👩‍💻 café');
    f.editor.setVoiceState('listening', 'This is a long 日本語 provisional preview '.repeat(15), 0.2);
    const rows = f.editor.render(width);
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(9);
    expect(f.editor.getText()).toBe('prefix\n東京 👩‍💻 café');
  });
  it('replaces the visual draft with accepted final text exactly once', () => {
    const f = fixture();
    f.editor.setText('Prefix');
    f.editor.setVoiceState('listening', 'rough words');
    f.editor.insertDictation('Accepted words.');
    f.editor.setVoiceState('ready');
    expect(f.editor.getText()).toBe('Prefix Accepted words.');
    expect(f.editor.render(80).join('')).not.toContain('rough words');
    expect(forwarded).not.toHaveBeenCalled();
  });
  it('cancels a preview click instead of treating its rows as real buffer coordinates', () => {
    const f = fixture();
    f.editor.setText('untouched');
    f.editor.setVoiceState('listening', 'draft');
    const result = f.editor.handleMouse({ type: 'press' } as never);
    expect(result?.handled).toBe(true);
    expect(f.controller.cancel).toHaveBeenCalled();
    expect(f.editor.getText()).toBe('untouched');
  });
  it('never includes preview text in forwarded submit/paste operations', () => {
    const f = fixture();
    f.editor.setText('actual');
    f.editor.setVoiceState('listening', 'not accepted');
    f.editor.handleInput('\r');
    expect(f.editor.getText()).toBe('actual');
    expect(forwarded).toHaveBeenCalledWith('\r');
    f.editor.setVoiceState('ready');
    expect(f.editor.render(80).join('')).not.toContain('not accepted');
  });
  it('opts into releases and routes Kitty Space press/repeat/release', () => {
    const f = fixture();
    f.editor.handleInput('\x1b[32;1:1u');
    f.editor.handleInput('\x1b[32;1:2u');
    f.editor.handleInput('\x1b[32;1:3u');
    expect(f.editor.wantsKeyRelease).toBe(true);
    expect(f.controller.space.mock.calls).toEqual([['press'], ['repeat'], ['release']]);
    expect(forwarded).not.toHaveBeenCalled();
  });

  it('recognizes release even if a modifier changed while Space was held', () => {
    const f = fixture();
    f.editor.handleInput(' ');
    f.editor.handleInput('\x1b[32;2:3u');
    expect(f.controller.space.mock.calls).toEqual([['press'], ['release']]);
  });

  it('supports a plain first Space event and suppresses non-Space releases', () => {
    const f = fixture();
    f.editor.handleInput(' ');
    f.editor.handleInput('\x1b[97;1:3u');
    expect(f.controller.space).toHaveBeenCalledExactlyOnceWith('press');
    expect(forwarded).not.toHaveBeenCalled();
  });

  it('preserves ordinary typing and bracketed pastes including spaces', () => {
    const f = fixture();
    for (const data of ['a', '\x1b[D', '\x1b[200~hello world\x1b[201~']) f.editor.handleInput(data);
    expect(forwarded.mock.calls).toEqual([['a'], ['\x1b[D'], ['\x1b[200~hello world\x1b[201~']]);
    expect(f.controller.space).not.toHaveBeenCalled();
  });

  it('uses Escape to cancel capture but otherwise preserves normal Escape handling', () => {
    const f = fixture();
    f.controller.cancel.mockReturnValueOnce(true);
    f.editor.handleInput('\x1b');
    expect(forwarded).not.toHaveBeenCalled();
    f.editor.handleInput('\x1b');
    expect(forwarded).toHaveBeenCalledExactlyOnceWith('\x1b');
  });

  it('cancels before submission, exit, clear or terminal suspension', () => {
    const f = fixture();
    for (const key of ['\r', '\x03', '\x04', '\x1a']) f.editor.handleInput(key);
    expect(f.controller.cancel).toHaveBeenCalledTimes(4);
    expect(forwarded).toHaveBeenCalledTimes(4);
  });

  it('inserts dictation with a separator while leaving normal spaces alone', () => {
    const f = fixture();
    f.editor.setText('Existing');
    f.editor.insertDictation('new speech.');
    f.editor.insertDictation(' ');
    expect(f.editor.getText()).toBe('Existing new speech. ');
    expect(f.refresh).toHaveBeenCalledTimes(2);
  });
});
