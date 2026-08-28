/* eslint-disable @typescript-eslint/unbound-method */
import { afterEach, describe, expect, it } from 'vitest';
import { buildGateway, type GatewayRepository } from '../../services/gateway/src/index.js';
import {
  FixedAuthProvider, fakePool, fakeRepository, grants, noDeliveryWakes, roles, testPrincipal
} from './helpers.js';

/**
 * Fleet panel reads require `read`; quota sample ingest remains an operator mutation with
 * `control`, additionally verified by the store. This separation lets a `reader` account browse
 * the console without acquiring authority to change operational state.
 *
 * What this file does NOT test (it needs a real Postgres, not available on this machine): a
 * non-hub operator only sees their own rows in fleetActivity()/quotaSnapshot(), and the
 * auto-pause/auto-resume of recordQuotaSample() behaves as migration 013 documents. That stays
 * for the *-postgres.test.ts files.
 */

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

function validQuotaSample() {
  return {
    host: 'kratos',
    captured_at: new Date().toISOString(),
    schema_version: 2,
    providers: [
      {
        provider: 'claude',
        ok: true,
        windows: [{ group_key: 'default', window_key: 'session', remaining_percent: 90 }]
      }
    ]
  };
}

describe('GET /v3/console/activity', () => {
  it('200 para un reader con permiso read y sin rol operator', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository, testPrincipal({ roles: roles('agent'), permissions: grants('read') }));
    const response = await app.inject({ method: 'GET', url: '/v3/console/activity' });
    expect(response.statusCode).toBe(200);
    expect(repository.fleetActivity).toHaveBeenCalledWith('Pablo', 'midas');
  });

  it('200 para un operator con permiso read, delegando en fleetActivity()', async () => {
    const repository = fakeRepository();
    const principal = testPrincipal({
      tenant_id: 'Pablo', alias: 'midas', roles: roles('operator'), permissions: grants('read')
    });
    const app = await gateway(repository, principal);
    const response = await app.inject({ method: 'GET', url: '/v3/console/activity' });
    expect(response.statusCode).toBe(200);
    expect(repository.fleetActivity).toHaveBeenCalledWith('Pablo', 'midas');
  });

  it('el JSON de respuesta nunca trae cuerpos de mensaje ni resultados de entrega', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository, testPrincipal({ roles: roles('operator'), permissions: grants('read') }));
    const response = await app.inject({ method: 'GET', url: '/v3/console/activity' });
    const text = response.payload;
    expect(text).not.toMatch(/"body"/);
    expect(text).not.toMatch(/"body_preview"/);
    expect(text).not.toMatch(/"result"/);
    expect(text).not.toMatch(/"last_error"/);
  });
});

describe('GET /v3/console/quotas', () => {
  it('200 para un reader con permiso read y sin rol operator', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository, testPrincipal({ roles: roles('agent'), permissions: grants('read') }));
    const response = await app.inject({ method: 'GET', url: '/v3/console/quotas' });
    expect(response.statusCode).toBe(200);
    expect(repository.quotaSnapshot).toHaveBeenCalledWith('Pablo', 'midas');
  });

  it('200 para un operator con permiso read, delegando en quotaSnapshot()', async () => {
    const repository = fakeRepository();
    const principal = testPrincipal({
      tenant_id: 'Steven', alias: 'kant', roles: roles('operator'), permissions: grants('read')
    });
    const app = await gateway(repository, principal);
    const response = await app.inject({ method: 'GET', url: '/v3/console/quotas' });
    expect(response.statusCode).toBe(200);
    expect(repository.quotaSnapshot).toHaveBeenCalledWith('Steven', 'kant');
  });
});

describe('POST /v3/quotas/samples', () => {
  it('403 para un agente con permiso control pero sin rol operator -- ni la ruta ni el store lo dejan pasar', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository, testPrincipal({ roles: roles('agent'), permissions: grants('control') }));
    const response = await app.inject({ method: 'POST', url: '/v3/quotas/samples', payload: validQuotaSample() });
    expect(response.statusCode).toBe(403);
    expect(repository.recordQuotaSample).not.toHaveBeenCalled();
  });

  it('403 para un operator SIN permiso control (sólo read)', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository, testPrincipal({ roles: roles('operator'), permissions: grants('read') }));
    const response = await app.inject({ method: 'POST', url: '/v3/quotas/samples', payload: validQuotaSample() });
    expect(response.statusCode).toBe(403);
    expect(repository.recordQuotaSample).not.toHaveBeenCalled();
  });

  it('202 para la identidad dedicada del recolector (operator + control)', async () => {
    const repository = fakeRepository();
    const principal = testPrincipal({
      tenant_id: 'Steven', alias: 'quota-collector', roles: roles('operator'), permissions: grants('control')
    });
    const app = await gateway(repository, principal);
    const payload = validQuotaSample();
    const response = await app.inject({ method: 'POST', url: '/v3/quotas/samples', payload });
    expect(response.statusCode).toBe(202);
    expect(repository.assertPermission).toHaveBeenCalledWith('Steven', 'quota-collector', 'control');
    expect(repository.recordQuotaSample).toHaveBeenCalledWith('Steven', 'quota-collector', expect.objectContaining({
      host: 'kratos', schema_version: 2
    }));
  });

  it('rechaza un cuerpo inválido (host con formato ilegal) antes de llegar al store', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository, testPrincipal({ roles: roles('operator'), permissions: grants('control') }));
    const response = await app.inject({
      method: 'POST', url: '/v3/quotas/samples',
      payload: { ...validQuotaSample(), host: 'no espacios permitidos!' }
    });
    expect(response.statusCode).toBe(400);
    expect(repository.recordQuotaSample).not.toHaveBeenCalled();
  });

  it('no vive bajo /v3/console/: no lo bloquea el hook de seguridad que exige Origin same-origin', async () => {
    const repository = fakeRepository();
    const principal = testPrincipal({ roles: roles('operator'), permissions: grants('control') });
    const app = await gateway(repository, principal);
    // Without an Origin header, as sent by a daemon with a client mTLS certificate — if this route
    // lived under /v3/console/, createConsoleSecurityHook would reject it with 403 right here.
    const response = await app.inject({ method: 'POST', url: '/v3/quotas/samples', payload: validQuotaSample() });
    expect(response.statusCode).toBe(202);
  });
});
