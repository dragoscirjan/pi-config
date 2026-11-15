import { CustomEditor } from '@earendil-works/pi-coding-agent';
import { isKeyRelease, isKeyRepeat, matchesKey, parseKey } from '@earendil-works/pi-tui';
import type { VoiceController } from './controller.js';

/** Only the focused main editor owns Space; overlays retain their original controls. */
export class HoldToTalkEditor extends CustomEditor {
  wantsKeyRelease = true;

  constructor(
    args: ConstructorParameters<typeof CustomEditor>,
    private readonly controller: VoiceController,
    private readonly refresh: () => void,
  ) {
    super(...args);
  }

  override handleInput(data: string): void {
    const released = isKeyRelease(data);
    // A modifier may change while Space is held; still recognize the physical Space release.
    if (matchesKey(data, 'space') || (released && parseKey(data)?.split('+').at(-1) === 'space')) {
      this.controller.space(released ? 'release' : isKeyRepeat(data) ? 'repeat' : 'press');
      this.refresh();
      return;
    }
    // Opting into Space releases must not make other releases insert duplicate characters.
    if (released) return;
    if (matchesKey(data, 'escape') && this.controller.cancel()) return;
    if ((['enter', 'ctrl+c', 'ctrl+d', 'ctrl+z'] as const).some((key) => matchesKey(data, key))) {
      this.controller.cancel();
    } else {
      this.controller.otherKey();
    }
    super.handleInput(data);
  }

  insertDictation(text: string): void {
    if (text === ' ') {
      this.insertTextAtCursor(text);
    } else {
      const { line, col } = this.getCursor();
      const current = this.getLines()[line] ?? '';
      const before = current.slice(0, col).at(-1);
      const after = current.slice(col)[0];
      const left = before && !/[\s([{]/u.test(before) ? ' ' : '';
      const right = after && !/[\s.,!?;:)\]}]/u.test(after) ? ' ' : '';
      this.insertTextAtCursor(`${left}${text}${right}`);
    }
    this.refresh();
  }
}
