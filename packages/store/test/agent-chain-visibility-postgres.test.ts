import { preparePostgresSuite } from './postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { requireValue } from './helpers.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, StoreError, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

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

interface Consumer {
  tenant: Tenant;
  alias: string;
  instanceId: string;
  epoch: number;
}

async function consumer(tenant: Tenant, alias: string): Promise<Consumer> {
  const instanceId = `${alias}-${randomUUID()}`;
  const lease = await repository.acquireLease(tenant, alias, instanceId, [], 30_000);
  return { tenant, alias, instanceId, epoch: requireValue(lease.epoch, 'lease.epoch') };
}

async function nextDelivery(
  target: Consumer,
  predicate: (delivery: DeliveryEnvelope) => boolean = () => true
): Promise<DeliveryEnvelope> {
  const claimed = await repository.claimDeliveries(
    target.tenant, target.alias, target.instanceId, target.epoch, 10, 30_000
  );
  const delivery = claimed.find(predicate);
  if (!delivery) {
    throw new Error(`no matching delivery for ${target.alias}: ${JSON.stringify(
      claimed.map((item) => item.body.type ?? 'request')
    )}`);
  }
  return delivery;
}

function terminalAck(
  delivery: DeliveryEnvelope,
  target: Consumer,
  messages: unknown[],
  reply: string | null = 'done',
  eventId = randomUUID()
): Ack {
  return {
    version: '3.0',
    event_id: eventId,
    status: 'done',
    instance_id: target.instanceId,
    epoch: target.epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    result: { output: { reply, messages, status: 'done', retryable: false, artifacts: [] } }
  };
}

