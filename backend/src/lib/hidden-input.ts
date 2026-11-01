const ESC = '\u001b';
const CTRL_C = '\u0003';
const BACKSPACES = new Set(['\u007f', '\b']);

/** Length of the escape sequence starting at `start` (CSI `ESC [ … final`, SS3 `ESC O x`, or `ESC x`). */
function escapeLength(chars: string[], start: number): number {
  const kind = chars[start + 1];
  if (kind === '[') {
    let end = start + 2;
    // Parameter and intermediate bytes (0x20-0x3F) until the final byte (0x40-0x7E).
    while (end < chars.length && chars[end]! >= ' ' && chars[end]! <= '?') end += 1;
    return end - start + 1;
  }
  return kind === 'O' ? 3 : 2;
}

/**
 * Applies typed or pasted input to a hidden answer. Escape sequences (arrows,
 * Home, End, Delete) and control characters are ignored, so they never end up
 * inside a password. Input after Enter is returned as `rest` for the next prompt.
 */
export function readHiddenKeys(
  value: string,
  chunk: string,
): { value: string; done: boolean; cancelled: boolean; rest: string } {
  const chars = [...chunk];
  let answer = value;
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i]!;
    if (char === '\r' || char === '\n') {
      const next = char === '\r' && chars[i + 1] === '\n' ? i + 2 : i + 1;
      return { value: answer, done: true, cancelled: false, rest: chars.slice(next).join('') };
    }
    if (char === CTRL_C) return { value: answer, done: true, cancelled: true, rest: '' };
    if (char === ESC) i += escapeLength(chars, i) - 1;
    else if (BACKSPACES.has(char)) answer = [...answer].slice(0, -1).join('');
    else if (char >= ' ') answer += char;
  }
  return { value: answer, done: false, cancelled: false, rest: '' };
}
