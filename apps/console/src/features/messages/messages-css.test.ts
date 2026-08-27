import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { leerCss } from '../../test/leer-css';
import { sinComentarios } from '../../test/css-parser';

/**
 * Ninguna clase de esta vista puede apuntar a una regla que no existe.
 *
 * Este fichero sale de un fallo que cometí escribiendo el arreglo del fan-out: el detalle nuevo
 * reusaba `.metadata-grid`, que la MISMA rama había retirado de `styles.css` junto con la lista
 * plana de tarjetas. El resultado era un `dl` sin rejilla —los siete campos en columna, en un
 * panel pensado para cuatro por fila— y ni el typecheck, ni el lint, ni las 483 pruebas dicen una
 * palabra: un `className` es una cadena, y una cadena que no casa con ninguna regla no es un
 * error para nadie. Es la versión en CSS del defecto que esta vista existe para no repetir: algo
 * que se pierde sin dejar rastro.
 *
 * La comprobación es la barata y la que habría atrapado el fallo: toda clase que la carpeta
 * `features/messages` escribe tiene que estar definida en alguna de las dos hojas que la vista
 * carga (`styles.css`, global, y `messages.css`, propia).
 */
/**
 * Se resuelve desde `process.cwd()` (la raíz del paquete `@cauce/console`, tanto con `pnpm test`
 * como con `pnpm --filter`) y NO desde `import.meta.url`: bajo vitest esa URL es la del servidor
 * de vite (`/src/features/messages`), no una ruta del disco.
 */
const DIRECTORIO = resolve(process.cwd(), 'src/features/messages');
const HOJAS = [
  join(DIRECTORIO, 'messages.css'),
  join(DIRECTORIO, '..', '..', 'styles.css'),
  join(DIRECTORIO, '..', 'terminal', 'terminal-panel.css'),
];

/** Clases que pinta un componente COMPARTIDO (components/ui, TerminalTranscript) y no esta vista. */
const AJENAS = new Set(['sr-only', 'mono', 'eyebrow', 'button', 'small', 'secondary', 'primary', 'unknown']);

function clasesDefinidas(): Set<string> {
  const definidas = new Set<string>();
  for (const hoja of HOJAS) {
    let css: string;
    try {
      css = leerCss(hoja);
    } catch {
      continue;
    }
    // Se ignoran los bloques de comentario para que un nombre citado en una explicación —como el
    // `.metadata-grid` retirado, que se menciona justamente porque ya NO existe— no cuente.
    const limpio = sinComentarios(css);
    for (const coincidencia of limpio.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
      definidas.add(coincidencia[1]);
    }
  }
  return definidas;
}

/**
 * `className="..."` literal, o la parte FIJA de una plantilla (`className={\`messenger-avatar
 * ${...}\`}`). Se arma con `new RegExp` porque el backtick dentro de un literal de expresión
 * regular rompe al parser de rollup.
 */
const PATRON_CLASSNAME = new RegExp('className=(?:"([^"]*)"|\\{`([^`$]*))', 'g');

function clasesUsadas(): Map<string, string> {
  const usadas = new Map<string, string>();
  for (const fichero of readdirSync(DIRECTORIO)) {
    if (!fichero.endsWith('.tsx') || fichero.includes('.test.')) continue;
    const fuente = readFileSync(join(DIRECTORIO, fichero), 'utf8');
    // Sólo los `className` literales. Los compuestos por plantilla llevan su parte fija adelante
    // (`messenger-avatar ${...}`) y esa parte sí se comprueba.
    for (const coincidencia of fuente.matchAll(PATRON_CLASSNAME)) {
      for (const clase of (coincidencia[1] ?? coincidencia[2] ?? '').split(/\s+/)) {
        if (clase && !AJENAS.has(clase)) usadas.set(clase, fichero);
      }
    }
  }
  return usadas;
}

describe('las clases de la vista de mensajes', () => {
  it('están todas definidas en alguna hoja que la vista carga', () => {
    const definidas = clasesDefinidas();
    const huerfanas = [...clasesUsadas()]
      .filter(([clase]) => !definidas.has(clase))
      .map(([clase, fichero]) => `${clase} (${fichero})`);
    expect(huerfanas).toEqual([]);
  });

  /**
   * CONTROL NEGATIVO del propio guardia. Un comprobador que aprueba cualquier cosa es peor que no
   * tenerlo: acá se le da de comer la clase exacta que se retiró y se exige que la marque.
   */
  it('marcaría una clase retirada como la `metadata-grid` que rompió el detalle', () => {
    expect(clasesDefinidas().has('metadata-grid')).toBe(false);
    expect(clasesDefinidas().has('messenger-message-meta')).toBe(true);
  });
});
