import { describe, expect, it } from 'vitest';
import {
  CAMPOS_INERTES, MARCA_INERTE, columnasInertesDe, motivoInerte, sinConmutablesInertes,
} from './campos-inertes';
import { CAMPOS_CONMUTABLES, esCampoConmutable } from './interruptores';

/**
 * **El catálogo de campos que la pantalla enseña pero NADIE OBEDECE.**
 *
 * Lo que se audita acá no es una opinión: cada motivo tiene que citar la `ruta:línea` del lector
 * —o de su ausencia— que lo justifica. Un «esto no sirve» sin cita es exactamente la clase de
 * afirmación que este trabajo existe para no volver a hacer.
 *
 * Y la guarda que más importa es la de al revés: **un campo con interruptor NO puede estar marcado
 * como inerte**. Un interruptor dice «esto lo podés cambiar y va a pasar algo»; marcarlo inerte
 * sería la consola contradiciéndose a sí misma en la misma celda.
 */

describe('el catálogo de campos inertes', () => {
  it('marca `harness_definitions.command`, que no tiene ningún lector', () => {
    const motivo = motivoInerte('harness_definitions', 'command');
    expect(motivo).toBeDefined();
    expect(motivo).toMatch(/repository\.ts:5109/);
  });

  it('marca las tres columnas de emplazamiento de `agents` sin lector runtime', () => {
    for (const campo of ['harness_id', 'home_directory', 'state_directory']) {
      expect(motivoInerte('agents', campo), `falta el motivo de agents.${campo}`).toBeDefined();
    }
  });

  /**
   * CONTROL NEGATIVO del aserto de arriba: los campos de `agents` que SÍ tienen lector no pueden
   * estar en el catálogo. `role_brief` lo lee `selfRoleBrief()` (packages/store/src/repository.ts:1826)
   * y de ahí sale la línea «Tu rol:» del sobre; `display_name` y `enabled` los lee `listAgents`
   * (:7605) y `agentDeploymentStatus` (:1272). Marcarlos inertes borraría capacidad real de la
   * pantalla, que es el defecto opuesto y igual de caro.
   */
  it('NO marca los campos de `agents` que sí tienen lector', () => {
    expect(motivoInerte('agents', 'role_brief')).toBeUndefined();
    expect(motivoInerte('agents', 'display_name')).toBeUndefined();
    expect(motivoInerte('agents', 'enabled')).toBeUndefined();
    expect(motivoInerte('agents', 'container_name')).toBeUndefined();
    expect(motivoInerte('agents', 'runtime_user')).toBeUndefined();
  });

  /** CONTROL NEGATIVO: `capabilities` y `enabled` de un harness los lee `listAdapters` (:5109). */
  it('NO marca los campos de `harness_definitions` que sí tienen lector', () => {
    expect(motivoInerte('harness_definitions', 'capabilities')).toBeUndefined();
    expect(motivoInerte('harness_definitions', 'enabled')).toBeUndefined();
    expect(motivoInerte('harness_definitions', 'display_name')).toBeUndefined();
  });

  /** CONTROL NEGATIVO: una colección entera que no tiene nada inerte. */
  it('NO marca nada en las colecciones de permisos', () => {
    expect(motivoInerte('acl_edges', 'allow_route')).toBeUndefined();
    expect(motivoInerte('role_policies', 'allow_notify')).toBeUndefined();
    expect(motivoInerte('memberships', 'enabled')).toBeUndefined();
    expect(columnasInertesDe('acl_edges', ['allow_route', 'enabled'])).toEqual([]);
    expect(columnasInertesDe('agents', ['alias', 'harness_id'])).toEqual(['harness_id']);
  });

  /**
   * `Object.hasOwn` y no `?.`: una colección del servidor llamada `toString` heredaría un valor del
   * prototipo y la tabla pintaría una función como motivo.
   */
  it('no hereda nada del prototipo', () => {
    expect(motivoInerte('toString', 'toString')).toBeUndefined();
    expect(motivoInerte('constructor', 'constructor')).toBeUndefined();
    expect(columnasInertesDe('toString', ['toString'])).toEqual([]);
  });

  it('cada motivo cita al menos una ruta del repositorio con su línea', () => {
    const sinCita: string[] = [];
    for (const [coleccion, campos] of Object.entries(CAMPOS_INERTES)) {
      for (const [campo, motivo] of Object.entries(campos)) {
        if (!/[\w/-]+\.(ts|sql|md):\d+/.test(motivo)) sinCita.push(`${coleccion}.${campo}`);
      }
    }
    expect(sinCita, 'un motivo sin cita es una afirmación sin prueba').toEqual([]);
  });

  it('la marca visible es corta: entra en la cabecera de una columna', () => {
    expect(MARCA_INERTE.length).toBeLessThanOrEqual(12);
    expect(MARCA_INERTE.trim()).toBe(MARCA_INERTE);
  });
});

describe('la guarda: ningún campo con interruptor puede estar marcado como inerte', () => {
  it('el catálogo real la cumple', () => {
    expect(sinConmutablesInertes(CAMPOS_INERTES)).toEqual([]);
  });

  /**
   * CONTROL NEGATIVO POR MUTACIÓN. Se le da de comer un catálogo que marca inerte justo el permiso
   * que la pantalla ofrece como interruptor y se exige que lo señale. Un guardia que aprueba
   * cualquier cosa es peor que no tenerlo.
   */
  it('señala un catálogo que marca inerte un campo conmutable', () => {
    const roto = { ...CAMPOS_INERTES, acl_edges: { allow_route: 'inventado, repository.ts:1' } };
    expect(sinConmutablesInertes(roto)).toEqual(['acl_edges.allow_route']);
  });

  it('la premisa: los campos que usa el control negativo siguen siendo conmutables', () => {
    expect(esCampoConmutable('acl_edges', 'allow_route')).toBe(true);
    expect(Object.keys(CAMPOS_CONMUTABLES)).toContain('acl_edges');
  });
});

/**
 * **El aviso de la tabla se decide por las columnas QUE HAY, no por la colección.**
 *
 * MEDIDO en Chrome, mirando la pantalla: el gateway de las pruebas publica `harness_definitions`
 * con la forma del endpoint de adaptadores, que NO trae `command`. El aviso salía igual —«algunas
 * columnas van marcadas sin efecto»— encima de una tabla donde no había ni una marcada. Un cartel
 * que anuncia algo que no está es exactamente el defecto que este trabajo persigue, cometido por el
 * arreglo del defecto.
 */
describe('las columnas inertes que de verdad se están pintando', () => {
  it('devuelve sólo las que la tabla trae, en el orden en que se piden', () => {
    expect(columnasInertesDe('agents', ['tenant_id', 'alias', 'harness_id', 'container_name']))
      .toEqual(['harness_id']);
  });

  /**
   * CONTROL NEGATIVO: la colección tiene campos inertes en el catálogo, pero ESTE gateway no
   * publica ninguno de ellos. Sin este caso el aviso volvería a salir sobre una tabla limpia.
   */
  it('devuelve vacío cuando la tabla no trae ninguna de las columnas inertes', () => {
    expect(columnasInertesDe('harness_definitions', ['id', 'display_name', 'capabilities', 'enabled']))
      .toEqual([]);
    // Y con `command` presente sí la devuelve: la diferencia es la columna, no la colección.
    expect(columnasInertesDe('harness_definitions', ['id', 'command'])).toEqual(['command']);
  });
});
