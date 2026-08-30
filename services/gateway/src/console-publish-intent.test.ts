import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPublishReceipt, ConsolePublishIntentPrepareResultSchema, HUMAN_CHAT_PRIORITY,
  type ConsolePublishIntentCommand, type PublishMessage,
} from '@cauce/protocol';
import {
  PublishIntentExpiredError, PublishIntentRateLimitedError,
  PublishIntentReconciliationRequired, type DatabasePool,
} from '@cauce/store';
import { buildGateway, type GatewayRepository } from './app.js';
import {
  DevOnlyAuthProvider, type AuthProvider, type Principal,
} from './auth.js';
import { ConsolePublishTelemetry } from './console-publish-telemetry.js';

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];

function pool(): DatabasePool {
  return {
    query: vi.fn(async () => ({ rows: [{ ssl: true }], rowCount: 1 })),
  } as unknown as DatabasePool;
}

async function gateway(options: {
  authProvider?: AuthProvider;
  expired?: boolean;
  rateLimited?: number;
  reconciliation?: boolean;
  telemetry?: ConsolePublishTelemetry;
} = {}): Promise<{
  app: Awaited<ReturnType<typeof buildGateway>>;
  prepares: ConsolePublishIntentCommand[];
  prepareScopes: string[];
  publishes: {
    command: PublishMessage;
    options: {
      readonly requirePreparedConsoleIntent?: boolean;
      readonly consoleIntentOperatorScope?: string;
    } | undefined;
  }[];
  confirmations: unknown[];
}> {
  const prepares: ConsolePublishIntentCommand[] = [];
  const prepareScopes: string[] = [];
  const publishes: {
    command: PublishMessage;
    options: {
      readonly requirePreparedConsoleIntent?: boolean;
      readonly consoleIntentOperatorScope?: string;
    } | undefined;
  }[] = [];
  const confirmations: unknown[] = [];
  const app = await buildGateway({
    pool: pool(),
    authProvider: options.authProvider ?? DevOnlyAuthProvider.forTests(),
    ...(options.telemetry === undefined ? {} : { consolePublishTelemetry: options.telemetry }),
    repository: {
      claimOutbox: vi.fn(async () => []),
      prepareConsolePublishIntent: vi.fn(async (
        input: ConsolePublishIntentCommand,
        operatorScopeHash: string,
      ) => {
        prepares.push(input);
        prepareScopes.push(operatorScopeHash);
        if (options.rateLimited !== undefined) {
          throw new PublishIntentRateLimitedError(options.rateLimited);
        }
        if (options.reconciliation === true) {
          const {
            intent_nonce: _intentNonce,
            requested_priority: _requestedPriority,
            ...publishable
          } = input;
          void _intentNonce;
          void _requestedPriority;
          const receiptCommand: PublishMessage = {
            ...publishable,
            idempotency_key: 'console:committed-key',
          };
          const receipt = buildPublishReceipt(receiptCommand, {
            message_id: '33333333-3333-4333-8333-333333333333',
            delivery_ids: ['44444444-4444-4444-8444-444444444444'],
            duplicate: false,
            request_id: input.request_id,
            trace_id: input.trace_id,
          });
          throw new PublishIntentReconciliationRequired({
            version: 1,
            error: 'publish_intent_reconciliation_required',
            state: 'committed',
            idempotency_key: receipt.idempotency_key,
            receipt,
          });
        }
        return {
          version: 1 as const,
          state: 'prepared' as const,
          idempotency_key: 'console:server-generated-key',
          receipt: null,
        };
      }),
      publish: vi.fn(async (
        input: PublishMessage,
        publishOptions?: {
          readonly requirePreparedConsoleIntent?: boolean;
          readonly consoleIntentOperatorScope?: string;
        },
      ) => {
        publishes.push({ command: input, options: publishOptions });
        if (options.expired === true) throw new PublishIntentExpiredError(input.idempotency_key);
        return buildPublishReceipt(input, {
          message_id: '11111111-1111-4111-8111-111111111111',
          delivery_ids: ['22222222-2222-4222-8222-222222222222'],
          duplicate: false,
          request_id: input.request_id,
          trace_id: input.trace_id,
        });
      }),
      verifyPublishReceipt: vi.fn(async () => true),
      confirmConsolePublishIntent: vi.fn(async (
        tenantId: string,
        actorAlias: string,
        operatorScopeHash: string,
        input: { idempotency_key: string; message_id: string; causal_hash: string },
      ) => {
        confirmations.push({ tenantId, actorAlias, operatorScopeHash, input });
        return { version: 1 as const, confirmed: true as const, ...input };
      }),
    } as unknown as GatewayRepository,
    deliveryWakeSubscriber: async () => async () => undefined,
    exposeHealthRoutes: false,
    consoleOrigins: ['http://localhost'],
    logger: false,
  });
  apps.push(app);
  return { app, prepares, prepareScopes, publishes, confirmations };
}

