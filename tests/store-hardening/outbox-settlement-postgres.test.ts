import { preparePostgresSuite } from '../../packages/store/test/postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PublishMessage } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '@cauce/store';
import type { ClaimedOutboxEvent } from '@cauce/store';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

/**
 * Settlement of the adapter outbox: the transitions behind the recurring symptom "delegations
 * stop while the agents look alive". `completeOutbox`/`retryOutbox` and the two
 * `outbox_dead_letters` inserts are the third of the file the rest of the suites never reach.
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
    recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
    body: { text: 'outbox settlement' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 0,
    ...overrides
  };
}

interface OutboxRow {
  status: string;
  attempts: number;
  claimed_by: string | null;
  claim_token: string | null;
  claim_expires_at: Date | null;
  sent_at: Date | null;
  last_error: string | null;
  payload: Record<string, unknown>;
}

async function fila(id: string): Promise<OutboxRow> {
  const result = await pool.query<OutboxRow>(
    `SELECT status,attempts,claimed_by,claim_token,claim_expires_at,sent_at,last_error,payload
     FROM adapter_outbox WHERE id=$1`, [id]
  );
  const row = result.rows[0];
  if (!row) throw new Error(`adapter_outbox ${id} desapareció`);
  return row;
}

async function reclamar(worker: string, maxAttempts?: number): Promise<ClaimedOutboxEvent> {
  await repository.publish(command());
  if (maxAttempts !== undefined) {
    await pool.query(`UPDATE adapter_outbox SET max_attempts=$1 WHERE status='pending'`, [maxAttempts]);
  }
  const [claimed] = await repository.claimOutbox('wake', worker, 1, 5_000);
  if (!claimed) throw new Error('el wake no se pudo reclamar');
  return claimed;
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

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

describe('retryOutbox', () => {
  it('con los intentos agotados muere y deja la incidencia con su carga y sus intentos', async () => {
    const claimed = await reclamar('retry-dlq', 1);
    const antes = await fila(claimed.id);

    expect(await repository.retryOutbox(
      claimed.id, 'retry-dlq', claimed.claim_token, 250, 'el adaptador rechaza el wake'
    )).toBe('dead');

    const despues = await fila(claimed.id);
    expect(despues.status).toBe('dead');
    expect(despues.claim_expires_at).toBeNull();
    expect(despues.last_error).toBe('el adaptador rechaza el wake');

    const dlq = await pool.query<{ reason: string; attempts: number; payload: Record<string, unknown>; kind: string }>(
      'SELECT reason,attempts,payload,kind FROM outbox_dead_letters WHERE outbox_id=$1', [claimed.id]
    );
    expect(dlq.rows).toHaveLength(1);
    expect(dlq.rows[0]).toMatchObject({
      reason: 'el adaptador rechaza el wake', attempts: antes.attempts, kind: 'wake'
    });
    expect(dlq.rows[0]?.payload).toEqual(antes.payload);
  });

  it('con intentos de sobra devuelve la fila a la cola y suelta la garra', async () => {
    const claimed = await reclamar('retry-vivo', 5);

    expect(await repository.retryOutbox(claimed.id, 'retry-vivo', claimed.claim_token, 5_000, 'red caída'))
      .toBe('retry');

    const despues = await fila(claimed.id);
    expect(despues).toMatchObject({
      status: 'failed', claimed_by: null, claim_token: null, claim_expires_at: null, last_error: 'red caída'
    });
    expect((await pool.query('SELECT 1 FROM outbox_dead_letters WHERE outbox_id=$1', [claimed.id])).rowCount)
      .toBe(0);
  });

  it('recorta el motivo a 2000 caracteres antes de escribirlo', async () => {
    const claimed = await reclamar('retry-largo', 1);

    expect(await repository.retryOutbox(claimed.id, 'retry-largo', claimed.claim_token, 0, 'x'.repeat(4_000)))
      .toBe('dead');

    const dlq = await pool.query<{ reason: string }>(
      'SELECT reason FROM outbox_dead_letters WHERE outbox_id=$1', [claimed.id]
    );
    expect(dlq.rows[0]?.reason).toHaveLength(2_000);
  });

  it('sin trabajador o con una garra rancia queda vallado y no consume el intento', async () => {
    const claimed = await reclamar('retry-vallado', 5);

    expect(await repository.retryOutbox(claimed.id)).toBe('fenced');
    expect(await repository.retryOutbox(claimed.id, 'retry-vallado')).toBe('fenced');
    expect(await repository.retryOutbox(claimed.id, 'retry-vallado', randomUUID())).toBe('fenced');
    expect(await repository.retryOutbox(claimed.id, 'otro-trabajador', claimed.claim_token)).toBe('fenced');

    const despues = await fila(claimed.id);
    expect(despues).toMatchObject({ status: 'processing', attempts: claimed.attempt, last_error: null });
  });

  it('una garra caducada en vuelo ya no puede liquidar la fila', async () => {
    const claimed = await reclamar('retry-caducado', 5);
    await pool.query(
      `UPDATE adapter_outbox SET claim_expires_at=now()-interval '1 second' WHERE id=$1`, [claimed.id]
    );

    expect(await repository.retryOutbox(claimed.id, 'retry-caducado', claimed.claim_token)).toBe('fenced');
    expect((await fila(claimed.id)).status).toBe('processing');
  });
});

describe('completeOutbox', () => {
  it('cierra la fila reclamada por su propio trabajador', async () => {
    const claimed = await reclamar('complete-feliz');

    expect(await repository.completeOutbox(claimed.id, 'complete-feliz', claimed.claim_token)).toBe(true);

    const despues = await fila(claimed.id);
    expect(despues.status).toBe('sent');
    expect(despues.sent_at).not.toBeNull();
    expect(despues.claim_expires_at).toBeNull();
  });

  it('con una garra rancia es un no-op que devuelve false', async () => {
    const claimed = await reclamar('complete-rancio');

    expect(await repository.completeOutbox(claimed.id, 'complete-rancio', randomUUID())).toBe(false);
    expect(await repository.completeOutbox(claimed.id, 'otro-trabajador', claimed.claim_token)).toBe(false);
    expect(await repository.completeOutbox(claimed.id)).toBe(false);
    expect(await repository.completeOutbox(claimed.id, 'complete-rancio')).toBe(false);

    const despues = await fila(claimed.id);
    expect(despues).toMatchObject({ status: 'processing', sent_at: null });
  });

  it('con la garra caducada en vuelo tampoco cierra la fila', async () => {
    const claimed = await reclamar('complete-caducado');
    await pool.query(
      `UPDATE adapter_outbox SET claim_expires_at=now()-interval '1 second' WHERE id=$1`, [claimed.id]
    );

    expect(await repository.completeOutbox(claimed.id, 'complete-caducado', claimed.claim_token)).toBe(false);
    expect((await fila(claimed.id)).status).toBe('processing');
  });
});

describe('ackOutbox', () => {
  it('un ACK dead explícito escribe la incidencia aunque queden intentos', async () => {
    const claimed = await reclamar('ack-dead', 5);
    const antes = await fila(claimed.id);

    expect(await repository.ackOutbox({
      event_id: claimed.event_id, attempt: claimed.attempt, claim_token: claimed.claim_token,
      status: 'dead'
    })).toEqual({ status: 'dead', applied: true });

    const dlq = await pool.query<{ reason: string; attempts: number; payload: Record<string, unknown> }>(
      'SELECT reason,attempts,payload FROM outbox_dead_letters WHERE outbox_id=$1', [claimed.id]
    );
    expect(dlq.rows).toHaveLength(1);
    expect(dlq.rows[0]?.reason).toBe('worker rejected outbox event');
    expect(dlq.rows[0]?.attempts).toBe(antes.attempts);
    expect(dlq.rows[0]?.payload).toEqual(antes.payload);
  });

  it('con la garra caducada en vuelo el ACK no se aplica y la fila no cambia', async () => {
    const claimed = await reclamar('ack-caducado', 5);
    await pool.query(
      `UPDATE adapter_outbox SET claim_expires_at=now()-interval '1 second' WHERE id=$1`, [claimed.id]
    );

    expect(await repository.ackOutbox({
      event_id: claimed.event_id, attempt: claimed.attempt, claim_token: claimed.claim_token,
      status: 'sent'
    })).toEqual({ status: 'failed', applied: false });

    const despues = await fila(claimed.id);
    expect(despues).toMatchObject({ status: 'processing', sent_at: null });
  });

  it('un ACK sin garra o con intento no positivo es un error de vallado', async () => {
    const claimed = await reclamar('ack-invalido', 5);

    await expect(repository.ackOutbox({
      event_id: claimed.event_id, attempt: 0, claim_token: claimed.claim_token, status: 'sent'
    })).rejects.toMatchObject({ code: 'fenced' });
    await expect(repository.ackOutbox({
      event_id: claimed.event_id, attempt: claimed.attempt, claim_token: '', status: 'sent'
    })).rejects.toMatchObject({ code: 'fenced' });
  });
});
