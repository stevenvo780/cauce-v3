import { http, HttpResponse } from 'msw';
import {
  CauceApi, PublishIntentExpiredError, PublishIntentRateLimitedError,
  PublishIntentReconciliationError,
} from './client';
import type { ConfirmPublishIntentInput, PreparePublishIntentInput, PublishMessageInput } from './types';
import { agentClient } from './client/agent-client';
import { messagingClient } from './client/messaging-client';
import { systemClient, type RequestFn } from './client/system-client';
import { server } from '../mocks/server';

const nunca: RequestFn = () => new Promise<never>(() => undefined);
const metodosDeLosModulos = [systemClient(nunca), messagingClient(nunca), agentClient(nunca)]
  .flatMap((modulo) => Object.keys(modulo));

describe('CauceApi', () => {
  it('expone en la instancia cada método de los tres módulos, atado a SU propio request', async () => {
    // `Object.assign` en el constructor pone los métodos en la instancia, no en el prototipo: si un
    // módulo deja de mezclarse el tipo sigue compilando y la vista revienta en tiempo de ejecución.
    const api = new CauceApi();
    expect(metodosDeLosModulos).toHaveLength(30);
    for (const nombre of metodosDeLosModulos) {
      expect(typeof (api as unknown as Record<string, unknown>)[nombre]).toBe('function');
    }

    const rutas: string[] = [];
    const fetcher = ((entrada: RequestInfo | URL) => {
      rutas.push(new URL(entrada instanceof Request ? entrada.url : entrada).pathname);
      return Promise.resolve(new Response('{}', {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }) as typeof fetch;
    const atada = new CauceApi('http://localhost', fetcher);
    await Promise.all([atada.getStatus(), atada.listMessages(), atada.getFleetActivity()]);

    expect(rutas).toEqual(['/v3/status', '/v3/console/messages', '/v3/console/activity']);
  });

  it('uses cookie credentials and strips client identity fields from publish', async () => {
    let observed: Record<string, unknown> = {};
    let credentials: RequestCredentials | undefined;
    let authorization: string | null = null;
    let csrf: string | null = null;
    server.use(http.post('http://localhost/v3/console/messages', async ({ request }) => {
      observed = await request.json() as Record<string, unknown>;
      credentials = request.credentials;
      authorization = request.headers.get('authorization');
      csrf = request.headers.get('x-csrf-token');
      return HttpResponse.json({ message_id: 'msg-1' }, { status: 202 });
    }));
    const api = new CauceApi('http://localhost');
    const hostileInput = {
      room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: 'argos' }], body: { text: 'hola' },
      lane: 'interactive', priority: 10, idempotency_key: 'test-key', actor_alias: 'forged', session_id: 'forged', channel: 'forged',
    } as PublishMessageInput & Record<string, unknown>;

    await api.publishMessage(hostileInput);

    expect(credentials).toBe('include');
    expect(authorization).toBeNull();
    expect(csrf).toBe('mock-csrf-token');
    expect(observed).toEqual({
      room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: 'argos' }], body: { text: 'hola' },
      lane: 'interactive', priority: 10, idempotency_key: 'test-key',
    });
    expect(observed).not.toHaveProperty('actor_alias');
    expect(observed).not.toHaveProperty('session_id');
    expect(observed).not.toHaveProperty('channel');
  });

  it('keeps OIDC session and CSRF state in memory and logs out without bearer credentials', async () => {
    const requests: { path: string; csrf: string | null; authorization: string | null }[] = [];
    server.use(
      http.get('http://localhost/v3/auth/session', () => HttpResponse.json({
        authenticated: true, subject: 'Steven:kant', csrf_token: 'one-time-browser-csrf',
      })),
      http.post('http://localhost/v3/auth/logout', ({ request }) => {
        requests.push({
          path: new URL(request.url).pathname,
          csrf: request.headers.get('x-csrf-token'),
          authorization: request.headers.get('authorization'),
        });
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const api = new CauceApi('http://localhost');

    expect(await api.getAuthSession()).toMatchObject({ authenticated: true, subject: 'Steven:kant' });
    await api.logout();

    expect(requests).toEqual([{
      path: '/v3/auth/logout', csrf: 'one-time-browser-csrf', authorization: null,
    }]);
  });

  it('allowlists durable intent preparation and confirmation without client identity fields', async () => {
    const observed: unknown[] = [];
    server.use(
      http.post('http://localhost/v3/console/publish-intents', async ({ request }) => {
        observed.push(await request.json());
        return HttpResponse.json({
          version: 1, state: 'prepared', idempotency_key: 'server-key', receipt: null,
        });
      }),
      http.post('http://localhost/v3/console/publish-intents/confirm', async ({ request }) => {
        const input = await request.json() as Record<string, unknown>;
        observed.push(input);
        return HttpResponse.json({ version: 1, confirmed: true, ...input });
      }),
    );
    const api = new CauceApi('http://localhost');
    await api.preparePublishIntent({
      room_id: 'grp.steven',
      recipients: [{ tenant_id: 'Steven', alias: 'argos', forged: true }],
      body: { text: 'hola', forged: true },
      lane: 'interactive',
      priority: 10,
      intent_nonce: 'a0000000-0000-4000-8000-000000000001',
      actor_alias: 'forged',
    } as unknown as PreparePublishIntentInput & Record<string, unknown>);
    await api.confirmPublishIntent({
      idempotency_key: 'server-key',
      message_id: 'a0000000-0000-4000-8000-000000000001',
      causal_hash: 'b'.repeat(64),
      actor_alias: 'forged',
    } as ConfirmPublishIntentInput & Record<string, unknown>);

    expect(observed).toEqual([
      {
        room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
        body: { text: 'hola' }, lane: 'interactive', priority: 10,
        intent_nonce: 'a0000000-0000-4000-8000-000000000001',
      },
      {
        idempotency_key: 'server-key',
        message_id: 'a0000000-0000-4000-8000-000000000001',
        causal_hash: 'b'.repeat(64),
      },
    ]);
  });

  it('preserves only an exact reconciliation 409 as a typed durable receipt', async () => {
    const receipt = {
      message_id: '10000000-0000-4000-8000-000000000001',
      delivery_ids: ['20000000-0000-4000-8000-000000000001'],
      duplicate: false,
      request_id: '30000000-0000-4000-8000-000000000001',
      trace_id: 'trace-reconciliation',
      idempotency_key: 'server-key',
      tenant_id: 'Steven', actor_alias: 'kant',
      request_hash: 'a'.repeat(64), causal_hash: 'b'.repeat(64),
    };
    server.use(http.post('http://localhost/v3/console/publish-intents', () => HttpResponse.json({
      version: 1,
      error: 'publish_intent_reconciliation_required',
      state: 'committed',
      idempotency_key: 'server-key',
      receipt,
    }, { status: 409 })));
    const api = new CauceApi('http://localhost');

    const request = api.preparePublishIntent({
      room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
      body: { text: 'hola' }, lane: 'interactive', priority: 10,
      intent_nonce: 'a0000000-0000-4000-8000-000000000001',
    });
    await expect(request).rejects.toBeInstanceOf(PublishIntentReconciliationError);
    await expect(request).rejects.toMatchObject({ reconciliation: { receipt } });
  });

  it('does not bless a reconciliation 409 with extra fields', async () => {
    server.use(http.post('http://localhost/v3/console/publish-intents', () => HttpResponse.json({
      version: 1,
      error: 'publish_intent_reconciliation_required',
      state: 'committed',
      idempotency_key: 'server-key',
      receipt: {},
      body: 'must-not-cross-the-contract',
    }, { status: 409 })));
    const api = new CauceApi('http://localhost');

    const request = api.preparePublishIntent({
      room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
      body: { text: 'hola' }, lane: 'interactive', priority: 10,
      intent_nonce: 'a0000000-0000-4000-8000-000000000001',
    });
    await expect(request).rejects.toMatchObject({
      name: 'ApiError', status: 409, code: 'publish_intent_reconciliation_required',
    });
    await expect(request).rejects.not.toBeInstanceOf(PublishIntentReconciliationError);
  });

  it('preserves only an exact expired 410 as a safe-to-resubmit typed error', async () => {
    server.use(http.post('http://localhost/v3/console/messages', () => HttpResponse.json({
      version: 1,
      error: 'publish_intent_expired',
      state: 'expired',
      idempotency_key: 'server-key',
      safe_to_resubmit: true,
    }, { status: 410 })));
    const api = new CauceApi('http://localhost');

    const request = api.publishMessage({
      room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
      body: { text: 'hola' }, lane: 'interactive', priority: 10, idempotency_key: 'server-key',
    });
    await expect(request).rejects.toBeInstanceOf(PublishIntentExpiredError);
    await expect(request).rejects.toMatchObject({
      status: 410,
      expiration: { idempotency_key: 'server-key', safe_to_resubmit: true },
    });
  });

  it('rejects extra fields in an expired 410 instead of blessing it as safe', async () => {
    server.use(http.post('http://localhost/v3/console/messages', () => HttpResponse.json({
      version: 1,
      error: 'publish_intent_expired',
      state: 'expired',
      idempotency_key: 'server-key',
      safe_to_resubmit: true,
      receipt: {},
    }, { status: 410 })));
    const request = new CauceApi('http://localhost').publishMessage({
      room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
      body: { text: 'hola' }, lane: 'interactive', priority: 10, idempotency_key: 'server-key',
    });

    await expect(request).rejects.toMatchObject({ name: 'ApiError', status: 410 });
    await expect(request).rejects.not.toBeInstanceOf(PublishIntentExpiredError);
  });

  it('preserves only an exact prepare 429 with a bounded retry delay', async () => {
    server.use(http.post('http://localhost/v3/console/publish-intents', () => HttpResponse.json({
      version: 1,
      error: 'publish_intent_rate_limited',
      retry_after_seconds: 86_400,
      safe_to_retry: true,
    }, { status: 429 })));
    const request = new CauceApi('http://localhost').preparePublishIntent({
      room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
      body: { text: 'hola' }, lane: 'interactive', priority: 10,
      intent_nonce: 'a0000000-0000-4000-8000-000000000001',
    });

    await expect(request).rejects.toBeInstanceOf(PublishIntentRateLimitedError);
    await expect(request).rejects.toMatchObject({ rateLimit: { retry_after_seconds: 86_400 } });
  });

  it('treats a missing PTY backend as disabled', async () => {
    server.use(http.get('http://localhost/v3/console/terminal/capability', () => new HttpResponse(null, { status: 404 })));
    const capability = await new CauceApi('http://localhost').getTerminalCapability();
    expect(capability).toEqual({ available: false, reason: 'Backend PTY no disponible' });
  });

  it('distinguishes an absent agent from an unpublished directive or history endpoint', async () => {
    server.use(
      http.get('http://localhost/v3/console/agents/:tenant/:alias/directive', () => HttpResponse.json(
        { error: 'not_found', message: 'agent not found or not visible' }, { status: 404 },
      )),
      http.get('http://localhost/v3/console/role-assignments/:tenant/:alias/history', () => HttpResponse.json(
        { error: 'not_found', message: 'agent not found or not visible' }, { status: 404 },
      )),
    );
    const api = new CauceApi('http://localhost');

    await expect(api.getAgentDirective('Steven', 'missing')).rejects.toMatchObject({
      status: 404, code: 'not_found', message: 'agent not found or not visible',
    });
    await expect(api.getRoleBriefHistory('Steven', 'missing')).rejects.toMatchObject({
      status: 404, code: 'not_found', message: 'agent not found or not visible',
    });

    server.use(
      http.get('http://localhost/v3/console/agents/:tenant/:alias/directive', () =>
        new HttpResponse(null, { status: 404 })),
      http.get('http://localhost/v3/console/role-assignments/:tenant/:alias/history', () =>
        new HttpResponse(null, { status: 404 })),
    );
    await expect(api.getAgentDirective('Steven', 'missing')).resolves.toMatchObject({ publicado: false });
    await expect(api.getRoleBriefHistory('Steven', 'missing')).resolves.toMatchObject({ publicado: false });
  });

  it('passes only a bounded opaque DLQ cursor and rejects malformed pagination locally', async () => {
    let query = '';
    server.use(http.get('http://localhost/v3/console/dlq', ({ request }) => {
      query = new URL(request.url).search;
      return HttpResponse.json({ schemaVersion: 1, items: [], total: 0, truncated: false, nextCursor: null });
    }));
    const api = new CauceApi('http://localhost');

    await api.getDlq(50, 'ab12');
    expect(query).toBe('?limit=50&cursor=ab12');
    expect(() => api.getDlq(0)).toThrow(/between 1 and 500/i);
    expect(() => api.getDlq(50, '__proto__')).toThrow(/hexadecimal/i);
    expect(() => api.getDlq(50, 'abc')).toThrow(/hexadecimal/i);
  });

  it('sends revision-guarded config dry-runs and rollback without client authority', async () => {
    const observed: Record<string, unknown>[] = [];
    server.use(
      http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
        observed.push(await request.json() as Record<string, unknown>);
        return HttpResponse.json({ applied: false, dry_run: true, revision: 7 });
      }),
      http.post('http://localhost/v3/console/config/revisions/:revision/rollback', async ({ request }) => {
        observed.push(await request.json() as Record<string, unknown>);
        return HttpResponse.json({ applied: true, revision: 8 }, { status: 201 });
      }),
    );
    const api = new CauceApi('http://localhost');
    await api.changeConfiguration({
      resource: 'acl_edge', action: 'create', from_tenant: 'Isa', to_tenant: 'Steven',
      value: { allow_route: false }
    }, { dryRun: true, expectedRevision: 7 });
    await api.rollbackConfiguration('7', { dryRun: false, expectedRevision: 7 });
    expect(observed).toEqual([
      {
        dry_run: true, expected_revision: 7,
        mutation: { resource: 'acl_edge', action: 'create', from_tenant: 'Isa', to_tenant: 'Steven', value: { allow_route: false } }
      },
      { dry_run: false, expected_revision: 7 }
    ]);
  });
});
