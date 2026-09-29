import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CauceRepository } from '../src/index.js';
import { requireValue } from './helpers.js';
import {
  apply, type OperatorResolution, plan, pool, type ReconciliationPlan, registerDlqSuite,
  type SafeList, seedDeadDelivery, seedDeadOutbox, seedEffect,
} from './dlq-causal-reconciliation-postgres-helpers.js';

registerDlqSuite(import.meta.url);

describe('operator-only DLQ transitions', () => {
  it('manual replay verifies control and hash, preserves the incident, and reopens it on failure', async () => {
    const fixture = await seedDeadOutbox();
    const replayRequestId = randomUUID();
    await seedEffect(fixture, 0, 1, 'ambiguous', { hash: 'a'.repeat(64) });
    await apply(await plan());
    const incidentEvidence = requireValue((await pool.query<{ evidence_sha256: string }>(
      `SELECT evidence_sha256 FROM outbox_dead_letters WHERE id=$1`, [fixture.letterId],
    )).rows[0], 'rows').evidence_sha256;
    const inspected = requireValue((await pool.query<{ value: Record<string, unknown> }>(
      `SELECT cauce_inspect_telegram_replay_030($1,$2,'Steven','kant') AS value`,
      [fixture.letterId, incidentEvidence],
    )).rows[0], 'rows').value;
    expect(Object.keys(inspected).sort()).toEqual([
      'evidenceSha256', 'id', 'items', 'phase', 'schemaVersion', 'suite', 'total',
    ]);
    expect(inspected).toMatchObject({
      id: fixture.letterId,
      evidenceSha256: incidentEvidence,
      total: 1,
      items: [{
        chunkIndex: 0, effectSha256: 'a'.repeat(64),
        state: 'ambiguous', replayCount: 0, duplicateRisk: true,
      }],
    });
    const inspectedText = JSON.stringify(inspected);
    expect(inspectedText).not.toMatch(/payload|origin|provider|messageId|outboxId|diagnostic/u);
    expect(inspectedText).not.toContain(fixture.outboxId);

    await expect(pool.query(
      `SELECT cauce_manual_replay_telegram_030(
         $1,0,'ticket 42','Steven','jarvis',true,$2,$3,$4,0
       )`,
      ['a'.repeat(64), randomUUID(), fixture.letterId, incidentEvidence],
    )).rejects.toThrow(/lacks control permission/u);
    await expect(pool.query(
      `SELECT cauce_manual_replay_telegram_030(
         $1,0,'ticket 42','Steven','kant',false,$2,$3,$4,0
       )`,
      ['a'.repeat(64), randomUUID(), fixture.letterId, incidentEvidence],
    )).rejects.toThrow(/duplicate-risk acknowledgement/u);
    await expect(pool.query(
      `SELECT cauce_manual_replay_telegram_030(
         $1,0,'ticket 42','Steven','kant',true,$2,$3,$4,0
       )`,
      ['b'.repeat(64), randomUUID(), fixture.letterId, incidentEvidence],
    )).rejects.toThrow(/exactly one current effect/u);

    const replay = requireValue((await pool.query<{ value: Record<string, unknown> }>(
      `SELECT cauce_manual_replay_telegram_030(
         $1,0,'ticket 42','Steven','kant',true,$2,$3,$4,0
       ) AS value`,
      ['a'.repeat(64), replayRequestId, fixture.letterId, incidentEvidence],
    )).rows[0], 'rows').value;
    expect(replay).toMatchObject({ appliedCount: 1, duplicateRisk: true });
    expect((await pool.query<{ status: string; state: string; resolved: boolean }>(
      `SELECT outbox.status,effect.state,letter.resolved_at IS NOT NULL AS resolved
       FROM adapter_outbox outbox
       JOIN telegram_egress_effects effect ON effect.outbox_id=outbox.id
       JOIN outbox_dead_letters letter ON letter.outbox_id=outbox.id
       WHERE outbox.id=$1`, [fixture.outboxId],
    )).rows[0]).toEqual({ status: 'failed', state: 'prepared', resolved: true });
    expect((await pool.query(
      `SELECT 1 FROM outbox_dead_letters WHERE id=$1`, [fixture.letterId],
    )).rowCount).toBe(1);

    await pool.query(
      `UPDATE adapter_outbox SET status='dead',attempts=attempts+1,dead_at=now(),
         last_error='known later rejection',claimed_by='telegram-worker'
       WHERE id=$1 AND status='failed'`,
      [fixture.outboxId],
    );
    const reopened = (await pool.query<{
      resolved: boolean; reopen_count: number; last_reopened_at: Date | null;
    }>(
      `SELECT resolved_at IS NOT NULL AS resolved,reopen_count,last_reopened_at
       FROM outbox_dead_letters WHERE id=$1`, [fixture.letterId],
    )).rows[0];
    expect(reopened).toMatchObject({ resolved: false, reopen_count: 1 });
    expect(reopened?.last_reopened_at).toBeInstanceOf(Date);
    expect((await pool.query(
      `SELECT 1 FROM telegram_manual_replays WHERE effect_id=$1`, [`${fixture.outboxId}:0`],
    )).rowCount).toBe(1);
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='dlq.reopen'`,
    )).rowCount).toBe(1);
    const idempotentRetry = await pool.query<{ value: Record<string, unknown> }>(
      `SELECT cauce_manual_replay_telegram_030(
         $1,0,'ticket 42','Steven','kant',true,$2,$3,$4,0
       ) AS value`,
      ['a'.repeat(64), replayRequestId, fixture.letterId, incidentEvidence],
    );
    expect(requireValue(idempotentRetry.rows[0], 'idempotentRetry.rows').value).toMatchObject({
      appliedCount: 0, alreadyApplied: true, replaySequence: 1,
    });
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM telegram_manual_replays WHERE request_id=$1`,
      [replayRequestId],
    )).rows[0]?.count).toBe('1');

    await expect(pool.query(
      `SELECT cauce_manual_replay_telegram_030(
         $1,0,'stale review','Steven','kant',true,$2,$3,$4,0
       )`, [
        'a'.repeat(64), randomUUID(), fixture.letterId, incidentEvidence,
      ],
    )).rejects.toThrow(/incident evidence changed|current incident state|incident\/effect evidence/u);
    await apply(await plan());
    const refreshed = requireValue((await pool.query<{
      evidence_sha256: string;
    }>(
      `SELECT evidence_sha256 FROM outbox_dead_letters WHERE id=$1`, [fixture.letterId],
    )).rows[0], 'rows').evidence_sha256;
    const refreshedInspect = requireValue((await pool.query<{ value: Record<string, unknown> }>(
      `SELECT cauce_inspect_telegram_replay_030($1,$2,'Steven','kant') AS value`,
      [fixture.letterId, refreshed],
    )).rows[0], 'rows').value;
    expect(refreshedInspect).toMatchObject({
      items: [expect.objectContaining({ replayCount: 1, state: 'prepared', duplicateRisk: false })],
    });
    const secondReplay = requireValue((await pool.query<{ value: Record<string, unknown> }>(
      `SELECT cauce_manual_replay_telegram_030(
         $1,0,'fresh second review','Steven','kant',true,$2,$3,$4,1
       ) AS value`, [
        'a'.repeat(64), randomUUID(), fixture.letterId, refreshed,
      ],
    )).rows[0], 'rows').value;
    expect(secondReplay).toMatchObject({ appliedCount: 1, replaySequence: 2, duplicateRisk: false });
  });

  it('classifies prepared-only crashes as safe retry and schedules unsent chunks idempotently', async () => {
    const preparedOnly = await seedDeadOutbox();
    await seedEffect(preparedOnly, 0, 1, 'prepared', { hash: '1'.repeat(64) });
    const remainingPrepared = await seedDeadOutbox();
    await seedEffect(remainingPrepared, 0, 2, 'sent', {
      hash: '2'.repeat(64), provider: 'provider-complete-0',
    });
    await seedEffect(remainingPrepared, 1, 2, 'prepared', { hash: '3'.repeat(64) });

    const planned = await plan();
    expect(planned.material.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'classify_safe_retry_v1', count: 2 }),
    ]));
    await apply(planned);
    expect((await pool.query<{ disposition: string; count: string }>(
      `SELECT disposition,count(*)::text AS count FROM outbox_dead_letters
       WHERE id=ANY($1::uuid[]) GROUP BY disposition`,
      [[preparedOnly.letterId, remainingPrepared.letterId]],
    )).rows).toEqual([{ disposition: 'safe_retry', count: '2' }]);
    const preparedEvidence = (await pool.query<{ id: string; evidence_sha256: string }>(
      `SELECT id,evidence_sha256 FROM outbox_dead_letters WHERE id=ANY($1::uuid[])`,
      [[preparedOnly.letterId, remainingPrepared.letterId]],
    )).rows;
    const evidenceById = new Map(
      preparedEvidence.map((row) => [row.id, row.evidence_sha256] as const),
    );

    const preparedRequestId = randomUUID();
    const remainingRequestId = randomUUID();
    const calls = await Promise.all([
      pool.query<{ value: Record<string, unknown> }>(
        `SELECT cauce_manual_replay_telegram_030(
           $1,0,'prepared before remote call','Steven','kant',true,$2,$3,$4,0
         ) AS value`,
        [
          '1'.repeat(64), preparedRequestId,
          preparedOnly.letterId, evidenceById.get(preparedOnly.letterId),
        ],
      ),
      pool.query<{ value: Record<string, unknown> }>(
        `SELECT cauce_manual_replay_telegram_030(
           $1,1,'resume remaining unsent chunk','Steven','kant',true,$2,$3,$4,0
         ) AS value`,
        [
          '3'.repeat(64), remainingRequestId,
          remainingPrepared.letterId, evidenceById.get(remainingPrepared.letterId),
        ],
      ),
      pool.query<{ value: Record<string, unknown> }>(
        `SELECT cauce_manual_replay_telegram_030(
           $1,1,'resume remaining unsent chunk','Steven','kant',true,$2,$3,$4,0
         ) AS value`,
        [
          '3'.repeat(64), remainingRequestId,
          remainingPrepared.letterId, evidenceById.get(remainingPrepared.letterId),
        ],
      ),
    ]);
    expect(calls.map((call) => requireValue(call.rows[0], 'call.rows').value.appliedCount).sort()).toEqual([0, 1, 1]);
    expect(calls.map((call) => requireValue(call.rows[0], 'call.rows').value.alreadyApplied).sort()).toEqual([
      false, false, true,
    ]);
    expect(calls.every((call) => requireValue(call.rows[0], 'call.rows').value.duplicateRisk === false)).toBe(true);

    expect((await pool.query<{ status: string; resolved: boolean; rule: string }>(
      `SELECT outbox.status,letter.resolved_at IS NOT NULL AS resolved,
              letter.resolution_rule AS rule
       FROM adapter_outbox outbox
       JOIN outbox_dead_letters letter ON letter.outbox_id=outbox.id
       WHERE outbox.id=$1`,
      [remainingPrepared.outboxId],
    )).rows[0]).toEqual({ status: 'failed', resolved: true, rule: 'telegram_prepared_retry_v1' });
    expect((await pool.query<{
      state: string; provider_message_id: string | null; replay_count: number;
    }>(
      `SELECT state,provider_message_id,replay_count
       FROM telegram_egress_effects WHERE outbox_id=$1 ORDER BY chunk_index`,
      [remainingPrepared.outboxId],
    )).rows).toEqual([
      { state: 'sent', provider_message_id: 'provider-complete-0', replay_count: 0 },
      { state: 'prepared', provider_message_id: null, replay_count: 1 },
    ]);
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
       WHERE action='telegram.manual_replay'
         AND metadata->>'rule'='telegram_prepared_retry_v1'`,
    )).rows[0]?.count).toBe('2');
  });

  it('selects a replay by safe chunk coordinates when two chunks have the same payload hash', async () => {
    const fixture = await seedDeadOutbox();
    const sharedHash = '9'.repeat(64);
    await seedEffect(fixture, 0, 2, 'ambiguous', { hash: sharedHash });
    await seedEffect(fixture, 1, 2, 'ambiguous', { hash: sharedHash });
    await apply(await plan());
    const incidentEvidence = requireValue((await pool.query<{ evidence_sha256: string }>(
      `SELECT evidence_sha256 FROM outbox_dead_letters WHERE id=$1`, [fixture.letterId],
    )).rows[0], 'rows').evidence_sha256;

    const inspected = requireValue((await pool.query<{ value: Record<string, unknown> }>(
      `SELECT cauce_inspect_telegram_replay_030($1,$2,'Steven','kant') AS value`,
      [fixture.letterId, incidentEvidence],
    )).rows[0], 'rows').value;
    expect(inspected).toMatchObject({
      total: 2,
      items: [
        { chunkIndex: 0, effectSha256: sharedHash, state: 'ambiguous', replayCount: 0,
          duplicateRisk: true },
        { chunkIndex: 1, effectSha256: sharedHash, state: 'ambiguous', replayCount: 0,
          duplicateRisk: true },
      ],
    });
    expect(JSON.stringify(inspected)).not.toContain(fixture.outboxId);

    const replay = requireValue((await pool.query<{ value: Record<string, unknown> }>(
      `SELECT cauce_manual_replay_telegram_030(
         $1,1,'select second identical chunk','Steven','kant',true,$2,$3,$4,0
       ) AS value`,
      [sharedHash, randomUUID(), fixture.letterId, incidentEvidence],
    )).rows[0], 'rows').value;
    expect(replay).toMatchObject({ appliedCount: 1, replaySequence: 1 });
    expect((await pool.query<{ chunk_index: number; state: string; replay_count: number }>(
      `SELECT chunk_index,state,replay_count FROM telegram_egress_effects
       WHERE outbox_id=$1 ORDER BY chunk_index`, [fixture.outboxId],
    )).rows).toEqual([
      { chunk_index: 0, state: 'ambiguous', replay_count: 0 },
      { chunk_index: 1, state: 'prepared', replay_count: 1 },
    ]);
  });

  it('resolves reviewed ambiguity without replay, with ACL scope, CAS and concurrent idempotence', async () => {
    const fixture = await seedDeadOutbox();
    await seedEffect(fixture, 0, 1, 'ambiguous', { hash: 'c'.repeat(64) });
    await apply(await plan());
    const evidence = requireValue((await pool.query<{ evidence_sha256: string }>(
      `SELECT evidence_sha256 FROM outbox_dead_letters WHERE id=$1`, [fixture.letterId],
    )).rows[0], 'rows').evidence_sha256;

    await pool.query(
      `UPDATE memberships SET role='operator'
       WHERE tenant_id='Isa' AND alias='salva' AND room_id='grp.isa'`,
    );
    await pool.query(
      `UPDATE acl_edges SET allow_control=false WHERE from_tenant='Isa' AND to_tenant='Steven'`,
    );
    await expect(pool.query(
      `SELECT cauce_resolve_dlq_without_replay_030(
         'outbox',$1,$2,'reviewed incident','Isa','salva',true,true
       )`, [fixture.letterId, evidence],
    )).rejects.toThrow(/outside actor control scope/u);

    const scopedAway = requireValue((await pool.query<{ value: SafeList }>(
      `SELECT cauce_list_dlq_030('Isa','salva',200) AS value`,
    )).rows[0], 'rows').value;
    expect(scopedAway.items).toEqual([]);
    const scopedPlan = requireValue((await pool.query<{ value: ReconciliationPlan }>(
      `SELECT cauce_dlq_plan_030('Isa','salva') AS value`,
    )).rows[0], 'rows').value;
    expect(scopedPlan.material).toMatchObject({ candidateCount: 0, inventory: [] });
    const visible = requireValue((await pool.query<{ value: SafeList }>(
      `SELECT cauce_list_dlq_030('Steven','kant',200) AS value`,
    )).rows[0], 'rows').value;
    const listed = visible.items.find((item) => item.id === fixture.letterId);
    expect(listed).toMatchObject({
      target: 'outbox', kind: 'origin_relay', adapter: 'telegram', disposition: 'ambiguous',
      tenantId: 'Steven', open: true, actionable: true, evidenceSha256: evidence,
      attempts: 3, resolutionRule: null, reopenCount: 0,
    });
    expect(listed).toBeDefined();
    if (!listed) throw new Error('expected the scoped incident in the safe DLQ list');
    expect(Object.keys(listed).sort()).toEqual([
      'actionable', 'adapter', 'attempts', 'createdAt', 'disposition', 'dispositionAt',
      'evidenceSha256', 'id', 'kind', 'lastReopenedAt', 'open', 'reopenCount',
      'resolutionRule', 'resolvedAt', 'target', 'tenantId',
    ]);

    const before = requireValue((await pool.query<{ outbox: string; effect: string }>(
      `SELECT row_to_json(outbox)::text AS outbox,row_to_json(effect)::text AS effect
       FROM adapter_outbox outbox
       JOIN telegram_egress_effects effect ON effect.outbox_id=outbox.id
       WHERE outbox.id=$1`, [fixture.outboxId],
    )).rows[0], 'rows');
    const calls = await Promise.all([
      pool.query<{ value: OperatorResolution }>(
        `SELECT cauce_resolve_dlq_without_replay_030(
           'outbox',$1,$2,'reviewed incident','Steven','kant',true,true
         ) AS value`, [fixture.letterId, evidence],
      ),
      pool.query<{ value: OperatorResolution }>(
        `SELECT cauce_resolve_dlq_without_replay_030(
           'outbox',$1,$2,'reviewed incident','Steven','kant',true,true
         ) AS value`, [fixture.letterId, evidence],
      ),
    ]);
    expect(calls.map((call) => requireValue(call.rows[0], 'call.rows').value.alreadyApplied).sort()).toEqual([false, true]);

    const after = requireValue((await pool.query<{ outbox: string; effect: string; resolved: boolean }>(
      `SELECT row_to_json(outbox)::text AS outbox,row_to_json(effect)::text AS effect,
              letter.resolved_at IS NOT NULL AS resolved
       FROM adapter_outbox outbox
       JOIN telegram_egress_effects effect ON effect.outbox_id=outbox.id
       JOIN outbox_dead_letters letter ON letter.outbox_id=outbox.id
       WHERE outbox.id=$1`, [fixture.outboxId],
    )).rows[0], 'rows');
    expect(after.outbox).toBe(before.outbox);
    expect(after.effect).toBe(before.effect);
    expect(after.resolved).toBe(true);
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='dlq.resolve_without_replay'`,
    )).rowCount).toBe(1);
    expect((await pool.query(
      `SELECT 1 FROM dlq_operator_resolutions WHERE dead_letter_id=$1`, [fixture.letterId],
    )).rowCount).toBe(1);
  });

  it.each([
    { disposition: 'safe_retry', duplicate: false },
    { disposition: 'missing_final', duplicate: true },
    { disposition: 'auth', duplicate: false },
  ] as const)('closes actionable $disposition without replay', async ({ disposition, duplicate }) => {
    const fixture = await seedDeadOutbox();
    const evidence = disposition.charCodeAt(0).toString(16).padStart(2, '0').repeat(32);
    await pool.query(
      `UPDATE outbox_dead_letters SET disposition=$2,disposition_at=now(),evidence_sha256=$3
       WHERE id=$1`, [fixture.letterId, disposition, evidence],
    );
    const result = requireValue((await pool.query<{ value: Record<string, unknown> }>(
      `SELECT cauce_resolve_dlq_without_replay_030(
         'outbox',$1,$2,'reviewed without replay','Steven','kant',$3,true
       ) AS value`, [fixture.letterId, evidence, duplicate],
    )).rows[0], 'rows').value;
    expect(result).toMatchObject({ appliedCount: 1, alreadyApplied: false });
    expect((await pool.query<{ status: string; resolved: boolean }>(
      `SELECT outbox.status,letter.resolved_at IS NOT NULL AS resolved
       FROM outbox_dead_letters letter JOIN adapter_outbox outbox ON outbox.id=letter.outbox_id
       WHERE letter.id=$1`, [fixture.letterId],
    )).rows[0]).toEqual({ status: 'dead', resolved: true });
  });

  it('revalidates no-replay scope after a concurrent ACL revocation commits', async () => {
    const fixture = await seedDeadOutbox();
    const evidence = '9'.repeat(64);
    await pool.query(
      `UPDATE outbox_dead_letters
          SET disposition='ambiguous',disposition_at=now(),evidence_sha256=$2
        WHERE id=$1`,
      [fixture.letterId, evidence],
    );
    await pool.query(
      `UPDATE memberships SET role='operator'
        WHERE tenant_id='Isa' AND alias='salva' AND room_id='grp.isa'`,
    );
    await pool.query(
      `UPDATE acl_edges SET enabled=true,allow_control=true
        WHERE from_tenant='Isa' AND to_tenant='Steven'`,
    );

    const revoker = await pool.connect();
    let settled = false;
    try {
      await revoker.query('BEGIN');
      await revoker.query(
        `UPDATE acl_edges SET allow_control=false
          WHERE from_tenant='Isa' AND to_tenant='Steven'`,
      );
      const resolving = pool.query(
        `SELECT cauce_resolve_dlq_without_replay_030(
           'outbox',$1,$2,'revoked concurrently','Isa','salva',true,true
         )`,
        [fixture.letterId, evidence],
      ).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      await revoker.query('COMMIT');
      await expect(resolving).rejects.toThrow(/outside actor control scope/u);
    } finally {
      await revoker.query('ROLLBACK').catch(() => undefined);
      revoker.release();
    }
    expect((await pool.query<{ resolved: boolean }>(
      `SELECT resolved_at IS NOT NULL AS resolved FROM outbox_dead_letters WHERE id=$1`,
      [fixture.letterId],
    )).rows[0]?.resolved).toBe(false);
  });

  it.each([
    {
      label: 'membership disable',
      revoke: `UPDATE memberships SET enabled=false
               WHERE tenant_id='Isa' AND alias='salva' AND room_id='grp.isa'`,
    },
    {
      label: 'room disable',
      revoke: `UPDATE rooms SET enabled=false WHERE tenant_id='Isa' AND id='grp.isa'`,
    },
  ])('revalidates actor control after concurrent $label', async ({ revoke }) => {
    const fixture = await seedDeadOutbox();
    const evidence = '8'.repeat(64);
    await pool.query(
      `UPDATE outbox_dead_letters
          SET disposition='ambiguous',disposition_at=now(),evidence_sha256=$2
        WHERE id=$1`,
      [fixture.letterId, evidence],
    );
    await pool.query(
      `UPDATE memberships SET role='operator',enabled=true
        WHERE tenant_id='Isa' AND alias='salva' AND room_id='grp.isa'`,
    );
    await pool.query(`UPDATE rooms SET enabled=true WHERE tenant_id='Isa' AND id='grp.isa'`);
    await pool.query(
      `UPDATE acl_edges SET enabled=true,allow_control=true
        WHERE from_tenant='Isa' AND to_tenant='Steven'`,
    );

    const revoker = await pool.connect();
    let settled = false;
    try {
      await revoker.query('BEGIN');
      await revoker.query(revoke);
      const resolving = pool.query(
        `SELECT cauce_resolve_dlq_without_replay_030(
           'outbox',$1,$2,'actor revoked concurrently','Isa','salva',true,true
         )`,
        [fixture.letterId, evidence],
      ).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      await revoker.query('COMMIT');
      await expect(resolving).rejects.toThrow(/lacks control permission/u);
    } finally {
      await revoker.query('ROLLBACK').catch(() => undefined);
      revoker.release();
    }
    expect((await pool.query<{ resolved: boolean }>(
      `SELECT resolved_at IS NOT NULL AS resolved FROM outbox_dead_letters WHERE id=$1`,
      [fixture.letterId],
    )).rows[0]?.resolved).toBe(false);
  });

  it('denies list, plan, apply, no-replay and manual replay through historical invalid edges', async () => {
    const fixture = await seedDeadOutbox();
    const evidence = 'c'.repeat(64);
    await seedEffect(fixture, 0, 1, 'ambiguous', { hash: 'a'.repeat(64) });
    await pool.query(
      `UPDATE memberships SET role='operator'
        WHERE tenant_id='Isa' AND alias='salva' AND room_id='grp.isa'`,
    );
    await pool.query(
      `UPDATE acl_edges SET enabled=true,allow_control=true
        WHERE from_tenant='Isa' AND to_tenant='Steven'`,
    );
    const authorizedPlan = requireValue((await pool.query<{ value: ReconciliationPlan }>(
      `SELECT cauce_dlq_plan_030('Isa','salva') AS value`,
    )).rows[0], 'rows').value;
    expect(authorizedPlan.material.candidateCount).toBe(1);

    await pool.query(`
      BEGIN;
      ALTER TABLE tenants DISABLE TRIGGER tenants_hub_star_guard;
      UPDATE tenants SET is_hub=false WHERE id IN ('Isa','Steven');
      ALTER TABLE tenants ENABLE TRIGGER tenants_hub_star_guard;
      COMMIT
    `);
    expect(requireValue((await pool.query<{ value: SafeList }>(
      `SELECT cauce_list_dlq_030('Isa','salva',200) AS value`,
    )).rows[0], 'rows').value.items).toEqual([]);
    expect(requireValue((await pool.query<{ value: Record<string, unknown> }>(
      `SELECT cauce_dlq_inspect_030('Isa','salva') AS value`,
    )).rows[0], 'rows').value).toMatchObject({ inventory: [] });
    expect(requireValue((await pool.query<{ value: ReconciliationPlan }>(
      `SELECT cauce_dlq_plan_030('Isa','salva') AS value`,
    )).rows[0], 'rows').value.material).toMatchObject({ candidateCount: 0, inventory: [] });
    await expect(pool.query(
      `SELECT cauce_dlq_apply_030('Isa','salva',$1)`, [authorizedPlan.planSha256],
    )).rejects.toThrow(/plan is stale/u);
    await pool.query(
      `UPDATE outbox_dead_letters
          SET disposition='ambiguous',disposition_at=now(),evidence_sha256=$2
        WHERE id=$1`,
      [fixture.letterId, evidence],
    );
    await expect(pool.query(
      `SELECT cauce_resolve_dlq_without_replay_030(
         'outbox',$1,$2,'client-client historical edge','Isa','salva',true,true
       )`,
      [fixture.letterId, evidence],
    )).rejects.toThrow(/outside actor control scope/u);
    await expect(pool.query(
      `SELECT cauce_manual_replay_telegram_030(
         $1,0,'client-client historical edge','Isa','salva',true,$2,$3,$4,0
       )`, ['a'.repeat(64), randomUUID(), fixture.letterId, evidence],
    )).rejects.toThrow(/outside actor control scope/u);
    await expect(pool.query(
      `SELECT cauce_inspect_telegram_replay_030($1,$2,'Isa','salva')`,
      [fixture.letterId, evidence],
    )).rejects.toThrow(/outside actor control scope/u);
    expect((await pool.query<{ resolved: boolean }>(
      `SELECT resolved_at IS NOT NULL AS resolved FROM outbox_dead_letters WHERE id=$1`,
      [fixture.letterId],
    )).rows[0]?.resolved).toBe(false);

    await pool.query(`UPDATE tenants SET is_hub=(id='Steven') WHERE id IN ('Isa','Steven')`);
    const enabledPlan = requireValue((await pool.query<{ value: ReconciliationPlan }>(
      `SELECT cauce_dlq_plan_030('Isa','salva') AS value`,
    )).rows[0], 'rows').value;
    expect(enabledPlan.material.inventory).not.toEqual([]);
    await pool.query(`UPDATE tenants SET enabled=false WHERE id='Steven'`);
    expect(requireValue((await pool.query<{ value: SafeList }>(
      `SELECT cauce_list_dlq_030('Isa','salva',200) AS value`,
    )).rows[0], 'rows').value.items).toEqual([]);
    expect(requireValue((await pool.query<{ value: ReconciliationPlan }>(
      `SELECT cauce_dlq_plan_030('Isa','salva') AS value`,
    )).rows[0], 'rows').value.material).toMatchObject({ candidateCount: 0, inventory: [] });
    await expect(pool.query(
      `SELECT cauce_dlq_apply_030('Isa','salva',$1)`, [enabledPlan.planSha256],
    )).rejects.toThrow(/plan is stale/u);
    await expect(pool.query(
      `SELECT cauce_resolve_dlq_without_replay_030(
         'outbox',$1,$2,'disabled target tenant','Isa','salva',true,true
       )`,
      [fixture.letterId, evidence],
    )).rejects.toThrow(/outside actor control scope/u);
    await expect(pool.query(
      `SELECT cauce_manual_replay_telegram_030(
         $1,0,'disabled target tenant','Isa','salva',true,$2,$3,$4,0
       )`, ['a'.repeat(64), randomUUID(), fixture.letterId, evidence],
    )).rejects.toThrow(/outside actor control scope/u);
  });

  it('paginates the safe list with a scoped deterministic keyset cursor', async () => {
    const timestamp = '2026-08-26T12:34:56.123456Z';
    const outbox = await seedDeadOutbox({ createdAt: timestamp });
    await seedDeadDelivery({
      status: 'dead', terminal: true, letterId: outbox.letterId, createdAt: timestamp,
    });

    const repository = new CauceRepository(pool);
    const first = await repository.listOperationalDlq('Steven', 'kant', 1);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ target: 'outbox', id: outbox.letterId });
    expect(first).toMatchObject({ total: 2, truncated: true });
    expect(first.nextCursor).toMatch(/^[a-f0-9]+$/u);
    expect(first.nextCursor).not.toContain(outbox.letterId);

    const second = await repository.listOperationalDlq('Steven', 'kant', 1, first.nextCursor);
    expect(second.items).toEqual([
      expect.objectContaining({ target: 'delivery', id: outbox.letterId }),
    ]);
    expect(second).toMatchObject({ total: 2, truncated: false, nextCursor: null });
    expect(new Set(
      [...first.items, ...second.items].map((item) => `${item.target}:${item.id}`),
    ).size).toBe(2);

    await expect(pool.query(
      `SELECT cauce_list_dlq_030('Steven','kant',1,'not-a-cursor')`,
    )).rejects.toThrow(/cursor is invalid/u);
    await pool.query(
      `UPDATE memberships SET role='operator'
        WHERE tenant_id='Isa' AND alias='salva' AND room_id='grp.isa'`,
    );
    await expect(pool.query(
      `SELECT cauce_list_dlq_030('Isa','salva',1,$1)`, [first.nextCursor],
    )).rejects.toThrow(/cursor is invalid/u);
  });

  it('rejects unclassified incidents and risk acknowledgements that do not match uncertainty', async () => {
    const unclassified = await seedDeadOutbox();
    await pool.query(
      `UPDATE outbox_dead_letters SET evidence_sha256=$2 WHERE id=$1`,
      [unclassified.letterId, 'd'.repeat(64)],
    );
    const safeList = requireValue((await pool.query<{ value: SafeList }>(
      `SELECT cauce_list_dlq_030('Steven','kant',200) AS value`,
    )).rows[0], 'rows').value;
    expect(safeList.items.find((item) => item.id === unclassified.letterId)).toMatchObject({
      disposition: 'unclassified', open: true, actionable: false,
    });
    expect((await pool.query<{ actionable: boolean }>(
      `SELECT actionable FROM cauce_dlq_inventory_030
       WHERE source='outbox' AND kind='origin_relay' AND disposition='unclassified' AND open`,
    )).rows[0]).toEqual({ actionable: false });
    await expect(pool.query(
      `SELECT cauce_resolve_dlq_without_replay_030(
         'outbox',$1,$2,'not classified','Steven','kant',true,true
       )`, [unclassified.letterId, 'd'.repeat(64)],
    )).rejects.toThrow(/fenced by current incident state/u);

    const missingFinal = await seedDeadOutbox();
    await pool.query(
      `UPDATE outbox_dead_letters SET disposition='missing_final',disposition_at=now(),
         evidence_sha256=$2 WHERE id=$1`, [missingFinal.letterId, 'e'.repeat(64)],
    );
    await expect(pool.query(
      `SELECT cauce_resolve_dlq_without_replay_030(
         'outbox',$1,$2,'uncertain','Steven','kant',false,true
       )`, [missingFinal.letterId, 'e'.repeat(64)],
    )).rejects.toThrow(/possible-duplicate acknowledgement/u);
    await expect(pool.query(
      `SELECT cauce_resolve_dlq_without_replay_030(
         'outbox',$1,$2,'uncertain','Steven','kant',true,false
       )`, [missingFinal.letterId, 'e'.repeat(64)],
    )).rejects.toThrow(/no-delivery acknowledgement/u);
  });
});
