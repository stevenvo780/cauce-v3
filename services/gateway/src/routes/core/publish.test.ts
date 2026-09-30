import { afterEach, describe, expect, it } from 'vitest';
import { blobArtifactUri, blobLocator, buildPublishReceipt, type PublishMessage } from '@cauce/protocol';
import { AgentRootLimitError, type PublishOptions } from '@cauce/store';
import type { buildGateway } from '../../app.js';
import { DevOnlyAuthProvider, type PrincipalRole } from '../../auth.js';
import { ConsolePublishTelemetry } from '../../console-publish-telemetry.js';
import {
  buildTestGateway, fakePool, fakeRepository,
} from '../../test-support/gateway-doubles.js';

/**
 * The publish choke point: one handler serves the machine route and the console route. Whatever
 * the store answers, a 2xx is only credited for the exact durable receipt of THIS invocation;
 * anything else forces reconciliation by read with a 409.
 */

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const DELIVERY_ID = '22222222-2222-4222-8222-222222222222';
const DELIVERY_TWO = '22222222-2222-4222-8222-222222222223';

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

interface PublishCall {
  readonly command: PublishMessage;
  readonly options?: PublishOptions;
}

async function gateway(options: {
  readonly publish?: (input: PublishMessage) => Promise<unknown>;
  readonly verify?: (command: PublishMessage, receipt: never) => Promise<boolean>;
  readonly telemetry?: ConsolePublishTelemetry;
  readonly routePermission?: boolean;
  readonly roles?: readonly PrincipalRole[];
} = {}): Promise<{
  app: Awaited<ReturnType<typeof buildGateway>>;
  calls: PublishCall[];
  telemetry: ConsolePublishTelemetry;
}> {
  const calls: PublishCall[] = [];
  const telemetry = options.telemetry ?? new ConsolePublishTelemetry();
  const app = await buildTestGateway({
    pool: fakePool({ ssl: true }),
    authProvider: DevOnlyAuthProvider.forTests(options.routePermission === false
      ? { roles: ['operator'], permissions: ['read'] }
      : options.roles === undefined ? {} : { roles: options.roles, permissions: ['route', 'read'] }),
    consolePublishTelemetry: telemetry,
    repository: fakeRepository({
      publish: (async (input: PublishMessage, publishOptions?: PublishOptions) => {
        calls.push({ command: input, ...(publishOptions === undefined ? {} : { options: publishOptions }) });
        if (options.publish !== undefined) return options.publish(input);
        return buildPublishReceipt(input, {
          message_id: MESSAGE_ID,
          delivery_ids: [DELIVERY_ID],
          duplicate: false,
          request_id: input.request_id,
          trace_id: input.trace_id,
        });
      }) as never,
      verifyPublishReceipt: (async (
        command: PublishMessage, receipt: never,
      ) => (options.verify === undefined ? true : options.verify(command, receipt))),
    }),
  });
  apps.push(app);
  return { app, calls, telemetry };
}

const HEADERS = {
  'x-cauce-tenant': 'Steven',
  'x-cauce-alias': 'kant',
  origin: 'http://localhost',
};

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    room_id: 'grp.steven',
    recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }],
    body: { text: 'contrato de publish' },
    idempotency_key: 'publish-contrato-1',
    lane: 'interactive',
    priority: 0,
    ...overrides,
  };
}

