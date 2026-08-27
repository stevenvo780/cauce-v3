/**
 * LA PIEL DEL TERMINAL TIENE QUE ESTAR EN EL BUNDLE, Y TIENE QUE DECIR LO MISMO QUE XTERM.
 *
 * Esta prueba no mira la pantalla —jsdom no tiene layout ni aplica CSP— así que no puede afirmar
 * que la TUI se lee. Lo que sí puede, y es lo que se le pide, es que el fichero empaquetado no se
 * quede corto ni se desincronice de las dos cosas de las que copia:
 *
 *   · de `@xterm/xterm`, los 256 colores ANSI: se vuelven a derivar leyendo los literales de SU
 *     bundle, no de mi memoria. Si xterm cambia la paleta, esto se pone rojo.
 *   · de `pty-session.ts`, el tema y la familia: el valor por defecto de cada `var()` del CSS
 *     tiene que ser el mismo que la constante de TypeScript. Ese defecto es la red de seguridad
 *     para cuando el JS no llega a pintar el atributo `style`, y una red que miente es peor que
 *     no tenerla.
 *
 * La comprobación de que se LEE de verdad hay que hacerla en un Chrome real Y CON LA CABECERA CSP
 * PUESTA: `ops/console-legibilidad/servir-con-csp.mjs` sirve un `dist` con la misma cabecera que
 * producción. Sin ella la medición no puede dar rojo, que es exactamente cómo llegó hasta aquí.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FUENTE_TERMINAL, PTY_CUERPO_BASE, PTY_CUERPO_MINIMO, TEMA_TERMINAL } from './pty-session';

const AQUI = dirname(fileURLToPath(import.meta.url));

function readCssWithImports(filePath: string): string {
  const content = readFileSync(filePath, 'utf8');
  return content.replace(/@import\s+['"]([^'"]+)['"];/g, (_, relPath) => {
    return readCssWithImports(resolve(dirname(filePath), relPath));
  });
}

const PIEL = readCssWithImports(resolve(AQUI, 'xterm-csp.css'));
const SESION = readFileSync(resolve(AQUI, 'pty-session.ts'), 'utf8');

/** Los literales de la paleta salen del bundle de xterm, para que un cambio suyo se note acá. */
function paletaDeXterm(): string[] {
  const require_ = createRequire(import.meta.url);
  const fuente = readFileSync(require_.resolve('@xterm/xterm'), 'utf8');
  const inicio = fuente.indexOf('DEFAULT_ANSI_COLORS=Object.freeze');
  expect(inicio, 'no se encontró DEFAULT_ANSI_COLORS en el bundle de @xterm/xterm').toBeGreaterThan(0);
  const trozo = fuente.slice(inicio, inicio + 900);
  const base = [...trozo.matchAll(/toColor\("(#[0-9a-f]{6})"\)/g)].map((m) => m[1]);
  expect(base, 'los 16 colores base de xterm ya no son 16 literales seguidos').toHaveLength(16);
  const niveles = JSON.parse((trozo.match(/\[0,95,135,175,215,255\]/) ?? ['null'])[0]) as number[] | null;
  expect(niveles, 'los niveles del cubo de 216 de xterm cambiaron').toEqual([0, 95, 135, 175, 215, 255]);
  const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const todos = base.slice();
  for (let i = 0; i < 216; i += 1) todos.push(hex(niveles![((i / 36) | 0) % 6], niveles![((i / 6) | 0) % 6], niveles![i % 6]));
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
      if (!PIEL.includes(`.pty-host .xterm-fg-${i} { color: ${esperada[i]}; }`)) faltan.push(`fg-${i}`);
      if (!PIEL.includes(`.pty-host .xterm-bg-${i} { background-color: ${esperada[i]}; }`)) faltan.push(`bg-${i}`);
      if (!PIEL.includes(`.pty-host .xterm-fg-${i}.xterm-dim {`)) faltan.push(`dim-${i}`);
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
    // La celda: sin este `inline-block` la TUI se descuadra aunque los colores estén bien.
    expect(PIEL).toContain('.pty-host .xterm-rows span { display: inline-block; height: 100%; vertical-align: top; }');
    expect(PIEL).toContain('.xterm-cursor.xterm-cursor-block {');
    expect(PIEL).toContain('.pty-host .xterm-selection div {');
    expect(PIEL).toContain('span.xterm-bold { font-weight: 700; }');
    expect(PIEL).toContain('span.xterm-italic { font-style: italic; }');
  });

  it('los valores por defecto de las `var()` son los mismos que las constantes de TypeScript', () => {
    const defecto = (nombre: string): string => {
      const m = PIEL.match(new RegExp(`var\\(${nombre}, ([^)]+)\\)`));
      expect(m, `\`${nombre}\` no aparece con valor por defecto en la piel`).not.toBeNull();
      return m![1].trim();
    };
    expect(defecto('--pty-tinta')).toBe(TEMA_TERMINAL.foreground);
    expect(defecto('--pty-fondo')).toBe(TEMA_TERMINAL.background);
    expect(defecto('--pty-cursor')).toBe(TEMA_TERMINAL.cursor);
    expect(defecto('--pty-cursor-tinta')).toBe(TEMA_TERMINAL.cursorAccent);
    expect(defecto('--pty-seleccion')).toBe(TEMA_TERMINAL.selectionBackground);
    // La familia lleva comas dentro, así que se compara la cadena entera de la declaración.
    expect(PIEL).toContain(`font-family: var(--pty-fuente, ${FUENTE_TERMINAL.replace(/"/g, '')});`);
  });

  it('el cuerpo de letra nunca baja de lo que se puede leer', () => {
    // Medido en Chrome a 360x800: con el suelo en 7 px entraban 65 columnas —se cortaba IGUAL,
    // porque hacen falta 80— y encima no se leía. Bajar la letra sólo paga mientras se lea.
    expect(PTY_CUERPO_MINIMO).toBeGreaterThanOrEqual(10);
    // Y no puede subir tanto que rompa el escritorio: a 1400 px de ventana el hueco mide 535 px y
    // a 10 px entran exactamente las 80 columnas. A 11 se quedaría en 72 y avisaría de recorte.
    expect(PTY_CUERPO_MINIMO).toBeLessThanOrEqual(10);
    expect(PTY_CUERPO_BASE).toBeGreaterThan(PTY_CUERPO_MINIMO);
  });

  it('el terminal es SIEMPRE oscuro y con contraste de sobra: no depende del tema de la página', () => {
    // 4,5:1 es el mínimo de WCAG para texto normal. Un terminal tiene que ir muy por encima:
    // lo que se lee acá son trazas de 13 px durante horas.
    expect(contraste(TEMA_TERMINAL.foreground, TEMA_TERMINAL.background)).toBeGreaterThanOrEqual(7);
    expect(contraste(TEMA_TERMINAL.cursor, TEMA_TERMINAL.background)).toBeGreaterThanOrEqual(4.5);
    // Ninguna regla de la piel puede depender de una variable de tema de la consola: si el
    // terminal heredara `--text`, con el tema claro volvería a quedar ilegible.
    expect(PIEL).not.toMatch(/var\(--(text|surface|bg|muted|border)[^)]*\)/);
  });
});
