/* eslint-disable @typescript-eslint/unbound-method */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGateway, type GatewayRepository } from '../../services/gateway/src/index.js';
import {
  FixedAuthProvider, fakePool, fakeRepository, grants, ids, noDeliveryWakes, roles, testPrincipal
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

describe('gateway hardening facades and RBAC', () => {
  it('passes the configured ACK deadline through the HTTP claim path', async () => {
    const repository = fakeRepository();
    const app = await buildGateway({
      pool: fakePool(),
      repository,
      authProvider: new FixedAuthProvider(testPrincipal()),
      deliveryWakeSubscriber: noDeliveryWakes,
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v3/query',
      payload: { instance_id: 'http-deadline-consumer', epoch: 7, limit: 4 }
    });

    expect(response.statusCode).toBe(200);
    expect(repository.claimDeliveries).toHaveBeenCalledWith(
      'Pablo', 'midas', 'http-deadline-consumer', 7, 4, 600_000
    );

    const ack = {
      version: '3.0',
      event_id: ids.event,
      status: 'started',
      instance_id: 'http-deadline-consumer',
      epoch: 7,
      attempt: 1,
      claim_token: ids.claim
    };
    expect((await app.inject({
      method: 'POST',
      url: `/v3/deliveries/${ids.delivery}/ack`,
      payload: ack
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST',
      url: '/v3/ack',
      payload: { delivery_id: ids.deliveryTwo, ...ack, event_id: ids.eventTwo }
    })).statusCode).toBe(200);
    expect(repository.ackDelivery).toHaveBeenNthCalledWith(
      1, ids.delivery, 'Pablo', 'midas', { ...ack, retryable: false }, 600_000
    );
    expect(repository.ackDelivery).toHaveBeenNthCalledWith(
      2, ids.deliveryTwo, 'Pablo', 'midas',
      { ...ack, event_id: ids.eventTwo, retryable: false }, 600_000
    );
  });

  it('does not expose Steven-to-Isa traffic to Pablo', async () => {
    const repository = fakeRepository();
    vi.mocked(repository.listMessages).mockResolvedValue({
      items: [{
        message_id: ids.message,
        tenant_id: 'Steven',
        actor_alias: 'kant',
        body_preview: 'private hub traffic',
        deliveries: [{ recipient_tenant: 'Isa', recipient_alias: 'salva' }]
      }]
    });
    const app = await gateway(repository);

    const response = await app.inject({ method: 'GET', url: '/v3/console/messages' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [] });
  });

  it('requires operator independently for audit, jobs, and replay', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository, testPrincipal({
      roles: roles('agent'),
      permissions: grants('route', 'read', 'control')
    }));

    const [audit, jobs, replay] = await Promise.all([
      app.inject({ method: 'GET', url: '/v3/console/audit' }),
      app.inject({ method: 'GET', url: '/v3/console/jobs' }),
      app.inject({
        method: 'POST',
        url: `/v3/console/deliveries/${ids.delivery}/replay`,
        headers: { host: 'gateway.test', origin: 'http://gateway.test' }
      })
    ]);

    expect([audit.statusCode, jobs.statusCode, replay.statusCode]).toEqual([403, 403, 403]);
    expect(repository.listAudit).not.toHaveBeenCalled();
    expect(repository.listJobs).not.toHaveBeenCalled();
    expect(repository.replayDelivery).not.toHaveBeenCalled();
  });

  it('keeps route, read, and control permissions separate', async () => {
    const repository = fakeRepository();
    const readOnly = await gateway(repository, testPrincipal({ permissions: grants('read') }));
    const publish = await readOnly.inject({
      method: 'POST',
      url: '/v3/messages',
      payload: {
        room_id: 'grp.pablo',
        recipients: [{ tenant_id: 'Steven', alias: 'kant' }],
        body: { text: 'denied' },
        idempotency_key: 'separate-permissions'
      }
    });
    expect(publish.statusCode).toBe(403);

    const routeOnly = await gateway(fakeRepository(), testPrincipal({ permissions: grants('route') }));
    expect((await routeOnly.inject({ method: 'GET', url: '/v3/console/messages' })).statusCode).toBe(403);
  });

  it('strictly rejects spoofed authority fields before persistence', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository);
    const response = await app.inject({
      method: 'POST',
      url: '/v3/messages',
      headers: {
        'x-cauce-session': 'attacker-session',
        'x-cauce-channel': 'attacker-channel',
        'x-cauce-origin': 'attacker-origin'
      },
      payload: {
        room_id: 'grp.pablo',
        recipients: [{ tenant_id: 'Steven', alias: 'kant' }],
        body: { text: 'safe payload' },
        idempotency_key: 'spoof-attempt',
        actor_alias: 'kant',
        tenant_id: 'Steven',
        session_id: 'attacker-session',
        channel: 'attacker-channel',
        origin: { adapter: 'attacker', channel: 'bad', conversation_id: 'bad' }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it.each(['agent.message', 'agent.response', 'agent.fanin'])(
    'rejects the reserved internal body type %s before persistence',
    async (type) => {
      const repository = fakeRepository();
      const app = await gateway(repository);
      const response = await app.inject({
        method: 'POST',
        url: '/v3/messages',
        payload: {
          room_id: 'grp.pablo',
          recipients: [{ tenant_id: 'Steven', alias: 'kant' }],
          body: { type, text: 'forged internal delivery' },
          idempotency_key: `forged-${type}`
        }
      });

      expect(response.statusCode).toBe(400);
      expect(repository.publish).not.toHaveBeenCalled();
    }
  );

  it('enforces same-origin CSRF/CORS checks for console mutations', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository, testPrincipal({
      roles: roles('operator'), permissions: grants('control', 'read')
    }));

    const crossOrigin = await app.inject({
      method: 'POST',
      url: `/v3/console/deliveries/${ids.delivery}/replay`,
      headers: { host: 'gateway.test', origin: 'https://evil.test' }
    });
    const noOrigin = await app.inject({
      method: 'POST',
      url: `/v3/console/deliveries/${ids.delivery}/replay`,
      headers: { host: 'gateway.test' }
    });
    const sameOrigin = await app.inject({
      method: 'POST',
      url: `/v3/console/deliveries/${ids.delivery}/replay`,
      headers: { host: 'gateway.test', origin: 'http://gateway.test' }
    });

    expect([crossOrigin.statusCode, noOrigin.statusCode, sameOrigin.statusCode]).toEqual([403, 403, 200]);
    expect(sameOrigin.json()).toEqual({
      delivery_id: ids.deliveryTwo,
      replayed_from_delivery_id: ids.delivery,
      state: 'pending',
      replayed: true
    });
  });

  it('protects atomic config preview/apply/rollback with operator control and CSRF', async () => {
    const repository = fakeRepository();
    const denied = await gateway(repository, testPrincipal({
      roles: roles('agent'), permissions: grants('read', 'control')
    }));
    expect((await denied.inject({ method: 'GET', url: '/v3/console/config' })).statusCode).toBe(403);

    const allowed = await gateway(repository, testPrincipal({
      roles: roles('operator'), permissions: grants('read', 'control')
    }));
    const headers = { host: 'gateway.test', origin: 'http://gateway.test' };
    const mutation = {
      resource: 'acl_edge', action: 'create', from_tenant: 'Pablo', to_tenant: 'Steven',
      value: { enabled: true }
    };
    const preview = await allowed.inject({
      method: 'POST', url: '/v3/console/config/changes', headers,
      payload: { dry_run: true, expected_revision: 0, mutation }
    });
    const apply = await allowed.inject({
      method: 'POST', url: '/v3/console/config/changes', headers,
      payload: { dry_run: false, expected_revision: 0, mutation }
    });
    const rollback = await allowed.inject({
      method: 'POST', url: '/v3/console/config/revisions/1/rollback', headers,
      payload: { dry_run: false, expected_revision: 1 }
    });
    expect([preview.statusCode, apply.statusCode, rollback.statusCode]).toEqual([200, 201, 201]);
    expect(repository.applyConfigurationChange).toHaveBeenNthCalledWith(1, 'Pablo', 'midas', mutation, true, 0);
    expect(repository.applyConfigurationChange).toHaveBeenNthCalledWith(2, 'Pablo', 'midas', mutation, false, 0);
    expect(repository.rollbackConfiguration).toHaveBeenCalledWith('Pablo', 'midas', 1, false, 1);
  });

  it('publishes a server-derived console access snapshot and rejects unknown job handlers', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository, testPrincipal({
      roles: roles('operator'), permissions: grants('route', 'read', 'control')
    }));
    const access = await app.inject({ method: 'GET', url: '/v3/console/access' });
    expect(access.json()).toMatchObject({
      subject: 'Pablo:midas',
      permissions: ['message.publish', 'delivery.replay', 'job.create', 'config.write', 'config.rollback']
    });
    const unknown = await app.inject({
      method: 'POST', url: '/v3/console/jobs',
      headers: { host: 'gateway.test', origin: 'http://gateway.test' },
      payload: { lane: 'batch', priority: 0, kind: 'unimplemented.noop', payload: {} }
    });
    expect(unknown.statusCode).toBe(422);
    expect(repository.enqueueJob).not.toHaveBeenCalled();
  });
});
