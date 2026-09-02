import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { QueueItem } from '../../api/types';
import { contarPorGrupo, ESTADOS_DEL_GRUPO, filtrarEntregas } from './filtro-de-colas';
import { leerUltimoError } from './ultimo-error';

function entrega(parcial: Partial<QueueItem>): QueueItem {
  return { delivery_id: 'd-1', message_id: 'm-1', tenant_id: 'Steven', recipient_alias: 'zeus', lane: 'interactive', state: 'done', attempts: 1, max_attempts: 5, ...parcial };
}

describe('qué se lee en «Último error»', () => {
  it('el motivo, cuando el servidor lo dice', () => {
    expect(leerUltimoError('dead', 'max attempts exhausted')).toEqual({ clase: 'texto', texto: 'max attempts exhausted' });
  });

  it('«sin error» en los estados donde no haberlo es la respuesta', () => {
    for (const estado of ['done', 'pending', 'leased', 'accepted', 'started'] as const) {
      expect(leerUltimoError(estado, null)).toEqual({ clase: 'sin-error' });
    }
  });

  /**
   * What MUST NOT happen: turning the amber off for a dead delivery without a reason. There
   * the gap matters — a dead delivery nobody can diagnose — and it remains UNKNOWN.
   */
  it('UNKNOWN en los estados de error, que es donde el hueco duele', () => {
    for (const estado of ['dead', 'failed', 'retry'] as const) {
      expect(leerUltimoError(estado, null)).toEqual({ clase: 'desconocido' });
    }
  });

  it('sin estado NO se afirma «sin error»: sería inventar la mitad tranquilizadora', () => {
    expect(leerUltimoError(undefined, null)).toEqual({ clase: 'desconocido' });
  });

  it('una cadena vacía o de espacios no es un motivo', () => {
    expect(leerUltimoError('dead', '   ')).toEqual({ clase: 'desconocido' });
    expect(leerUltimoError('done', '')).toEqual({ clase: 'sin-error' });
  });
});

describe('el filtro de la tabla', () => {
  const filas = [
    entrega({ delivery_id: 'a', state: 'done' }),
    entrega({ delivery_id: 'b', state: 'dead', recipient_alias: 'kant', last_error: 'adapter timeout' }),
    entrega({ delivery_id: 'c', state: 'failed' }),
    entrega({ delivery_id: 'd', state: 'retry' }),
    entrega({ delivery_id: 'e', state: 'pending' }),
    entrega({ delivery_id: 'f', state: 'leased' }),
  ];

  /**
   * The case that has to be guarded: `failed` counts as "needs review". It also leaves a row
   * in `dead_letters` and `replayDelivery` accepts it. A group that only looked at `dead` would
   * again hide the same deliveries the `replayableStates` fix brought to light.
   */
  it('«revisión» incluye dead Y failed', () => {
    expect(ESTADOS_DEL_GRUPO.revision.has('failed')).toBe(true);
    expect(filtrarEntregas(filas, { grupo: 'revision', texto: '' }).map((fila) => fila.delivery_id)).toEqual(['b', 'c']);
  });

  it('«pendientes» son las que siguen vivas, incluida la que ya tomó un adaptador', () => {
    expect(filtrarEntregas(filas, { grupo: 'pendientes', texto: '' }).map((fila) => fila.delivery_id)).toEqual(['e', 'f']);
  });

  it('busca por alias, por id y por el texto del error', () => {
    expect(filtrarEntregas(filas, { grupo: 'todas', texto: 'kant' })).toHaveLength(1);
    expect(filtrarEntregas(filas, { grupo: 'todas', texto: 'TIMEOUT' })).toHaveLength(1);
    expect(filtrarEntregas(filas, { grupo: 'todas', texto: '  ' })).toHaveLength(filas.length);
  });

  /**
   * A state the console does not recognize does NOT enter any group. Guessing here would send
   * an operator to replay something whose state nobody can read.
   */
  it('un estado desconocido no entra en ningún grupo, pero sigue estando en «todas»', () => {
    const raras = [...filas, entrega({ delivery_id: 'z', state: 'inventado' as never })];
    expect(filtrarEntregas(raras, { grupo: 'todas', texto: '' })).toHaveLength(7);
    for (const grupo of ['revision', 'retry', 'pendientes'] as const) {
      expect(filtrarEntregas(raras, { grupo, texto: '' }).some((fila) => fila.delivery_id === 'z')).toBe(false);
    }
  });

  it('cuenta cada grupo sobre las filas que la tabla puede mostrar', () => {
    expect(contarPorGrupo(filas)).toEqual({ todas: 6, revision: 2, retry: 1, pendientes: 2 });
  });
});

