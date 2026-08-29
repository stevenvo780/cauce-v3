import { describe, expect, it } from 'vitest';
import {
  CAMPOS_INERTES, MARCA_INERTE, columnasInertesDe, motivoInerte,
} from './campos-inertes';
import { CAMPOS_CONMUTABLES, esCampoConmutable } from './interruptores';

/**
 * **The catalog of fields the screen shows but NOBODY OBEYS.**
 *
 * What is audited here isn't an opinion: every reason must cite the `path:line` of the reader
 * —or its absence— that justifies it. A "this is useless" without a citation is exactly the kind
 * of claim this work exists to not make again.
 *
 * And the most important guard is the reverse one: **a field with a switch CANNOT be marked
 * as inert**. A switch says "you can change this and something will happen"; marking it inert
 * would be the console contradicting itself in the same cell.
 */

describe('el catálogo de campos inertes', () => {
  it('marca `harness_definitions.command`, que no tiene ningún lector', () => {
    const motivo = motivoInerte('harness_definitions', 'command');
    expect(motivo).toBeDefined();
    expect(motivo).toMatch(/listAdapters/);
  });

  it('marca las tres columnas de emplazamiento de `agents` sin lector runtime', () => {
    const esperados: Record<string, RegExp> = {
      harness_id: /harnessFromCommand/,
      home_directory: /RuntimeFacts/,
      state_directory: /CAUCE_STATE_DIR/,
    };
    for (const [campo, patron] of Object.entries(esperados)) {
      const motivo = motivoInerte('agents', campo);
      expect(motivo, `falta el motivo de agents.${campo}`).toBeDefined();
      expect(motivo).toMatch(patron);
    }
  });

  /**
   * NEGATIVE CONTROL of the assertion above: the fields in `agents` that DO have a reader cannot
   * be in the catalog. `role_brief` is read by `selfRoleFromProfile()` (packages/store/src/repository/agents.ts:215),
   * and `display_name` and `enabled` are read by `listAgents` (packages/store/src/repository/agents.ts:321)
   * and `agentDeploymentStatus` (packages/store/src/repository/observability/helpers.ts:7). Marking
   * them inert would erase real capability from the screen, which is the opposite, equally costly defect.
   */
  it('NO marca los campos de `agents` que sí tienen lector', () => {
    expect(motivoInerte('agents', 'role_brief')).toBeUndefined();
    expect(motivoInerte('agents', 'display_name')).toBeUndefined();
    expect(motivoInerte('agents', 'enabled')).toBeUndefined();
    expect(motivoInerte('agents', 'container_name')).toBeUndefined();
    expect(motivoInerte('agents', 'runtime_user')).toBeUndefined();
  });

  /** NEGATIVE CONTROL: a harness's `capabilities` and `enabled` are read by `listAdapters` (packages/store/src/repository/agents.ts:278). */
  it('NO marca los campos de `harness_definitions` que sí tienen lector', () => {
    expect(motivoInerte('harness_definitions', 'capabilities')).toBeUndefined();
    expect(motivoInerte('harness_definitions', 'enabled')).toBeUndefined();
    expect(motivoInerte('harness_definitions', 'display_name')).toBeUndefined();
  });

  /** NEGATIVE CONTROL: an entire collection that has nothing inert. */
  it('NO marca nada en las colecciones de permisos', () => {
    expect(motivoInerte('acl_edges', 'allow_route')).toBeUndefined();
    expect(motivoInerte('role_policies', 'allow_notify')).toBeUndefined();
    expect(motivoInerte('memberships', 'enabled')).toBeUndefined();
    expect(columnasInertesDe('acl_edges', ['allow_route', 'enabled'])).toEqual([]);
    expect(columnasInertesDe('agents', ['alias', 'harness_id'])).toEqual(['harness_id']);
  });

  /**
   * `Object.hasOwn`, not `?.`: a server collection named `toString` would inherit a value from
   * the prototype and the table would render a function as the reason.
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
    const choques: string[] = [];
    for (const [coleccion, campos] of Object.entries(CAMPOS_INERTES)) {
      for (const campo of Object.keys(campos)) {
        if (esCampoConmutable(coleccion, campo)) choques.push(`${coleccion}.${campo}`);
      }
    }
    expect(choques).toEqual([]);
  });

  it('la premisa: los campos que usa el control negativo siguen siendo conmutables', () => {
    expect(esCampoConmutable('acl_edges', 'allow_route')).toBe(true);
    expect(Object.keys(CAMPOS_CONMUTABLES)).toContain('acl_edges');
  });
});

/**
 * **The table's notice is decided by the columns IT HAS, not by the collection.**
 */
describe('las columnas inertes que de verdad se están pintando', () => {
  it('devuelve sólo las que la tabla trae, en el orden en que se piden', () => {
    expect(columnasInertesDe('agents', ['tenant_id', 'alias', 'harness_id', 'container_name']))
      .toEqual(['harness_id']);
  });

  /**
   * NEGATIVE CONTROL: the collection has inert fields in the catalog, but THIS gateway does not
   * publish any of them. Without this case the notice would show again over a clean table.
   */
  it('devuelve vacío cuando la tabla no trae ninguna de las columnas inertes', () => {
    expect(columnasInertesDe('harness_definitions', ['id', 'display_name', 'capabilities', 'enabled']))
      .toEqual([]);
    // And with `command` present it does return it: the difference is the column, not the collection.
    expect(columnasInertesDe('harness_definitions', ['id', 'command'])).toEqual(['command']);
  });
});
