import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOTTOM_BAR_VIEWPORT, RAIL_VIEWPORT } from './breakpoints';
import { leerCss } from './test/leer-css';

/**
 * One scale of widths, and nobody may invent a fourth: the two viewports the shell matches from
 * JavaScript are literally the two the sheets declare, and no sheet declares any other. A width off
 * the scale is a width no gate measures — `qa/layout-gate.mjs` drives 360/760/1100/1440/1920/2560 —
 * so it breaks in a band nobody looks at. Exceptions are named one by one below.
 */

/** Same root `leerCss` resolves relative paths against: the `src` of this package. */
const RAIZ_CSS = resolve(process.cwd(), 'src');

/** The three steps: compact (<=760), medium (<=1100), wide (no query). Declared in `base.css`. */
const ESCALA = [760, 1100];

/**
 * The widths outside the scale, one by one, with the measurement that pays for them. None of them is
 * a viewport step: each is the width at which a specific piece of CONTENT stops fitting, and raising
 * any of them to the compact step was measured to cost scroll depth the layout ratchet refuses
 * (`qa/layout-baseline.json`). The reason is written beside each rule in its own sheet.
 */
const EXCEPCIONES = new Map<string, number[]>([
  // The fleet table beside the 420px drawer.
  ['features/live/live-drawer.css', [1479]],
  // A page title and its action button; a panel title and its sentence.
  ['styles/responsive.css', [640, 460]],
  // A provider title beside its column of figures.
  ['features/accounts/licenses.css', [720]],
]);

interface Hoja { hoja: string; css: string }

function hojasDeLaConsola(directorio = RAIZ_CSS): Hoja[] {
  const salida: Hoja[] = [];
  for (const nombre of readdirSync(directorio)) {
    const ruta = join(directorio, nombre);
    if (statSync(ruta).isDirectory()) salida.push(...hojasDeLaConsola(ruta));
    else if (ruta.endsWith('.css')) {
      salida.push({ hoja: relative(RAIZ_CSS, ruta), css: readFileSync(ruta, 'utf8') });
    }
  }
  return salida;
}

/** `@media` preludes only: an `@container` width is the width of a BOX, not of the window. */
function consultasDeVentana(css: string): string[] {
  return [...css.matchAll(/@media([^{]+)\{/g)].map((m) => m[1].trim());
}

function anchosDeclarados(consulta: string): { topes: number[]; pisos: number[] } {
  return {
    topes: [
      ...[...consulta.matchAll(/max-width:\s*(\d+)px/g)].map((m) => Number(m[1])),
      ...[...consulta.matchAll(/width\s*<=\s*(\d+)px/g)].map((m) => Number(m[1])),
    ],
    pisos: [
      ...[...consulta.matchAll(/min-width:\s*(\d+)px/g)].map((m) => Number(m[1])),
      ...[...consulta.matchAll(/width\s*>=\s*(\d+)px/g)].map((m) => Number(m[1])),
    ],
  };
}

export function defectosDeEscala(hojas: Hoja[]): string[] {
  const defectos: string[] = [];
  for (const { hoja, css } of hojas) {
    const permitidos = new Set([...ESCALA, ...(EXCEPCIONES.get(hoja) ?? [])]);
    const pisosPermitidos = new Set(ESCALA.map((paso) => paso + 1));
    for (const consulta of consultasDeVentana(css)) {
      const { topes, pisos } = anchosDeclarados(consulta);
      for (const tope of topes) {
        if (!permitidos.has(tope)) {
          defectos.push(
            `${hoja} declara un corte de ${String(tope)}px: fuera de la escala `
            + `(${ESCALA.join(', ')}) y sin medición que lo pague`,
          );
        }
      }
      for (const piso of pisos) {
        if (!pisosPermitidos.has(piso)) {
          defectos.push(
            `${hoja} declara un piso de ${String(piso)}px: el complemento de la escala es `
            + `${[...pisosPermitidos].join(', ')}`,
          );
        }
      }
    }
  }
  return defectos;
}

describe('la escala de cortes de pantalla', () => {
  it('la hoja del armazón declara LOS MISMOS dos anchos que el shell consulta desde JavaScript', () => {
    const responsive = readFileSync(join(RAIZ_CSS, 'styles/responsive.css'), 'utf8');
    const consultas = consultasDeVentana(responsive);
    expect(consultas).toContain(RAIL_VIEWPORT);
    expect(consultas).toContain(BOTTOM_BAR_VIEWPORT);
  });

  it('los dos anchos del shell son los dos pasos de la escala', () => {
    for (const consulta of [RAIL_VIEWPORT, BOTTOM_BAR_VIEWPORT]) {
      const { topes } = anchosDeclarados(consulta);
      expect(topes).toHaveLength(1);
      expect(ESCALA).toContain(topes[0]);
    }
  });

  it('ninguna hoja de la consola declara un ancho fuera de la escala', () => {
    expect(defectosDeEscala(hojasDeLaConsola())).toEqual([]);
  });

  it('CONTROL NEGATIVO — una hoja con el corte de 1343px que había en /terminal sale marcada', () => {
    const inventado: Hoja[] = [{
      hoja: 'features/terminal/terminal-panel.css',
      css: '@media (max-width: 1343px) { .ultimate-terminal-shell { grid-template-columns: 1fr; } }'
        + '@media (max-width: 640px) { .x { color: red; } }',
    }];
    expect(defectosDeEscala(inventado)).toContainEqual(expect.stringContaining('1343px'));
    expect(defectosDeEscala(inventado)).toContainEqual(expect.stringContaining('640px'));
  });

  it('CONTROL NEGATIVO — la excepción medida NO tapa la misma anchura en otra hoja', () => {
    const conExcepcion: Hoja[] = [{ hoja: 'features/live/live-drawer.css', css: '@media (max-width: 1479px) { .x { color: red; } }' }];
    const sinExcepcion: Hoja[] = [{ hoja: 'features/live/live-fleet.css', css: '@media (max-width: 1479px) { .x { color: red; } }' }];
    expect(defectosDeEscala(conExcepcion)).toEqual([]);
    expect(defectosDeEscala(sinExcepcion)).toContainEqual(expect.stringContaining('1479px'));
  });

  it('la escala está escrita en `base.css`, que es de donde sale este contrato', () => {
    const base = leerCss('styles/base.css');
    for (const paso of ESCALA) expect(base).toContain(`max-width: ${String(paso)}px`);
  });
});
