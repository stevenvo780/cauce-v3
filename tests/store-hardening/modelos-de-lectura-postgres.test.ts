import { preparePostgresSuite } from '../../packages/store/test/postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PublishMessage } from '@cauce/protocol';
import {
  CauceRepository, DEFAULT_FLEET_ACTIVITY_THRESHOLDS, agentWorkState,
  type DatabasePool, type FleetActivityFlag, type FleetWorkState,
} from '@cauce/store';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

/**
 * Read models behind the operator panel: `fleetActivity` and `queueSnapshot`. The console already
 * paints these four states against fixtures nobody validates, and `fleet-activity.ts` had zero
 * functions executed by any suite.
 */

const SIN_BASE = 'agentWorkState decide el estado sin tocar la base';

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

interface ActivityAgent {
  tenant_id: string; alias: string; registered: boolean; work_state: FleetWorkState;
  flags: FleetActivityFlag[]; in_flight: number; queued: number; queued_ready: number;
  claimed_not_started: number; overdue_in_flight: number; seconds_since_last_ack: number | null;
  oldest_claimed_not_started_seconds: number | null;
  oldest_claimed_not_started_without_ack_seconds: number | null;
  oldest_claimed_not_started_activity_seconds: number | null;
  presence: { online: boolean | null }; rooms: string[];
  in_flight_items: { delivery_id: string; status: string }[];
  in_flight_items_truncated: boolean;
}
interface Activity { agents: ActivityAgent[] }
interface QueueItem { delivery_id: string; state: string; recipient_alias: string }
interface Queue {
  pending: number; retrying: number; dead: number; muestra_recortada: boolean;
  totals: { pending: number; retrying: number; dead: number }; items: QueueItem[];
}

function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
    body: { text: 'modelos de lectura' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 0,
    ...overrides
  };
}

async function actividad(tenant = 'Steven', alias = 'kant'): Promise<Activity> {
  return await repository.fleetActivity(tenant, alias) as unknown as Activity;
}

async function cola(tenant = 'Steven', alias = 'kant', limit?: number): Promise<Queue> {
  return await repository.queueSnapshot(tenant, alias, limit) as unknown as Queue;
}

function agente(vista: Activity, alias: string): ActivityAgent {
  const found = vista.agents.find((candidate) => candidate.alias === alias);
  if (!found) throw new Error(`el alias ${alias} no aparece en fleetActivity`);
  return found;
}

async function registrarAgente(tenant: string, alias: string): Promise<void> {
  await pool.query(
    `INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,
       runtime_user,home_directory,state_directory)
     VALUES($1,$2,'fake',$2,true,'ws-'||$2,'dev','/home/dev','/var/lib/'||$2)`,
    [tenant, alias]
  );
}

async function entregas(cuantas: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < cuantas; index += 1) {
    const published = await repository.publish(command());
    const first = published.delivery_ids[0];
    if (first === undefined) throw new Error('publish no devolvió delivery_id');
    ids.push(first);
  }
  return ids;
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000, [SIN_BASE]);

