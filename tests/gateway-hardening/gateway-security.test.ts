/* eslint-disable @typescript-eslint/unbound-method */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPublishReceipt, type Permission } from '@cauce/protocol';
import {
  buildGateway, type AuthProvider, type GatewayRepository, type Principal,
} from '../../services/gateway/src/index.js';
import {
  FixedAuthProvider, fakePool, fakeRepository, grants, ids, noDeliveryWakes, roles, testPrincipal
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

async function gateGateway(repository: GatewayRepository, gatePrincipal: Principal, name = 'mtls') {
  const authProvider: AuthProvider = {
    name,
    mode: 'test',
    authenticateHttp: async () => gatePrincipal,
    authenticateHello: async () => gatePrincipal,
  };
  const app = await buildGateway({
    pool: fakePool(), repository, authProvider, deliveryWakeSubscriber: noDeliveryWakes,
    outboxPollMs: 60_000,
  });
  apps.push(app);
  return app;
}

describe('gateway hardening facades and RBAC', () => {
  it('returns an HTTP hello token and requires it explicitly for query and heartbeat', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository);
    const hello = await app.inject({
      method: 'POST',
      url: '/v3/connections/hello',
      payload: {
        type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
        instance_id: 'http-fenced-consumer', capabilities: ['acks.v3'],
      },
    });
    expect(hello.statusCode).toBe(200);
    const lease = hello.json<{ connection_token: string; epoch: number }>();
    expect(lease.connection_token).toMatch(/^[0-9a-f-]{36}$/u);

    const missing = await app.inject({
      method: 'POST',
      url: '/v3/deliveries/query',
      payload: { instance_id: 'http-fenced-consumer', epoch: lease.epoch, limit: 1 },
    });
    expect(missing.statusCode).toBe(403);
    const queried = await app.inject({
      method: 'POST',
      url: '/v3/deliveries/query',
      payload: {
        instance_id: 'http-fenced-consumer', epoch: lease.epoch, limit: 1,
        connection_token: lease.connection_token,
      },
    });
    expect(queried.statusCode).toBe(200);

    const heartbeat = await app.inject({
      method: 'POST',
      url: '/v3/heartbeat',
      payload: {
        type: 'heartbeat', instance_id: 'http-fenced-consumer', epoch: lease.epoch,
        connection_token: lease.connection_token,
      },
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(repository.heartbeat).toHaveBeenCalledWith(
      'Pablo', 'midas', 'http-fenced-consumer', lease.epoch, 180_000,
      lease.connection_token,
    );
  });

  it('passes the configured ACK deadline through the HTTP claim path', async () => {
    const repository = fakeRepository();
    const app = await buildGateway({
      pool: fakePool(),
      repository,
      authProvider: new FixedAuthProvider(testPrincipal()),
      deliveryWakeSubscriber: noDeliveryWakes,
      ackDeadlineMs: 600_000,
      // The lease cap travels the same path as the deadline: the gateway is the one freezing
      // `ack_deadline_at` when a renewal would exceed the cap, so if it did not reach the store a
      // stuck harness would keep renewing between reaper ticks.
      deliveryLeaseCap: { leaseCapMs: 7_200_000, leaseCapGraceMs: 600_000 },
      outboxPollMs: 60_000
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v3/deliveries/query',
      payload: {
        instance_id: 'http-deadline-consumer', epoch: 7, limit: 4,
        connection_token: ids.claim,
      }
    });

    expect(response.statusCode).toBe(200);
    // The client `limit: 4` no longer reaches the store raw: it is split against the configured
    // budget (2 general + 2 reserved for humans). The POST was the other place an agent's queue
    // could be drained without a cap.
    expect(repository.claimDeliveries).toHaveBeenCalledWith(
      'Pablo', 'midas', 'http-deadline-consumer', 7, 4, 600_000, undefined,
      {
        generalCapacity: 2, humanReservedCapacity: 2, maxClaims: 4,
        requireDeclaredCapacity: true,
      }, ids.claim,
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
    const leaseCap = { leaseCapMs: 7_200_000, leaseCapGraceMs: 600_000 };
    expect(repository.ackDelivery).toHaveBeenNthCalledWith(
      1, ids.delivery, 'Pablo', 'midas', { ...ack, retryable: false }, 600_000, leaseCap
    );
    expect(repository.ackDelivery).toHaveBeenNthCalledWith(
      2, ids.deliveryTwo, 'Pablo', 'midas',
      { ...ack, event_id: ids.eventTwo, retryable: false }, 600_000, leaseCap
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

  it('lets a reader inspect audit and jobs but still requires operator for replay and cancel', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository, testPrincipal({
      roles: roles('agent'),
      permissions: grants('route', 'read', 'control')
    }));

    const [audit, jobs, replay, cancel] = await Promise.all([
      app.inject({ method: 'GET', url: '/v3/console/audit' }),
      app.inject({ method: 'GET', url: '/v3/console/jobs' }),
      app.inject({
        method: 'POST',
        url: `/v3/console/deliveries/${ids.delivery}/replay`,
        headers: { host: 'gateway.test', origin: 'http://gateway.test' }
      }),
      // Cancel moves someone else's terminal state the same way replay does, so it gets the same
      // lock: plain `control` is not enough if the role is not operator.
      app.inject({
        method: 'POST',
        url: `/v3/console/deliveries/${ids.delivery}/cancel`,
        headers: { host: 'gateway.test', origin: 'http://gateway.test' },
        payload: { reason: 'intento sin rol operator' }
      })
    ]);

    expect([audit.statusCode, jobs.statusCode, replay.statusCode, cancel.statusCode])
      .toEqual([200, 200, 403, 403]);
    expect(repository.listAudit).toHaveBeenCalledWith('Pablo', 'midas', { limit: 100, before: null });
    expect(repository.listJobs).toHaveBeenCalledWith('Pablo', 'midas');
    expect(repository.replayDelivery).not.toHaveBeenCalled();
    expect(repository.cancelDelivery).not.toHaveBeenCalled();
  });

  it('passes the operator cancellation reason through to the store as plain text', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository, testPrincipal({
      roles: roles('operator'), permissions: grants('route', 'read', 'control')
    }));

    const cancelled = await app.inject({
      method: 'POST',
      url: `/v3/console/deliveries/${ids.delivery}/cancel`,
      headers: { host: 'gateway.test', origin: 'http://gateway.test' },
      payload: { reason: 'duplicado del árbol roto' }
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ cancelled: true, replayable: true });
    expect(repository.cancelDelivery).toHaveBeenCalledWith(
      ids.delivery, 'Pablo', 'midas', 'duplicado del árbol roto'
    );

    // A reason that is not text is ignored instead of breaking the cancel: the field is
    // decorative and the operation cannot fail because of it.
    const forged = await app.inject({
      method: 'POST',
      url: `/v3/console/deliveries/${ids.delivery}/cancel`,
      headers: { host: 'gateway.test', origin: 'http://gateway.test' },
      payload: { reason: { nested: 'objeto' } }
    });
    expect(forged.statusCode).toBe(200);
    expect(repository.cancelDelivery).toHaveBeenLastCalledWith(
      ids.delivery, 'Pablo', 'midas', undefined
    );
  });

  it('returns only exact mutation receipts and never reflects store-private fields', async () => {
    const repository = fakeRepository();
    vi.mocked(repository.cancelDelivery).mockResolvedValue({
      delivery_id: ids.delivery,
      state: 'dead',
      cancelled: true,
      cancelled_from_state: 'started',
      parent_notice: 'returned',
      origin_relayed: true,
      replayable: true,
      reason: 'private operator reason',
      payload: { text: 'private message' },
    });
    const app = await gateway(repository, testPrincipal({
      roles: roles('operator'), permissions: grants('route', 'read', 'control')
    }));
    const response = await app.inject({
      method: 'POST',
      url: `/v3/console/deliveries/${ids.delivery}/cancel`,
      headers: { host: 'gateway.test', origin: 'http://gateway.test' },
      payload: { reason: 'private operator reason' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      delivery_id: ids.delivery,
      state: 'dead',
      cancelled: true,
      cancelled_from_state: 'started',
      parent_notice: 'returned',
      origin_relayed: true,
      replayable: true,
    });
    expect(response.body).not.toContain('private');
  });

  it('returns 409 instead of a false 2xx when durable mutation receipts are malformed', async () => {
    const repository = fakeRepository();
    vi.mocked(repository.replayDelivery).mockResolvedValue({
      delivery_id: ids.deliveryTwo,
      replayed_from_delivery_id: ids.deliveryTwo,
      state: 'pending',
      replayed: true,
      payload: 'private replay body',
    });
    vi.mocked(repository.cancelDelivery).mockResolvedValue({
      delivery_id: ids.delivery,
      state: 'dead',
      cancelled: true,
      reason: 'private cancel body',
    });
    const app = await gateway(repository, testPrincipal({
      roles: roles('operator'), permissions: grants('route', 'read', 'control')
    }));
    const headers = { host: 'gateway.test', origin: 'http://gateway.test' };

    const replay = await app.inject({
      method: 'POST', url: `/v3/console/deliveries/${ids.delivery}/replay`, headers,
    });
    const cancel = await app.inject({
      method: 'POST', url: `/v3/console/deliveries/${ids.delivery}/cancel`, headers, payload: {},
    });

    expect([replay.statusCode, cancel.statusCode]).toEqual([409, 409]);
    expect(replay.body).not.toContain('private');
    expect(cancel.body).not.toContain('private');
  });

  it('returns 409 and no false publish success for a malformed applied receipt', async () => {
    const repository = fakeRepository();
    vi.mocked(repository.publish).mockResolvedValue({
      message_id: ids.message,
      secret: 'private publish body',
    } as never);
    const app = await gateway(repository, testPrincipal({
      roles: roles('operator'), permissions: grants('route', 'read', 'control')
    }));
    const response = await app.inject({
      method: 'POST',
      url: '/v3/console/messages',
      headers: { host: 'gateway.test', origin: 'http://gateway.test' },
      payload: {
        room_id: 'grp.pablo',
        recipients: [{ tenant_id: 'Pablo', alias: 'midas' }],
        body: { text: 'test' },
        lane: 'interactive',
        priority: 10,
        idempotency_key: 'malformed-receipt-test',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('private');
    expect(response.json()).toMatchObject({ error: 'conflict' });
  });

  it('rejects cross-tenant/actor/request and mixed-ID receipts, but accepts one exact duplicate', async () => {
    const repository = fakeRepository();
    vi.mocked(repository.publish)
      .mockImplementationOnce(async (input) => buildPublishReceipt({
        ...input, tenant_id: 'Steven', actor_alias: 'kant', room_id: 'grp.steven',
      }, {
        message_id: ids.message, delivery_ids: [ids.delivery], duplicate: true,
        request_id: '30000000-0000-4000-8000-000000000011', trace_id: 'other-tenant',
      }))
      .mockImplementationOnce(async (input) => buildPublishReceipt({
        ...input, actor_alias: 'seneca',
      }, {
        message_id: ids.message, delivery_ids: [ids.delivery], duplicate: true,
        request_id: '30000000-0000-4000-8000-000000000012', trace_id: 'other-actor',
      }))
      .mockImplementationOnce(async (input) => buildPublishReceipt({
        ...input, body: { text: 'another semantic request' },
      }, {
        message_id: ids.message, delivery_ids: [ids.delivery], duplicate: true,
        request_id: '30000000-0000-4000-8000-000000000013', trace_id: 'other-request',
      }))
      // Fresh response with another publish's IDs but the original causal digest.
      .mockImplementationOnce(async (input) => ({
        ...buildPublishReceipt(input, {
          message_id: ids.message, delivery_ids: [ids.delivery], duplicate: false,
          request_id: input.request_id, trace_id: input.trace_id,
        }),
        message_id: '10000000-0000-4000-8000-000000000099',
        delivery_ids: ['20000000-0000-4000-8000-000000000099'],
      }))
      // The same mixed-effect attack must fail in the duplicate branch too.
      .mockImplementationOnce(async (input) => ({
        ...buildPublishReceipt(input, {
          message_id: ids.message, delivery_ids: [ids.delivery], duplicate: true,
          request_id: '30000000-0000-4000-8000-000000000014', trace_id: 'original-attempt',
        }),
        delivery_ids: ['20000000-0000-4000-8000-000000000098'],
      }))
      // A self-consistent digest still cannot make alien IDs part of the durable effect.
      .mockImplementationOnce(async (input) => buildPublishReceipt(input, {
        message_id: '10000000-0000-4000-8000-000000000097',
        delivery_ids: ['20000000-0000-4000-8000-000000000097'],
        duplicate: false,
        request_id: input.request_id,
        trace_id: input.trace_id,
      }))
      .mockImplementationOnce(async (input) => buildPublishReceipt(input, {
        message_id: '10000000-0000-4000-8000-000000000096',
        delivery_ids: ['20000000-0000-4000-8000-000000000096'],
        duplicate: true,
        request_id: '30000000-0000-4000-8000-000000000016',
        trace_id: 'alien-original-attempt',
      }))
      .mockImplementationOnce(async (input) => buildPublishReceipt(input, {
        message_id: ids.message,
        delivery_ids: [ids.delivery],
        duplicate: true,
        request_id: '30000000-0000-4000-8000-000000000015',
        trace_id: 'trace-original-attempt',
      }));
    const app = await gateway(repository, testPrincipal({
      roles: roles('operator'), permissions: grants('route', 'read', 'control')
    }));
    const publish = (idempotencyKey: string) => app.inject({
      method: 'POST',
      url: '/v3/console/messages',
      headers: { host: 'gateway.test', origin: 'http://gateway.test' },
      payload: {
        room_id: 'grp.pablo',
        recipients: [{ tenant_id: 'Pablo', alias: 'midas' }],
        body: { text: 'causal receipt' },
        lane: 'interactive',
        priority: 10,
        idempotency_key: idempotencyKey,
      },
    });

    expect((await publish('cross-tenant')).statusCode).toBe(409);
    expect((await publish('cross-actor')).statusCode).toBe(409);
    expect((await publish('cross-request')).statusCode).toBe(409);
    expect((await publish('fresh-mixed-ids')).statusCode).toBe(409);
    expect((await publish('duplicate-mixed-ids')).statusCode).toBe(409);
    expect((await publish('fresh-self-consistent-alien-ids')).statusCode).toBe(409);
    expect((await publish('duplicate-self-consistent-alien-ids')).statusCode).toBe(409);
    const duplicate = await publish('duplicate-causal');
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toMatchObject({
      duplicate: true,
      idempotency_key: 'duplicate-causal',
      trace_id: 'trace-original-attempt',
    });
    expect(repository.verifyPublishReceipt).toHaveBeenCalledTimes(3);
  });

  it('serves the agent registry reads to a principal with read and no operator role', async () => {
    const repository = fakeRepository();
    vi.mocked(repository.getAgent).mockResolvedValue({
      tenant_id: 'Pablo', alias: 'midas', deployment_status: 'disabled'
    });
    const app = await gateway(repository, testPrincipal({
      roles: roles('agent'), permissions: grants('route', 'read', 'control')
    }));

    const [agents, agent] = await Promise.all([
      app.inject({ method: 'GET', url: '/v3/console/agents' }),
      app.inject({ method: 'GET', url: '/v3/console/agents/midas' })
    ]);

    expect([agents.statusCode, agent.statusCode]).toEqual([200, 200]);
    expect(repository.listAgents).toHaveBeenCalledWith('Pablo', 'midas');
    expect(repository.getAgent).toHaveBeenCalledWith('midas', 'Pablo', 'midas');
  });

  it('serves the agent registry reads for an operator', async () => {
    const repository = fakeRepository();
    vi.mocked(repository.getAgent).mockImplementation(async (alias) =>
      alias === 'midas' ? { tenant_id: 'Pablo', alias: 'midas', deployment_status: 'disabled' } : undefined
    );
    const app = await gateway(repository, testPrincipal({
      roles: roles('operator'), permissions: grants('route', 'read', 'control')
    }));

    const agents = await app.inject({ method: 'GET', url: '/v3/console/agents' });
    expect(agents.statusCode).toBe(200);
    expect(repository.listAgents).toHaveBeenCalledWith('Pablo', 'midas');

    const agent = await app.inject({ method: 'GET', url: '/v3/console/agents/midas' });
    expect(agent.statusCode).toBe(200);
    expect(agent.json()).toMatchObject({ tenant_id: 'Pablo', alias: 'midas' });
    expect(repository.getAgent).toHaveBeenCalledWith('midas', 'Pablo', 'midas');

    const missing = await app.inject({ method: 'GET', url: '/v3/console/agents/ghost' });
    expect(missing.statusCode).toBe(404);

    const malformed = await app.inject({ method: 'GET', url: '/v3/console/agents/NotAnAlias' });
    expect(malformed.statusCode).toBe(400);
  });

  it('uses the canonical allow_read target check for a reader and hides denied cross-tenant aliases', async () => {
    const repository = fakeRepository();
    repository.authorizeAgentTarget = vi.fn(async (
      _actorTenant, _actorAlias, targetTenant, targetAlias, permission,
    ) => permission === 'read' && targetTenant === 'Miguel' && targetAlias === 'atlas'
      ? {
          tenant_id: 'Miguel' as const, alias: 'atlas', enabled: true,
          harness_id: 'codex', home_directory: '/home/dev',
        }
      : undefined);
    const app = await gateway(repository, testPrincipal({
      tenant_id: 'Pablo', alias: 'midas', roles: [], permissions: grants('read'),
    }));

    const visible = await app.inject({
      method: 'GET', url: '/v3/console/tenants/Miguel/agents/atlas/documents',
    });
    const hidden = await app.inject({
      method: 'GET', url: '/v3/console/tenants/Isa/agents/salva/documents',
    });

    expect(visible.statusCode).toBe(200);
    expect(hidden.statusCode).toBe(404);
    expect(repository.authorizeAgentTarget).toHaveBeenNthCalledWith(
      1, 'Pablo', 'midas', 'Miguel', 'atlas', 'read',
    );
    expect(repository.authorizeAgentTarget).toHaveBeenNthCalledWith(
      2, 'Pablo', 'midas', 'Isa', 'salva', 'read',
    );
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

  it('admits system.gate.probe only from the exact dedicated mTLS principal and canonical shape', async () => {
    const nonce = '0123456789abcdef0123456789abcdef';
    const payload = {
      room_id: 'grp.steven',
      recipients: [{ tenant_id: 'Steven', alias: 'kant' }],
      body: { type: 'system.gate.probe', nonce, timeout_ms: 5_000 },
      idempotency_key: `gate:Steven:kant:${nonce}`,
      lane: 'interactive',
      priority: -100,
    };
    const exact: Principal = {
      tenant_id: 'Steven', alias: 'gate-probe', session_id: 'gate-probe', channel: 'gate',
      roles: roles('agent'), permissions: grants('route', 'read'),
    };

    const repository = fakeRepository();
    const accepted = await gateGateway(repository, exact);
    expect((await accepted.inject({ method: 'POST', url: '/v3/messages', payload })).statusCode).toBe(202);
    expect(repository.publish).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: 'Steven', actor_alias: 'kant', body: payload.body,
      authenticated_context: { session_id: 'gate-probe', channel: 'gate' },
    }), { requirePreparedConsoleIntent: false });

    const wrongProvider = await gateGateway(fakeRepository(), exact, 'fixed-test');
    expect((await wrongProvider.inject({ method: 'POST', url: '/v3/messages', payload })).statusCode).toBe(403);

    const wrongPrincipal = await gateGateway(fakeRepository(), {
      ...exact, alias: 'quota-collector', roles: roles('operator'), permissions: grants('route', 'read', 'control'),
    });
    expect((await wrongPrincipal.inject({ method: 'POST', url: '/v3/messages', payload })).statusCode).toBe(403);

    const malformed = await gateGateway(fakeRepository(), exact);
    expect((await malformed.inject({
      method: 'POST', url: '/v3/messages', payload: { ...payload, body: { ...payload.body, text: 'forbidden' } },
    })).statusCode).toBe(400);
  });

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
    expect((await denied.inject({ method: 'GET', url: '/v3/console/config' })).statusCode).toBe(200);
    expect(repository.getConfiguration).toHaveBeenCalledWith('Pablo', 'midas');

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
    expect(preview.json()).toMatchObject({ rolled_back_revision_id: null });
    expect(apply.json()).toMatchObject({ rolled_back_revision_id: null });
    expect(rollback.json()).toMatchObject({ rolled_back_revision_id: 1 });
    expect(repository.applyConfigurationChange).toHaveBeenNthCalledWith(1, 'Pablo', 'midas', mutation, true, 0);
    expect(repository.applyConfigurationChange).toHaveBeenNthCalledWith(2, 'Pablo', 'midas', mutation, false, 0);
    expect(repository.rollbackConfiguration).toHaveBeenCalledWith('Pablo', 'midas', 1, false, 1);
  });

  it('rejects malformed configuration receipts after apply and never reflects private extras', async () => {
    const repository = fakeRepository();
    vi.mocked(repository.applyConfigurationChange).mockResolvedValue({
      applied: true,
      dry_run: false,
      revision: 2,
      summary: 'claimed apply without causal mutation',
      secret: 'private config body',
    });
    const app = await gateway(repository, testPrincipal({
      roles: roles('operator'), permissions: grants('route', 'read', 'control')
    }));
    const response = await app.inject({
      method: 'POST',
      url: '/v3/console/config/changes',
      headers: { host: 'gateway.test', origin: 'http://gateway.test' },
      payload: {
        dry_run: false,
        expected_revision: 1,
        mutation: { resource: 'tenant', action: 'update', id: 'Pablo', value: { enabled: true } },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'conflict' });
    expect(response.body).not.toContain('private');
  });

  it('rejects a structurally valid rollback receipt for a different source revision', async () => {
    const repository = fakeRepository();
    const mutation = {
      resource: 'tenant', action: 'update', id: 'Pablo', value: { enabled: true },
    } as const;
    vi.mocked(repository.rollbackConfiguration).mockResolvedValue({
      applied: true,
      dry_run: false,
      revision: 3,
      rolled_back_revision_id: 2,
      summary: 'rollback 2: update tenant Pablo',
      mutation,
      inverse_mutation: mutation,
      secret: 'private config body',
    });
    const app = await gateway(repository, testPrincipal({
      roles: roles('operator'), permissions: grants('route', 'read', 'control'),
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v3/console/config/revisions/1/rollback',
      headers: { host: 'gateway.test', origin: 'http://gateway.test' },
      payload: { dry_run: false, expected_revision: 2 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'conflict' });
    expect(response.body).not.toContain('private');
  });

  it('publishes a server-derived console access snapshot and rejects unknown job handlers', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository, testPrincipal({
      roles: roles('operator'), permissions: grants('route', 'read', 'control')
    }));
    const access = await app.inject({ method: 'GET', url: '/v3/console/access' });
    expect(access.json()).toMatchObject({
      subject: 'Pablo:midas',
      permissions: [
        'message.publish', 'delivery.replay', 'delivery.cancel', 'job.create', 'config.write',
        'config.rollback', 'dlq.resolve'
      ]
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

describe('proactive egress endpoint', () => {
  const notifyBody = {
    destination: 'steven.dm',
    kind: 'task_complete',
    body: 'la tarea larga terminó',
    idempotency_key: 'run-4711'
  };

  it('refuses a principal without the notify permission', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository, testPrincipal({ permissions: grants('route', 'read', 'control') }));
    const response = await app.inject({
      method: 'POST', url: '/v3/egress/notifications',
      headers: { host: 'gateway.test', origin: 'http://gateway.test' },
      payload: notifyBody
    });
    expect(response.statusCode).toBe(403);
    expect(repository.enqueueNotification).not.toHaveBeenCalled();
  });

  it('accepts an allowlisted destination and never lets the caller name a chat', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository, testPrincipal({ permissions: grants('route', 'read', 'notify') }));
    const accepted = await app.inject({
      method: 'POST', url: '/v3/egress/notifications',
      headers: { host: 'gateway.test', origin: 'http://gateway.test' },
      payload: notifyBody
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ notification_id: ids.notification, decision: 'allowed' });
    expect(repository.enqueueNotification).toHaveBeenCalledWith('Pablo', 'midas', {
      ...notifyBody, dry_run: false
    });

    for (const forbiddenField of [
      { conversation_id: '-100123' }, { tenant_id: 'Steven' }, { alias: 'argos' },
      { origin: { adapter: 'telegram' } }, { room_id: 'grp.steven' }
    ]) {
      const rejected = await app.inject({
        method: 'POST', url: '/v3/egress/notifications',
        headers: { host: 'gateway.test', origin: 'http://gateway.test' },
        payload: { ...notifyBody, ...forbiddenField }
      });
      expect(rejected.statusCode).toBe(400);
    }
  });

  it('surfaces a policy denial as 403 with its durable denial code', async () => {
    const repository = fakeRepository();
    repository.enqueueNotification = vi.fn(async () => ({
      notification_id: ids.notification,
      decision: 'denied' as const,
      denial_code: 'cold_contact' as const,
      duplicate: false,
      dry_run: false
    }));
    const app = await gateway(repository, testPrincipal({ permissions: grants('route', 'read', 'notify') }));
    const response = await app.inject({
      method: 'POST', url: '/v3/egress/notifications',
      headers: { host: 'gateway.test', origin: 'http://gateway.test' },
      payload: notifyBody
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'forbidden', denial_code: 'cold_contact' });
  });

  it('advertises message.notify and lists notifications for the reader tenant only', async () => {
    const repository = fakeRepository();
    repository.principalAccess = vi.fn(async () => ({
      roles: ['agent'],
      permissions: ['route', 'read', 'notify'] as Permission[]
    }));
    repository.listNotifications = vi.fn(async () => ({
      items: [
        { id: ids.notification, tenant_id: 'Pablo', alias: 'midas', decision: 'denied' },
        { id: ids.outbox, tenant_id: 'Steven', alias: 'argos', decision: 'allowed' }
      ]
    }));
    const app = await gateway(repository, testPrincipal({ permissions: grants('route', 'read', 'notify') }));
    expect((await app.inject({ method: 'GET', url: '/v3/console/access' })).json())
      .toMatchObject({ permissions: ['message.publish', 'message.notify'] });

    const listed = await app.inject({ method: 'GET', url: '/v3/console/egress/notifications' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      items: [{ id: ids.notification, tenant_id: 'Pablo', alias: 'midas', decision: 'denied' }]
    });
  });
});
