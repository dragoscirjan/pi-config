import type { CustomEditor } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceController } from './controller.js';
import { HoldToTalkEditor } from './editor.js';

const { forwarded } = vi.hoisted(() => ({ forwarded: vi.fn() }));
vi.mock('@earendil-works/pi-coding-agent', () => ({
  CustomEditor: class {
    text = '';
    cursor = 0;
    handleInput(data: string) {
      forwarded(data);
    }
    getCursor() {
      return { line: 0, col: this.cursor };
    }
    getLines() {
      return [this.text];
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
