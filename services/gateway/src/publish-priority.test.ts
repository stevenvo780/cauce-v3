import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_PRIORITY_CEILING, HUMAN_CHAT_PRIORITY, HUMAN_PRIORITY_FLOOR } from '@cauce/protocol';
import type { DatabasePool } from '@cauce/store';
import { buildGateway, type GatewayRepository } from './app.js';
import { DevOnlyAuthProvider } from './auth.js';

/**
 * `/v3/messages` is the only surface where a caller chooses its own `priority`, and the only place
 * in the process that knows whether that caller is a machine or a person. The database is a
 * substitute here: what is under test is the number the gateway hands to the store.
 */

interface Published {
  priority: number;
  tenant_id: string;
  actor_alias: string;
}

const apps: Array<Awaited<ReturnType<typeof buildGateway>>> = [];

function pool(): DatabasePool {
  return {
    query: vi.fn(async () => ({ rows: [{ ssl: true }], rowCount: 1 }))
  } as unknown as DatabasePool;
}

/**
 * Fastify 5 only accepts a logger CONFIGURATION here, not a logger instance, so the records are
 * collected off the destination stream — which is also what production reads.
 */
function recordingLogger(warnings: Array<Record<string, unknown>>): never {
  return {
    level: 'warn',
    stream: {
      write: (line: string) => {
        try {
          warnings.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // A non-JSON line is not a record this test can assert on.
        }
      }
    }
  } as never;
}

async function gateway(): Promise<{
  app: Awaited<ReturnType<typeof buildGateway>>;
  published: Published[];
  warnings: Array<Record<string, unknown>>;
}> {
  const published: Published[] = [];
  const warnings: Array<Record<string, unknown>> = [];
  const app = await buildGateway({
    pool: pool(),
    authProvider: DevOnlyAuthProvider.forTests(),
    repository: {
      claimOutbox: vi.fn(async () => []),
      publish: vi.fn(async (input: {
        priority: number; tenant_id: string; actor_alias: string; request_id: string; trace_id: string;
      }) => {
        published.push({
          priority: input.priority,
          tenant_id: input.tenant_id,
          actor_alias: input.actor_alias
        });
        return {
          message_id: '11111111-1111-4111-8111-111111111111',
          delivery_ids: ['22222222-2222-4222-8222-222222222222'],
          duplicate: false,
          request_id: input.request_id,
          trace_id: input.trace_id
        };
      })
    } as unknown as GatewayRepository,
    deliveryWakeSubscriber: async () => async () => undefined,
    exposeHealthRoutes: false,
    consoleOrigins: ['http://localhost'],
    logger: recordingLogger(warnings)
  });
  apps.push(app);
  return { app, published, warnings };
}

async function publish(
  app: Awaited<ReturnType<typeof buildGateway>>,
  alias: string,
  priority: number,
  path = '/v3/messages'
): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: path,
    headers: {
      'x-cauce-tenant': 'Steven',
      'x-cauce-alias': alias,
      // The console routes sit behind the same-origin hook.
      origin: 'http://localhost'
    },
    payload: {
      room_id: 'grp.steven',
      recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }],
      body: { text: 'priority ceiling' },
      idempotency_key: `ceiling-${alias}-${priority}-${path}`,
      lane: 'interactive',
      priority
    }
  });
  return response.statusCode;
}

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

describe('agent priority ceiling', () => {
  it('holds an agent under the ceiling instead of rejecting it', async () => {
    // `argos` authenticates with the agent role. 100, 90 and 85 are the three values agents were
    // measured self-assigning in production; each must publish, and each must land in the agent
    // band so it can never overtake a person.
    const { app, published } = await gateway();
    for (const requested of [100, 90, 85]) {
      expect(await publish(app, 'argos', requested)).toBe(202);
    }
    expect(published.map((entry) => entry.priority)).toEqual([
      AGENT_PRIORITY_CEILING, AGENT_PRIORITY_CEILING, AGENT_PRIORITY_CEILING
    ]);
    for (const entry of published) expect(entry.priority).toBeLessThan(HUMAN_PRIORITY_FLOOR);
  });

  it('cannot be reached from the console publish route either', async () => {
    const { app, published } = await gateway();
    expect(await publish(app, 'argos', 100, '/v3/console/messages')).toBe(202);
    expect(published[0]?.priority).toBe(AGENT_PRIORITY_CEILING);
  });

  it('leaves an agent asking for a normal priority untouched', async () => {
    const { app, published, warnings } = await gateway();
    for (const requested of [0, 10, 40, AGENT_PRIORITY_CEILING, -100]) {
      expect(await publish(app, 'argos', requested)).toBe(202);
    }
    expect(published.map((entry) => entry.priority)).toEqual([0, 10, 40, AGENT_PRIORITY_CEILING, -100]);
    expect(warnings).toHaveLength(0);
  });

  it('leaves the clamp visible in the log so the misconfiguration is still diagnosable', async () => {
    const { app, warnings } = await gateway();
    await publish(app, 'argos', 100);
    expect(warnings).toContainEqual(expect.objectContaining({
      event: 'publish_priority_clamped',
      tenant_id: 'Steven',
      alias: 'argos',
      requested: 100,
      applied: AGENT_PRIORITY_CEILING
    }));
  });

  it('keeps the human band reachable by an operator principal', async () => {
    // `Steven/kant` is the operator identity of the development provider. The operator role
    // already replays deliveries and mutates configuration here; escalating a priority is
    // strictly weaker than what it can otherwise do, so it keeps the full range.
    const { app, published } = await gateway();
    expect(await publish(app, 'kant', 100)).toBe(202);
    expect(published[0]?.priority).toBe(100);
    expect(published[0]?.priority).toBeGreaterThanOrEqual(HUMAN_CHAT_PRIORITY);
  });
});
