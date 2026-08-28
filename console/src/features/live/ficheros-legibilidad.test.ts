import { describe, expect, it } from 'vitest';
import { leerCss } from '../../test/leer-css';

/**
 * THAT THE MOST IMPORTANT WARNING OF THE VIEW CAN ALSO BE READ ON WHITE PAPER.
 *
 * And it was exactly the worst place for it to happen. That box is the ONLY explanation of why
 * the editor has no content; if it is not seen, the screen stays as a list of files that do not
 * open, without a single word, which is exactly the kind of "silent gap" this work came to
 * remove. An unreadable warning is worse than none: it occupies the place of the one that
 * would be read.
 *
 * jsdom has no layout and no computed color, so — as in `styles.legibilidad.test.ts` — this
 * checks the SHEET as text. It is the cheap thing that catches the regression, and it carries
 * its negative control by mutation: it is fed a sheet without the block and is required to flag
 * it.
 */

const HOJA = 'features/live/live.css';

export function bloquesDeModoClaro(css: string): string {
  const bloques: string[] = [];
  const marca = '@media (prefers-color-scheme: light)';
  let desde = css.indexOf(marca);
  while (desde !== -1) {
    const abre = css.indexOf('{', desde);
    let nivel = 0;
    let i = abre;
    for (; i < css.length; i += 1) {
      if (css[i] === '{') nivel += 1;
      else if (css[i] === '}') {
        nivel -= 1;
        if (nivel === 0) break;
      }
    }
    bloques.push(css.slice(abre + 1, i));
    desde = css.indexOf(marca, i);
  }
  return bloques.join('\n');
}

/**
 * File editor classes that paint color and background with a fixed hex instead of theme tokens.
 * Each one of them HAS to be redefined in light mode, because a dark-theme hex does not adapt
 * on its own.
 */
const CON_COLOR_FIJO = ['.ficheros-caveat', '.ficheros-aviso', '.ficheros-fallo'];

describe('los avisos del editor de ficheros se leen en los dos temas', () => {
  it('cada recuadro con color fijo tiene su redefinición en modo claro', () => {
    const claro = bloquesDeModoClaro(leerCss(HOJA));
    for (const clase of CON_COLOR_FIJO) {
      expect(claro, `${clase} no se redefine en modo claro`).toContain(clase);
    }
  });

  /**
   * THE NEGATIVE CONTROL. Without it, the test above would pass equally with a function that
   * returned the whole sheet — or anything that contains those names — and would prove nothing.
   */
  it('una hoja SIN el bloque de modo claro se marca como rota', () => {
    const rota = '.ficheros-fallo { color: #ffb7bc; }\n@media (max-width: 600px) { .x { color: red; } }';
    const claro = bloquesDeModoClaro(rota);
    expect(claro).not.toContain('.ficheros-fallo');
  });

  it('el extractor devuelve el contenido del bloque y no la hoja entera', () => {
    const hoja = '.fuera { color: red; }\n@media (prefers-color-scheme: light) { .dentro { color: blue; } }';
    const claro = bloquesDeModoClaro(hoja);
    expect(claro).toContain('.dentro');
    expect(claro).not.toContain('.fuera');
  });

  /** Las llaves anidadas no pueden cortar el bloque antes de tiempo. */
  it('el extractor sobrevive a reglas anidadas dentro del bloque', () => {
    const hoja = '@media (prefers-color-scheme: light) { .a { color: blue; } .b { color: green; } }\n.despues { color: red; }';
    const claro = bloquesDeModoClaro(hoja);
    expect(claro).toContain('.b');
    expect(claro).not.toContain('.despues');
  });
});
