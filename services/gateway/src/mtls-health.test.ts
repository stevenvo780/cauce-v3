import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { DatabasePool } from '@cauce/store';
import { buildGateway, type GatewayRepository } from './app.js';
import { MtlsAuthProvider } from './auth.js';
import { buildLoopbackHealthProbe } from './health.js';

function pool(): DatabasePool {
  return {
    query: vi.fn(async () => ({ rows: [{ ssl: true }], rowCount: 1 }))
  } as unknown as DatabasePool;
}

// Generated, non-production fixture with no authority outside this test.
const testKey = readFileSync(new URL('./test-fixtures/mtls-server-private.pem', import.meta.url));
const testCertificate = readFileSync(new URL('./test-fixtures/mtls-server-certificate.pem', import.meta.url));

async function deniedWithoutClientCertificate(port: number): Promise<Error> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      host: '127.0.0.1',
      port,
      path: '/v3/status',
      method: 'GET',
      ca: testCertificate,
      rejectUnauthorized: true
    });
    request.once('response', (response) => {
      response.resume();
      reject(new Error(`mTLS listener unexpectedly returned HTTP ${String(response.statusCode ?? 0)}`));
    });
    request.once('error', resolve);
    request.end();
  });
}

describe('mTLS health isolation', () => {
  it('keeps health on the dedicated app and denies a data route without verified TLS client identity', async () => {
    const database = pool();
    const health = await buildLoopbackHealthProbe({ pool: database, requirePostgresTls: true });
    const data = await buildGateway({
      pool: database,
      authProvider: new MtlsAuthProvider({
        resolve: vi.fn(async () => {
          throw new Error('an unverified request must never reach certificate mapping');
        })
      }),
      repository: {
        claimOutbox: vi.fn(async () => []),
        // MtlsAuthProvider is production-mode, so the data-plane fixture must advertise the
        // durable reconnect primitive instead of weakening buildGateway's production invariant.
        liveDeliveryClaims: vi.fn(async () => []),
      } as unknown as GatewayRepository,
      deliveryWakeSubscriber: async () => async () => undefined,
      exposeHealthRoutes: false,
      https: {
        key: testKey,
        cert: testCertificate,
        ca: testCertificate,
        requestCert: true,
        rejectUnauthorized: true
      }
    });
    try {
      await health.listen({ host: '127.0.0.1', port: 0 });
      await data.listen({ host: '127.0.0.1', port: 0 });
      const healthAddress = health.server.address() as AddressInfo;
      const healthLive = await fetch(`http://127.0.0.1:${String(healthAddress.port)}/health/live`);
      const healthReady = await fetch(`http://127.0.0.1:${String(healthAddress.port)}/health/ready`);
      expect(await healthLive.json()).toEqual({ status: 'live' });
      expect(await healthReady.json()).toEqual({ status: 'ready' });
      expect((await health.inject({ method: 'GET', url: '/v3/status' })).statusCode).toBe(404);
      expect((await data.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(404);
      const protectedRoute = await data.inject({ method: 'GET', url: '/v3/status' });
      expect(protectedRoute.statusCode).toBe(401);
      expect(protectedRoute.json()).toMatchObject({ error: 'unauthorized' });
      const dataAddress = data.server.address() as AddressInfo;
      const tlsError = await deniedWithoutClientCertificate(dataAddress.port);
      expect(`${tlsError.name} ${tlsError.message}`).toMatch(/certificate|tls|socket|reset/i);
    } finally {
      await data.close();
      await health.close();
    }
  });
});
