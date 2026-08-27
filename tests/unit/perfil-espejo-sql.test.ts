import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AGENT_PROFILE_LIMITS, AGENT_PROFILE_LIST_FIELDS, AGENT_PROFILE_TEXT_FIELDS
} from '@cauce/protocol';

/**
 * Validación estática de sincronización entre límites de `AGENT_PROFILE_LIMITS`
 * en `@cauce/protocol` y las restricciones CHECK en la migración `026_agent_profile.sql`.
 */

const migracion = readFileSync(
  fileURLToPath(new URL('../../packages/store/migrations/026_agent_profile.sql', import.meta.url)),
  'utf8'
);

/** El cuerpo del CHECK del presupuesto total, que es donde se suman todos los campos. */
function presupuesto(): string {
  const desde = migracion.indexOf('CONSTRAINT agent_profiles_budget');
  expect(desde, 'la migración 026 no declara el CHECK del presupuesto total').toBeGreaterThan(-1);
  return migracion.slice(desde, migracion.indexOf('\n);', desde));
}

describe('los topes del perfil están espejados en la migración 026', () => {
  it('cada TEXTO del contrato tiene su CHECK por campo, con SU número', () => {
    for (const campo of AGENT_PROFILE_TEXT_FIELDS) {
      const tope = AGENT_PROFILE_LIMITS[campo];
      const constraint = new RegExp(
        `CONSTRAINT agent_profiles_${campo}_len CHECK \\(\\s*${campo} IS NULL OR ` +
        `cauce_utf16_units\\(${campo}\\) BETWEEN 1 AND ${tope}\\b`
      );
      expect(
        migracion,
        `026 no declara el CHECK de ${campo} con el tope ${tope} que dice AGENT_PROFILE_LIMITS`
      ).toMatch(constraint);
    }
  });

  it('cada LISTA del contrato tiene su tope de cardinalidad y el de elemento', () => {
    for (const campo of AGENT_PROFILE_LIST_FIELDS) {
      expect(migracion, `026 no limita cuántos elementos admite ${campo}`).toMatch(
        new RegExp(`agent_profiles_${campo}_count CHECK \\(coalesce\\(array_length\\(${campo},1\\),0\\) <= ${AGENT_PROFILE_LIMITS.items}\\b`)
      );
      expect(migracion, `026 no limita el tamaño de un elemento de ${campo}`).toMatch(
        new RegExp(`agent_profiles_${campo}_items CHECK \\(cauce_text_items_ok\\(${campo}, ${AGENT_PROFILE_LIMITS.item}\\)`)
      );
    }
  });

  it('TODOS los campos entran en el presupuesto total, y ninguno se queda fuera', () => {
    // Éste es el que atrapa el olvido caro: añadir un campo, ponerle su CHECK, y no sumarlo al
    // presupuesto. Con un campo fuera, seis campos «dentro de su tope» dan un fichero que no entra.
    const cuerpo = presupuesto();
    for (const campo of AGENT_PROFILE_TEXT_FIELDS) {
      expect(cuerpo, `${campo} no se suma al presupuesto total de 026`)
        .toContain(`cauce_utf16_units(coalesce(${campo},''))`);
    }
    for (const campo of AGENT_PROFILE_LIST_FIELDS) {
      expect(cuerpo, `${campo} no se suma al presupuesto total de 026`)
        .toContain(`cauce_utf16_units(array_to_string(${campo},''))`);
    }
    expect(cuerpo, 'el techo del presupuesto no es el de AGENT_PROFILE_LIMITS.total')
      .toContain(`<= ${AGENT_PROFILE_LIMITS.total}`);
  });

  it('la tabla declara una COLUMNA por cada campo del contrato', () => {
    const desde = migracion.indexOf('CREATE TABLE IF NOT EXISTS agent_profiles');
    const cuerpo = migracion.slice(desde, migracion.indexOf('PRIMARY KEY', desde));
    for (const campo of AGENT_PROFILE_TEXT_FIELDS) {
      expect(cuerpo, `agent_profiles no tiene la columna ${campo}`).toMatch(
        new RegExp(`^\\s*${campo} text,`, 'm')
      );
    }
    for (const campo of AGENT_PROFILE_LIST_FIELDS) {
      expect(cuerpo, `agent_profiles no tiene la columna ${campo}`).toMatch(
        new RegExp(`^\\s*${campo} text\\[\\] NOT NULL DEFAULT '\\{\\}',`, 'm')
      );
    }
  });

  it('CONTROL NEGATIVO: el guardia mira el fichero de verdad, no una copia suya', () => {
    // Sin esto, todo lo de arriba pasaría contra una cadena vacía si la ruta se rompiera: los
    // `toMatch` sobre '' fallarían, pero un futuro refactor que leyera el fichero equivocado —o
    // que lo encontrara vacío— tiene que dar rojo acá y no silenciosamente en verde.
    expect(migracion.length).toBeGreaterThan(1_000);
    expect(migracion).toContain('CREATE TABLE IF NOT EXISTS agent_profiles');
    // Y un campo que NO está en el contrato no puede estar sumándose al presupuesto: si alguien
    // borra un campo de TypeScript y se olvida del SQL, el presupuesto suma algo que ya no existe.
    const sumandos = presupuesto().match(/cauce_utf16_units\(/g) ?? [];
    expect(
      sumandos.length,
      'el presupuesto de 026 suma más términos que campos tiene el contrato'
    ).toBe(AGENT_PROFILE_TEXT_FIELDS.length + AGENT_PROFILE_LIST_FIELDS.length);
  });
});
