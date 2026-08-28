/* eslint-disable @typescript-eslint/unbound-method */
/**
 * GET /v3/accounts/selection — the route the adapter uses to ask the selector which
 * subscription to spend.
 *
 * What is tested here is the half that does NOT need Postgres: the subject of the query comes
 * from the CERTIFICATE, not the body or the query string. Selector semantics (priority, pause,
 * exhaustion, failover) live in tests/store-hardening/account-selector-postgres.test.ts, against
 * a real database.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildGateway, type GatewayRepository } from '../../services/gateway/src/index.js';
import {
  FixedAuthProvider, fakePool, fakeRepository, noDeliveryWakes, testPrincipal
} from './helpers.js';

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];

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
    // An alias resolves its own and nothing else: the response includes the account's
    // `credential_ref`, and even though it is a locator rather than a secret, telling an agent
    // where another agent looks up its credential is exactly the data that does not need to cross.
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