beforeEach(async () => {
  if (!databaseStarted) return;
  await resetTestDatabase(pool);
  await pool.query('TRUNCATE delivery_lane_fairness,job_lane_fairness,outbox_dead_letters CASCADE');
});

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('agentWorkState', () => {
  const base = {
    registered: true, in_flight: 0, queued: 0, overdue_in_flight: 0,
    claimed_not_started: 0, oldest_in_flight_seconds: null,
    oldest_claimed_not_started_without_ack_seconds: null,
    oldest_claimed_not_started_activity_seconds: null,
    seconds_since_last_ack: 10, lease_online: true,
  };

  it(SIN_BASE, () => {
    expect(agentWorkState(base)).toEqual({ work_state: 'idle', flags: [] });
    expect(agentWorkState({ ...base, queued: 3 }))
      .toEqual({ work_state: 'queued', flags: ['queued_without_consumer'] });
    expect(agentWorkState({ ...base, in_flight: 2 }).work_state).toBe('working');
    expect(agentWorkState({ ...base, in_flight: 8 }))
      .toMatchObject({ work_state: 'saturated', flags: ['saturated'] });
    // Entregada y nunca empezada: el corte de 60 s es lo que evita que una garra sana de
    // milisegundos dispare el aviso en cada lectura del panel.
    expect(agentWorkState({ ...base, in_flight: 1, claimed_not_started: 1,
      oldest_in_flight_seconds: 59, oldest_claimed_not_started_without_ack_seconds: 59,
      oldest_claimed_not_started_activity_seconds: 59 })
      .work_state).toBe('working');
    expect(agentWorkState({ ...base, in_flight: 1, claimed_not_started: 1,
      oldest_in_flight_seconds: 61, oldest_claimed_not_started_without_ack_seconds: 61,
      oldest_claimed_not_started_activity_seconds: 61 }))
      .toEqual({ work_state: 'stalled', flags: ['claimed_not_started'] });
    expect(agentWorkState({ ...base, in_flight: 2, claimed_not_started: 1,
      oldest_in_flight_seconds: 1_800, oldest_claimed_not_started_without_ack_seconds: null,
      oldest_claimed_not_started_activity_seconds: 61 }))
      .toEqual({ work_state: 'working', flags: [] });
    expect(agentWorkState({ ...base, in_flight: 2, claimed_not_started: 1,
      oldest_in_flight_seconds: 1_800, oldest_claimed_not_started_without_ack_seconds: null,
      oldest_claimed_not_started_activity_seconds: 120 }))
      .toEqual({ work_state: 'working', flags: [] });
    expect(agentWorkState({ ...base, in_flight: 2, claimed_not_started: 1,
      oldest_in_flight_seconds: 1_800, oldest_claimed_not_started_without_ack_seconds: null,
      oldest_claimed_not_started_activity_seconds: 301 }))
      .toEqual({ work_state: 'stalled', flags: ['claimed_not_started'] });
    expect(agentWorkState({ ...base, in_flight: 1, seconds_since_last_ack: null }))
      .toEqual({ work_state: 'stalled', flags: ['ack_stalled'] });
    expect(agentWorkState({ ...base, registered: false, lease_online: null }).flags)
      .toEqual(['never_connected', 'unregistered']);
    expect(agentWorkState({ ...base, lease_online: false }).flags).toEqual(['lease_expired']);
    expect(agentWorkState({ ...base, in_flight: 1, overdue_in_flight: 1 }))
      .toMatchObject({ work_state: 'stalled', flags: ['overdue_acks'] });
    expect(DEFAULT_FLEET_ACTIVITY_THRESHOLDS.start_after_seconds).toBe(60);
  });
});

