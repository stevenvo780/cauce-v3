/**
 * The 256 ANSI colours of xterm, re-derived from its own bundle with its own formula, and the
 * CSS the console ships in their place because the CSP drops the stylesheet xterm injects.
 *
 * Pure by contract: no fs, no DOM, no node globals. Both tsconfig projects compile this file.
 */

const ANCHOR = 'DEFAULT_ANSI_COLORS=Object.freeze';
const WINDOW = 900;
const BASE_LITERAL = /toColor\("(#[0-9a-f]{6})"\)/g;
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];
const CUBE_LEVELS_LITERAL = '[0,95,135,175,215,255]';

/** Thrown when xterm's bundle stops yielding the palette this derivation copies. */
export class AnsiPaletteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnsiPaletteError';
  }
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export function xtermAnsiPalette(bundleSource: string): string[] {
  const start = bundleSource.indexOf(ANCHOR);
  if (start < 0) throw new AnsiPaletteError(`${ANCHOR} is no longer in the @xterm/xterm bundle`);
  const chunk = bundleSource.slice(start, start + WINDOW);
  const base = [...chunk.matchAll(BASE_LITERAL)].map((match) => match[1]);
  if (base.length !== 16) {
    throw new AnsiPaletteError(`xterm's 16 base colours are no longer 16 consecutive literals: found ${String(base.length)}`);
  }
  if (!chunk.includes(CUBE_LEVELS_LITERAL)) throw new AnsiPaletteError("xterm's 216-cube levels changed");
  const palette = base.slice();
  for (let index = 0; index < 216; index += 1) {
    palette.push(hex(
      CUBE_LEVELS[((index / 36) | 0) % 6],
      CUBE_LEVELS[((index / 6) | 0) % 6],
      CUBE_LEVELS[index % 6],
    ));
  }
  for (let step = 0; step < 24; step += 1) {
    const level = 8 + 10 * step;
    palette.push(hex(level, level, level));
  }
  return palette;
}

export function ansiPaletteCss(palette: readonly string[]): string {
  const rules: string[] = [];
  for (let index = 0; index < palette.length; index += 1) {
    const color = palette[index];
    rules.push(`.pty-host .xterm-fg-${String(index)} { color: ${color}; }`);
    rules.push(`.pty-host .xterm-fg-${String(index)}.xterm-dim { color: color-mix(in srgb, ${color} 50%, transparent); }`);
    rules.push(`.pty-host .xterm-bg-${String(index)} { background-color: ${color}; }`);
  }
  return `${rules.join('\n')}\n`;
}
