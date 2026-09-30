import { preparePostgresSuite } from './postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PublishMessage, Tenant } from '@cauce/protocol';
import {
  AGENT_ROOT_DELEGATIONS, AGENT_ROOT_OPEN_LIMIT, AgentRootLimitError, CauceRepository,
  type DatabasePool
} from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';
import {
  ackWith as applyTerminalAck, consumer as leaseConsumer, nextDelivery as claimNext, type Consumer
} from './helpers/consumer.js';

/**
 * Roots published by an agent principal (the TUI of an alias, or anything holding its
 * certificate) carry limits that need no clock: a cap of open roots released by completion,
 * reduced chain fuel, and the actor counted as already visited.
 */

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'raíz de agente' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 0,
    ...overrides
  };
}

const agentRoot = (input: PublishMessage = command()) => repository.publish(input, { agentRoot: true });
const consumer = (tenant: Tenant, alias: string): Promise<Consumer> => leaseConsumer(repository, tenant, alias);

async function setCaps(values: {
  delegation_caps_enabled?: boolean;
  cycle_cut_enabled?: boolean;
  max_edge_repeats_per_root?: number;
}): Promise<void> {
  await pool.query(
    `UPDATE agent_chain_policies SET
       delegation_caps_enabled=COALESCE($1,delegation_caps_enabled),
       cycle_cut_enabled=COALESCE($2,cycle_cut_enabled),
       max_edge_repeats_per_root=COALESCE($3,max_edge_repeats_per_root),
       max_delegations_per_root=64
     WHERE id='default'`,
    [values.delegation_caps_enabled ?? null, values.cycle_cut_enabled ?? null,
      values.max_edge_repeats_per_root ?? null]
  );
}

async function fillOpenRoots(): Promise<PublishMessage[]> {
  const published: PublishMessage[] = [];
  for (let index = 0; index < AGENT_ROOT_OPEN_LIMIT; index += 1) {
    const input = command({ body: { text: `raíz abierta ${String(index)}` } });
    await agentRoot(input);
    published.push(input);
  }
  return published;
}

async function rejectionOf(input: PublishMessage): Promise<AgentRootLimitError> {
  const error: unknown = await agentRoot(input).then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(AgentRootLimitError);
  return error as AgentRootLimitError;
}

