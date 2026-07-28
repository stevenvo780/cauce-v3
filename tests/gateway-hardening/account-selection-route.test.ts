/* eslint-disable @typescript-eslint/unbound-method */
/**
 * GET /v3/accounts/selection — la ruta por la que el adaptador le pregunta al selector qué
 * suscripción gastar.
 *
 * Lo que se prueba acá es la mitad que NO necesita Postgres: que el sujeto de la consulta sale del
 * CERTIFICADO y no del cuerpo ni del query string. La semántica del selector (prioridad, pausa,
 * agotamiento, failover) vive en tests/store-hardening/account-selector-postgres.test.ts, contra
 * una base de verdad.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildGateway, type GatewayRepository } from '../../services/gateway/src/index.js';
import {
  FixedAuthProvider, fakePool, fakeRepository, noDeliveryWakes, testPrincipal
} from './helpers.js';

const apps: Array<Awaited<ReturnType<typeof buildGateway>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

async function gateway(repository: GatewayRepository, principal = testPrincipal()) {
  const app = await buildGateway({
    pool: fakePool(),
    repository,
    authProvider: new FixedAuthProvider(principal),
    deliveryWakeSubscriber: noDeliveryWakes,
    outboxPollMs: 60_000
  });
  apps.push(app);
  return app;
}

describe('GET /v3/accounts/selection', () => {
  it('resuelve la cuenta del alias del certificado', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository);

    const response = await app.inject({ method: 'GET', url: '/v3/accounts/selection?provider=claude' });

    expect(response.statusCode).toBe(200);
    expect(repository.selectAccount).toHaveBeenCalledWith('Pablo', 'midas', 'claude');
  });

  it('el sujeto NO se puede suplantar por query string', async () => {
    // Un alias resuelve lo suyo y nada más: la respuesta incluye el `credential_ref` de la cuenta
    // y, aunque sea un locator y no un secreto, decirle a un agente dónde busca su credencial otro
    // agente es exactamente el dato que no tiene por qué cruzar.
    const repository = fakeRepository();
    const app = await gateway(repository);

    const response = await app.inject({
      method: 'GET',
      url: '/v3/accounts/selection?provider=claude&tenant_id=Steven&alias=argos&agent_alias=argos'
    });

    expect(response.statusCode).toBe(200);
    expect(repository.selectAccount).toHaveBeenCalledWith('Pablo', 'midas', 'claude');
  });

  it('exige el parámetro provider', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository);

    const response = await app.inject({ method: 'GET', url: '/v3/accounts/selection' });

    expect(response.statusCode).toBe(400);
    expect(repository.selectAccount).not.toHaveBeenCalled();
  });

  it('un principal sin permiso route no llega al store', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository, testPrincipal({ permissions: ['read'] }));

    const response = await app.inject({ method: 'GET', url: '/v3/accounts/selection?provider=claude' });

    expect(response.statusCode).toBe(403);
    expect(repository.selectAccount).not.toHaveBeenCalled();
  });
});
