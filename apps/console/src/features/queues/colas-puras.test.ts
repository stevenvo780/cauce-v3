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
   * Lo que NO puede pasar: apagar el ámbar de una entrega muerta sin motivo. Ahí el hueco importa
   * —una entrega muerta que nadie puede diagnosticar— y sigue siendo UNKNOWN.
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
   * El caso que hay que guardar: `failed` cuenta como «requiere revisión». También deja fila en
   * `dead_letters` y `replayDelivery` la acepta. Un grupo que sólo mirara `dead` volvería a
   * esconder las mismas entregas que el arreglo de `replayableStates` sacó a la luz.
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
   * Un estado que la consola no reconoce NO se mete en ningún grupo. Adivinar acá mandaría a un
   * operador a reinyectar algo cuyo estado nadie sabe leer.
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
 * ------------------------------------------------------------ LA VISTA EN EL TELÉFONO, EN LA HOJA
 *
 * Los dos defectos medidos a 360x800 son de layout y jsdom no los ve: corre sin motor de
 * disposición, así que ninguna de las pruebas de arriba mira una sola regla. Se comprueban sobre
 * el texto de la hoja —lo barato que sí los atrapa— y cada afirmación lleva su control negativo
 * por mutación.
 *
 * Lo que esto NO prueba, y hay que decirlo: que en un navegador real las tres tarjetas queden
 * sobre el pliegue. Eso se mide con un Chrome a 360 px, no acá.
 */
const QUEUES_CSS = readFileSync(resolve(process.cwd(), 'src/features/queues/queues.css'), 'utf8');

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

export function defectosDeColasEnElTelefono(css: string): string[] {
  const defectos: string[] = [];
  const estrecho = bloqueEstrecho(css);
  if (!estrecho) return ['queues.css no tiene bloque @media (max-width: 760px): la vista sale como a 1280'];

  /*
   * `styles.css` apila `.metrics-grid.three` a UNA columna en este corte y le da 115 px de alto a
   * cada `.metric`. Tres tarjetas apiladas son 345 px y, con la cabecera encima, «DEAD LETTERS 7»
   * —que es a lo que un operador entra— quedaba bajo el pliegue. Medido.
   */
  /*
   * El selector tiene que GANARLE a `.metrics-grid.three`, que en este mismo corte declara UNA
   * columna en `styles.css`. Con una clase no se aplicaba; con dos empataba en especificidad y
   * ganaba styles.css por orden de carga. Las dos veces la hoja «decía» tres columnas y Chrome
   * pintaba una. Por eso se exige el selector de TRES clases y no sólo la propiedad.
   */
  if (!/\.metrics-grid\.three\.metricas-de-cola\s*\{[^}]*grid-template-columns:\s*repeat\(3/.test(estrecho)) {
    defectos.push('las tres tarjetas se apilan en el teléfono: la tercera («Dead letters») queda bajo el pliegue');
  }
  if (!/\.metricas-de-cola \.metric\s*\{[^}]*min-height:\s*0/.test(estrecho)) {
    defectos.push('las tarjetas conservan los 115 px de alto de styles.css: en fila de tres no caben');
  }

  /*
   * La tabla tiene OCHO columnas y `.table-wrap` sólo la deja arrastrable en horizontal: a 360 px
   * se veían Delivery y Destino, y «Estado» —el dato por el que se entra a esta vista— había que
   * ir a buscarlo fuera de pantalla.
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
   * CONTROL NEGATIVO con el fallo REAL que cometí dos veces: la regla escrita con menos clases de
   * las que hacen falta para ganarle a `.metrics-grid.three` de styles.css. La hoja «decía» tres
   * columnas y el navegador pintaba una. Un comprobador que sólo buscara la propiedad —o que se
   * conformara con dos clases— habría aprobado eso.
   */
  it('CONTROL NEGATIVO — marca las tarjetas apiladas, que es el defecto medido', () => {
    const roto = QUEUES_CSS.replace(
      '.metrics-grid.three.metricas-de-cola { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }',
      '.metrics-grid.metricas-de-cola { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }',
    );
    expect(roto).not.toBe(QUEUES_CSS);
    expect(defectosDeColasEnElTelefono(roto)).toContainEqual(expect.stringContaining('bajo el pliegue'));
  });

  it('CONTROL NEGATIVO — marca la tabla sin apilar, con «Estado» fuera de pantalla', () => {
    const roto = QUEUES_CSS
      .replace('.tabla-entregas, .tabla-entregas tbody, .tabla-entregas tr, .tabla-entregas td { display: block; width: 100%; }', '')
      .replace(/\.tabla-entregas td \{ display: grid;[^}]*\}/, '.tabla-entregas td { padding: 7px 12px; }');
    expect(roto).not.toBe(QUEUES_CSS);
    expect(defectosDeColasEnElTelefono(roto)).toContainEqual(expect.stringContaining('fuera de pantalla'));
  });

  /**
   * COMPROBACIÓN CRUZADA. El rótulo de cada celda apilada sale del `data-label` que escribe
   * `DeliveryTable`. Son dos ficheros y nada los ata: quitar los atributos deja la hoja intacta y
   * el síntoma —ocho valores sueltos sin nombre, sólo en el teléfono— no lo ve ninguna prueba de
   * DOM ni el typecheck.
   */
  it('la hoja lee los mismos `data-label` que la tabla escribe', () => {
    const tabla = readFileSync(resolve(process.cwd(), 'src/features/queues/DeliveryTable.tsx'), 'utf8');
    for (const rotulo of ['Delivery', 'Destino', 'Lane', 'Estado', 'Intentos', 'Disponible', 'Último error', 'Acción']) {
      expect(tabla, `falta data-label="${rotulo}" en DeliveryTable`).toContain(`data-label="${rotulo}"`);
    }
    expect(QUEUES_CSS).toContain('content: attr(data-label)');
  });
});
