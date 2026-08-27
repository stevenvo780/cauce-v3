import { describe, expect, it } from 'vitest';
import { NAV_ENTRIES } from './nav';
import { leerCss } from './test/leer-css';
import {
  bloqueMedia,
  declaraciones,
  valor,
} from './test/css-parser';

/**
 * **LA NAVEGACIÓN PRIMARIA, ILEGIBLE EN EL TELÉFONO.**
 *
 * 
 * `/live`. Los ocho rótulos de la barra inferior se PISABAN unos con otros y se leían como texto
 * corrupto:
 *
 *     «Portada  La flota ahoCuentas y cuotaMensajesQueues &SDBlQles y a»
 *
 * Sólo «Portada» quedaba legible. Cinco pares de rótulos adyacentes se solapaban, medido con
 * `getBoundingClientRect`: «Señales y auditoría»↔«Ajustes y altas» 42,2 px ·
 * «Ajustes y altas»↔«Ultimate Terminal» 38,4 px · «Queues & DLQ»↔«Señales y auditoría»
 * 25,0 px · «La flota ahora»↔«Cuentas y cuotas» 18,5 px · «Cuentas y cuotas»↔«Mensajes» 6,9 px.
 * Cada `<a>` medía 54 px de caja con 62–81 px de texto dentro, y el `<ul>` sumaba 493 px en una
 * barra de 344. El CSS servido en producción era
 * `.sidebar nav ul{display:flex;overflow-x:auto;gap:4px}` con el rótulo en `nowrap`.
 *
 * **Lo que este fichero NO prueba, y hay que decirlo:** que en un navegador real los rótulos no
 * se toquen. Eso se mide con Chrome a 360 px, no acá — vitest corre en jsdom, que no hace layout,
 * así que ninguna de las 650 pruebas de esta consola mira una sola regla y un menú que se pisa
 * pasa verde por unanimidad. Lo que sí prueba es la causa, sobre la hoja: la tira que se arrastra
 * y el rótulo que no puede partirse. Cada afirmación lleva su CONTROL NEGATIVO POR MUTACIÓN.
 *
 * La reja de cuatro columnas viene de `consola/fix-legibilidad-20260823`, donde se midió en
 * Chrome con el arnés de `ops/console-legibilidad/`. Acá se replica idéntica —a propósito: dos
 * ramas que arreglan lo mismo con el mismo texto se funden sin conflicto— y se le pone el guardia
 * que faltaba en esta rama.
 */

const GLOBAL = leerCss('styles.css');

/** El corte en el que la consola pasa a barra de navegación inferior fija. */
const CORTE_ESTRECHO = 760;

/**
 * El diagnóstico completo del menú de móvil. Devuelve la LISTA DE DEFECTOS y no un booleano, para
 * que el control negativo pueda exigir el defecto concreto y no «algo falló».
 */
export function defectosDelMenuMovil(global: string): string[] {
  const defectos: string[] = [];
  const estrecho = bloqueMedia(global, `@media (max-width: ${CORTE_ESTRECHO}px)`);
  if (!estrecho) return [`no hay bloque @media (max-width: ${CORTE_ESTRECHO}px) en styles.css`];

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
  // Con las ocho entradas de `NAV_ENTRIES` y dos filas, hacen falta cuatro columnas o más.
  if (cuantas < Math.ceil(NAV_ENTRIES.length / 2)) {
    defectos.push(
      `el menú de móvil declara ${cuantas} columnas y hay ${NAV_ENTRIES.length} entradas: `
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
  it('muestra las ocho entradas sin pisarse ni esconderse detrás de un arrastre', () => {
    expect(defectosDelMenuMovil(GLOBAL)).toEqual([]);
  });

  it('CONTROL NEGATIVO — marca la vuelta a la tira `flex` que se arrastra, que es lo que se midió', () => {
    // La reja del menú de ESCRITORIO también empieza por `display: grid`: sin citar las columnas,
    // la mutación caería sobre ella y el bloque de móvil quedaría intacto — un control negativo
    // que muta la regla equivocada aprueba el defecto que venía a buscar.
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
     * El recuento no se copia a mano. `NAV_ENTRIES` pasó de trece entradas a ocho en agosto; un
     * «cuatro columnas» escrito de memoria envejece en cuanto alguien agregue la novena, y
     * envejece en silencio: no rompe el typecheck, ni el lint, ni ninguna prueba de DOM.
     */
    const estrecho = bloqueMedia(GLOBAL, `@media (max-width: ${CORTE_ESTRECHO}px)`);
    const columnas = valor(declaraciones(estrecho, '.sidebar nav ul'), 'grid-template-columns') ?? '';
    const cuantas = Number(/repeat\(\s*(\d+)\s*,/.exec(columnas)?.[1] ?? 0);
    expect(cuantas * 2).toBeGreaterThanOrEqual(NAV_ENTRIES.length);
  });
});
