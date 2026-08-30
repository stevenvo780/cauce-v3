import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * Puertas de arranque de `services/gateway/src/main.ts`, que no exporta nada y estaba al
 * 0 % en todas las suites: `tests/e2e` construye la app con `buildGateway` desde `app.ts`
 * y se salta el cableado entero. Se ejercitan lanzando el proceso y leyendo por qué muere,
 * con control negativo: cumplida la condición, el arranque muere MÁS ADELANTE y por otro
 * motivo. Ojo, lo de verify-full lo hace cumplir `productionSsl` de
 * `packages/store/src/db.ts`, no el `assertPostgresTls` de `main.ts` — mismo texto, así que
 * anular el de `main.ts` deja esto verde: lo que se fija es el contrato observable.
 */

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tsx = join(raiz, 'node_modules/.bin/tsx');
const entrada = join(raiz, 'services/gateway/src/main.ts');
const ejecutar = promisify(execFile);

const TLS_EXIGIDO = 'production PostgreSQL requires sslmode=verify-full';
const SIN_AUTH = 'No production AuthProvider configured; refusing to start';

/** Entorno desde cero: heredarlo traería el `DATABASE_URL` de la base de pruebas. */
async function arrancar(entorno: Record<string, string>): Promise<string> {
  try {
    const { stdout, stderr } = await ejecutar(tsx, [entrada], {
      cwd: raiz,
      timeout: 60_000,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...entorno }
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    const fallo = error as { stdout?: string; stderr?: string; message?: string };
    return `${fallo.stdout ?? ''}${fallo.stderr ?? ''}${fallo.message ?? ''}`;
  }
}

const URL_DEBIL = 'postgresql://usuario@destino.invalido/db';
const URL_FUERTE = 'postgresql://usuario@destino.invalido/db?sslmode=verify-full';

describe('puertas de arranque del gateway', () => {
  it('se niega a arrancar sin DATABASE_URL', async () => {
    expect(await arrancar({ NODE_ENV: 'test' })).toContain('DATABASE_URL is required');
  });

  it('en producción rechaza PostgreSQL sin verify-full, y lo acepta con él', async () => {
    const [debil, enUrl, enEntorno] = await Promise.all([
      arrancar({ NODE_ENV: 'production', DATABASE_URL: URL_DEBIL }),
      arrancar({ NODE_ENV: 'production', DATABASE_URL: URL_FUERTE }),
      arrancar({ NODE_ENV: 'production', DATABASE_URL: URL_DEBIL, PGSSLMODE: 'verify-full' })
    ]);
    expect(debil).toContain(TLS_EXIGIDO);
    // Controles negativos: abre por la URL y por PGSSLMODE, y muere en la exigencia siguiente.
    expect(enUrl).not.toContain(TLS_EXIGIDO);
    expect(enUrl).toContain('PGSSLROOTCERT');
    expect(enEntorno).not.toContain(TLS_EXIGIDO);
    expect(enEntorno).toContain('PGSSLROOTCERT');
  });

  it('fuera de producción no exige verify-full', async () => {
    const salida = await arrancar({ NODE_ENV: 'development', DATABASE_URL: URL_DEBIL });
    expect(salida).not.toContain(TLS_EXIGIDO);
    expect(salida).toContain(SIN_AUTH);
  });

  it('en producción CAUCE_DEV_AUTH=1 no habilita el proveedor de desarrollo', async () => {
    const salida = await arrancar({
      NODE_ENV: 'production', DATABASE_URL: URL_FUERTE, PGSSLROOTCERT: '/dev/null',
      CAUCE_DEV_AUTH: '1'
    });
    expect(salida).toContain(SIN_AUTH);
  });

  it('fuera de producción CAUCE_DEV_AUTH=1 sí lo habilita', async () => {
    // Control negativo: pasa la selección y muere resolviendo el host; sin esto la prueba de
    // arriba daría verde aunque el proveedor de desarrollo ya no existiera.
    const salida = await arrancar({
      NODE_ENV: 'development', DATABASE_URL: URL_DEBIL, CAUCE_DEV_AUTH: '1'
    });
    expect(salida).not.toContain(SIN_AUTH);
    expect(salida).toContain('destino.invalido');
  });
});