async function ackWith(
  target: Consumer,
  delivery: DeliveryEnvelope,
  messages: unknown[],
  reply: string | null = 'done',
  eventId = randomUUID()
): Promise<void> {
  const result = await repository.ackDelivery(
    delivery.delivery_id, target.tenant, target.alias,
    terminalAck(delivery, target, messages, reply, eventId)
  );
  expect(result.applied).toBe(true);
}

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

  it.each([
    { name: 'fractional', value: 1.5 },
    { name: 'integer overflow', value: 2_147_483_647 },
    { name: 'negative', value: -5 },
    { name: 'string', value: '9' },
    { name: 'null', value: null }
  ])('applies the ACK and materializes hop 1 for a poisoned hop_count: $name', async ({ value }) => {
    const argos = await consumer('Steven', 'argos');
    await repository.publish(command({
      body: { text: 'poisoned hop count', correlation: { hop_count: value } }
    }));
    const delivery = await nextDelivery(argos);

    await ackWith(argos, delivery, [{ to: 'socrates', body: 'still one hop' }]);

    expect((await materializations())[0]).toMatchObject({ hop_count: 1, hop_budget: 16 });
  });

  it('saturates a poisoned durable hop budget instead of propagating it', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(command());
    const root = await nextDelivery(argos);
    await ackWith(argos, root, [{ to: 'socrates', body: 'first hop' }]);
    await pool.query(`UPDATE agent_output_materializations SET hop_budget=1000000000`);

    const child = await nextDelivery(socrates);
    await ackWith(socrates, child, [{ to: 'jarvis', body: 'second hop' }]);

    const rows = await materializations();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      source_alias: 'socrates', target_alias: 'jarvis', hop_count: 2, hop_budget: 16
    });
  });

  it('keeps growing the delegation path across an agent.response continuation', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const seneca = await consumer('Pablo', 'seneca');
    await repository.publish(command());
    const root = await nextDelivery(argos);
    await ackWith(argos, root, [{ to: 'socrates', body: 'delegate down' }]);
    const child = await nextDelivery(socrates);
    await ackWith(socrates, child, [{ to: 'seneca', body: 'delegate deeper' }]);
    const leaf = await nextDelivery(seneca);
    await ackWith(seneca, leaf, [], 'leaf reply');

    const continuation = await nextDelivery(socrates, (item) => item.body.type === 'agent.response');
    await ackWith(socrates, continuation, [{ to: 'jarvis', body: 'redelegate after the answer' }]);

    const rows = await materializations();
    const redelegation = rows.find((row) => row.target_alias === 'jarvis');
    expect(redelegation).toMatchObject({ hop_count: 2, hop_budget: 16 });
    expect(redelegation?.visited_path).toEqual(['Steven/argos', 'Steven/socrates']);
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

  it('leaves the back edge alone while the policy flag is off', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const jarvis = await consumer('Steven', 'jarvis');
    await repository.publish(command());
    const root = await nextDelivery(argos);
    await ackWith(argos, root, [{ to: 'socrates', body: 'go' }]);
    const child = await nextDelivery(socrates);
    await ackWith(socrates, child, [{ to: 'jarvis', body: 'go deeper' }]);
    const grandchild = await nextDelivery(jarvis);

    await ackWith(jarvis, grandchild, [{ to: 'argos', body: 'back edge' }]);

    const rows = await materializations();
    expect(rows.map((row) => [row.source_alias, row.target_alias, row.status])).toEqual([
      ['argos', 'socrates', 'materialized'],
      ['socrates', 'jarvis', 'materialized'],
      ['jarvis', 'argos', 'materialized']
    ]);
  });

  it('allows a diamond where two branches converge on an unvisited agent', async () => {
    await setChainPolicy({ cycle_cut_enabled: true });
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const jarvis = await consumer('Steven', 'jarvis');
    await repository.publish(command());
    const root = await nextDelivery(argos);
    await ackWith(argos, root, [
      { to: 'socrates', body: 'left' },
      { to: 'jarvis', body: 'right' }
    ]);

    const left = await nextDelivery(socrates);
    await ackWith(socrates, left, [{ to: 'seneca', body: 'converge' }]);
    const right = await nextDelivery(jarvis);
    await ackWith(jarvis, right, [{ to: 'seneca', body: 'converge' }]);

    const rows = await materializations();
    expect(rows.filter((row) => row.target_alias === 'seneca')).toEqual([
      expect.objectContaining({ source_alias: 'socrates', status: 'materialized' }),
      expect.objectContaining({ source_alias: 'jarvis', status: 'materialized' })
    ]);
    expect(rows.every((row) => row.rejection_code === null)).toBe(true);
  });
});

