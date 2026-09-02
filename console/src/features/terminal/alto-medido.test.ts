/**
 * THE VARIABLE THE COMPONENT WRITES AND THE ONE THE SHEET READS ARE ONE STRING.
 *
 * `TerminalPage` measures the top of the terminal box and publishes it as a custom property; the
 * stylesheet subtracts it from the viewport. Nothing type-checks that pair: rename either half and
 * the box silently falls back to the hand-summed number in the `var()` default, which is the very
 * defect this replaced. Each check carries a negative control, because a test over a string that
 * cannot go red is worth nothing.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cuerposDeSelector, sinComentarios } from '../../test/css-parser';
import { leerCss } from '../../test/leer-css';
import { VAR_TOPE_PAGINA, VAR_TOPE_TERMINAL } from './TerminalPage';

const HOJA = sinComentarios(leerCss('features/terminal/terminal-panel.css'));
const BASE = sinComentarios(leerCss('styles/base.css'));
const FUENTE = readFileSync(resolve(process.cwd(), 'src/features/terminal/TerminalPage.tsx'), 'utf8');

const CAJA = '.ultimate-terminal-page:not([data-tui="abierta"]) .ultimate-terminal-shell';

function defectosDelAltoMedido(css: string, variable: string): string[] {
  const defectos: string[] = [];
  const cuerpos = cuerposDeSelector(css, CAJA);
  if (cuerpos.length === 0) return ['la caja sin sesión no declara alto en ningún sitio'];
  for (const cuerpo of cuerpos) {
    const alto = /(?:^|;)\s*height:\s*([^;]+)/.exec(cuerpo)?.[1];
    if (!alto) {
      defectos.push('la caja sin sesión no declara alto');
      continue;
    }
    if (!alto.includes(`var(${variable}`)) defectos.push(`el alto no lee el tope medido: ${alto}`);
    if (!alto.includes('430px')) defectos.push(`el alto pierde el suelo de 430px: ${alto}`);
    if (!/grid-template-rows:\s*minmax\(0, 1fr\)/.test(cuerpo)) {
      defectos.push('la única fila vuelve a ser `auto` y la lista desborda su propio `overflow: hidden`');
    }
  }
  return defectos;
}

describe('el alto de la caja del terminal sale de una medición, no de una suma a mano', () => {
  it('la variable que el componente escribe es la MISMA que la hoja lee', () => {
    expect(VAR_TOPE_TERMINAL).toBe('--terminal-tope');
    expect(HOJA).toContain(`var(${VAR_TOPE_TERMINAL},`);
    expect(FUENTE).toContain(`setProperty(VAR_TOPE_TERMINAL`);
  });

  it('y la del contenedor de página la lee `page-shell-aplicacion` en `base.css`', () => {
    expect(VAR_TOPE_PAGINA).toBe('--shell-tope');
    expect(BASE).toContain(`var(${VAR_TOPE_PAGINA},`);
    expect(FUENTE).toContain(`setProperty(VAR_TOPE_PAGINA`);
  });

  it('la caja sin sesión conserva el suelo, la fila explícita y el tope medido', () => {
    expect(defectosDelAltoMedido(HOJA, VAR_TOPE_TERMINAL)).toEqual([]);
  });

  it('CONTROL NEGATIVO — renombrar la variable en la hoja deja de casar con la del componente', () => {
    const roto = HOJA.replace('var(--terminal-tope,', 'var(--terminal-alto,');
    expect(roto).not.toBe(HOJA);
    expect(roto).not.toContain(`var(${VAR_TOPE_TERMINAL},`);
    expect(defectosDelAltoMedido(roto, VAR_TOPE_TERMINAL)).toContainEqual(
      expect.stringContaining('no lee el tope medido'),
    );
  });

  it('CONTROL NEGATIVO — marca la vuelta al número fijo, que es el defecto medido', () => {
    const roto = HOJA.replace(/height:\s*clamp\(430px[^;]*;/, 'height: clamp(430px, calc(100dvh - 396px), 820px);');
    expect(roto).not.toBe(HOJA);
    expect(defectosDelAltoMedido(roto, VAR_TOPE_TERMINAL)).toContainEqual(
      expect.stringContaining('no lee el tope medido'),
    );
  });

  it('CONTROL NEGATIVO — marca la fila implícita, que es la que desborda la lista de la flota', () => {
    const roto = HOJA.replace('grid-template-rows: minmax(0, 1fr);', '');
    expect(roto).not.toBe(HOJA);
    expect(defectosDelAltoMedido(roto, VAR_TOPE_TERMINAL)).toContainEqual(
      expect.stringContaining('desborda'),
    );
  });
});