async function materializedAndRejected(): Promise<{ materialized: number; codes: (string | null)[] }> {
  const rows = (await pool.query<{ status: string; rejection_code: string | null }>(
    'SELECT status,rejection_code FROM agent_output_materializations ORDER BY created_at,output_index'
  )).rows;
  return {
    materialized: rows.filter((row) => row.status === 'materialized').length,
    codes: rows.filter((row) => row.rejection_code !== null).map((row) => row.rejection_code)
  };
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

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

describe('tope de raíces abiertas por agente', () => {
  it('admite el tope y rechaza la siguiente con la lista de lo que espera', async () => {
    const published = await fillOpenRoots();
    const rejection = await rejectionOf(command());
    expect(rejection).toMatchObject({ code: 'conflict', reason: 'agent_root_limit', limit: AGENT_ROOT_OPEN_LIMIT });
    expect(rejection.openRoots).toHaveLength(AGENT_ROOT_OPEN_LIMIT);
    const stored = (await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE actor_alias='kant' ORDER BY created_at,id`
    )).rows.map((row) => row.id);
    expect(stored).toHaveLength(published.length);
    expect(rejection.openRoots.map((root) => root.message_id).sort()).toEqual([...stored].sort());
    for (const root of rejection.openRoots) {
      expect(root.recipients).toEqual([{ tenant_id: 'Steven', alias: 'argos', status: 'pending' }]);
    }
  }, 120_000);

  it('una raíz terminada libera un lugar', async () => {
    await fillOpenRoots();
    await rejectionOf(command());
    const argos = await consumer('Steven', 'argos');
    const delivery = await claimNext(repository, argos);
    await applyTerminalAck(repository, argos, delivery, { reply: 'listo' });
    await expect(agentRoot()).resolves.toMatchObject({ duplicate: false });
    await rejectionOf(command());
  }, 120_000);

  it('el reintento idempotente al tope sigue devolviendo duplicate:true', async () => {
    const [first] = await fillOpenRoots();
    if (first === undefined) throw new Error('no root was published');
    await expect(agentRoot(first)).resolves.toMatchObject({ duplicate: true });
  }, 120_000);

  it('publicaciones concurrentes no pasan el tope', async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: AGENT_ROOT_OPEN_LIMIT + 4 }, () => agentRoot())
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(AGENT_ROOT_OPEN_LIMIT);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') expect(outcome.reason).toBeInstanceOf(AgentRootLimitError);
    }
  }, 120_000);

  it('las raíces de operador no cuentan ni tienen tope', async () => {
    for (let index = 0; index < AGENT_ROOT_OPEN_LIMIT + 2; index += 1) {
      await expect(repository.publish(command())).resolves.toMatchObject({ duplicate: false });
    }
    await fillOpenRoots();
    await rejectionOf(command());
  }, 120_000);
});

describe('combustible y ciclo de una raíz de agente', () => {
  const branches = (count: number) => Array.from(
    { length: count }, (_, index) => ({ to: 'socrates', body: `rama ${String(index)}` })
  );

  it(`corta la cadena de agente en ${String(AGENT_ROOT_DELEGATIONS)} delegaciones`, async () => {
    await setCaps({ delegation_caps_enabled: true, max_edge_repeats_per_root: 1_000 });
    const argos = await consumer('Steven', 'argos');
    await agentRoot();
    const result = await applyTerminalAck(repository, argos, await claimNext(repository, argos), {
      messages: branches(AGENT_ROOT_DELEGATIONS + 1)
    });
    expect(await materializedAndRejected()).toEqual({
      materialized: AGENT_ROOT_DELEGATIONS, codes: ['root_budget_exhausted']
    });
    expect(result.delegation_rejections?.[0]?.reason).toContain(`${String(AGENT_ROOT_DELEGATIONS)} delegaciones`);
  }, 120_000);

  it('la raíz de operador conserva el combustible de la política', async () => {
    await setCaps({ delegation_caps_enabled: true, max_edge_repeats_per_root: 1_000 });
    const argos = await consumer('Steven', 'argos');
    await repository.publish(command());
    await applyTerminalAck(repository, argos, await claimNext(repository, argos), {
      messages: branches(AGENT_ROOT_DELEGATIONS + 1)
    });
    expect(await materializedAndRejected()).toEqual({ materialized: AGENT_ROOT_DELEGATIONS + 1, codes: [] });
  }, 120_000);

  async function chainBackToActor(publish: () => Promise<unknown>): Promise<(string | null)[]> {
    await setCaps({ cycle_cut_enabled: true });
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await publish();
    await applyTerminalAck(repository, argos, await claimNext(repository, argos), {
      messages: [{ to: 'socrates', body: 'seguí vos' }]
    });
    const toSocrates = await claimNext(repository, socrates, (item) => item.body.type === 'agent.message');
    const result = await applyTerminalAck(repository, socrates, toSocrates, {
      messages: [{ to: 'kant', body: 'te lo devuelvo' }]
    });
    return (result.delegation_rejections ?? []).map((rejection) => rejection.code);
  }

  it('el actor cuenta como visitado: B -> C -> A se corta como ciclo', async () => {
    expect(await chainBackToActor(() => agentRoot())).toEqual(['cycle_detected']);
    expect((await materializedAndRejected()).codes).toEqual(['cycle_detected']);
  }, 120_000);

  it('en una raíz de operador el mismo camino sigue abierto', async () => {
    expect(await chainBackToActor(() => repository.publish(command()))).toEqual([]);
    expect(await materializedAndRejected()).toEqual({ materialized: 2, codes: [] });
  }, 120_000);
});

describe('lectura del resultado por quien publicó', () => {
  it('el remitente ve la respuesta; otro lector del cuarto no', async () => {
    const argos = await consumer('Steven', 'argos');
    const receipt = await agentRoot();
    await applyTerminalAck(repository, argos, await claimNext(repository, argos), { reply: 'hecho y verificado' });
    const own = await repository.getMessage(receipt.message_id, 'Steven', 'kant');
    expect(own.deliveries).toEqual([expect.objectContaining({ alias: 'argos', status: 'done', reply: 'hecho y verificado' })]);
    const other = await repository.getMessage(receipt.message_id, 'Steven', 'socrates');
    expect(JSON.stringify(other.deliveries)).not.toContain('hecho y verificado');
  }, 120_000);
});
