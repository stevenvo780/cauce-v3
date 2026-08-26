import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MapShadowTargetRegistry } from '../../services/shadow-router/src/target.js';
import { PostgresShadowRepository } from '../../services/shadow-router/src/repository.js';
import { ShadowRouter } from '../../services/shadow-router/src/router.js';
import type { ShadowEnvelope } from '../../services/shadow-router/src/types.js';
import { ShadowRouterWorker } from '../../services/shadow-router/src/worker.js';
import type { DatabasePool } from '../../packages/store/src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase,
} from '../helpers/postgres.js';

const version = '036_shadow_router_target_phase.sql';
const upPath = new URL(`../../packages/store/migrations/${version}`, import.meta.url);
const downPath = new URL(`../../packages/store/migrations/down/${version}`, import.meta.url);

let database: TestDatabase;
let pool: DatabasePool;
let up: string;
let down: string;

function envelope(source = 'shadow-phase-source'): ShadowEnvelope {
  return {
    direction: 'v2-to-v3',
    source_event_id: source,
    tenant_id: 'Steven',
    correlation: { request_id: `${source}-request`, trace_id: `${source}-trace` },
    payload: { synthetic: true },
    expects_human_reply: false,
  };
}

async function columnExists(): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='shadow_router_inbox'
          AND column_name='claim_target_started'
     ) AS exists`,
  );
  return result.rows[0]?.exists === true;
}

async function ensureUp(): Promise<void> {
  if (!await columnExists()) await pool.query(up);
  await pool.query(
    `INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING`, [version],
  );
}

beforeAll(async () => {
  [up, down] = await Promise.all([readFile(upPath, 'utf8'), readFile(downPath, 'utf8')]);
  database = await startTestDatabase();
  pool = database.pool;
}, 120_000);

beforeEach(async () => {
  await ensureUp();
  await resetTestDatabase(pool);
  await pool.query(`DELETE FROM schema_migrations WHERE version='999_future.sql'`);
});

afterEach(async () => {
  await pool.query(`DELETE FROM schema_migrations WHERE version='999_future.sql'`);
  await pool.query(
    `UPDATE shadow_router_inbox
        SET status=CASE WHEN attempts=0 THEN 'pending' ELSE 'failed' END,
            claimed_by=NULL,claim_token=NULL,claim_expires_at=NULL
      WHERE status='processing'`,
  ).catch(() => undefined);
  await ensureUp();
});

afterAll(async () => {
  await pool?.end();
  await database?.container.stop();
});

describe('durable shadow target phase', () => {
  it('forces stop/drain before up and rejects every eager pre-036 claim after commit', async () => {
    await pool.query(down);
    const repository = new PostgresShadowRepository(pool);
    const input = envelope('shadow-phase-rollout-interlock');
    await repository.enqueue(input, 'shadow');
    await pool.query(
      `UPDATE shadow_router_inbox
          SET status='processing',attempts=attempts+1,claimed_by='old-worker',
              claim_token=gen_random_uuid(),claim_expires_at=now()-interval '1 millisecond'
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    );

    await expect(pool.query(up)).rejects.toThrow(/workers stopped and processing leases drained/u);
    expect(await columnExists()).toBe(false);
    await pool.query(
      `UPDATE shadow_router_inbox
          SET status='failed',available_at=now(),claimed_by=NULL,claim_token=NULL,
              claim_expires_at=NULL,last_error='old drain'
        WHERE status='processing'`,
    );
    await ensureUp();

    await expect(pool.query(
      `UPDATE shadow_router_inbox
          SET status='processing',attempts=attempts+1,claimed_by='old-worker',
              claim_token=gen_random_uuid(),claim_expires_at=now()+interval '30 seconds'
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    )).rejects.toMatchObject({ constraint: 'shadow_router_inbox_claim_phase_transition' });
    await expect(pool.query(
      `SELECT status,attempts,claim_target_started FROM shadow_router_inbox
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    )).resolves.toMatchObject({
      rows: [{ status: 'pending', attempts: 0, claim_target_started: false }],
    });
  });

  it('arms dispatch before target invocation and consumes the attempt only with completion', async () => {
    const repository = new PostgresShadowRepository(pool);
    const input = envelope('shadow-phase-order');
    await repository.enqueue(input, 'shadow');
    const preview = vi.fn(async () => {
      await expect(pool.query(
        `SELECT status,attempts,claim_target_started FROM shadow_router_inbox
          WHERE direction=$1 AND source_event_id=$2`,
        [input.direction, input.source_event_id],
      )).resolves.toMatchObject({
        rows: [{ status: 'processing', attempts: 0, claim_target_started: true }],
      });
      return { output: { ok: true } };
    });
    const router = new ShadowRouter({
      mode: 'shadow',
      allowedTenants: new Set(['Steven']),
      repository,
      targets: new MapShadowTargetRegistry([[
        'v2-to-v3', { preview, deliver: vi.fn(async () => ({})) },
      ]]),
    });

    await expect(new ShadowRouterWorker({ repository, router }).runOnce()).resolves.toBe(1);

    expect(preview).toHaveBeenCalledOnce();
    await expect(pool.query(
      `SELECT status,attempts,claim_target_started,claimed_by,claim_token
         FROM shadow_router_inbox WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    )).resolves.toMatchObject({ rows: [{
      status: 'done', attempts: 1, claim_target_started: false,
      claimed_by: null, claim_token: null,
    }] });
  });

  it('recovers release timeout without consuming its unstarted attempt', async () => {
    const repository = new PostgresShadowRepository(pool);
    const input = envelope('shadow-phase-release-timeout');
    await repository.enqueue(input, 'shadow');
    const [lease] = await repository.claim('worker-before-outage', 1, 30_000);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `SELECT id FROM shadow_router_inbox
          WHERE direction=$1 AND source_event_id=$2 FOR UPDATE`,
        [input.direction, input.source_event_id],
      );
      await expect(repository.releaseUnstartedInbox(
        lease!, 'shutdown cleanup timed out', AbortSignal.timeout(75),
      )).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
    await pool.query(
      `UPDATE shadow_router_inbox SET claim_expires_at=now()-interval '1 millisecond'
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    );

    const replacement = new PostgresShadowRepository(pool);
    const [recovered] = await replacement.claim('worker-after-outage', 1, 30_000);
    expect(recovered).toMatchObject({ attempt: 1, source_event_id: input.source_event_id });
    await expect(pool.query(
      `SELECT attempts,claim_target_started FROM shadow_router_inbox
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    )).resolves.toMatchObject({ rows: [{ attempts: 0, claim_target_started: false }] });
    await replacement.releaseUnstartedInbox(recovered!, 'test cleanup');
  });

  it('reoffers the armed final crash window and dead-letters only an observed failure', async () => {
    const input = envelope('shadow-phase-final-attempt');
    const first = new PostgresShadowRepository(pool);
    await first.enqueue(input, 'shadow');
    await pool.query(
      `UPDATE shadow_router_inbox SET attempts=4,max_attempts=5
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    );
    const [armed] = await first.claim('worker-final-crash', 1, 30_000);
    await first.begin(input, 'shadow');
    await first.markTargetStarted(armed!);
    await expect(pool.query(
      `SELECT attempts,claim_target_started FROM shadow_router_inbox
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    )).resolves.toMatchObject({ rows: [{ attempts: 4, claim_target_started: true }] });
    await pool.query(
      `UPDATE shadow_router_inbox SET claim_expires_at=now()-interval '1 millisecond'
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    );

    const replacement = new PostgresShadowRepository(pool);
    const [replayed] = await replacement.claim('worker-final-replay', 1, 30_000);
    expect(replayed).toMatchObject({ attempt: 5, max_attempts: 5 });
    await replacement.markTargetStarted(replayed!);
    await expect(replacement.retryInbox(replayed!, 0, 'observed target failure')).resolves.toBe('dead');
    await expect(pool.query(
      `SELECT status,attempts FROM shadow_router_inbox
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    )).resolves.toMatchObject({ rows: [{ status: 'dead', attempts: 5 }] });
  });

  it('keeps mapping terminal and settles done when a competing final lease fails late', async () => {
    const input = envelope('shadow-phase-competing-leases');
    const leaseARepository = new PostgresShadowRepository(pool);
    await leaseARepository.enqueue(input, 'shadow');
    await pool.query(
      `UPDATE shadow_router_inbox SET attempts=4,max_attempts=5
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    );
    const [leaseA] = await leaseARepository.claim('worker-a', 1, 30_000);
    const mapping = await leaseARepository.begin(input, 'shadow');
    await leaseARepository.markTargetStarted(leaseA!);
    await pool.query(
      `UPDATE shadow_router_inbox SET claim_expires_at=now()-interval '1 millisecond'
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    );

    const leaseBRepository = new PostgresShadowRepository(pool);
    const [leaseB] = await leaseBRepository.claim('worker-b', 1, 30_000);
    await leaseBRepository.markTargetStarted(leaseB!);
    // A returns after expiry and durably completes the shared idempotent effect.
    await leaseARepository.complete(mapping, 'shadowed');
    const terminal = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM shadow_router_mappings
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    );
    // Exact old/unconditional late failure shape from B: the 036 DB trigger must preserve A.
    await pool.query(
      `UPDATE shadow_router_mappings SET status='failed',updated_at=now()
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    );
    await expect(pool.query(
      `SELECT status,updated_at FROM shadow_router_mappings
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    )).resolves.toMatchObject({ rows: [{
      status: 'shadowed', updated_at: terminal.rows[0]?.updated_at,
    }] });

    await expect(leaseBRepository.retryInbox(leaseB!, 0, 'late competing failure'))
      .resolves.toBe('done');
    await expect(pool.query(
      `SELECT status,attempts,last_error FROM shadow_router_inbox
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    )).resolves.toMatchObject({
      rows: [{ status: 'done', attempts: 5, last_error: null }],
    });
  });

  it('repairs a competing final dead settlement when expired target success commits later', async () => {
    const input = envelope('shadow-phase-competing-dead-first');
    const leaseARepository = new PostgresShadowRepository(pool);
    await leaseARepository.enqueue(input, 'shadow');
    await pool.query(
      `UPDATE shadow_router_inbox SET attempts=4,max_attempts=5
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    );
    const [leaseA] = await leaseARepository.claim('worker-a-dead-first', 1, 30_000);
    const mapping = await leaseARepository.begin(input, 'shadow');
    await leaseARepository.markTargetStarted(leaseA!);
    await pool.query(
      `UPDATE shadow_router_inbox SET claim_expires_at=now()-interval '1 millisecond'
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    );
    const leaseBRepository = new PostgresShadowRepository(pool);
    const [leaseB] = await leaseBRepository.claim('worker-b-dead-first', 1, 30_000);
    await leaseBRepository.markTargetStarted(leaseB!);

    // B settles its observed failure first and legitimately consumes the final attempt.
    await leaseBRepository.complete(mapping, 'failed');
    await expect(leaseBRepository.retryInbox(leaseB!, 0, 'B failed before A committed'))
      .resolves.toBe('dead');
    await expect(pool.query(
      `SELECT status,attempts FROM shadow_router_inbox
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    )).resolves.toMatchObject({ rows: [{ status: 'dead', attempts: 5 }] });

    // A's late success is authoritative and atomically repairs B's false terminal inbox state.
    await leaseARepository.complete(mapping, 'shadowed');
    await expect(pool.query(
      `SELECT inbox.status AS inbox_status,inbox.attempts,mapping.status AS mapping_status
         FROM shadow_router_inbox inbox
         JOIN shadow_router_mappings mapping USING(direction,source_event_id)
        WHERE inbox.direction=$1 AND inbox.source_event_id=$2`,
      [input.direction, input.source_event_id],
    )).resolves.toMatchObject({ rows: [{
      inbox_status: 'done', attempts: 5, mapping_status: 'shadowed',
    }] });
  });

  it('accounts late target success after its replacement releases before target invocation', async () => {
    const input = envelope('shadow-phase-late-success-after-unstarted-release');
    const leaseARepository = new PostgresShadowRepository(pool);
    await leaseARepository.enqueue(input, 'shadow');
    await pool.query(
      `UPDATE shadow_router_inbox SET attempts=4,max_attempts=5
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    );
    const [leaseA] = await leaseARepository.claim('worker-a-late-success', 1, 30_000);
    const mapping = await leaseARepository.begin(input, 'shadow');
    await leaseARepository.markTargetStarted(leaseA!);
    await pool.query(
      `UPDATE shadow_router_inbox SET claim_expires_at=now()-interval '1 millisecond'
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    );

    const leaseBRepository = new PostgresShadowRepository(pool);
    const [leaseB] = await leaseBRepository.claim('worker-b-unstarted-release', 1, 30_000);
    expect(leaseB).toMatchObject({ attempt: 5 });
    await leaseBRepository.releaseUnstartedInbox(leaseB!, 'shutdown before target invocation');
    const released = await pool.query<{ status: string; attempts: number; last_error: string | null }>(
      `SELECT status,attempts,last_error FROM shadow_router_inbox
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    );
    expect(released.rows).toMatchObject([{ status: 'failed', attempts: 4 }]);
    expect(released.rows[0]?.last_error).toMatch(
      /^shadow inbox lease released before target dispatch:/u,
    );

    // A's delayed terminal mapping proves that the still-unaccounted logical attempt settled.
    await leaseARepository.complete(mapping, 'shadowed');
    await expect(pool.query(
      `SELECT inbox.status AS inbox_status,inbox.attempts,inbox.last_error,
              mapping.status AS mapping_status
         FROM shadow_router_inbox inbox
         JOIN shadow_router_mappings mapping USING(direction,source_event_id)
        WHERE inbox.direction=$1 AND inbox.source_event_id=$2`,
      [input.direction, input.source_event_id],
    )).resolves.toMatchObject({ rows: [{
      inbox_status: 'done', attempts: 5, last_error: null, mapping_status: 'shadowed',
    }] });
  });

  it('marks an abandoned armed lease orphaned until late mapping success reconciles done', async () => {
    const repository = new PostgresShadowRepository(pool);
    const input = envelope('shadow-phase-terminal-reconcile');
    await repository.enqueue(input, 'shadow');
    const [lease] = await repository.claim('worker-before-terminal-crash', 1, 30_000);
    await repository.markTargetStarted(lease!);
    const mapping = await repository.begin(input, 'shadow');
    expect(await repository.health()).toMatchObject({
      processing: 1, owned_processing: 1, orphaned_processing: 0,
    });
    repository.abandonLocalInboxClaim(lease!);
    expect(await repository.health()).toMatchObject({
      processing: 1, owned_processing: 0, orphaned_processing: 1,
    });
    await repository.complete(mapping, 'shadowed');
    await expect(pool.query(
      `SELECT status,attempts,completed_at IS NOT NULL AS completed FROM shadow_router_inbox
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    )).resolves.toMatchObject({
      rows: [{ status: 'done', attempts: 1, completed: true }],
    });
  });

  it('accepts an already committed inbox completion after its acknowledgement is lost', async () => {
    const repository = new PostgresShadowRepository(pool);
    const input = envelope('shadow-phase-lost-completion-ack');
    await repository.enqueue(input, 'shadow');
    const [lease] = await repository.claim('worker-lost-completion-ack', 1, 30_000);
    await repository.markTargetStarted(lease!);
    await pool.query(
      `UPDATE shadow_router_inbox
          SET status='done',attempts=attempts+1,completed_at=now(),
              claimed_by=NULL,claim_token=NULL,claim_expires_at=NULL,claim_target_started=false
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    );

    await expect(repository.completeInbox(lease!)).resolves.toBeUndefined();
    await expect(pool.query(
      `SELECT status,attempts FROM shadow_router_inbox
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    )).resolves.toMatchObject({ rows: [{ status: 'done', attempts: 1 }] });
  });

  it('rejects a reused source id when any immutable envelope dimension differs', async () => {
    const repository = new PostgresShadowRepository(pool);
    const input = envelope('shadow-envelope-conflict');
    await expect(repository.enqueue(input, 'compare')).resolves.toMatchObject({ duplicate: false });
    await expect(repository.enqueue(input, 'compare')).resolves.toMatchObject({ duplicate: true });
    for (const changed of [
      { ...input, payload: { synthetic: false } },
      { ...input, baseline: { answer: 'different' } },
      { ...input, expects_human_reply: true },
    ]) {
      await expect(repository.enqueue(changed, 'compare')).rejects.toMatchObject({
        code: 'shadow_inbox_idempotency_conflict',
      });
    }
  });

  it('repairs historical terminal false dead and restores blocked no-target accounting', async () => {
    await pool.query(down);
    const delivered = envelope('shadow-phase-historical-delivered');
    const blocked = envelope('shadow-phase-historical-blocked');
    for (const [input, status, attempts] of [
      [delivered, 'shadowed', 5],
      [blocked, 'blocked', 3],
    ] as const) {
      await pool.query(
        `INSERT INTO shadow_router_mappings(
           direction,source_event_id,tenant_id,mode,correlation,status
         ) VALUES($1,$2,$3,'shadow',$4::jsonb,$5)`,
        [input.direction, input.source_event_id, input.tenant_id, JSON.stringify(input.correlation), status],
      );
      await pool.query(
        `INSERT INTO shadow_router_inbox(
           direction,source_event_id,tenant_id,mode,correlation,envelope,status,
           attempts,max_attempts,last_error
         ) VALUES($1,$2,$3,'shadow',$4::jsonb,$5::jsonb,'dead',$6,5,'old false dead')`,
        [
          input.direction, input.source_event_id, input.tenant_id,
          JSON.stringify(input.correlation), JSON.stringify(input), attempts,
        ],
      );
    }

    await ensureUp();

    await expect(pool.query(
      `SELECT source_event_id,status,attempts,last_error
         FROM shadow_router_inbox ORDER BY source_event_id`,
    )).resolves.toMatchObject({ rows: [
      {
        source_event_id: blocked.source_event_id,
        status: 'done',
        attempts: 2,
        last_error: 'shadow accounting v036: blocked mapping proves target was not invoked',
      },
      { source_event_id: delivered.source_event_id, status: 'done', attempts: 5, last_error: null },
    ] });

    // The blocked accounting marker survives rollback, so re-applying 036 is idempotent.
    await pool.query(down);
    await ensureUp();
    await expect(pool.query(
      `SELECT status,attempts,last_error FROM shadow_router_inbox
        WHERE direction=$1 AND source_event_id=$2`,
      [blocked.direction, blocked.source_event_id],
    )).resolves.toMatchObject({ rows: [{
      status: 'done',
      attempts: 2,
      last_error: 'shadow accounting v036: blocked mapping proves target was not invoked',
    }] });
  });

  it('restores full capacity when legacy eager attempt history has no terminal proof', async () => {
    await pool.query(down);
    const input = envelope('shadow-phase-historical-ambiguous');
    await pool.query(
      `INSERT INTO shadow_router_mappings(
         direction,source_event_id,tenant_id,mode,correlation,status
       ) VALUES($1,$2,$3,'shadow',$4::jsonb,'failed')`,
      [input.direction, input.source_event_id, input.tenant_id, JSON.stringify(input.correlation)],
    );
    await pool.query(
      `INSERT INTO shadow_router_inbox(
         direction,source_event_id,tenant_id,mode,correlation,envelope,status,attempts,max_attempts
       ) VALUES($1,$2,$3,'shadow',$4::jsonb,$5::jsonb,'dead',5,5)`,
      [
        input.direction, input.source_event_id, input.tenant_id,
        JSON.stringify(input.correlation), JSON.stringify(input),
      ],
    );

    await ensureUp();

    await expect(pool.query(
      `SELECT status,attempts,last_error FROM shadow_router_inbox
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    )).resolves.toMatchObject({ rows: [{
      status: 'pending', attempts: 0,
      last_error: 'schema 036 reset unverifiable eager attempt history',
    }] });

    const repository = new PostgresShadowRepository(pool);
    const [reopened] = await repository.claim('worker-after-ambiguous-backfill', 1, 30_000);
    expect(reopened).toMatchObject({ attempt: 1, max_attempts: 5 });
    await repository.releaseUnstartedInbox(reopened!, 'test cleanup');
  });

  it('preserves runtime-036 observed attempt accounting across drained down and up', async () => {
    const repository = new PostgresShadowRepository(pool);
    const input = envelope('shadow-phase-observed-down-up');
    await repository.enqueue(input, 'shadow');
    const [lease] = await repository.claim('worker-observed-before-down', 1, 30_000);
    const mapping = await repository.begin(input, 'shadow');
    await repository.markTargetStarted(lease!);
    await repository.complete(mapping, 'failed');
    await expect(repository.retryInbox(lease!, 0, 'synthetic observed failure'))
      .resolves.toBe('retry');
    const observed = await pool.query<{ status: string; attempts: number; last_error: string | null }>(
      `SELECT status,attempts,last_error FROM shadow_router_inbox
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    );
    expect(observed.rows).toMatchObject([{ status: 'failed', attempts: 1 }]);
    expect(observed.rows[0]?.last_error).toMatch(/^shadow target settlement observed:/u);

    await pool.query(down);
    await ensureUp();
    const restored = await pool.query<{ status: string; attempts: number; last_error: string | null }>(
      `SELECT status,attempts,last_error FROM shadow_router_inbox
        WHERE direction=$1 AND source_event_id=$2`,
      [input.direction, input.source_event_id],
    );
    expect(restored.rows).toMatchObject([{ status: 'failed', attempts: 1 }]);
    expect(restored.rows[0]?.last_error).toMatch(/^shadow target settlement observed:/u);
  });

  it('round-trips only while drained, rejects later schema, and restores old writer after down', async () => {
    const repository = new PostgresShadowRepository(pool);
    const input = envelope('shadow-phase-down-guard');
    await repository.enqueue(input, 'shadow');
    const [lease] = await repository.claim('worker-down-guard', 1, 30_000);
    await expect(pool.query(down)).rejects.toThrow(/shadow leases are processing/u);
    await repository.releaseUnstartedInbox(lease!, 'drain for migration test');

    await pool.query(`INSERT INTO schema_migrations(version) VALUES('999_future.sql')`);
    await expect(pool.query(down)).rejects.toThrow(/later migration/u);
    await pool.query(`DELETE FROM schema_migrations WHERE version='999_future.sql'`);
    await pool.query(down);
    expect(await columnExists()).toBe(false);

    const oldInput = envelope('shadow-phase-old-after-down');
    await repository.enqueue(oldInput, 'shadow');
    await expect(pool.query(
      `UPDATE shadow_router_inbox
          SET status='processing',attempts=attempts+1,claimed_by='old-after-down',
              claim_token=gen_random_uuid(),claim_expires_at=now()+interval '30 seconds'
        WHERE direction=$1 AND source_event_id=$2 RETURNING attempts`,
      [oldInput.direction, oldInput.source_event_id],
    )).resolves.toMatchObject({ rows: [{ attempts: 1 }] });
    await pool.query(
      `UPDATE shadow_router_inbox
          SET status='failed',claimed_by=NULL,claim_token=NULL,claim_expires_at=NULL
        WHERE direction=$1 AND source_event_id=$2`,
      [oldInput.direction, oldInput.source_event_id],
    );
  });
});
