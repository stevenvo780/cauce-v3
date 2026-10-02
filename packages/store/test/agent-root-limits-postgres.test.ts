import { preparePostgresSuite } from './postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PublishMessage, Tenant } from '@cauce/protocol';
import {
  AGENT_ROOT_DELEGATIONS, AGENT_ROOT_OPEN_LIMIT, AgentRootLimitError, CauceRepository,
  type DatabasePool, type MessageReader
} from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';
import { requireValue } from './helpers.js';
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

async function fillOpenRoots(count = AGENT_ROOT_OPEN_LIMIT): Promise<PublishMessage[]> {
  const published: PublishMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    const input = command({ body: { text: `raíz abierta ${String(index)}` } });
    await agentRoot(input);
    published.push(input);
  }
  return published;
}

/** An agent root whose delivery died and that its author retried: returns the clone's message id. */
async function replayedAgentRoot(): Promise<string> {
  const dead = requireValue((await agentRoot()).delivery_ids[0], 'delivery id');
  await pool.query(`UPDATE deliveries SET status='dead',terminal_at=now() WHERE id=$1`, [dead]);
  await pool.query(`INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
    SELECT id,recipient_tenant,'prueba','{}'::jsonb,attempt FROM deliveries WHERE id=$1`, [dead]);
  const clone = await repository.retryOwnDelivery(dead, 'Steven', 'kant');
  return requireValue((await pool.query<{ message_id: string }>(
    'SELECT message_id FROM deliveries WHERE id=$1', [clone.delivery_id]
  )).rows[0], 'clone').message_id;
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

  it('el clon reintentado de una raíz de agente muerta ocupa un lugar', async () => {
    const clone = await replayedAgentRoot();
    await fillOpenRoots(AGENT_ROOT_OPEN_LIMIT - 1);
    const rejection = await rejectionOf(command());
    expect(rejection.openRoots.map((root) => root.message_id)).toContain(clone);
  }, 120_000);

  it('una raíz ocupa su lugar mientras corre su cadena, no sólo su primer salto', async () => {
    await fillOpenRoots(AGENT_ROOT_OPEN_LIMIT - 1);
    const jarvis = await consumer('Steven', 'jarvis');
    const socrates = await consumer('Steven', 'socrates');
    const chain = await agentRoot(command({ recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }] }));
    await applyTerminalAck(repository, jarvis, await claimNext(repository, jarvis), {
      messages: [{ to: 'socrates', body: 'averiguá vos' }], reply: 'provisional'
    });
    expect((await rejectionOf(command())).openRoots.map((root) => root.message_id)).toContain(chain.message_id);
    const pending = await repository.getMessage(chain.message_id, 'Steven', 'kant', 'agent');
    expect(pending).toMatchObject({ chain_open: true });
    await applyTerminalAck(repository, socrates,
      await claimNext(repository, socrates, (item) => item.body.type === 'agent.message'), { reply: 'dato de socrates' });
    await rejectionOf(command());
    await applyTerminalAck(repository, jarvis,
      await claimNext(repository, jarvis, (item) => item.body.type === 'agent.response'), { reply: 'sigo esperando' });
    await rejectionOf(command());
    await applyTerminalAck(repository, jarvis,
      await claimNext(repository, jarvis, (item) => item.body.type === 'agent.fanin'), { reply: 'consolidado' });
    const closed = await repository.getMessage(chain.message_id, 'Steven', 'kant', 'agent');
    expect(closed).toMatchObject({ chain_open: false });
    expect(closed.deliveries).toEqual([expect.objectContaining({ alias: 'jarvis', status: 'done', reply: 'consolidado' })]);
    await expect(agentRoot()).resolves.toMatchObject({ duplicate: false });
  }, 180_000);

  it('una espera humana abierta en la cadena también ocupa el lugar', async () => {
    const argos = await consumer('Steven', 'argos');
    const root = await agentRoot(command({ recipients: [{ tenant_id: 'Steven', alias: 'argos' }] }));
    const delivery = await claimNext(repository, argos);
    await applyTerminalAck(repository, argos, delivery, { reply: 'pregunté a la persona' });
    await pool.query(
      `INSERT INTO agent_chain_gates(root_message_id,tenant_id,asked_by_alias,source_delivery_id,source_attempt,
         output_index,trace_id,question,correlation)
       VALUES($1,'Steven','argos',$2,1,0,'trace-gate','¿Aprobás?','{}'::jsonb)`,
      [root.message_id, delivery.delivery_id]
    );
    await fillOpenRoots(AGENT_ROOT_OPEN_LIMIT - 1);
    expect((await rejectionOf(command())).openRoots.map((open) => open.message_id)).toContain(root.message_id);
    await pool.query(`UPDATE agent_chain_gates SET status='cancelled'`);
    await expect(agentRoot()).resolves.toMatchObject({ duplicate: false });
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

  async function fuelOf(publish: () => Promise<unknown>) {
    await setCaps({ delegation_caps_enabled: true, max_edge_repeats_per_root: 1_000 });
    const argos = await consumer('Steven', 'argos');
    await publish();
    const result = await applyTerminalAck(repository, argos, await claimNext(repository, argos), {
      messages: branches(AGENT_ROOT_DELEGATIONS + 1)
    });
    return { rows: await materializedAndRejected(), reason: result.delegation_rejections?.[0]?.reason };
  }

  it(`corta la cadena de agente en ${String(AGENT_ROOT_DELEGATIONS)} delegaciones`, async () => {
    const { rows, reason } = await fuelOf(() => agentRoot());
    expect(rows).toEqual({ materialized: AGENT_ROOT_DELEGATIONS, codes: ['root_budget_exhausted'] });
    expect(reason).toContain(`${String(AGENT_ROOT_DELEGATIONS)} delegaciones`);
  }, 120_000);

  it('el clon de una raíz de agente muerta conserva el combustible reducido', async () => {
    const { rows } = await fuelOf(() => replayedAgentRoot());
    expect(rows).toEqual({ materialized: AGENT_ROOT_DELEGATIONS, codes: ['root_budget_exhausted'] });
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

  it('el clon de una raíz de agente muerta también corta B -> C -> A', async () => {
    expect(await chainBackToActor(() => replayedAgentRoot())).toEqual(['cycle_detected']);
  }, 120_000);

  it('en una raíz de operador el mismo camino sigue abierto', async () => {
    expect(await chainBackToActor(() => repository.publish(command()))).toEqual([]);
    expect(await materializedAndRejected()).toEqual({ materialized: 2, codes: [] });
  }, 120_000);
});

describe('lectura del resultado por quien publicó', () => {
  async function answered(publish: () => Promise<{ message_id: string }>): Promise<string> {
    const argos = await consumer('Steven', 'argos');
    const receipt = await publish();
    await applyTerminalAck(repository, argos, await claimNext(repository, argos), { reply: 'hecho y verificado' });
    return receipt.message_id;
  }
  const replyOf = async (id: string, alias: string, reader?: MessageReader) =>
    ((await repository.getMessage(id, 'Steven', alias, reader)).deliveries as { reply?: unknown }[])[0]?.reply;

  it('el agente ve la respuesta de su raíz de agente; nadie más la ve', async () => {
    const id = await answered(() => agentRoot());
    expect(await replyOf(id, 'kant', 'agent')).toBe('hecho y verificado');
    expect(await replyOf(id, 'kant', 'operator')).toBeUndefined();
    expect(await replyOf(id, 'kant')).toBeUndefined();
    expect(await replyOf(id, 'socrates', 'agent')).toBeUndefined();
  }, 120_000);

  it('cada destinatario muestra la respuesta de su rama, no la de una rama ajena que lo usó', async () => {
    const [argos, socrates, jarvis] = await Promise.all(
      ['argos', 'socrates', 'jarvis'].map((alias) => consumer('Steven', alias))
    ) as [Consumer, Consumer, Consumer];
    const root = await agentRoot(command({
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }, { tenant_id: 'Steven', alias: 'socrates' }]
    }));
    await applyTerminalAck(repository, argos, await claimNext(repository, argos), { reply: 'respuesta propia de argos' });
    await applyTerminalAck(repository, socrates, await claimNext(repository, socrates), {
      messages: [{ to: 'argos', body: 'ayudame con esto' }], reply: 'le pedí a argos'
    });
    await applyTerminalAck(repository, argos,
      await claimNext(repository, argos, (item) => item.body.type === 'agent.message'),
      { messages: [{ to: 'jarvis', body: 'averiguá' }], reply: 'le pedí a jarvis' });
    await applyTerminalAck(repository, jarvis,
      await claimNext(repository, jarvis, (item) => item.body.type === 'agent.message'), { reply: 'dato de jarvis' });
    await applyTerminalAck(repository, argos,
      await claimNext(repository, argos, (item) => item.body.type === 'agent.response'), { reply: 'rama de socrates' });
    const view = await repository.getMessage(root.message_id, 'Steven', 'kant', 'agent');
    expect((view.deliveries as { alias: string; reply?: unknown }[]).find((item) => item.alias === 'argos')?.reply)
      .toBe('respuesta propia de argos');
  }, 180_000);

  async function throughFanin(faninStatus: 'done' | 'failed'): Promise<string> {
    const [socrates, jarvis] = await Promise.all(
      ['socrates', 'jarvis'].map((alias) => consumer('Steven', alias))
    ) as [Consumer, Consumer];
    const root = await agentRoot(command({ recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }] }));
    await applyTerminalAck(repository, jarvis, await claimNext(repository, jarvis), {
      messages: [{ to: 'socrates', body: 'averiguá' }], reply: 'provisional'
    });
    await applyTerminalAck(repository, socrates,
      await claimNext(repository, socrates, (item) => item.body.type === 'agent.message'), { reply: 'dato' });
    const response = await claimNext(repository, jarvis, (item) => item.body.type === 'agent.response');
    await applyTerminalAck(repository, jarvis, response, { reply: 'respuesta de un subagente' });
    await applyTerminalAck(repository, jarvis,
      await claimNext(repository, jarvis, (item) => item.body.type === 'agent.fanin'),
      faninStatus === 'done' ? { reply: 'consolidado' } : { reply: 'no pude', status: 'failed' });
    // The sub-agent's response lands after the fan-in closed: by time it is the newest word of the branch.
    await pool.query(`UPDATE deliveries SET terminal_at=now()+interval '1 minute' WHERE id=$1`, [response.delivery_id]);
    return root.message_id;
  }

  it('una respuesta tardía de un subagente no reemplaza la del fan-in', async () => {
    const view = await repository.getMessage(await throughFanin('done'), 'Steven', 'kant', 'agent');
    expect(view.deliveries).toEqual([expect.objectContaining({ alias: 'jarvis', reply: 'consolidado' })]);
  }, 180_000);

  it('un fan-in fallido no se tapa con la respuesta de un subagente', async () => {
    const view = await repository.getMessage(await throughFanin('failed'), 'Steven', 'kant', 'agent');
    expect(view.deliveries).toEqual([expect.objectContaining({ alias: 'jarvis', reply: null })]);
  }, 180_000);

  it('el operador ve la respuesta de lo que publicó como operador; su certificado de agente no', async () => {
    const id = await answered(() => repository.publish(command()));
    expect(await replyOf(id, 'kant', 'operator')).toBe('hecho y verificado');
    expect(await replyOf(id, 'kant', 'agent')).toBeUndefined();
  }, 120_000);

  it('la respuesta de una sonda de gate no se muestra a nadie', async () => {
    const nonce = 'a'.repeat(32);
    const id = await answered(() => repository.publish(command({
      body: { type: 'system.gate.probe', nonce, timeout_ms: 60_000 }, priority: -100,
      idempotency_key: `gate:Steven:argos:${nonce}`,
      authenticated_context: { session_id: 'gate-probe', channel: 'gate' },
    })));
    expect(await replyOf(id, 'kant', 'operator')).toBeUndefined();
    expect(await replyOf(id, 'kant', 'agent')).toBeUndefined();
  }, 120_000);
});