const headers = {
  'x-cauce-tenant': 'Steven',
  'x-cauce-alias': 'kant',
  origin: 'http://localhost',
};

const semantic = {
  room_id: 'grp.steven',
  recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
  body: { text: 'same effective priority' },
  lane: 'interactive',
  priority: 10,
} as const;

function preparePayload(intentNonce = randomUUID()) {
  return { ...semantic, intent_nonce: intentNonce };
}

function fixedOperatorAuth(operatorId: string, channel = 'password'): AuthProvider {
  const principal: Principal = {
    tenant_id: 'Steven',
    alias: 'kant',
    session_id: `session:${operatorId}`,
    channel,
    roles: ['operator'],
    permissions: ['route', 'read', 'control'],
    operator_id: operatorId,
  };
  return {
    name: 'test-operator',
    mode: 'test',
    authenticateHttp: vi.fn(async () => principal),
    authenticateHello: vi.fn(async () => principal),
  };
}

function fixedMachineAuth(channel: string): AuthProvider {
  const principal: Principal = {
    tenant_id: 'Steven',
    alias: 'kant',
    session_id: `machine-session:${channel}`,
    channel,
    roles: ['agent'],
    permissions: ['route', 'read'],
  };
  return {
    name: 'test-machine',
    mode: 'test',
    authenticateHttp: vi.fn(async () => principal),
    authenticateHello: vi.fn(async () => principal),
  };
}

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