describe('fleetActivity: los cuatro estados que pinta la consola', () => {
  it('una flota vacía no inventa agentes', async () => {
    expect((await actividad()).agents).toEqual([]);
  });

  it('un agente registrado y conectado sin trabajo está ocioso y sin banderas', async () => {
    await registrarAgente('Isa', 'salva');
    await repository.acquireLease('Isa', 'salva', 'salva-1', [], 60_000);

    const salva = agente(await actividad(), 'salva');
    expect(salva).toMatchObject({
      registered: true, work_state: 'idle', flags: [], in_flight: 0, queued: 0
    });
    expect(salva.presence.online).toBe(true);
    expect(salva.rooms).toEqual(['grp.isa']);
  });

  it.each(['leased', 'accepted'])('una reclamación %s recién tomada sin ACK no inventa atasco', async (status) => {
    await registrarAgente('Isa', 'salva');
    await repository.acquireLease('Isa', 'salva', 'salva-1', [], 60_000);
    const [entrega] = await entregas(1);
    await pool.query(
      `UPDATE deliveries SET status=$2,attempt=1,claimed_at=now()-interval '1 second',
         ack_deadline_at=now()+interval '5 minutes' WHERE id=$1`, [entrega, status]
    );
    expect(agente(await actividad(), 'salva')).toMatchObject({
      work_state: 'working', flags: [], in_flight: 1, claimed_not_started: 1,
      seconds_since_last_ack: null, overdue_in_flight: 0
    });
  });

  it('una garra atascada sale como stalled sin atribuirle una ejecución iniciada', async () => {
    await registrarAgente('Isa', 'salva');
    await repository.acquireLease('Isa', 'salva', 'salva-1', [], 60_000);
    const [entrega] = await entregas(1);
    await pool.query(
      `UPDATE deliveries SET status='leased',attempt=1,claimed_at=now()-interval '10 minutes',
         ack_deadline_at=now()-interval '5 minutes' WHERE id=$1`, [entrega]
    );

    const salva = agente(await actividad(), 'salva');
    expect(salva.work_state).toBe('stalled');
    expect([...salva.flags].sort())
      .toEqual(['claimed_not_started', 'overdue_acks']);
    expect(salva).toMatchObject({ in_flight: 1, claimed_not_started: 1, overdue_in_flight: 1 });
    expect(salva.oldest_claimed_not_started_seconds).toBeGreaterThan(500);
    expect(salva.oldest_claimed_not_started_without_ack_seconds).toBeGreaterThan(500);
    expect(salva.seconds_since_last_ack).toBeNull();
    expect(salva.in_flight_items).toHaveLength(1);
    expect(salva.in_flight_items[0]).toMatchObject({ delivery_id: entrega, status: 'leased' });
  });

  it('un alias con cola y sin consumidor lo dice, aunque nadie lo haya registrado', async () => {
    await entregas(2);

    const salva = agente(await actividad(), 'salva');
    expect(salva).toMatchObject({
      registered: false, work_state: 'queued', in_flight: 0, queued: 2, queued_ready: 2
    });
    expect([...salva.flags].sort()).toEqual(['never_connected', 'queued_without_consumer', 'unregistered']);
    expect(salva.presence.online).toBeNull();
  });

  it('ocho entregas en vuelo con ACK fresco son saturación, no atasco', async () => {
    await registrarAgente('Isa', 'salva');
    await repository.acquireLease('Isa', 'salva', 'salva-1', [], 60_000);
    const ids = await entregas(8);
    await pool.query(
      `UPDATE deliveries SET status='started',attempt=1,claimed_at=now()-interval '5 seconds',
         ack_deadline_at=now()+interval '5 minutes' WHERE id = ANY($1::uuid[])`, [ids]
    );
    await pool.query(
      `INSERT INTO delivery_acks(delivery_id,status,instance_id,epoch,applied,claim_token,attempt,event_id)
       SELECT id,'started','salva-1',1,true,gen_random_uuid(),1,gen_random_uuid()
       FROM deliveries WHERE id = ANY($1::uuid[])`, [ids]
    );

    const salva = agente(await actividad(), 'salva');
    expect(salva).toMatchObject({ work_state: 'saturated', flags: ['saturated'], in_flight: 8 });
    expect(salva.seconds_since_last_ack).not.toBeNull();
  });

  it('una entrega aceptada espera detrás del turno activo sin marcar atasco', async () => {
    await registrarAgente('Isa', 'salva');
    await repository.acquireLease('Isa', 'salva', 'salva-1', [], 60_000);
    const [started, accepted] = await entregas(2);
    await pool.query(
      `UPDATE deliveries SET status='started',attempt=1,claimed_at=now()-interval '30 minutes',
         ack_deadline_at=now()+interval '5 minutes' WHERE id=$1`, [started]
    );
    await pool.query(
      `UPDATE deliveries SET status='accepted',attempt=1,claimed_at=now()-interval '15 minutes',
         ack_deadline_at=now()+interval '5 minutes' WHERE id=$1`, [accepted]
    );
    await pool.query(
      `INSERT INTO delivery_acks(delivery_id,status,instance_id,epoch,applied,renewal,claim_token,attempt,event_id)
       VALUES($1,'accepted','salva-1',1,true,true,gen_random_uuid(),1,gen_random_uuid())`, [accepted]
    );
    const salva = agente(await actividad(), 'salva');
    expect(salva).toMatchObject({
      work_state: 'working', flags: [], in_flight: 2, claimed_not_started: 1
    });
    expect(salva.oldest_claimed_not_started_seconds).toBeGreaterThan(800);
    expect(salva.oldest_claimed_not_started_without_ack_seconds).toBeNull();
    expect(salva.oldest_claimed_not_started_activity_seconds).toBeLessThan(60);
  });

  it('una ejecución vieja no envejece una entrega recién aceptada', async () => {
    await registrarAgente('Isa', 'salva');
    await repository.acquireLease('Isa', 'salva', 'salva-1', [], 60_000);
    const [started, accepted] = await entregas(2);
    await pool.query(
      `UPDATE deliveries SET status='started',attempt=1,claimed_at=now()-interval '30 minutes',
         ack_deadline_at=now()+interval '5 minutes' WHERE id=$1`, [started]
    );
    await pool.query(
      `UPDATE deliveries SET status='accepted',attempt=1,claimed_at=now()-interval '5 seconds',
         ack_deadline_at=now()+interval '5 minutes' WHERE id=$1`, [accepted]
    );
    await pool.query(
      `INSERT INTO delivery_acks(delivery_id,status,instance_id,epoch,applied,renewal,claim_token,attempt,event_id)
       VALUES($1,'started','salva-1',1,true,true,gen_random_uuid(),1,gen_random_uuid())`, [started]
    );
    const salva = agente(await actividad(), 'salva');
    expect(salva).toMatchObject({ work_state: 'working', flags: [], claimed_not_started: 1 });
    expect(salva.oldest_claimed_not_started_without_ack_seconds).toBeLessThan(60);
    expect(salva.oldest_claimed_not_started_activity_seconds).toBeLessThan(60);
  });

  it('una entrega aceptada vieja sin ACK propio alerta aunque otra ejecución renueve', async () => {
    await registrarAgente('Isa', 'salva');
    await repository.acquireLease('Isa', 'salva', 'salva-1', [], 60_000);
    const [started, accepted] = await entregas(2);
    await pool.query(
      `UPDATE deliveries SET status='started',attempt=1,claimed_at=now()-interval '30 minutes',
         ack_deadline_at=now()+interval '5 minutes' WHERE id=$1`, [started]
    );
    await pool.query(
      `UPDATE deliveries SET status='accepted',attempt=2,claimed_at=now()-interval '15 minutes',
         ack_deadline_at=now()+interval '5 minutes' WHERE id=$1`, [accepted]
    );
    await pool.query(
      `INSERT INTO delivery_acks(delivery_id,status,instance_id,epoch,applied,renewal,claim_token,attempt,event_id)
       VALUES($1,'started','salva-1',1,true,true,gen_random_uuid(),1,gen_random_uuid())`, [started]
    );
    await pool.query(
      `INSERT INTO delivery_acks(delivery_id,status,instance_id,epoch,applied,renewal,claim_token,attempt,event_id)
       VALUES($1,'accepted','salva-1',1,true,true,gen_random_uuid(),1,gen_random_uuid())`, [accepted]
    );

    const salva = agente(await actividad(), 'salva');
    expect(salva.work_state).toBe('stalled');
    expect(salva.flags).toEqual(['claimed_not_started']);
    expect(salva.oldest_claimed_not_started_without_ack_seconds).toBeGreaterThan(800);
    expect(salva.oldest_claimed_not_started_activity_seconds).toBeGreaterThan(800);
  });

  it('la lista de entregas en vuelo se recorta y lo declara', async () => {
    await registrarAgente('Isa', 'salva');
    const ids = await entregas(DEFAULT_FLEET_ACTIVITY_THRESHOLDS.items_per_agent + 1);
    await pool.query(
      `UPDATE deliveries SET status='started',attempt=1,claimed_at=now() WHERE id = ANY($1::uuid[])`,
      [ids]
    );

    const salva = agente(await actividad(), 'salva');
    expect(salva.in_flight).toBe(ids.length);
    expect(salva.in_flight_items).toHaveLength(DEFAULT_FLEET_ACTIVITY_THRESHOLDS.items_per_agent);
    expect(salva.in_flight_items_truncated).toBe(true);
  });

  it('retirar allow_read borra al agente ajeno aunque la arista siga habilitada', async () => {
    await registrarAgente('Steven', 'jarvis');

    expect((await actividad('Isa', 'salva')).agents.map((row) => row.alias)).toEqual(['jarvis']);

    await pool.query(
      `UPDATE acl_edges SET allow_read=false WHERE from_tenant='Isa' AND to_tenant='Steven'`
    );
    expect((await pool.query<{ enabled: boolean }>(
      `SELECT enabled FROM acl_edges WHERE from_tenant='Isa' AND to_tenant='Steven'`
    )).rows[0]?.enabled).toBe(true);
    expect((await actividad('Isa', 'salva')).agents).toEqual([]);
  });
});