describe('POST /v3/messages validation', () => {
  it('rejects a body outside the public contract before the store sees it', async () => {
    const { app, calls } = await gateway();
    for (const invalid of [
      payload({ recipients: undefined }),
      payload({ body: undefined }),
      payload({ idempotency_key: '' }),
      payload({ actor_alias: 'suplantado' }),
      payload({ tenant_id: 'Pablo' }),
      [],
    ]) {
      const response = await app.inject({
        method: 'POST', url: '/v3/messages', headers: HEADERS, payload: invalid,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBe('invalid_request');
    }
    expect(calls).toEqual([]);
  });

  it('rejects an artifacts_v1 blob/uri split before persisting or granting it', async () => {
    const { app, calls } = await gateway();
    const response = await app.inject({
      method: 'POST', url: '/v3/messages', headers: HEADERS,
      payload: payload({ body: { artifacts_v1: [{
        name: 'foreign.txt', blob: blobLocator('a'.repeat(64)), uri: blobArtifactUri('b'.repeat(64)),
      }] } }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('invalid_request');
    expect(calls).toEqual([]);
  });

  it('rejects a whitespace or BOM prefixed blob URI before the store sees it', async () => {
    const { app, calls } = await gateway();
    for (const prefix of [' ', '\uFEFF', ' \uFEFF\t']) {
      const response = await app.inject({
        method: 'POST', url: '/v3/messages', headers: HEADERS,
        payload: payload({ body: { artifacts_v1: [{
          name: 'poison.txt', uri: `${prefix}${blobArtifactUri('a'.repeat(64))}`,
          sha256: 'b'.repeat(64),
        }] } }),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBe('invalid_request');
    }
    expect(calls).toEqual([]);
  });

  it('requires the route permission and touches nothing without it', async () => {
    const { app, calls } = await gateway({ routePermission: false });
    const response = await app.inject({
      method: 'POST', url: '/v3/messages', headers: HEADERS, payload: payload(),
    });

    expect(response.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('answers 409, never 2xx, when the receipt is not the effect of this invocation', async () => {
    const { app, calls } = await gateway({
      publish: async (input) => {
        const receipt = buildPublishReceipt(input, {
          message_id: MESSAGE_ID,
          delivery_ids: [DELIVERY_ID],
          duplicate: false,
          request_id: input.request_id,
          trace_id: input.trace_id,
        });
        // The IDs of another publish stitched onto this request: it parses, but the causal
        // binding the gateway recomputes no longer holds.
        return { ...receipt, message_id: '99999999-9999-4999-8999-999999999999' };
      },
    });
    const response = await app.inject({
      method: 'POST', url: '/v3/messages', headers: HEADERS, payload: payload(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'conflict', message: 'publish did not return an exact durable receipt',
    });
    expect(calls).toHaveLength(1);
  });

  it('answers 409 when the delivery set does not cover every recipient', async () => {
    const { app } = await gateway({
      publish: async (input) => buildPublishReceipt(input, {
        message_id: MESSAGE_ID,
        delivery_ids: [DELIVERY_ID],
        duplicate: false,
        request_id: input.request_id,
        trace_id: input.trace_id,
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v3/messages',
      headers: HEADERS,
      payload: payload({
        recipients: [
          { tenant_id: 'Steven', alias: 'jarvis' },
          { tenant_id: 'Steven', alias: 'zeus' },
        ],
      }),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe('conflict');
  });

  it('answers 409 when the receipt verification against the durable effect fails', async () => {
    const { app, calls } = await gateway({ verify: async () => false });
    const response = await app.inject({
      method: 'POST', url: '/v3/messages', headers: HEADERS, payload: payload(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'conflict', message: 'publish receipt does not match its durable effect',
    });
    expect(calls).toHaveLength(1);
  });

  it('credits an idempotent duplicate carrying the original transport pair', async () => {
    const { app } = await gateway({
      publish: async (input) => buildPublishReceipt(input, {
        message_id: MESSAGE_ID,
        delivery_ids: [DELIVERY_ID, DELIVERY_TWO],
        duplicate: true,
        request_id: '30000000-0000-4000-8000-000000000099',
        trace_id: 'trace-30000000-0000-4000-8000-000000000099',
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v3/messages',
      headers: HEADERS,
      payload: payload({
        recipients: [
          { tenant_id: 'Steven', alias: 'jarvis' },
          { tenant_id: 'Steven', alias: 'zeus' },
        ],
      }),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json<{ duplicate: boolean }>().duplicate).toBe(true);
  });
});

describe('POST /v3/messages from an agent principal', () => {
  const AGENT_HEADERS = { ...HEADERS, 'x-cauce-alias': 'hades' };

  it('marks only an agent or adapter certificate without operator authority as an agent root', async () => {
    const cases: [readonly PrincipalRole[] | undefined, Record<string, string>, boolean][] = [
      [['adapter'], AGENT_HEADERS, true],
      [['agent'], AGENT_HEADERS, true],
      [undefined, HEADERS, false],
      [['operator', 'adapter'], AGENT_HEADERS, false],
    ];
    for (const [roles, headers, expected] of cases) {
      const { app, calls } = await gateway(roles === undefined ? {} : { roles });
      const response = await app.inject({ method: 'POST', url: '/v3/messages', headers, payload: payload() });
      expect(response.statusCode).toBe(202);
      expect(calls[0]?.options?.agentRoot === true).toBe(expected);
    }
  });

  it('marks an agent certificate publishing through the console route too', async () => {
    const { app, calls } = await gateway({ roles: ['adapter'] });
    const response = await app.inject({
      method: 'POST', url: '/v3/console/messages', headers: AGENT_HEADERS, payload: payload(),
    });
    expect(response.statusCode).toBe(202);
    expect(calls[0]?.options).toMatchObject({ requirePreparedConsoleIntent: true, agentRoot: true });
  });

  it('answers 409 agent_root_limit listing the open roots the actor is waiting on', async () => {
    const openRoots = [{
      message_id: MESSAGE_ID, created_at: '2000-01-01T00:00:00.000Z',
      recipients: [{ tenant_id: 'Steven' as const, alias: 'jarvis', status: 'pending' }],
    }];
    const { app } = await gateway({
      roles: ['adapter'],
      publish: async () => { throw new AgentRootLimitError(openRoots); },
    });
    const response = await app.inject({
      method: 'POST', url: '/v3/messages', headers: AGENT_HEADERS, payload: payload(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'agent_root_limit', limit: 8, open_roots: openRoots });
  });
});

describe('POST /v3/console/messages validation', () => {
  it('rejects outside the contract and records the failed publish attempt', async () => {
    const { app, calls, telemetry } = await gateway();
    const response = await app.inject({
      method: 'POST', url: '/v3/console/messages', headers: HEADERS, payload: payload({ body: 42 }),
    });

    expect(response.statusCode).toBe(400);
    expect(calls).toEqual([]);
    expect(telemetry.snapshot()['publish:error']).toBe(1);
    expect(telemetry.snapshot()['publish:committed']).toBe(0);
  });

  it('records a committed console publish exactly once', async () => {
    const { app, telemetry } = await gateway({
      publish: async (input) => buildPublishReceipt(input, {
        message_id: MESSAGE_ID,
        delivery_ids: [DELIVERY_ID],
        duplicate: false,
        request_id: input.request_id,
        trace_id: input.trace_id,
      }),
    });
    const consoleRoute = await app.inject({
      method: 'POST', url: '/v3/console/messages', headers: HEADERS, payload: payload(),
    });
    const machineRoute = await app.inject({
      method: 'POST', url: '/v3/messages', headers: HEADERS, payload: payload(),
    });

    expect(consoleRoute.statusCode).toBe(202);
    expect(machineRoute.statusCode).toBe(202);
    // Only the console leg feeds the console journal telemetry.
    expect(telemetry.snapshot()['publish:committed']).toBe(1);
  });
});
