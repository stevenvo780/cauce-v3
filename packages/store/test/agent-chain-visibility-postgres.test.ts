import { preparePostgresSuite } from './postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, lockCompanyAuthority, type DatabasePool } from '../src/index.js';
import { seedFleetHuman } from './fleet-human-postgres.fixtures.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';
import {
  ackWith as applyTerminalAck, consumer as leaseConsumer, nextDelivery as claimNext,
  type Consumer
} from './helpers/consumer.js';

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

const telegramOrigin = (conversation: string) => ({
  adapter: 'telegram',
  channel: 'telegram',
  conversation_id: conversation,
  external_message_id: conversation,
  relay: [],
  metadata: { bridge_alias: 'argos', bridge_tenant: 'Steven' }
});

function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'chain visibility source' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 7,
    ...overrides
  };
}

const consumer = (tenant: Tenant, alias: string): Promise<Consumer> =>
  leaseConsumer(repository, tenant, alias);

const nextDelivery = (
  target: Consumer, predicate?: (delivery: DeliveryEnvelope) => boolean
): Promise<DeliveryEnvelope> => claimNext(repository, target, predicate);

const ackWith = async (
  target: Consumer, delivery: DeliveryEnvelope, messages: unknown[],
  reply: string | null = 'done', eventId = randomUUID()
): Promise<void> => {
  await applyTerminalAck(repository, target, delivery, { messages, reply, eventId });
};

async function setChainPolicy(values: {
  progress_relay_enabled?: boolean;
  progress_relay_max_events?: number;
  cycle_cut_enabled?: boolean;
}): Promise<void> {
  await pool.query(
    `UPDATE agent_chain_policies
     SET progress_relay_enabled=COALESCE($1,progress_relay_enabled),
         progress_relay_max_events=COALESCE($2,progress_relay_max_events),
         cycle_cut_enabled=COALESCE($3,cycle_cut_enabled)
     WHERE id='default'`,
    [values.progress_relay_enabled ?? null, values.progress_relay_max_events ?? null,
      values.cycle_cut_enabled ?? null]
  );
}

async function materializations(): Promise<{
  source_alias: string;
  target_alias: string | null;
  status: string;
  rejection_code: string | null;
  hop_count: number;
  hop_budget: number;
  visited_path: string[];
  root_message_id: string;
}[]> {
  return (await pool.query<{
    source_alias: string;
    target_alias: string | null;
    status: string;
    rejection_code: string | null;
    hop_count: number;
    hop_budget: number;
    visited_path: string[];
    root_message_id: string;
  }>(
    `SELECT source_alias,target_alias,status,rejection_code,hop_count,hop_budget,visited_path,
            correlation->>'root_message_id' AS root_message_id
     FROM agent_output_materializations
     ORDER BY hop_count,created_at,output_index`
  )).rows;
}

