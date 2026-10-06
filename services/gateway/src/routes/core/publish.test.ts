import { afterEach, describe, expect, it, vi } from 'vitest';
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
  vi.restoreAllMocks();
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


describe('chat latency publication boundaries', () => {
  it('waits for the durable receipt and verification before logging the server reply', async () => {
    let releasePublish!: () => void;
    let releaseVerify!: (value: boolean) => void;
    const publishReady = new Promise<void>((resolve) => { releasePublish = resolve; });
    const verifyReady = new Promise<boolean>((resolve) => { releaseVerify = resolve; });
    const verify = vi.fn(async () => verifyReady);
    const { app, calls } = await gateway({
      publish: async (input) => {
        await publishReady;
        return buildPublishReceipt(input, {
          message_id: MESSAGE_ID, delivery_ids: [DELIVERY_ID], duplicate: false,
          request_id: input.request_id, trace_id: input.trace_id,
        });
      }, verify,
    });
    const events: Record<string, unknown>[] = [];
    vi.spyOn(app.log, 'info').mockImplementation((entry: unknown) => {
      if (entry && typeof entry === 'object' && 'event' in entry && entry.event === 'chat_latency') {
        events.push(entry);
      }
    });
    const pending = app.inject({ method: 'POST', url: '/v3/console/messages',
      headers: HEADERS, payload: payload({ body: { text: 'private-body-sentinel' } }) }).then((response) => response);
    try {
      await vi.waitFor(() => { expect(calls).toHaveLength(1); });
      expect(events).toEqual([]);
      releasePublish();
      await vi.waitFor(() => { expect(verify).toHaveBeenCalledOnce(); });
      expect(events).toEqual([]);
      releaseVerify(true);
      expect((await pending).statusCode).toBe(202);
      await vi.waitFor(() => { expect(events.map((event) => event.phase)).toEqual([
        'publish_receipt_verified', 'publish_http_reply_completed',
      ]); });
      expect(events[0]).toMatchObject({ message_id: MESSAGE_ID, delivery_id: DELIVERY_ID,
        request_id: calls[0]?.command.request_id, trace_id: calls[0]?.command.trace_id });
      expect(events[1]?.request_correlation).toBe(events[0]?.request_correlation);
      expect(events[0]?.request_correlation).toMatch(/^req-[a-z0-9]+$/u);
      expect(JSON.stringify(events)).not.toMatch(/private-body-sentinel|body|headers|tenant|alias|idempotency|csrf|token/);
      for (const event of events) {
        expect(Number.isFinite(event.elapsed_ms)).toBe(true);
        expect(event.elapsed_ms).toBeGreaterThanOrEqual(0);
        expect(event.at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/u);
      }
    } finally { releasePublish(); releaseVerify(true); await pending; }
  });

  it('does not report a successful boundary for a rejected receipt', async () => {
    const { app } = await gateway({ verify: async () => false });
    const events: Record<string, unknown>[] = [];
    vi.spyOn(app.log, 'info').mockImplementation((entry: unknown) => {
      if (entry && typeof entry === 'object' && 'event' in entry && entry.event === 'chat_latency') {
        events.push(entry);
      }
    });
    const response = await app.inject({ method: 'POST', url: '/v3/console/messages', headers: HEADERS, payload: payload() });
    expect(response.statusCode).toBe(409);
    expect(events).toEqual([]);
  });

  it('preserves the exact HTTP outcome when the latency sink throws', async () => {
    const { app } = await gateway();
    let attempts = 0;
    vi.spyOn(app.log, 'info').mockImplementation((entry: unknown) => {
      if (entry && typeof entry === 'object' && 'event' in entry && entry.event === 'chat_latency') {
        attempts += 1;
        throw new Error('latency sink unavailable');
      }
    });
    const response = await app.inject({ method: 'POST', url: '/v3/console/messages', headers: HEADERS, payload: payload() });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ message_id: MESSAGE_ID, delivery_ids: [DELIVERY_ID] });
    await vi.waitFor(() => { expect(attempts).toBe(2); });
  });
});
