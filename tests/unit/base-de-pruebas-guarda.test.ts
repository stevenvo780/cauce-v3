import { describe, expect, it } from 'vitest';
import { esBaseDePruebas, nombreDeBase } from '../helpers/postgres.js';

/*
 * The guard that stops the suite from truncating production.
 *
 * `resetTestDatabase()` runs `TRUNCATE ... RESTART IDENTITY CASCADE` against 30 tables. While
 * testcontainers created the database, that was harmless: the database did not exist until
 * `beforeAll`. By accepting `CAUCE_TEST_DATABASE_URL` — so these tests can run from a container
 * without a Docker daemon, which is the case for the ENTIRE fleet — the possibility opens of
 * pointing by mistake at the real database. The only thing standing between them is this check.
 *
 * That is why the negative control is not a flourish: it is the case the guard exists to
 * prevent, and it is written with the URL that would actually be used.
 */

describe('la guarda de base desechable', () => {
  it('acepta una base cuyo nombre empieza por cauce_test', () => {
    expect(esBaseDePruebas('postgresql://u:p@127.0.0.1:5432/cauce_test')).toBe(true);
    expect(esBaseDePruebas('postgresql://u:p@127.0.0.1:5432/cauce_test_zeus_20260824')).toBe(true);
  });

  // ── NEGATIVE CONTROL: what this guard exists to prevent ──────────────────────────────────
  it('RECHAZA la base de producción, que se llama «cauce»', () => {
    expect(esBaseDePruebas('postgresql://cauce:secreto@10.0.0.5:5432/cauce')).toBe(false);
  });

  it('RECHAZA un nombre que sólo CONTIENE cauce_test pero no empieza por ahí', () => {
    // `endsWith`/`includes` would have let this through. The check is by PREFIX.
    expect(esBaseDePruebas('postgresql://u:p@h:5432/produccion_cauce_test')).toBe(false);
  });

  it('RECHAZA una URL rota en vez de darle el beneficio de la duda', () => {
    expect(esBaseDePruebas('no-es-una-url')).toBe(false);
    expect(esBaseDePruebas('')).toBe(false);
  });

  it('lee el nombre de la base sin arrastrar la contraseña', () => {
    expect(nombreDeBase('postgresql://u:p%40ss@h:5432/cauce_test')).toBe('cauce_test');
  });
});
