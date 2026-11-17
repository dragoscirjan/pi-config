import { stripVTControlCharacters } from 'node:util';
import { CustomEditor } from '@earendil-works/pi-coding-agent';
import {
  CURSOR_MARKER,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  parseKey,
  renderFakeCursor,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';
import type { VoicePhase, VoiceController } from './controller.js';

/** Only the focused main editor owns Space; overlays retain their original controls. */
export class HoldToTalkEditor extends CustomEditor {
  wantsKeyRelease = true;
  private voicePhase: VoicePhase = 'ready';
  private preview = '';
  private levels: number[] = [];
  private readonly rows: () => number;

  constructor(
    args: ConstructorParameters<typeof CustomEditor>,
    private readonly controller: VoiceController,
    private readonly refresh: () => void,
  ) {
    super(...args);
    this.rows = () => args[0]?.terminal.rows ?? 24;
  }

  setVoiceState(phase: VoicePhase, preview?: string, level?: number): void {
    this.voicePhase = phase;
    if (phase === 'ready' || phase === 'off' || phase === 'stopping' || phase === 'holding' || phase === 'starting') {
      this.preview = '';
      this.levels = [];
    } else {
      if (preview !== undefined)
        this.preview = stripVTControlCharacters(preview)
          .replace(/\p{Cc}/gu, ' ')
          .replace(/\s+/gu, ' ')
          .trim();
      if (phase === 'listening' && level !== undefined && Number.isFinite(level)) {
        this.levels = [...this.levels.slice(-7), Math.max(0, Math.min(1, level))];
      }
    }
    this.invalidate();
    this.refresh();
  }

  override render(width: number): string[] {
    if (width < 1) return [];
    const normal = super.render(width);
    if (this.voicePhase === 'ready' || this.voicePhase === 'off') return normal;
    const bars = '▁▂▃▄▅▆▇█';
    const wave = [...Array(Math.max(0, 8 - this.levels.length)).fill(0), ...this.levels]
      .map((value: number) => bars[Math.min(7, Math.floor(Math.sqrt(value) * 12))])
      .join('');
    const captions = {
      holding: 'Hold Space · mic off',
      starting: 'Preparing voice',
      listening: 'Listening · release Space',
      transcribing: 'Decoding · Esc cancels',
      stopping: 'Stopping',
    };
    const label = ` ⟨${this.voicePhase === 'listening' ? wave : '········'}⟩ ${captions[this.voicePhase]} `;
    const title = truncateToWidth(label, Math.max(0, width - 1), '');
    normal[0] = this.borderColor(`─${title}${'─'.repeat(Math.max(0, width - 1 - visibleWidth(title)))}`);
    if (!this.preview || (this.voicePhase !== 'listening' && this.voicePhase !== 'transcribing')) return normal;

    // Render only. The real text, cursor, undo stack, history and submitted value never contain a preview.
    const { line, col } = this.getCursor();
    const lines = this.getLines();
    const safe = (text: string) =>
      text
        .split('\n')
        .map((part) => stripVTControlCharacters(part).replace(/\p{Cc}/gu, ' '))
        .join('\n');
    const before = safe([...lines.slice(0, line), (lines[line] ?? '').slice(0, col)].join('\n'));
    const after = safe([(lines[line] ?? '').slice(col), ...lines.slice(line + 1)].join('\n'));
    const marker = this.focused ? CURSOR_MARKER : '';
    const draft = `${before}\x1b[2m⟪${this.preview}\x1b[22m${marker}${renderFakeCursor('⟫')}${after}`;
    const padding = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
    const contentWidth = Math.max(1, width - padding * 2);
    const wrapped = wrapTextWithAnsi(draft, Math.max(1, contentWidth - (padding ? 0 : 1)));
    const cursorRow = Math.max(
      0,
      wrapped.findIndex((row) => row.includes(CURSOR_MARKER)),
    );
    const height = Math.max(5, Math.floor(this.rows() * 0.3));
    const start = Math.max(0, Math.min(cursorRow - height + 1, wrapped.length - height));
    const body = wrapped.slice(start, start + height).map((row) => {
      const text = truncateToWidth(row, contentWidth, '');
      return `${' '.repeat(padding)}${text}${' '.repeat(Math.max(0, contentWidth - visibleWidth(text)) + padding)}`;
    });
    return [normal[0]!, ...body, this.borderColor('─'.repeat(width))];
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.preview && (event.type === 'press' || event.type === 'click' || event.type === 'drag')) {
      // Preview rows are not editable buffer coordinates. Cancel before a click can relocate real text.
      this.controller.cancel();
      return { handled: true, focus: true, render: true };
    }
    return super.handleMouse(event);
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
