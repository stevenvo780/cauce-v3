/**
 * THE TERMINAL SKIN MUST BE IN THE BUNDLE, AND IT MUST SAY THE SAME AS XTERM.
 *
 * This test does not look at the screen — jsdom has no layout and does not apply CSP — so it
 * cannot assert that the TUI is read. What it CAN, and what is asked of it, is that the
 * bundled file does not fall short or desync from the two things it copies:
 *
 *   · from `@xterm/xterm`, the 256 ANSI colors: they are re-derived by reading the literals of
 *     ITS bundle, not from my memory. If xterm changes the palette, this goes red.
 *   · from `pty-session.ts`, the theme and the family: the default value of each `var()` in
 *     the CSS must be the same as the TypeScript constant. That default is the safety net
 *     for when the JS fails to paint the `style` attribute, and a lying net is worse than no
 *     net at all.
 *
 * The check that it actually READS must be done in a real Chrome AND WITH THE CSP HEADER SET:
 * `ops/console-legibilidad/servir-con-csp.mjs` serves a `dist` with the same header as
 * production. Without it the measurement cannot go red, which is exactly how it got here.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FUENTE_TERMINAL, PTY_CUERPO_BASE, PTY_CUERPO_MINIMO, TEMA_TERMINAL } from './pty-session';
import { leerCss } from '../../test/leer-css';

const AQUI = dirname(fileURLToPath(import.meta.url));

const PIEL = leerCss(resolve(AQUI, 'xterm-csp.css'));
const SESION = readFileSync(resolve(AQUI, 'pty-session.ts'), 'utf8');

/** The palette literals come from xterm's bundle, so a change there is noticed here. */
function paletaDeXterm(): string[] {
  const require_ = createRequire(import.meta.url);
  const fuente = readFileSync(require_.resolve('@xterm/xterm'), 'utf8');
  const inicio = fuente.indexOf('DEFAULT_ANSI_COLORS=Object.freeze');
  expect(inicio, 'no se encontró DEFAULT_ANSI_COLORS en el bundle de @xterm/xterm').toBeGreaterThan(0);
  const trozo = fuente.slice(inicio, inicio + 900);
  const base = [...trozo.matchAll(/toColor\("(#[0-9a-f]{6})"\)/g)].map((m) => m[1]);
  expect(base, 'los 16 colores base de xterm ya no son 16 literales seguidos').toHaveLength(16);
  const niveles = JSON.parse(((/\[0,95,135,175,215,255\]/.exec(trozo)) ?? ['null'])[0]) as number[] | null;
  expect(niveles, 'los niveles del cubo de 216 de xterm cambiaron').toEqual([0, 95, 135, 175, 215, 255]);
  if (!niveles) throw new Error('los niveles del cubo de 216 de xterm cambiaron');
  const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const todos = base.slice();
  for (let i = 0; i < 216; i += 1) todos.push(hex(niveles[((i / 36) | 0) % 6], niveles[((i / 6) | 0) % 6], niveles[i % 6]));
  for (let t = 0; t < 24; t += 1) { const v = 8 + 10 * t; todos.push(hex(v, v, v)); }
  return todos;
}

