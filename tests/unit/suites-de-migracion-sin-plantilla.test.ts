import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SUITES_SIN_PLANTILLA } from '../helpers/postgres.js';

const DIRECTORIO_DE_SUITES = fileURLToPath(new URL('../../packages/store/test', import.meta.url));

function suitesDeMigracionEnDisco(): string[] {
  return readdirSync(DIRECTORIO_DE_SUITES)
    .filter((fichero) => fichero.endsWith('-migration-postgres.test.ts')
      || fichero === 'migration-integrity-postgres.test.ts')
    .sort();
}

describe('el opt-out de la plantilla no puede quedarse a mano', () => {
  it('toda suite de migración de packages/store/test está en SUITES_SIN_PLANTILLA', () => {
    const enDisco = suitesDeMigracionEnDisco();

    expect(enDisco.length).toBeGreaterThan(5);
    expect(enDisco.filter((fichero) => !SUITES_SIN_PLANTILLA.has(fichero))).toEqual([]);
  });

  it('y la lista no arrastra nombres que ya no existen en el árbol', () => {
    expect([...SUITES_SIN_PLANTILLA].sort()).toEqual(suitesDeMigracionEnDisco());
  });
});