describe('console publish-intent endpoints', () => {
  it('normalizes prepare and publish to the same authenticated human priority', async () => {
    const { app, prepares, prepareScopes, publishes } = await gateway();
    const prepared = await app.inject({
      method: 'POST',
      url: '/v3/console/publish-intents',
      headers,
      payload: preparePayload(),
    });
    expect(prepared.statusCode).toBe(200);
    const preparedBody = ConsolePublishIntentPrepareResultSchema.parse(prepared.json());
    expect(preparedBody).toEqual({
      version: 1,
      state: 'prepared',
      idempotency_key: 'console:server-generated-key',
      receipt: null,
    });
    expect(prepares[0]).toMatchObject({
      tenant_id: 'Steven',
      actor_alias: 'kant',
      priority: HUMAN_CHAT_PRIORITY,
      requested_priority: 10,
      authenticated_context: { channel: 'dev' },
    });
    expect(Object.hasOwn(prepares[0] ?? {}, 'idempotency_key')).toBe(false);
    expect(prepares[0]?.intent_nonce).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(prepareScopes[0]).toMatch(/^[0-9a-f]{64}$/u);

    const published = await app.inject({
      method: 'POST',
      url: '/v3/console/messages',
      headers,
      payload: { ...semantic, idempotency_key: preparedBody.idempotency_key },
    });
    expect(published.statusCode).toBe(202);
    expect(publishes[0]?.command.priority).toBe(HUMAN_CHAT_PRIORITY);
    expect(publishes[0]?.options).toEqual({
      requirePreparedConsoleIntent: true,
      consoleIntentOperatorScope: prepareScopes[0],
    });
  });

  it('keeps machine publish outside the console-intent gate', async () => {
    const { app, publishes } = await gateway();
    const response = await app.inject({
      method: 'POST',
      url: '/v3/messages',
      headers,
      payload: { ...semantic, idempotency_key: 'machine-owned-key' },
    });
    expect(response.statusCode).toBe(202);
    expect(publishes[0]?.options).toEqual({ requirePreparedConsoleIntent: false });
  });

  it('authenticates both endpoints and rejects non-exact request contracts', async () => {
    const { app, prepares, confirmations } = await gateway();
    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/v3/console/publish-intents',
      headers: { origin: 'http://localhost' },
      payload: preparePayload(),
    });
    expect(unauthenticated.statusCode).toBe(401);

    for (const payload of [
      { ...preparePayload(), idempotency_key: 'caller-chosen' },
      { ...preparePayload(), actor_alias: 'kant' },
      { ...preparePayload(), unexpected: true },
      { ...semantic, intent_nonce: 'not-a-uuid-v4' },
    ]) {
      const response = await app.inject({
        method: 'POST', url: '/v3/console/publish-intents', headers, payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(prepares).toHaveLength(0);

    const invalidConfirm = await app.inject({
      method: 'POST',
      url: '/v3/console/publish-intents/confirm',
      headers,
      payload: {
        idempotency_key: 'console:server-generated-key',
        message_id: '11111111-1111-4111-8111-111111111111',
        causal_hash: 'a'.repeat(64),
        unexpected: true,
      },
    });
    expect(invalidConfirm.statusCode).toBe(400);
    expect(confirmations).toHaveLength(0);

    const confirmed = await app.inject({
      method: 'POST',
      url: '/v3/console/publish-intents/confirm',
      headers,
      payload: {
        idempotency_key: 'console:server-generated-key',
        message_id: '11111111-1111-4111-8111-111111111111',
        causal_hash: 'a'.repeat(64),
      },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toEqual({
      version: 1,
      confirmed: true,
      idempotency_key: 'console:server-generated-key',
      message_id: '11111111-1111-4111-8111-111111111111',
      causal_hash: 'a'.repeat(64),
    });
    expect(confirmations).toHaveLength(1);
  });

  it('returns the exact structured 409 for committed reconciliation', async () => {
    const { app } = await gateway({ reconciliation: true });
    const response = await app.inject({
      method: 'POST',
      url: '/v3/console/publish-intents',
      headers,
      payload: preparePayload(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      version: 1,
      error: 'publish_intent_reconciliation_required',
      state: 'committed',
      idempotency_key: 'console:committed-key',
      receipt: {
        idempotency_key: 'console:committed-key',
        tenant_id: 'Steven',
        actor_alias: 'kant',
      },
    });
    expect(Object.keys(response.json()).sort()).toEqual([
      'error', 'idempotency_key', 'receipt', 'state', 'version',
    ]);
  });

  it('returns exact actionable expiry and durable rate-limit responses', async () => {
    const telemetry = new ConsolePublishTelemetry();
    const expiredGateway = await gateway({ expired: true, telemetry });
    const expired = await expiredGateway.app.inject({
      method: 'POST',
      url: '/v3/console/messages',
      headers,
      payload: { ...semantic, idempotency_key: 'console:expired-key' },
    });
    expect(expired.statusCode).toBe(410);
    expect(expired.json()).toEqual({
      version: 1,
      error: 'publish_intent_expired',
      state: 'expired',
      idempotency_key: 'console:expired-key',
      safe_to_resubmit: true,
    });

    const limitedGateway = await gateway({ rateLimited: 86_123, telemetry });
    const limited = await limitedGateway.app.inject({
      method: 'POST',
      url: '/v3/console/publish-intents',
      headers,
      payload: preparePayload(),
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('86123');
    expect(limited.json()).toEqual({
      version: 1,
      error: 'publish_intent_rate_limited',
      retry_after_seconds: 86_123,
      safe_to_retry: true,
    });
    expect(telemetry.snapshot()['publish:expired']).toBe(1);
    expect(telemetry.snapshot()['publish:error']).toBe(0);
    expect(telemetry.snapshot()['prepare:rate_limited']).toBe(1);
    expect(telemetry.snapshot()['prepare:error']).toBe(0);
  });

  it('derives a stable scope from operator identity, not alias or session', async () => {
    const firstGateway = await gateway({ authProvider: fixedOperatorAuth('operator-one') });
    const secondGateway = await gateway({ authProvider: fixedOperatorAuth('operator-two') });
    const firstResponse = await firstGateway.app.inject({
      method: 'POST', url: '/v3/console/publish-intents', headers, payload: preparePayload(),
    });
    const retryResponse = await firstGateway.app.inject({
      method: 'POST', url: '/v3/console/publish-intents', headers, payload: preparePayload(),
    });
    const secondResponse = await secondGateway.app.inject({
      method: 'POST', url: '/v3/console/publish-intents', headers, payload: preparePayload(),
    });
    expect([firstResponse.statusCode, retryResponse.statusCode, secondResponse.statusCode])
      .toEqual([200, 200, 200]);
    expect(firstGateway.prepareScopes[0]).toBe(firstGateway.prepareScopes[1]);
    expect(firstGateway.prepareScopes[0]).not.toBe(secondGateway.prepareScopes[0]);
    for (const scope of [...firstGateway.prepareScopes, ...secondGateway.prepareScopes]) {
      expect(scope).toMatch(/^[0-9a-f]{64}$/u);
      expect(scope).not.toContain('operator-');
    }
  });

  it('separates the compatibility fallback by authenticated machine channel', async () => {
    const mtls = await gateway({ authProvider: fixedMachineAuth('mtls') });
    const token = await gateway({ authProvider: fixedMachineAuth('token-file') });
    await mtls.app.inject({
      method: 'POST', url: '/v3/console/publish-intents', headers, payload: preparePayload(),
    });
    await token.app.inject({
      method: 'POST', url: '/v3/console/publish-intents', headers, payload: preparePayload(),
    });
    expect(mtls.prepareScopes[0]).toMatch(/^[0-9a-f]{64}$/u);
    expect(token.prepareScopes[0]).toMatch(/^[0-9a-f]{64}$/u);
    expect(mtls.prepareScopes[0]).not.toBe(token.prepareScopes[0]);
  });
});