describe('server-side @all prohibition on internal turns', () => {
  it('rejects an @all directive emitted from a delegated agent.message', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await consumer('Steven', 'jarvis');
    await repository.publish(command());
    const root = await nextDelivery(argos);
    await ackWith(argos, root, [{ to: 'socrates', body: 'delegate' }]);
    const child = await nextDelivery(socrates);

    await ackWith(socrates, child, [{ to: '@all', body: 'broadcast from an internal turn' }]);

    const rows = await materializations();
    expect(rows.filter((row) => row.source_alias === 'socrates')).toEqual([
      expect.objectContaining({ status: 'rejected', rejection_code: 'invalid_output' })
    ]);
  });

  it('still expands @all for a non-internal user request', async () => {
    const argos = await consumer('Steven', 'argos');
    await consumer('Steven', 'socrates');
    await repository.publish(command());
    const root = await nextDelivery(argos);

    await ackWith(argos, root, [{ to: '@all', body: 'broadcast from a user request' }]);

    const rows = await materializations();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.status === 'materialized')).toBe(true);
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

  it('announces the addressed delegation but suppresses a delegated branch return', async () => {
    await setChainPolicy({ progress_relay_enabled: true, progress_relay_max_events: 12 });
    const chain = await telegramChain('progress-basic');
    const root = await nextDelivery(chain.argos);
    await ackWith(chain.argos, root, [
      { to: 'kant', body: 'branch one' },
      { to: 'socrates', body: 'branch two' }
    ]);
    const first = await nextDelivery(chain.kant);
    await ackWith(chain.kant, first, [], 'branch one reply');

    const relays = await progressRelays();
    expect(relays.map((relay) => relay.stage)).toEqual(['delegated']);
    expect(relays.every((relay) => relay.relay_kind === 'ack' && !relay.terminal)).toBe(true);
    expect(relays.every((relay) => relay.root_message_id === chain.rootMessageId)).toBe(true);
    expect(relays[0]?.reply).toContain('argos delegó en Steven/kant, Steven/socrates');
    expect((await pool.query<{ emitted: number }>(
      `SELECT emitted FROM agent_chain_progress WHERE root_message_id=$1`, [chain.rootMessageId]
    )).rows[0]?.emitted).toBe(1);
  });

  it('preserves denied progress for a delegated branch', async () => {
    await setChainPolicy({ progress_relay_enabled: true, progress_relay_max_events: 12 });
    const chain = await telegramChain('progress-denied');
    const seneca = await consumer('Pablo', 'seneca');
    const root = await nextDelivery(chain.argos);
    await ackWith(chain.argos, root, [
      { to: 'seneca', body: 'cross-tenant branch before reverse ACL revocation' }
    ]);
    const child = await nextDelivery(seneca);
    await pool.query(
      `UPDATE acl_edges SET allow_route=false
       WHERE from_tenant='Pablo' AND to_tenant='Steven'`
    );

    await ackWith(seneca, child, [], 'denied branch reply');

    const relays = await progressRelays();
    expect(relays.map((relay) => relay.stage)).toEqual(['delegated', 'denied']);
    expect(relays[1]?.reply).toContain('reverse_acl_unavailable');
    expect(relays.every((relay) => relay.root_message_id === chain.rootMessageId)).toBe(true);
    expect((await pool.query<{ emitted: number }>(
      `SELECT emitted FROM agent_chain_progress WHERE root_message_id=$1`, [chain.rootMessageId]
    )).rows[0]?.emitted).toBe(2);
  });

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

  it('never double counts a replayed ACK', async () => {
    await setChainPolicy({ progress_relay_enabled: true, progress_relay_max_events: 12 });
    const chain = await telegramChain('progress-replay');
    const root = await nextDelivery(chain.argos);
    const eventId = randomUUID();
    const ack = terminalAck(root, chain.argos, [{ to: 'kant', body: 'once' }], 'done', eventId);
    await repository.ackDelivery(root.delivery_id, 'Steven', 'argos', ack);
    await repository.ackDelivery(root.delivery_id, 'Steven', 'argos', ack);

    expect(await progressRelays()).toHaveLength(1);
    expect((await pool.query<{ emitted: number }>(
      `SELECT emitted FROM agent_chain_progress WHERE root_message_id=$1`, [chain.rootMessageId]
    )).rows[0]?.emitted).toBe(1);
  });

  it('emits nothing at all while the policy flag is off', async () => {
    const chain = await telegramChain('progress-disabled');
    const root = await nextDelivery(chain.argos);
    await ackWith(chain.argos, root, [{ to: 'kant', body: 'silent' }]);

    expect(await progressRelays()).toEqual([]);
    expect((await pool.query(`SELECT 1 FROM agent_chain_progress`)).rowCount).toBe(0);
  });

  it('is unclaimable and superseded once a final relay of the same root is processing', async () => {
    await setChainPolicy({ progress_relay_enabled: true, progress_relay_max_events: 12 });
    const chain = await telegramChain('progress-supersede');
    const root = await nextDelivery(chain.argos);
    await ackWith(chain.argos, root, [{ to: 'kant', body: 'branch' }]);
    await pool.query(
      `INSERT INTO adapter_outbox(
         tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,
         payload,status,claimed_at,claim_expires_at
       ) VALUES('Steven','telegram','origin_relay',$1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'processing',
                now(),now()+interval '1 minute')`,
      [
        `relay-root:${chain.rootMessageId}`, root.request_id, chain.rootMessageId, root.delivery_id,
        chain.traceId, JSON.stringify(telegramOrigin('progress-supersede')),
        JSON.stringify({
          outcome: 'done',
          result: { output: { reply: 'final' } },
          correlation: { message_id: chain.rootMessageId, root_message_id: chain.rootMessageId }
        })
      ]
    );

    const claimed = await repository.claimOutbox('origin_relay', 'progress-worker', 10, 30_000, 'telegram');

    expect(claimed.some((event) => event.payload.progress_stage !== undefined)).toBe(false);
    expect((await pool.query<{ status: string }>(
      `SELECT status FROM adapter_outbox WHERE payload->>'progress_stage' IS NOT NULL`
    )).rows).toEqual([{ status: 'dead' }]);
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

  it('is default-deny for an actor outside the chain and for an unknown trace', async () => {
    const argos = await consumer('Steven', 'argos');
    const input = command();
    await repository.publish(input);
    const root = await nextDelivery(argos);
    await ackWith(argos, root, [{ to: 'socrates', body: 'private branch' }]);

    await expect(repository.agentChain(input.trace_id, 'Miguel', 'kratos'))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(repository.agentChain(`trace-${randomUUID()}`, 'Steven', 'kant'))
      .rejects.toBeInstanceOf(StoreError);
    // 'kant' is the seed hub operator (migration 003 reassigns it once), not a plain
    // 'agent' member, so the permission this actor actually holds comes from 'operator'.
    await pool.query(`UPDATE role_policies SET allow_read=false WHERE role='operator'`);
    await expect(repository.agentChain(input.trace_id, 'Steven', 'kant'))
      .rejects.toMatchObject({ code: 'forbidden' });
    await pool.query(`UPDATE role_policies SET allow_read=true WHERE role='operator'`);
  });
});

describe('versioned chain policy', () => {
  it('previews, applies, audits and rolls back a chain policy change', async () => {
    await pool.query(
      `UPDATE memberships SET role='operator' WHERE tenant_id='Steven' AND alias='jarvis'`
    );
    const preview = await repository.applyConfigurationChange('Steven', 'jarvis', {
      resource: 'chain_policy', action: 'update', id: 'default', value: { cycle_cut_enabled: true }
    }, true);
    expect(preview).toMatchObject({ applied: false, dry_run: true });
    expect((await pool.query<{ cycle_cut_enabled: boolean }>(
      `SELECT cycle_cut_enabled FROM agent_chain_policies WHERE id='default'`
    )).rows[0]?.cycle_cut_enabled).toBe(false);

    const applied = await repository.applyConfigurationChange('Steven', 'jarvis', {
      resource: 'chain_policy', action: 'update', id: 'default',
      value: { cycle_cut_enabled: true, progress_relay_max_events: 4 }
    }, false);
    expect((await pool.query<{ cycle_cut_enabled: boolean; progress_relay_max_events: number }>(
      `SELECT cycle_cut_enabled,progress_relay_max_events FROM agent_chain_policies WHERE id='default'`
    )).rows[0]).toEqual({ cycle_cut_enabled: true, progress_relay_max_events: 4 });

    await repository.rollbackConfiguration('Steven', 'jarvis', applied.revision, false);
    expect((await pool.query<{ cycle_cut_enabled: boolean; progress_relay_max_events: number }>(
      `SELECT cycle_cut_enabled,progress_relay_max_events FROM agent_chain_policies WHERE id='default'`
    )).rows[0]).toEqual({ cycle_cut_enabled: false, progress_relay_max_events: 12 });
  });

  it('denies a chain policy mutation from a non-hub operator', async () => {
    await pool.query(
      `UPDATE memberships SET role='operator' WHERE tenant_id='Pablo' AND alias='midas'`
    );
    await expect(repository.applyConfigurationChange('Pablo', 'midas', {
      resource: 'chain_policy', action: 'update', id: 'default', value: { cycle_cut_enabled: true }
    }, false)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
