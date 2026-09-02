import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_PRIORITY_CEILING, buildPublishReceipt, HUMAN_CHAT_PRIORITY, HUMAN_PRIORITY_FLOOR,
  type PublishMessage,
} from '@cauce/protocol';
import type { buildGateway } from './app.js';
import { buildTestGateway, fakePool, fakeRepository } from './test-support/gateway-doubles.js';

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

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];

/**
 * Fastify 5 only accepts a logger CONFIGURATION here, not a logger instance, so the records are
 * collected off the destination stream — which is also what production reads.
 */
function recordingLogger(warnings: Record<string, unknown>[]): never {
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
  warnings: Record<string, unknown>[];
}> {
  const published: Published[] = [];
  const warnings: Record<string, unknown>[] = [];
  const app = await buildTestGateway({
    pool: fakePool({ ssl: true }),
    repository: fakeRepository({
      publish: vi.fn(async (input: {
        priority: number; tenant_id: string; actor_alias: string; request_id: string; trace_id: string;
        idempotency_key: string;
      }) => {
        published.push({
          priority: input.priority,
          tenant_id: input.tenant_id,
          actor_alias: input.actor_alias
        });
        return buildPublishReceipt(input as PublishMessage, {
          message_id: '11111111-1111-4111-8111-111111111111',
          delivery_ids: ['22222222-2222-4222-8222-222222222222'],
          duplicate: false,
          request_id: input.request_id,
          trace_id: input.trace_id,
        });
      }),
      verifyPublishReceipt: vi.fn(async () => true),
    }),
    logger: recordingLogger(warnings)
  });
  apps.push(app);
  return { app, published, warnings };
}

async function publish(
  app: Awaited<ReturnType<typeof buildGateway>>,
  alias: string,
  priority: number,
  path = '/v3/messages',
  lane: PublishMessage['lane'] = 'interactive',
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
      idempotency_key: `ceiling-${alias}-${String(priority)}-${path}`,
      lane,
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

  it('does not let an attributed operator reserve the human band on the machine publish route', async () => {
    const { app, published } = await gateway();
    expect(await publish(app, 'kant', 100)).toBe(202);
    expect(published.map((entry) => entry.priority)).toEqual([AGENT_PRIORITY_CEILING]);
  });

  it('puts an authenticated console operator into the human band even when the UI requests 10', async () => {
    const { app, published } = await gateway();
    expect(await publish(app, 'kant', 10, '/v3/console/messages')).toBe(202);
    expect(published[0]?.priority).toBe(HUMAN_CHAT_PRIORITY);
    expect(published[0]?.priority).toBeGreaterThanOrEqual(HUMAN_PRIORITY_FLOOR);
  });

  it('does not reserve the human band for a batch publish on the console route', async () => {
    const { app, published } = await gateway();
    expect(await publish(app, 'kant', 100, '/v3/console/messages', 'batch')).toBe(202);
    expect(published[0]?.priority).toBe(AGENT_PRIORITY_CEILING);
  });
});