async function progressRelays(): Promise<{
  stage: string; relay_kind: string; terminal: boolean; reply: string; root_message_id: string;
}[]> {
  return (await pool.query<{
    stage: string; relay_kind: string; terminal: boolean; reply: string; root_message_id: string;
  }>(
    `SELECT payload->>'progress_stage' AS stage,payload->>'relay_kind' AS relay_kind,
            (payload->>'terminal')::boolean AS terminal,
            payload#>>'{result,output,reply}' AS reply,
            payload#>>'{correlation,root_message_id}' AS root_message_id
     FROM adapter_outbox
     WHERE kind='origin_relay' AND payload->>'progress_stage' IS NOT NULL
     ORDER BY created_at,id`
  )).rows;
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
    UPDATE tenants SET enabled=true;
    UPDATE rooms SET enabled=true;
    UPDATE memberships SET enabled=true;
    UPDATE role_policies SET allow_route=true WHERE role IN ('agent','operator','adapter');
  `);
});

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('correlation provenance and hop saturation', () => {
  it('ignores a forged correlation on a body no reserved type protects', async () => {
    const victimRoot = randomUUID();
    const input = command({
      body: {
        text: 'forged correlation',
        correlation: {
          root_message_id: victimRoot,
          root_request_id: randomUUID(),
          root_delivery_id: randomUUID(),
          hop_count: 1.5,
          hop_budget: 999_999,
          visited_path: ['Steven/kant']
        }
      }
    });
    const argos = await consumer('Steven', 'argos');
    const published = await repository.publish(input);
    const delivery = await nextDelivery(argos);

    await ackWith(argos, delivery, [{ to: 'socrates', body: 'inherit nothing from the body' }]);

    expect(await materializations()).toEqual([{
      source_alias: 'argos',
      target_alias: 'socrates',
      status: 'materialized',
      rejection_code: null,
      hop_count: 1,
      hop_budget: 16,
      visited_path: ['Steven/argos'],
      root_message_id: published.message_id
    }]);
    expect((await pool.query(
      `SELECT 1 FROM agent_output_materializations WHERE correlation->>'root_message_id'=$1`,
      [victimRoot]
    )).rowCount).toBe(0);
  });
});

describe('cycle cutting', () => {
  // The back edge targets 'argos', which is two hops removed from the delegating agent
  // ('jarvis'), not its immediate sender ('socrates'). A back edge straight to the
  // immediate sender is already, and unconditionally, rejected as 'unroutable_alias' by
  // the ping-pong guard (see "an internal delivery cannot send any message back to its
  // sender"), independently of cycle_cut_enabled; that guard would shadow cycle_detected
  // and make it untestable. Only a revisit further back in the path exercises this policy.
  it('rejects a back edge as cycle_detected and lets the sibling branch finish', async () => {
    await setChainPolicy({ cycle_cut_enabled: true });
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const jarvis = await consumer('Steven', 'jarvis');
    await repository.publish(command());
    const root = await nextDelivery(argos);
    await ackWith(argos, root, [{ to: 'socrates', body: 'go' }]);
    const child = await nextDelivery(socrates);
    await ackWith(socrates, child, [{ to: 'jarvis', body: 'go deeper' }]);
    const grandchild = await nextDelivery(jarvis);

    await ackWith(jarvis, grandchild, [
      { to: 'argos', body: 'back edge' },
      { to: 'seneca', body: 'legitimate sibling' }
    ]);

    const rows = await materializations();
    expect(rows.filter((row) => row.status === 'rejected')).toEqual([expect.objectContaining({
      source_alias: 'jarvis',
      status: 'rejected',
      rejection_code: 'cycle_detected',
      hop_count: 3
    })]);
    expect(rows.some((row) => row.target_alias === 'seneca' && row.status === 'materialized')).toBe(true);
    expect((await pool.query(
      `SELECT 1 FROM audit_events
       WHERE action='agent_output.materialize' AND decision='deny'
         AND metadata->>'rejection_code'='cycle_detected'`
    )).rowCount).toBe(1);
  });
});

describe('interim chain progress towards Telegram', () => {
  async function telegramChain(conversation: string): Promise<{
    argos: Consumer; kant: Consumer; socrates: Consumer; jarvis: Consumer;
    rootMessageId: string; traceId: string;
  }> {
    const argos = await consumer('Steven', 'argos');
    const kant = await consumer('Steven', 'kant');
    const socrates = await consumer('Steven', 'socrates');
    const jarvis = await consumer('Steven', 'jarvis');
    const input = command({
      actor_alias: 'argos',
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
      authenticated_context: {
        session_id: conversation, channel: 'telegram', origin: telegramOrigin(conversation)
      }
    });
    const published = await repository.publish(input);
    return {
      argos, kant, socrates, jarvis,
      rootMessageId: published.message_id, traceId: input.trace_id
    };
  }

  it('stops exactly at the configured budget with a single capped notice', async () => {
    await setChainPolicy({ progress_relay_enabled: true, progress_relay_max_events: 1 });
    const chain = await telegramChain('progress-capped');
    const root = await nextDelivery(chain.argos);
    await ackWith(chain.argos, root, [
      { to: 'kant', body: 'branch one' },
      { to: 'socrates', body: 'branch two' },
      { to: 'jarvis', body: 'branch three' }
    ]);
    await ackWith(chain.kant, await nextDelivery(chain.kant), [], 'one');
    await ackWith(chain.socrates, await nextDelivery(chain.socrates), [], 'two');

    const relays = await progressRelays();
    expect(relays.map((relay) => relay.stage)).toEqual(['capped']);
    expect((await pool.query<{ emitted: number }>(
      `SELECT emitted FROM agent_chain_progress WHERE root_message_id=$1`, [chain.rootMessageId]
    )).rows[0]?.emitted).toBe(1);
  });
});

describe('agentChain read model', () => {
  it('exposes the live topology, the open branch and the origin relays of one trace', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const input = command({
      actor_alias: 'argos',
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
      authenticated_context: {
        session_id: 'chain-read-model', channel: 'telegram', origin: telegramOrigin('chain-read-model')
      }
    });
    await repository.publish(input);
    const root = await nextDelivery(argos);
    await ackWith(argos, root, [
      { to: 'socrates', body: 'answered branch' },
      { to: 'jarvis', body: 'branch that never answers' }
    ]);
    const child = await nextDelivery(socrates);
    await ackWith(socrates, child, [], 'socrates reply');

    const chain = await repository.agentChain(input.trace_id, 'Steven', 'kant');

    expect(chain.trace_id).toBe(input.trace_id);
    const edges = chain.edges as Record<string, unknown>[];
    expect(edges).toHaveLength(2);
    expect(edges.map((edge) => (edge.target as Record<string, unknown>).alias)).toEqual(['socrates', 'jarvis']);
    expect(edges.map((edge) => edge.open)).toEqual([false, true]);
    expect((edges[0]?.response as Record<string, unknown>).decision).toBe('allow');
    expect(edges[1]?.response).toBeNull();
    expect(chain.counters).toMatchObject({ edges: 2, open_branches: 1, redacted_endpoints: 0 });
    const nodes = chain.nodes as Record<string, unknown>[];
    expect(nodes.map((node) => node.alias)).toEqual(['argos', 'jarvis', 'socrates']);
    expect(nodes.find((node) => node.alias === 'argos')).toMatchObject({ delegated: 2 });
    expect((chain.origin_relays as unknown[]).length).toBeGreaterThan(0);
  });

  it('redacts the endpoint a cross-tenant participant may not identify', async () => {
    const argos = await consumer('Steven', 'argos');
    const input = command();
    await repository.publish(input);
    const root = await nextDelivery(argos);
    await ackWith(argos, root, [{ to: 'seneca', body: 'cross tenant branch' }]);

    const chain = await repository.agentChain(input.trace_id, 'Pablo', 'seneca');

    const edges = chain.edges as Record<string, unknown>[];
    expect(edges).toHaveLength(1);
    expect(edges[0]?.source).toMatchObject({ redacted: true });
    expect(JSON.stringify(edges[0]?.source)).not.toContain('argos');
    expect(edges[0]?.target).toMatchObject({ tenant_id: 'Pablo', alias: 'seneca' });
    expect(chain.counters).toMatchObject({ redacted_endpoints: 1 });
  });
});

describe('versioned chain policy', () => {
  it('previews, applies, audits and rolls back a chain policy change as a verified platform person', async () => {
    await pool.query(
      `UPDATE memberships SET role='operator' WHERE tenant_id='Steven' AND alias='jarvis'`
    );
    await database.adminPool.query("INSERT INTO agents(tenant_id,alias,enabled) VALUES('Steven','jarvis',false)");
    const humanId = (await seedFleetHuman(database.adminPool, 'Steven', 'jarvis', null)).slice('console:'.length);
    await database.adminPool.query('INSERT INTO platform_admins(human_id) VALUES($1)', [humanId]);
    const authority = (client: Parameters<typeof lockCompanyAuthority>[0]) => lockCompanyAuthority(client, { tenant: 'Steven', alias: 'jarvis', humanId });
    const preview = await repository.applyConfigurationChange('Steven', 'jarvis', {
      resource: 'chain_policy', action: 'update', id: 'default', value: { cycle_cut_enabled: true }
    }, true, 0, authority);
    expect(preview).toMatchObject({ applied: false, dry_run: true });
    expect((await pool.query<{ cycle_cut_enabled: boolean }>(
      `SELECT cycle_cut_enabled FROM agent_chain_policies WHERE id='default'`
    )).rows[0]?.cycle_cut_enabled).toBe(false);

    const applied = await repository.applyConfigurationChange('Steven', 'jarvis', {
      resource: 'chain_policy', action: 'update', id: 'default',
      value: { cycle_cut_enabled: true, progress_relay_max_events: 4 }
    }, false, 0, authority);
    expect((await pool.query<{ cycle_cut_enabled: boolean; progress_relay_max_events: number }>(
      `SELECT cycle_cut_enabled,progress_relay_max_events FROM agent_chain_policies WHERE id='default'`
    )).rows[0]).toEqual({ cycle_cut_enabled: true, progress_relay_max_events: 4 });

    await repository.rollbackConfiguration('Steven', 'jarvis', applied.revision, false, applied.revision, authority);
    expect((await pool.query<{ cycle_cut_enabled: boolean; progress_relay_max_events: number }>(
      `SELECT cycle_cut_enabled,progress_relay_max_events FROM agent_chain_policies WHERE id='default'`
    )).rows[0]).toEqual({ cycle_cut_enabled: false, progress_relay_max_events: 12 });
    expect((await pool.query("SELECT scope,actor_human_id::text FROM config_revisions ORDER BY id")).rows)
      .toEqual([1, 2].map(() => ({ scope: 'platform', actor_human_id: humanId })));
    expect((await pool.query("SELECT action,actor_human_id::text FROM audit_events WHERE action LIKE 'config.%' ORDER BY id")).rows)
      .toEqual([{ action: 'config.change', actor_human_id: humanId }, { action: 'config.rollback', actor_human_id: humanId }]);
  });
});
