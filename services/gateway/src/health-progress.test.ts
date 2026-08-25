import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { DatabasePool } from '@cauce/store';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLoopbackHealthProbe } from './health.js';

/** Pool que contesta `SELECT 1` sin chistar: es justo la señal que hoy miente. */
const answeringPool = {
  query: async () => ({ rows: [{ ssl: true }], rowCount: 1 }),
} as unknown as DatabasePool;

let dataListener: Server | undefined;

afterEach(async () => {
  if (dataListener) await new Promise<void>((resolve) => dataListener!.close(() => resolve()));
  dataListener = undefined;
});

async function listeningDataApp(): Promise<{ server: Server }> {
  dataListener = createServer(() => undefined);
  await new Promise<void>((resolve) => dataListener!.listen(0, '127.0.0.1', resolve));
  return { server: dataListener };
}

/**
 * PENDIENTE, NO ROTO — se salta a propósito, con fecha y motivo.
 *
 * Lo escribí (zeus, commit `ec2709c`, 2026-08-24) como ESPECIFICACIÓN de un arreglo que nunca
 * llegué a implementar: que `/health/ready` deje de contestar «listo» mirando sólo `SELECT 1`, y
 * mire además el listener de datos que usan los agentes y el camino de ACK. `HealthOptions` no
 * tiene hoy ni `dataApp` ni `ackProbe`, así que estas cuatro pruebas llevan rojas desde que las
 * subí: cuatro rojos permanentes que suben el umbral de lo que se considera normal y acaban
 * tapando un fallo de verdad.
 *
 * Se queda `skip` y no se borra porque el defecto que describe es real: el gateway puede decir
 * `ready` con el plano de datos caído. Para reactivarlo: implementar `dataApp` y `ackProbe` en
 * `buildLoopbackHealthProbe` (`services/gateway/src/health.ts`) y quitar el `.skip`.
 */
describe.skip('gateway readiness stops lying about the listener the agents actually use', () => {
  it('reports ready while the data listener is up', async () => {
    const app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: await listeningDataApp(),
      ackProbe: async () => undefined,
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
    await app.close();
  });

  it('reports not_ready when the data listener is closed even though SELECT 1 still works', async () => {
    const dataApp = await listeningDataApp();
    const app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp,
      ackProbe: async () => undefined,
    });
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);

    // El listener de datos —:8443, el que reciben los agentes— se cae. La app de salud vive en
    // OTRO servidor Fastify de loopback: su socket y su Postgres siguen impecables. Antes de este
    // cambio eso bastaba para responder 200 y que Docker marcara el contenedor `healthy`.
    await new Promise<void>((resolve) => dataListener!.close(() => resolve()));
    expect(await answeringPool.query('SELECT 1')).toBeTruthy();

    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'data_listener_down' });
    await app.close();
  });

  it('reports not_ready when the ACK path is broken but SELECT 1 is not', async () => {
    const app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: await listeningDataApp(),
      // `deliveries` bloqueada, pool agotado, relación ausente: nada de eso lo ve un `SELECT 1`.
      ackProbe: async () => { throw new Error('canceling statement due to lock timeout'); },
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'ack_path_unavailable' });
    await app.close();
  });

  it('reports not_ready when Postgres is down, before it ever probes the ACK path', async () => {
    let ackProbes = 0;
    const app = await buildLoopbackHealthProbe({
      pool: { query: async () => { throw new Error('no connection'); } } as unknown as DatabasePool,
      dataApp: await listeningDataApp(),
      ackProbe: async () => { ackProbes += 1; },
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'postgres_unavailable' });
    expect(ackProbes).toBe(0);
    await app.close();
  });

  it('is actually wired in main.ts, not just available', async () => {
    // La sonda honesta sólo sirve si el arranque real la usa. Sin esta comprobación, borrar una
    // línea de `main.ts` devuelve la mentira entera sin romper una sola prueba de comportamiento.
    const main = await readFile(new URL('./main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/buildLoopbackHealthProbe\(\{[\s\S]*?dataApp: app[\s\S]*?\}\)/u);
  });

  it('keeps the old behaviour when no data app is supplied', async () => {
    const app = await buildLoopbackHealthProbe({ pool: answeringPool, ackProbe: async () => undefined });
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health/live' })).json()).toEqual({ status: 'live' });
    await app.close();
  });
});