function canal(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
function luminancia(hex: string): number {
  const [r, g, b] = canal(hex).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contraste(a: string, b: string): number {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe('la piel empaquetada del terminal', () => {
  it('la carga `pty-session.ts`: sin el import no viaja en el bundle', () => {
    expect(SESION).toContain("import './xterm-csp.css';");
  });

  it('trae los 256 colores ANSI de xterm, sin huecos y con el valor que dice xterm', () => {
    const esperada = paletaDeXterm();
    expect(esperada).toHaveLength(256);
    const faltan: string[] = [];
    for (let i = 0; i < esperada.length; i += 1) {
      if (!PIEL.includes(`.pty-host .xterm-fg-${String(i)} { color: ${esperada[i]}; }`)) faltan.push(`fg-${String(i)}`);
      if (!PIEL.includes(`.pty-host .xterm-bg-${String(i)} { background-color: ${esperada[i]}; }`)) faltan.push(`bg-${String(i)}`);
      if (!PIEL.includes(`.pty-host .xterm-fg-${String(i)}.xterm-dim {`)) faltan.push(`dim-${String(i)}`);
    }
    expect(faltan, `reglas ANSI ausentes o con otro color: ${faltan.slice(0, 8).join(', ')}`).toEqual([]);
  });

  it('cubre el vídeo inverso (257), que es lo que usan las barras de tmux', () => {
    expect(PIEL).toContain('.pty-host .xterm-fg-257 {');
    expect(PIEL).toContain('.pty-host .xterm-bg-257 {');
  });

  it('repone TODO lo que xterm inyectaba: tinta, letra monoespaciada, cuerpo, celda, cursor y selección', () => {
    const filas = PIEL.slice(PIEL.indexOf('.pty-host .xterm-rows {'), PIEL.indexOf('.pty-host .xterm-rows .xterm-dim'));
    for (const propiedad of ['color:', 'font-family:', 'font-size:', 'font-kerning: none', 'white-space: pre']) {
      expect(filas, `a \`.xterm-rows\` le falta \`${propiedad}\``).toContain(propiedad);
    }
    // The cell: without this `inline-block` the TUI disaligns even when the colors are right.
    expect(PIEL).toContain('.pty-host .xterm-rows span { display: inline-block; height: 100%; vertical-align: top; }');
    expect(PIEL).toContain('.xterm-cursor.xterm-cursor-block {');
    expect(PIEL).toContain('.pty-host .xterm-selection div {');
    expect(PIEL).toContain('span.xterm-bold { font-weight: 700; }');
    expect(PIEL).toContain('span.xterm-italic { font-style: italic; }');
  });

  it('los valores por defecto de las `var()` son los mismos que las constantes de TypeScript', () => {
    const defecto = (nombre: string): string => {
      const m = new RegExp(`var\\(${nombre}, ([^)]+)\\)`).exec(PIEL);
      expect(m, `\`${nombre}\` no aparece con valor por defecto en la piel`).not.toBeNull();
      if (!m) throw new Error(`\`${nombre}\` no aparece con valor por defecto en la piel`);
      return m[1].trim();
    };
    expect(defecto('--pty-tinta')).toBe(TEMA_TERMINAL.foreground);
    expect(defecto('--pty-fondo')).toBe(TEMA_TERMINAL.background);
    expect(defecto('--pty-cursor')).toBe(TEMA_TERMINAL.cursor);
    expect(defecto('--pty-cursor-tinta')).toBe(TEMA_TERMINAL.cursorAccent);
    expect(defecto('--pty-seleccion')).toBe(TEMA_TERMINAL.selectionBackground);
    // The family carries commas inside, so the whole declaration string is compared.
    expect(PIEL).toContain(`font-family: var(--pty-fuente, ${FUENTE_TERMINAL.replace(/"/g, '')});`);
  });

  it('el cuerpo de letra nunca baja de lo que se puede leer', () => {
    // Measured in Chrome at 360x800: with the floor at 7 px, 65 columns fit — it cut off THE SAME,
    // because 80 are needed — and on top of that it was unreadable. Lowering the font only pays
    // while it stays readable.
    expect(PTY_CUERPO_MINIMO).toBeGreaterThanOrEqual(10);
    // And it must not go so high that it breaks the desktop: at 1400 px of viewport the gap is
    // 535 px and at 10 px exactly 80 columns fit. At 11 it would drop to 72 and warn about truncation.
    expect(PTY_CUERPO_MINIMO).toBeLessThanOrEqual(10);
    expect(PTY_CUERPO_BASE).toBeGreaterThan(PTY_CUERPO_MINIMO);
  });

  it('el terminal es SIEMPRE oscuro y con contraste de sobra: no depende del tema de la página', () => {
    // 4.5:1 is the WCAG minimum for normal text. A terminal must go well above: what is read
    // here are traces at 13 px for hours.
    expect(contraste(TEMA_TERMINAL.foreground, TEMA_TERMINAL.background)).toBeGreaterThanOrEqual(7);
    expect(contraste(TEMA_TERMINAL.cursor, TEMA_TERMINAL.background)).toBeGreaterThanOrEqual(4.5);
    // No skin rule may depend on a console theme variable: if the terminal inherited `--text`,
    // with the light theme it would become unreadable again.
    expect(PIEL).not.toMatch(/var\(--(text|surface|bg|muted|border)[^)]*\)/);
  });
});
