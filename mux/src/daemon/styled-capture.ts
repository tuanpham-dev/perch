// One buffer row as text with its styling kept as SGR escapes, for
// `io.capture` with `styles`: what a reader needs to tell apart text that only
// color distinguishes (a TUI's highlighted tab, a selected row). Every change
// of style emits a full reset plus the new attributes, so a reader can take
// any escape on its own; a row that ends styled ends with a reset. Trailing
// unstyled blanks are dropped, as the plain capture drops trailing spaces.
import type { IBuffer, IBufferCell } from '@xterm/headless';

const RESET = '\x1b[0m';

function colorParams(cell: IBufferCell, kind: 'fg' | 'bg'): string[] {
  const isFg = kind === 'fg';
  if (isFg ? cell.isFgDefault() : cell.isBgDefault()) return [];
  const color = isFg ? cell.getFgColor() : cell.getBgColor();
  if (isFg ? cell.isFgRGB() : cell.isBgRGB()) {
    return [isFg ? '38' : '48', '2', String((color >> 16) & 255), String((color >> 8) & 255), String(color & 255)];
  }
  if (color < 8) return [String((isFg ? 30 : 40) + color)];
  if (color < 16) return [String((isFg ? 90 : 100) + color - 8)];
  return [isFg ? '38' : '48', '5', String(color)];
}

// The SGR parameters of a cell's style, "" for the default style.
export function cellSgr(cell: IBufferCell): string {
  const params: string[] = [];
  if (cell.isBold()) params.push('1');
  if (cell.isDim()) params.push('2');
  if (cell.isItalic()) params.push('3');
  if (cell.isUnderline()) params.push('4');
  if (cell.isBlink()) params.push('5');
  if (cell.isInverse()) params.push('7');
  if (cell.isInvisible()) params.push('8');
  if (cell.isStrikethrough()) params.push('9');
  params.push(...colorParams(cell, 'fg'), ...colorParams(cell, 'bg'));
  return params.join(';');
}

export function styledRow(buffer: IBuffer, y: number): string {
  const line = buffer.getLine(y);
  if (!line) return '';
  const cell = buffer.getNullCell();
  // Past the last cell that shows something: a glyph, or a styled blank.
  let end = 0;
  for (let x = 0; x < line.length; x++) {
    line.getCell(x, cell);
    if ((cell.getChars() !== '' && cell.getChars() !== ' ') || cellSgr(cell) !== '') end = x + cell.getWidth();
  }
  let out = '';
  let current = '';
  for (let x = 0; x < end; x++) {
    line.getCell(x, cell);
    // The second half of a wide glyph holds nothing of its own.
    if (cell.getWidth() === 0) continue;
    const sgr = cellSgr(cell);
    if (sgr !== current) {
      out += sgr === '' ? RESET : `\x1b[0;${sgr}m`;
      current = sgr;
    }
    out += cell.getChars() || ' ';
  }
  return current === '' ? out : out + RESET;
}