describe('queueSnapshot: la muestra y los totales de la cola', () => {
  it('cuenta pendientes, reintentos y muertas por separado', async () => {
    const ids = await entregas(4);
    await pool.query(`UPDATE deliveries SET status='retry' WHERE id=$1`, [ids[0]]);
    await pool.query(`UPDATE deliveries SET status='dead',terminal_at=now() WHERE id=$1`, [ids[1]]);
    await pool.query(`UPDATE deliveries SET status='failed',terminal_at=now() WHERE id=$1`, [ids[2]]);

    const vista = await cola();
    expect(vista).toMatchObject({ pending: 1, retrying: 1, dead: 2, muestra_recortada: false });
    expect(vista.totals).toEqual({ pending: 1, retrying: 1, dead: 2 });
    expect(vista.items).toHaveLength(4);
    expect(vista.items.every((item) => item.recipient_alias === 'salva')).toBe(true);
  });

  it('una muestra recortada lo declara sin mentir sobre los totales', async () => {
    await entregas(3);

    const vista = await cola('Steven', 'kant', 2);
    expect(vista.items).toHaveLength(2);
    expect(vista.muestra_recortada).toBe(true);
    expect(vista.totals.pending).toBe(3);
  });

  it('exactamente `limit` entregas NO es una muestra recortada', async () => {
    await entregas(2);

    const vista = await cola('Steven', 'kant', 2);
    expect(vista.items).toHaveLength(2);
    expect(vista.muestra_recortada).toBe(false);
  });

  it('el destinatario ve sus entregas y el tenant sin arista no ve ninguna', async () => {
    await entregas(1);

    expect((await cola('Isa', 'salva')).items).toHaveLength(1);
    await pool.query(`UPDATE acl_edges SET allow_read=false WHERE from_tenant='Isa' AND to_tenant='Steven'`);
    expect((await cola('Isa', 'salva')).items).toEqual([]);
    expect((await cola('Isa', 'salva')).totals).toEqual({ pending: 0, retrying: 0, dead: 0 });
  });
});
