import { rect, type Ctx } from './paint';

const GLYPH_W = 3;
const GLYPH_H = 5;

const GLYPHS: Readonly<Record<string, string>> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101111011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', 0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
  4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010', 8: '111101111101111',
  9: '111101111001110', '.': '000000000000010', '-': '000000111000000', _: '000000000000111', ':': '000010000010000',
  ' ': '000000000000000', '?': '110001010000010',
};

const plain = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

/** Width in art px of `text` set at `scale`, glyphs one column apart. */
export function textWidth(text: string, scale: number): number {
  const count = Array.from(plain(text)).length;
  return count === 0 ? 0 : (count * (GLYPH_W + 1) - 1) * scale;
}

export const TEXT_HEIGHT = (scale: number): number => GLYPH_H * scale;

/** The largest scale (at most `limit`) at which `text` fits `room` px; text that fits at none is cut with a dot. */
export function fitText(text: string, room: number, limit: number): { text: string; scale: number } {
  for (let scale = limit; scale >= 1; scale -= 1) if (textWidth(text, scale) <= room) return { text, scale };
  const letters = Array.from(plain(text));
  while (letters.length > 1 && textWidth(`${letters.join('')}.`, 1) > room) letters.pop();
  return { text: `${letters.join('')}.`, scale: 1 };
}

export function paintText(ctx: Ctx, text: string, x: number, y: number, scale: number, color: string): void {
  let cursor = x;
  for (const char of plain(text)) {
    const rows = GLYPHS[char] ?? GLYPHS['?'];
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index] === '1') rect(ctx, cursor + (index % GLYPH_W) * scale, y + Math.floor(index / GLYPH_W) * scale, scale, scale, color);
    }
    cursor += (GLYPH_W + 1) * scale;
  }
}
