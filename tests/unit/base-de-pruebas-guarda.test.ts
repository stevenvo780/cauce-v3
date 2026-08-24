import { describe, expect, it } from 'vitest';
import { esBaseDePruebas, nombreDeBase } from '../helpers/postgres.js';

/*
 * La guarda que impide que la suite trunque producción.
 *
 * `resetTestDatabase()` hace `TRUNCATE ... RESTART IDENTITY CASCADE` sobre 30 tablas. Mientras la
 * base la creaba `testcontainers`, eso era inofensivo: la base ni existía hasta el `beforeAll`.
 * Al admitir `CAUCE_TEST_DATABASE_URL` —para poder correr estas pruebas desde un contenedor sin
 * demonio de Docker, que es el caso de TODA la flota— aparece la posibilidad de apuntar por error
 * a la base real. Lo único que lo separa es esta comprobación.
 *
 * Por eso el control negativo no es un adorno: es el caso que la guarda existe para impedir, y va
 * escrito con la URL que de verdad se usaría.
 */

describe('la guarda de base desechable', () => {
  it('acepta una base cuyo nombre empieza por cauce_test', () => {
    expect(esBaseDePruebas('postgresql://u:p@127.0.0.1:5432/cauce_test')).toBe(true);
    expect(esBaseDePruebas('postgresql://u:p@127.0.0.1:5432/cauce_test_zeus_20260824')).toBe(true);
  });

  // ── CONTROL NEGATIVO: lo que esta guarda viene a impedir ──────────────────────────────────
  it('RECHAZA la base de producción, que se llama «cauce»', () => {
    expect(esBaseDePruebas('postgresql://cauce:secreto@10.0.0.5:5432/cauce')).toBe(false);
  });

  it('RECHAZA un nombre que sólo CONTIENE cauce_test pero no empieza por ahí', () => {
    // `endsWith`/`includes` habrían dejado pasar esto. La comprobación es por PREFIJO.
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