/**
 * The two bugs measured at 360x800 are layout and jsdom does not see them: it runs without a
 * layout engine, so none of the tests above looks at a single CSS rule. They are checked on
 * the sheet text — the cheap thing that does catch them — and each assertion carries its
 * negative control by mutation.
 *
 * What this does NOT prove, and it must be said: that in a real browser the three cards
 * stay above the fold. That is measured with a Chrome at 360 px, not here.
 */
const QUEUES_CSS = readFileSync(resolve(process.cwd(), 'src/features/queues/queues.css'), 'utf8');
const GLOBAL_CSS = readFileSync(resolve(process.cwd(), 'src/styles/components.css'), 'utf8');

/** Un `min-height` en `.metric` —venga de donde venga— es lo que apilaba las tres tarjetas. */
function altoFijoDeLaTarjeta(css: string): boolean {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some((regla) => {
    const alto = /min-height:\s*([^;\s]+)/.exec(regla[2])?.[1];
    return /\.metric\b/.test(regla[1]) && alto !== undefined && !/^0[a-z]*$/.test(alto);
  });
}

function bloqueEstrecho(css: string): string {
  const limpio = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const inicio = limpio.indexOf('@media (max-width: 760px)');
  if (inicio < 0) return '';
  let profundidad = 0;
  let cursor = limpio.indexOf('{', inicio);
  const desde = cursor + 1;
  for (; cursor < limpio.length; cursor += 1) {
    if (limpio[cursor] === '{') profundidad += 1;
    else if (limpio[cursor] === '}') {
      profundidad -= 1;
      if (profundidad === 0) return limpio.slice(desde, cursor);
    }
  }
  return '';
}

