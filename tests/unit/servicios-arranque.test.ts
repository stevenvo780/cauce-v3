import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * Puertas de arranque de los tres `main.ts` de servicio. Los tres son entrypoints sin
 * exports y los tres estaban al 0 % en todas las suites: nadie los importa. Lo que queda
 * sin cubrir así no es cableado, son las exigencias que impiden que un despliegue mal
 * configurado levante. Cada caso trae control negativo — cumplida la condición, el arranque
 * muere en la puerta SIGUIENTE — porque mirar sólo "falló" da verde contra un binario roto.
 */

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tsx = join(raiz, 'node_modules/.bin/tsx');
const ejecutar = promisify(execFile);
const URL_INALCANZABLE = 'postgresql://usuario@destino.invalido/db';

async function arrancar(servicio: string, entorno: Record<string, string>): Promise<string> {
  const entrada = join(raiz, 'services', servicio, 'src/main.ts');
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

describe('puertas de arranque de los servicios', () => {
  it('el dispatcher exige DATABASE_URL antes que nada', async () => {
    const [sinUrl, conUrl] = await Promise.all([
      arrancar('dispatcher', { NODE_ENV: 'test' }),
      arrancar('dispatcher', { NODE_ENV: 'production', DATABASE_URL: URL_INALCANZABLE })
    ]);
    expect(sinUrl).toContain('DATABASE_URL is required');
    // Control negativo: con URL pasa esa puerta y muere en la de TLS de producción.
    expect(conUrl).not.toContain('DATABASE_URL is required');
    expect(conUrl).toContain('sslmode=verify-full');
  });

  it('el bridge rechaza un lease de egress por debajo del suelo de 10 s', async () => {
    const base = { NODE_ENV: 'test', DATABASE_URL: URL_INALCANZABLE };
    const [corto, justo] = await Promise.all([
      arrancar('telegram-bridge', { ...base, CAUCE_TELEGRAM_EGRESS_LEASE_MS: '5000' }),
      arrancar('telegram-bridge', { ...base, CAUCE_TELEGRAM_EGRESS_LEASE_MS: '10000' })
    ]);
    expect(corto).toContain('CAUCE_TELEGRAM_EGRESS_LEASE_MS must be at least 10000');
    // El suelo es inclusivo: 10000 pasa y el arranque avanza hasta pedir la configuración.
    expect(justo).not.toContain('must be at least 10000');
    expect(justo).toContain('CAUCE_TELEGRAM_CONFIG_FILE is required');
  });

  it('el bridge distingue un lease no numérico de uno demasiado corto', async () => {
    const salida = await arrancar('telegram-bridge', {
      NODE_ENV: 'test', DATABASE_URL: URL_INALCANZABLE, CAUCE_TELEGRAM_EGRESS_LEASE_MS: 'pronto'
    });
    expect(salida).toContain('CAUCE_TELEGRAM_EGRESS_LEASE_MS must be a positive integer');
    expect(salida).not.toContain('must be at least 10000');
  });

  it('el relay exige certificado y clave de mTLS, en ese orden', async () => {
    const [sinCert, conCert] = await Promise.all([
      arrancar('terminal-relay', { NODE_ENV: 'test' }),
      arrancar('terminal-relay', {
        NODE_ENV: 'test', CAUCE_TERMINAL_RELAY_TLS_CERT_FILE: '/inexistente/relay.crt'
      })
    ]);
    expect(sinCert).toContain('CAUCE_TERMINAL_RELAY_TLS_CERT_FILE is required');
    // Control negativo: puesto el certificado, la queja pasa a ser la clave.
    expect(conCert).not.toContain('CAUCE_TERMINAL_RELAY_TLS_CERT_FILE is required');
    expect(conCert).toContain('CAUCE_TERMINAL_RELAY_TLS_KEY_FILE is required');
  });
});
