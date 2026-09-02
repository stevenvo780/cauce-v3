import { describe, expect, it } from 'vitest';
import { NAV_ENTRIES } from './nav';
import { leerCss } from './test/leer-css';
import {
  bloqueMedia,
  declaraciones,
  valor,
} from './test/css-parser';

/**
 * **THE PRIMARY NAVIGATION, UNREADABLE ON THE PHONE.**
 *
 * `/live`. The eight labels of the bottom bar OVERLAPPED each other and read like corrupted text:
 *
 *     "Portada  La flota ahoCuentas y cuotaMensajesQueues &SDBlQles y a"
 *
 * Only "Portada" stayed readable. Five pairs of adjacent labels overlapped, measured with
 * `getBoundingClientRect`: "Señales y auditoría"↔"Ajustes y altas" 42.2 px ·
 * "Ajustes y altas"↔"Ultimate Terminal" 38.4 px · "Queues & DLQ"↔"Señales y auditoría"
 * 25.0 px · "La flota ahora"↔"Cuentas y cuotas" 18.5 px · "Cuentas y cuotas"↔"Mensajes" 6.9 px.
 * Each `<a>` measured 54 px of box with 62-81 px of text inside, and the `<ul>` summed 493 px in
 * a 344-px bar. The production CSS was `.sidebar nav ul{display:flex;overflow-x:auto;gap:4px}`
 * with the label in `nowrap`.
 *
 * **What this file does NOT test, and has to be said:** that in a real browser the labels do
 * not touch. That is measured with Chrome at 360 px, not here — vitest runs on jsdom, which
 * does not do layout, so none of this console's 650 tests looks at a single rule and an
 * overlapping menu passes green by unanimity. What it does test is the cause, on the stylesheet:
 * the scrolling strip and the label that cannot break. Every assertion carries its own
 * NEGATIVE MUTATION CONTROL.
 *
 * The four-column grid comes from `consola/fix-legibilidad-20260823`, where it was measured in
 * Chrome with the harness from `ops/console-legibilidad/`. It is replicated here identically — on
 * purpose: two branches fixing the same thing with the same text merge without conflict — and the
 * guard that was missing in this branch is added here.
 */

const GLOBAL = leerCss('styles.css');

/** The breakpoint at which the console switches to a fixed bottom navigation bar. */
const CORTE_ESTRECHO = 760;

/**
 * The complete mobile menu diagnosis. Returns the LIST OF DEFECTS, not a boolean, so the
 * negative control can require the specific defect rather than "something failed".
 */
export function defectosDelMenuMovil(global: string): string[] {
  const defectos: string[] = [];
  const estrecho = bloqueMedia(global, `@media (max-width: ${String(CORTE_ESTRECHO)}px)`);
  if (!estrecho) return [`no hay bloque @media (max-width: ${String(CORTE_ESTRECHO)}px) en styles.css`];

  const lista = declaraciones(estrecho, '.sidebar nav ul');
  if (valor(lista, 'display') !== 'grid') {
    defectos.push(
      `el menú de móvil es ${valor(lista, 'display') ?? 'una caja sin display propio'} y no una reja: `
      + 'una tira que se arrastra esconde entradas sin decirlo',
    );
  }

  const columnas = valor(lista, 'grid-template-columns');
  const repeticion = columnas ? /repeat\(\s*(\d+)\s*,/.exec(columnas) : null;
  const cuantas = repeticion ? Number(repeticion[1]) : 0;
  // With the eight entries in `NAV_ENTRIES` and two rows, four columns or more are needed.
  if (cuantas < Math.ceil(NAV_ENTRIES.length / 2)) {
    defectos.push(
      `el menú de móvil declara ${String(cuantas)} columnas y hay ${String(NAV_ENTRIES.length)} entradas: `
      + 'no caben en dos filas sin pisarse',
    );
  }

  const rotulo = declaraciones(estrecho, '.sidebar nav a span');
  if (valor(rotulo, 'white-space') !== 'normal') {
    defectos.push(
      `el rótulo del menú lleva white-space ${valor(rotulo, 'white-space') ?? 'heredado'}: sin permiso `
      + 'para partirse en dos renglones se sale de su enlace y se pisa con el de al lado',
    );
  }
  if (valor(rotulo, 'max-width') !== '100%') {
    defectos.push('el rótulo del menú no se limita al ancho de su enlace: puede volver a desbordarlo');
  }
  if (!valor(rotulo, 'min-height')) {
    defectos.push(
      'el rótulo no reserva sus dos renglones: la altura de la barra pasa a depender de qué palabras '
      + 'entren, y el compositor de /messages se ancla a un número que deja de ser cierto',
    );
  }

  const enlace = declaraciones(estrecho, '.sidebar nav a');
  if (valor(enlace, 'min-width') !== '0') {
    defectos.push('el enlace del menú conserva su mínimo automático de contenido: el texto vuelve a mandar sobre la caja');
  }

  return defectos;
}

describe('el menú de móvil de la consola', () => {
  it('muestra sus nueve entradas sin pisarse ni esconderse detrás de un arrastre', () => {
    expect(defectosDelMenuMovil(GLOBAL)).toEqual([]);
  });

  it('CONTROL NEGATIVO — marca la vuelta a la tira `flex` que se arrastra, que es lo que se midió', () => {
    // The DESKTOP menu grid also starts with `display: grid`: without naming the columns, the
    // mutation would land there and the mobile block would remain untouched — a negative control
    // that mutates the wrong rule would pass the defect it came to look for.
    const roto = GLOBAL.replace(
      /\.sidebar nav ul \{ display: grid; grid-template-columns:[^}]*\}/,
      '.sidebar nav ul { display: flex; overflow-x: auto; gap: 4px; }',
    );
    expect(roto).not.toBe(GLOBAL);
    expect(defectosDelMenuMovil(roto)).toContainEqual(expect.stringContaining('no una reja'));
  });

  it('CONTROL NEGATIVO — marca el rótulo con `nowrap`, que es lo que hacía que se pisaran', () => {
    const roto = GLOBAL.replace(
      /(\.sidebar nav a span \{[^}]*?)white-space: normal;/,
      '$1white-space: nowrap;',
    );
    expect(roto).not.toBe(GLOBAL);
    expect(defectosDelMenuMovil(roto)).toContainEqual(expect.stringContaining('se pisa con el de al lado'));
  });

  it('CONTROL NEGATIVO — marca al enlace recuperando su mínimo de contenido', () => {
    const roto = GLOBAL.replace(/(\.sidebar nav a \{ min-width: )0;/, '$1auto;');
    expect(roto).not.toBe(GLOBAL);
    expect(defectosDelMenuMovil(roto)).toContainEqual(expect.stringContaining('mínimo automático de contenido'));
  });

  it('la reja se dimensiona para las entradas que HAY, no para las que había cuando se escribió', () => {
    /*
     * The count is not copy-pasted by hand. `NAV_ENTRIES` went from thirteen entries to eight in
     * August; a "four columns" written from memory ages the moment someone adds the ninth, and it
     * ages silently: it does not break typecheck, nor lint, nor any DOM test.
     */
    const estrecho = bloqueMedia(GLOBAL, `@media (max-width: ${String(CORTE_ESTRECHO)}px)`);
    const columnas = valor(declaraciones(estrecho, '.sidebar nav ul'), 'grid-template-columns') ?? '';
    const cuantas = Number(/repeat\(\s*(\d+)\s*,/.exec(columnas)?.[1] ?? 0);
    expect(cuantas * 2).toBeGreaterThanOrEqual(NAV_ENTRIES.length);
  });
});