export function defectosDeColasEnElTelefono(css: string, global = GLOBAL_CSS): string[] {
  const defectos: string[] = [];
  const estrecho = bloqueEstrecho(css);
  if (!estrecho) return ['queues.css no tiene bloque @media (max-width: 760px): la vista sale como a 1280'];

  /* `styles.css` stacks `.metrics-grid.three` to ONE column at this breakpoint, and three stacked
     cards, with the header on top, put "DEAD LETTERS 7" —what an operator enters for— below the
     fold. Measured. */
  /*
   * The selector has to WIN against `.metrics-grid.three`, which at this same breakpoint
   * declares ONE column in `styles.css`. With one class it did not apply; with two it tied on
   * specificity and styles.css won by load order. Both times the sheet "said" three columns and
   * Chrome painted one. That is why we require the THREE-class selector and not just the
   * property.
   */
  if (!/\.metrics-grid\.three\.metricas-de-cola\s*\{[^}]*grid-template-columns:\s*repeat\(3/.test(estrecho)) {
    defectos.push('las tres tarjetas se apilan en el teléfono: la tercera («Dead letters») queda bajo el pliegue');
  }
  /* The 115 px that stacked them are gone from `components.css`: a `.metric` is its padding and
     the subgrid rows. What is still required is that NOBODY puts a height back without this view
     cancelling it — with three in a row, a fixed height is what pushes the third off screen. */
  if (altoFijoDeLaTarjeta(global) && !/\.metricas-de-cola \.metric\s*\{[^}]*min-height:\s*0/.test(estrecho)) {
    defectos.push('alguien le repuso alto fijo a `.metric`: en fila de tres no caben');
  }

  /*
   * The table has EIGHT columns and `.table-wrap` only makes it horizontally scrollable: at 360
   * px Delivery and Destination were visible, and "Estado" — the data you enter this view for
   * — had to be sought off-screen.
   */
  if (!/\.tabla-entregas td\s*\{[^}]*display:\s*(block|grid)/.test(estrecho)) {
    defectos.push('la tabla sigue siendo una tabla de 8 columnas en el teléfono: la columna «Estado» queda fuera de pantalla');
  }
  if (!/\.tabla-entregas td::before\s*\{[^}]*content:\s*attr\(data-label\)/.test(estrecho)) {
    defectos.push('las celdas apiladas no llevan su rótulo: sin la cabecera, ocho valores sueltos no se pueden leer');
  }
  return defectos;
}

describe('/queues en el teléfono', () => {
  it('las tres tarjetas caben en una fila y la tabla se apila con sus rótulos', () => {
    expect(defectosDeColasEnElTelefono(QUEUES_CSS)).toEqual([]);
  });

  /**
   * Control negativo: comprueba la especificidad CSS necesaria frente a `.metrics-grid.three`.
   */
  it('CONTROL NEGATIVO — marca las tarjetas apiladas, que es el defecto medido', () => {
    const roto = QUEUES_CSS.replace(
      '.metrics-grid.three.metricas-de-cola { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-2); }',
      '.metrics-grid.metricas-de-cola { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-2); }',
    );
    expect(roto).not.toBe(QUEUES_CSS);
    expect(defectosDeColasEnElTelefono(roto)).toContainEqual(expect.stringContaining('bajo el pliegue'));
  });

  it('CONTROL NEGATIVO — marca que le repongan alto fijo a la tarjeta', () => {
    expect(defectosDeColasEnElTelefono(QUEUES_CSS, '.metric { min-height: 115px; }'))
      .toContainEqual(expect.stringContaining('alto fijo'));
    expect(defectosDeColasEnElTelefono(QUEUES_CSS, '.metric { min-height: 0; }')).toEqual([]);
  });

  it('CONTROL NEGATIVO — marca la tabla sin apilar, con «Estado» fuera de pantalla', () => {
    const roto = QUEUES_CSS
      .replace('.tabla-entregas, .tabla-entregas tbody, .tabla-entregas tr, .tabla-entregas td { display: block; width: 100%; }', '')
      .replace(/\.tabla-entregas td \{ display: grid;[^}]*\}/, '.tabla-entregas td { padding: 7px 12px; }');
    expect(roto).not.toBe(QUEUES_CSS);
    expect(defectosDeColasEnElTelefono(roto)).toContainEqual(expect.stringContaining('fuera de pantalla'));
  });

  /**
   * CROSS-CHECK. The label of each stacked cell comes from the `data-label` written by
   * `DeliveryTable`. They are two files and nothing binds them: removing the attributes leaves
   * the sheet intact and the symptom — eight loose values without a name, only on the phone —
   * is seen by no DOM test nor by the typecheck.
   */
  it('la hoja lee los mismos `data-label` que la tabla escribe', () => {
    const tabla = readFileSync(resolve(process.cwd(), 'src/features/queues/DeliveryTable.tsx'), 'utf8');
    for (const rotulo of ['Delivery', 'Destino', 'Carril', 'Estado', 'Intentos', 'Disponible', 'Último error', 'Acción']) {
      expect(tabla, `falta data-label="${rotulo}" en DeliveryTable`).toContain(`data-label="${rotulo}"`);
    }
    expect(QUEUES_CSS).toContain('content: attr(data-label)');
  });
});
