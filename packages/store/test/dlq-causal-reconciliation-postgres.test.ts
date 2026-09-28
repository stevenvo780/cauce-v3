import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  apply, plan, pool, registerDlqSuite, seedDeadDelivery, seedDeadOutbox, seedDelivery, seedEffect,
  seedMessage, seedOutboxWithoutDlq,
} from './dlq-causal-reconciliation-postgres-helpers.js';

registerDlqSuite(import.meta.url);

describe('causal DLQ reconciliation', () => {
  it('recovers dead to sent only with complete chunk proof, including a superseded outbox', async () => {
    const proven = await seedDeadOutbox({ lastError: 'superseded by a newer relay' });
    await seedEffect(proven, 0, 2, 'sent');
    await seedEffect(proven, 1, 2, 'sent');

    const missingChunk = await seedDeadOutbox();
    await seedEffect(missingChunk, 0, 2, 'sent');
    const duplicateProvider = await seedDeadOutbox();
    await seedEffect(duplicateProvider, 0, 2, 'sent', { provider: 'provider-duplicate' });
    await seedEffect(duplicateProvider, 1, 2, 'sent', { provider: 'provider-duplicate' });
    const invalidSent = await seedDeadOutbox();
    await expect(seedEffect(invalidSent, 0, 1, 'sent', { provider: null }))
      .rejects.toThrow(/durable provider acceptance and sent time/u);
    const ambiguous = await seedDeadOutbox();
    await seedEffect(ambiguous, 0, 1, 'ambiguous');

    const planned = await plan();
    const serializedPlan = JSON.stringify(planned);
    expect(serializedPlan).not.toContain(proven.outboxId);
    expect(serializedPlan).not.toContain('provider-0');
    expect(serializedPlan).not.toContain('superseded by a newer relay');
    expect(planned.material.candidateSetSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(planned.material.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'telegram_exact_sent_v1', count: 1 }),
      expect.objectContaining({ rule: 'classify_ambiguous_v1', count: 1 }),
    ]));

    const applied = await apply(planned);
    expect(applied).toMatchObject({ alreadyApplied: false, recoveredSentCount: 1 });
    expect((await pool.query<{ status: string }>(
      `SELECT status FROM adapter_outbox WHERE id=$1`, [proven.outboxId],
    )).rows[0]?.status).toBe('sent');
    expect((await pool.query<{ resolved: boolean }>(
      `SELECT resolved_at IS NOT NULL AS resolved FROM outbox_dead_letters WHERE id=$1`,
      [proven.letterId],
    )).rows[0]?.resolved).toBe(true);

    for (const fixture of [missingChunk, duplicateProvider, invalidSent, ambiguous]) {
      expect((await pool.query<{ status: string }>(
        `SELECT status FROM adapter_outbox WHERE id=$1`, [fixture.outboxId],
      )).rows[0]?.status).toBe('dead');
      expect((await pool.query<{ resolved: boolean }>(
        `SELECT resolved_at IS NOT NULL AS resolved FROM outbox_dead_letters WHERE id=$1`,
        [fixture.letterId],
      )).rows[0]?.resolved).toBe(false);
    }
    expect((await pool.query<{ disposition: string }>(
      `SELECT disposition FROM outbox_dead_letters WHERE id=$1`, [ambiguous.letterId],
    )).rows[0]?.disposition).toBe('ambiguous');

    const auditBefore = Number((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events WHERE action='dlq.reconcile'`,
    )).rows[0]?.count);
    await expect(apply(planned)).resolves.toMatchObject({ alreadyApplied: true, transitionCount: 0 });
    expect(Number((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events WHERE action='dlq.reconcile'`,
    )).rows[0]?.count)).toBe(auditBefore);

    const audit = await pool.query<{ tenant_id: string; metadata: Record<string, unknown> }>(
      `SELECT tenant_id,metadata FROM audit_events
       WHERE action='dlq.reconcile' AND metadata->>'rule'='telegram_exact_sent_v1'`,
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]?.tenant_id).toBe('Steven');
    const auditText = JSON.stringify(audit.rows[0]?.metadata);
    expect(auditText).not.toContain(proven.outboxId);
    expect(auditText).not.toContain('provider-0');
    expect(auditText).not.toMatch(/payload|origin|provider_message_id/u);
  });

  it('shares an outbox-stable effect fence with concurrent effect writers', async () => {
    const fixture = await seedDeadOutbox();
    await seedEffect(fixture, 0, 1, 'sent');
    const planned = await plan();
    const writer = await pool.connect();
    let applySettled = false;
    try {
      await writer.query('BEGIN');
      await writer.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('telegram-effect:' || $1::text,0))`,
        [fixture.outboxId],
      );
      const applying = apply(planned).finally(() => { applySettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(applySettled).toBe(false);
      await expect(writer.query(
        `INSERT INTO telegram_egress_effects(
           effect_id,outbox_id,tenant_id,bridge_alias,chunk_index,chunk_count,payload_hash,state
         ) VALUES($1,$2,'Steven','kant',1,2,$3,'prepared')`,
        [`${fixture.outboxId}:late`, fixture.outboxId, 'f'.repeat(64)],
      )).rejects.toThrow(/live processing outbox/u);
      await writer.query('ROLLBACK');
      await expect(applying).resolves.toMatchObject({ recoveredSentCount: 1 });
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
    await expect(pool.query(
      `UPDATE telegram_egress_effects SET state='prepared'
       WHERE effect_id=$1`,
      [`${fixture.outboxId}:0`],
    )).rejects.toThrow(/durably sent Telegram effect is immutable/u);
    await expect(pool.query(
      `UPDATE telegram_egress_effects SET provider_message_id=NULL
       WHERE effect_id=$1`,
      [`${fixture.outboxId}:0`],
    )).rejects.toThrow(/durably sent Telegram effect is immutable/u);
    await expect(pool.query(
      `UPDATE telegram_egress_effects SET payload_hash=$2
       WHERE effect_id=$1`,
      [`${fixture.outboxId}:0`, 'e'.repeat(64)],
    )).rejects.toThrow(/causal coordinates are immutable/u);
    expect((await pool.query<{ status: string; effects: string }>(
      `SELECT outbox.status,count(effect.*)::text AS effects
       FROM adapter_outbox outbox
       JOIN telegram_egress_effects effect ON effect.outbox_id=outbox.id
       WHERE outbox.id=$1 GROUP BY outbox.status`,
      [fixture.outboxId],
    )).rows[0]).toEqual({ status: 'sent', effects: '1' });

    const wrongKind = await seedDeadOutbox({ adapter: 'gateway', kind: 'wake' });
    await expect(seedEffect(wrongKind, 0, 1, 'prepared'))
      .rejects.toThrow(/causal origin-relay outbox/u);
    const wrongTenant = await seedDeadOutbox();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE adapter_outbox SET status='processing',dead_at=NULL WHERE id=$1`, [
        wrongTenant.outboxId,
      ]);
      await expect(client.query(
        `INSERT INTO telegram_egress_effects(
           effect_id,outbox_id,tenant_id,bridge_alias,chunk_index,chunk_count,payload_hash,state
         ) VALUES($1,$2,'Isa','salva',0,1,$3,'prepared')`,
        [`${wrongTenant.outboxId}:wrong-tenant`, wrongTenant.outboxId, 'a'.repeat(64)],
      )).rejects.toThrow(/causal origin-relay outbox/u);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('freezes outbox/effect/DLQ causal identity without advisory-order deadlocks', async () => {
    const fixture = await seedDeadOutbox();
    await seedEffect(fixture, 0, 1, 'prepared', { hash: 'a'.repeat(64) });
    for (const statement of [
      `UPDATE adapter_outbox SET tenant_id='Isa' WHERE id=$1`,
      `UPDATE adapter_outbox SET adapter='gateway' WHERE id=$1`,
      `UPDATE adapter_outbox SET payload='{"changed":true}'::jsonb WHERE id=$1`,
    ]) {
      await expect(pool.query(statement, [fixture.outboxId]))
        .rejects.toThrow(/causal coordinates are immutable/u);
    }
    for (const statement of [
      `UPDATE outbox_dead_letters SET tenant_id='Isa' WHERE id=$1`,
      `UPDATE outbox_dead_letters SET adapter='gateway' WHERE id=$1`,
      `UPDATE outbox_dead_letters SET created_at=created_at+interval '1 second' WHERE id=$1`,
      `DELETE FROM outbox_dead_letters WHERE id=$1`,
    ]) {
      await expect(pool.query(statement, [fixture.letterId]))
        .rejects.toThrow(/causal coordinates|must be resolved/u);
    }
    await expect(pool.query(
      `UPDATE outbox_dead_letters SET disposition='safe_retry',disposition_at=now(),
         evidence_sha256=$2 WHERE id=$1`,
      [fixture.letterId, 'b'.repeat(64)],
    )).resolves.toBeDefined();

    const delivery = await seedDeadDelivery({ status: 'dead', terminal: true });
    for (const statement of [
      `UPDATE dead_letters SET tenant_id='Isa' WHERE id=$1`,
      `UPDATE dead_letters SET created_at=created_at+interval '1 second' WHERE id=$1`,
      `DELETE FROM dead_letters WHERE id=$1`,
    ]) {
      await expect(pool.query(statement, [delivery.letterId]))
        .rejects.toThrow(/causal coordinates|must be resolved/u);
    }
    await expect(pool.query(
      `UPDATE dead_letters SET disposition='safe_retry',disposition_at=now(),
         evidence_sha256=$2 WHERE id=$1`,
      [delivery.letterId, 'c'.repeat(64)],
    )).resolves.toBeDefined();
    const mismatchedDelivery = await seedDelivery({ status: 'dead', terminal: true });
    await expect(pool.query(
      `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
       VALUES($1,'Isa','mismatch','{}'::jsonb,1)`,
      [mismatchedDelivery],
    )).rejects.toThrow(/does not match its causal target/u);

    const mismatch = await seedOutboxWithoutDlq({ relay_kind: 'final' });
    await expect(pool.query(
      `INSERT INTO outbox_dead_letters(
         outbox_id,tenant_id,adapter,kind,reason,payload,attempts
       ) VALUES($1,'Isa','telegram','origin_relay','mismatch','{}'::jsonb,0)`,
      [mismatch.outboxId],
    )).rejects.toThrow(/does not match its causal outbox/u);

    await expect(pool.query(
      `UPDATE telegram_egress_effects SET replay_count=-1 WHERE effect_id=$1`,
      [`${fixture.outboxId}:0`],
    )).rejects.toThrow(/replay generation must be monotonic/u);
    await expect(pool.query(
      `UPDATE telegram_egress_effects SET replay_count=1 WHERE effect_id=$1`,
      [`${fixture.outboxId}:0`],
    )).rejects.toThrow(/requires a new prepared transition/u);

    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('telegram-effect:' || $1::text,0))`,
        [fixture.outboxId],
      );
      await expect(pool.query(
        `UPDATE adapter_outbox SET status='failed',dead_at=NULL WHERE id=$1`,
        [fixture.outboxId],
      )).resolves.toBeDefined();
      await expect(writer.query(
        `SELECT 1 FROM adapter_outbox WHERE id=$1 FOR UPDATE`, [fixture.outboxId],
      )).resolves.toBeDefined();
      await writer.query('ROLLBACK');
    } finally {
      writer.release();
    }
  });

  it('serializes both DLQ-insert/outbox-update interleavings without scope drift', async () => {
    const updateFirst = await seedOutboxWithoutDlq({ relay_kind: 'final' });
    const updater = await pool.connect();
    try {
      await updater.query('BEGIN');
      await updater.query(`SELECT 1 FROM adapter_outbox WHERE id=$1 FOR UPDATE`, [updateFirst.outboxId]);
      let insertSettled = false;
      const inserting = pool.query(
        `INSERT INTO outbox_dead_letters(
           outbox_id,tenant_id,adapter,kind,reason,payload,attempts
         ) VALUES($1,'Steven','telegram','origin_relay','racing','{}'::jsonb,0)`,
        [updateFirst.outboxId],
      ).finally(() => { insertSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(insertSettled).toBe(false);
      await updater.query(`UPDATE adapter_outbox SET tenant_id='Isa' WHERE id=$1`, [updateFirst.outboxId]);
      await updater.query('COMMIT');
      await expect(inserting).rejects.toThrow(/does not match its causal outbox/u);
    } finally {
      await updater.query('ROLLBACK').catch(() => undefined);
      updater.release();
    }

    const insertFirst = await seedOutboxWithoutDlq({ relay_kind: 'final' });
    const inserter = await pool.connect();
    try {
      await inserter.query('BEGIN');
      await inserter.query(
        `INSERT INTO outbox_dead_letters(
           outbox_id,tenant_id,adapter,kind,reason,payload,attempts
         ) VALUES($1,'Steven','telegram','origin_relay','racing','{}'::jsonb,0)`,
        [insertFirst.outboxId],
      );
      let updateSettled = false;
      const updating = pool.query(
        `UPDATE adapter_outbox SET tenant_id='Isa' WHERE id=$1`, [insertFirst.outboxId],
      ).finally(() => { updateSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(updateSettled).toBe(false);
      await inserter.query('COMMIT');
      await expect(updating).rejects.toThrow(/causal coordinates are immutable/u);
    } finally {
      await inserter.query('ROLLBACK').catch(() => undefined);
      inserter.release();
    }
  });

  it('applies only the exact captured candidate set when a new incident commits mid-apply', async () => {
    const approved = await seedDeadOutbox();
    await seedEffect(approved, 0, 1, 'sent');
    const planned = await plan();
    const auditBlocker = await pool.connect();
    let applySettled = false;
    try {
      await auditBlocker.query('BEGIN');
      await auditBlocker.query(`LOCK TABLE audit_events IN SHARE MODE`);
      const applying = apply(planned).finally(() => { applySettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(applySettled).toBe(false);
      const late = await seedDeadOutbox();
      await seedEffect(late, 0, 1, 'sent');
      await auditBlocker.query('COMMIT');
      await expect(applying).resolves.toMatchObject({ recoveredSentCount: 1, transitionCount: 1 });
      expect((await pool.query<{ status: string; resolved: boolean }>(
        `SELECT outbox.status,letter.resolved_at IS NOT NULL AS resolved
         FROM adapter_outbox outbox JOIN outbox_dead_letters letter ON letter.outbox_id=outbox.id
         WHERE outbox.id=$1`, [late.outboxId],
      )).rows[0]).toEqual({ status: 'dead', resolved: false });
    } finally {
      await auditBlocker.query('ROLLBACK').catch(() => undefined);
      auditBlocker.release();
    }
  });

  it.each(['processing', 'sent', 'dead'] as const)(
    'resolves an ACK only after its correlated final is claimed or terminal (%s)',
    async (finalStatus) => {
      const root = randomUUID();
      const acknowledgement = await seedDeadOutbox({
        payload: { relay_kind: 'ack', correlation: { root_message_id: root } },
      });
      const final = await seedOutboxWithoutDlq({
        relay_kind: 'final', correlation: { root_message_id: root },
      });
      await pool.query(
        `UPDATE adapter_outbox SET status=$2,attempts=$3,dead_at=CASE WHEN $2='dead' THEN now() ELSE NULL END
         WHERE id=$1`,
        [final.outboxId, finalStatus, finalStatus === 'processing' ? 1 : 0],
      );

      const planned = await plan();
      expect(planned.material.transitions).toEqual(expect.arrayContaining([
        expect.objectContaining({ rule: 'telegram_ack_final_claimed_v1', count: 1 }),
      ]));
      const results = await Promise.all([apply(planned), apply(planned)]);
      expect(results.map((value) => value.alreadyApplied).sort()).toEqual([false, true]);
      expect((await pool.query<{ resolved: boolean }>(
        `SELECT resolved_at IS NOT NULL AS resolved FROM outbox_dead_letters WHERE id=$1`,
        [acknowledgement.letterId],
      )).rows[0]?.resolved).toBe(true);
      expect((await pool.query<{ status: string }>(
        `SELECT status FROM adapter_outbox WHERE id=$1`, [acknowledgement.outboxId],
      )).rows[0]?.status).toBe('dead');
      expect((await pool.query(
        `SELECT 1 FROM audit_events
         WHERE action='dlq.reconcile' AND metadata->>'rule'='telegram_ack_final_claimed_v1'`,
      )).rowCount).toBe(1);
    },
  );

  it('keeps an ACK open while its correlated final is only pending', async () => {
    const root = randomUUID();
    const acknowledgement = await seedDeadOutbox({
      payload: { relay_kind: 'ack', correlation: { root_message_id: root } },
    });
    const final = await seedOutboxWithoutDlq({
      relay_kind: 'final', correlation: { root_message_id: root },
    });
    await pool.query(
      `UPDATE adapter_outbox SET status='pending',attempts=0,dead_at=NULL WHERE id=$1`,
      [final.outboxId],
    );
    await apply(await plan());
    expect((await pool.query<{ resolved: boolean; disposition: string }>(
      `SELECT resolved_at IS NOT NULL AS resolved,disposition
       FROM outbox_dead_letters WHERE id=$1`, [acknowledgement.letterId],
    )).rows[0]).toEqual({ resolved: false, disposition: 'missing_final' });
  });

  it('resolves wakes only from a terminal delivery or a later sent wake and classifies the rest', async () => {
    const terminalDelivery = await seedDelivery({ status: 'done', terminal: true });
    const terminalWake = await seedDeadOutbox({ kind: 'wake', adapter: 'gateway', deliveryId: terminalDelivery });

    const retriedDelivery = await seedDelivery({ status: 'pending' });
    const oldWake = await seedDeadOutbox({
      kind: 'wake', adapter: 'gateway', deliveryId: retriedDelivery, createdAt: '2026-01-01T00:00:00Z',
    });
    const seeded = await seedMessage();
    await pool.query(
      `INSERT INTO adapter_outbox(
         tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,payload,
         status,attempts,max_attempts,sent_at,created_at
       ) VALUES('Steven','gateway','wake',$1,$2,$3,$4,'wake-later','{}','sent',1,3,now(),now())`,
      [randomUUID(), seeded.requestId, seeded.messageId, retriedDelivery],
    );

    const missingFinal = await seedDeadOutbox({ kind: 'wake', adapter: 'gateway' });
    const offlineDelivery = await seedDelivery({ status: 'pending', recipientAlias: 'hegel' });
    await pool.query(
      `INSERT INTO agents(tenant_id,alias,harness_id,enabled)
       VALUES('Steven','hegel','openclaw',false)`,
    );
    const expectedOffline = await seedDeadOutbox({
      kind: 'wake', adapter: 'gateway', deliveryId: offlineDelivery,
    });

    await apply(await plan());
    for (const fixture of [terminalWake, oldWake]) {
      expect((await pool.query<{ resolved: boolean }>(
        `SELECT resolved_at IS NOT NULL AS resolved FROM outbox_dead_letters WHERE id=$1`,
        [fixture.letterId],
      )).rows[0]?.resolved).toBe(true);
    }
    expect((await pool.query<{ disposition: string }>(
      `SELECT disposition FROM outbox_dead_letters WHERE id=$1`, [missingFinal.letterId],
    )).rows[0]?.disposition).toBe('missing_final');
    expect((await pool.query<{ resolved: boolean; rule: string; disposition: string }>(
      `SELECT resolved_at IS NOT NULL AS resolved,resolution_rule AS rule,disposition
       FROM outbox_dead_letters WHERE id=$1`, [expectedOffline.letterId],
    )).rows[0]).toEqual({
      resolved: true,
      rule: 'wake_expected_offline_v1',
      disposition: 'expected_offline',
    });
    const inventory = await pool.query<{
      source: string; kind: string; actionable: boolean; count: string;
    }>(
      `SELECT source,kind,actionable,count::text FROM cauce_dlq_inventory_030
       WHERE source='outbox' ORDER BY kind,open,actionable`,
    );
    expect(inventory.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'outbox', kind: 'wake', actionable: false }),
      expect.objectContaining({ source: 'outbox', kind: 'wake', actionable: true }),
    ]));
  });

  it('resolves terminal delivery incidents only from direct allow audits and preserves deliveries', async () => {
    const proven = await Promise.all([
      'agent_output.materialize', 'agent_output.response', 'agent_output.fanin', 'delivery.cancel',
    ].map(async (action) => {
      const fixture = await seedDeadDelivery({ status: 'dead', terminal: true });
      await pool.query(
        `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,delivery_id)
         VALUES('Steven','kant',$2,'allow',$1)`,
        [fixture.deliveryId, action],
      );
      return { ...fixture, action };
    }));
    const denied = await seedDeadDelivery({ status: 'dead', terminal: true });
    await pool.query(
      `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,delivery_id)
       VALUES('Steven','kant','agent_output.response','deny',$1)`,
      [denied.deliveryId],
    );
    const absent = await seedDeadDelivery({ status: 'failed', terminal: true });
    const nonterminal = await seedDeadDelivery({ status: 'dead', terminal: false });
    await pool.query(
      `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,delivery_id)
       VALUES('Steven','kant','agent_output.fanin','allow',$1)`,
      [nonterminal.deliveryId],
    );
    const before = await pool.query<{ id: string; value: string }>(
      `SELECT id,row_to_json(delivery)::text AS value FROM deliveries delivery
       WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [proven.map((fixture) => fixture.deliveryId)],
    );

    const planned = await plan();
    expect(planned.material.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'delivery_terminal_notice_materialized_v1', count: 3 }),
      expect.objectContaining({ rule: 'delivery_cancelled_v1', count: 1 }),
    ]));
    const results = await Promise.all([apply(planned), apply(planned)]);
    expect(results.map((result) => result.alreadyApplied).sort()).toEqual([false, true]);

    const after = await pool.query<{ id: string; value: string }>(
      `SELECT id,row_to_json(delivery)::text AS value FROM deliveries delivery
       WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [proven.map((fixture) => fixture.deliveryId)],
    );
    expect(after.rows).toEqual(before.rows);
    for (const fixture of proven) {
      const incident = (await pool.query<{ resolved: boolean; rule: string; evidence: string }>(
        `SELECT resolved_at IS NOT NULL AS resolved,resolution_rule AS rule,
                evidence_sha256 AS evidence FROM dead_letters WHERE id=$1`,
        [fixture.letterId],
      )).rows[0];
      expect(incident?.resolved).toBe(true);
      expect(incident?.rule).toBe(
        fixture.action === 'delivery.cancel'
          ? 'delivery_cancelled_v1'
          : 'delivery_terminal_notice_materialized_v1',
      );
      expect(incident?.evidence).toMatch(/^[a-f0-9]{64}$/u);
    }
    for (const fixture of [denied, absent, nonterminal]) {
      expect((await pool.query<{ resolved: boolean }>(
        `SELECT resolved_at IS NOT NULL AS resolved FROM dead_letters WHERE id=$1`,
        [fixture.letterId],
      )).rows[0]?.resolved).toBe(false);
    }
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='dlq.reconcile'
         AND metadata->>'rule' IN (
           'delivery_terminal_notice_materialized_v1','delivery_cancelled_v1'
         )`,
    )).rowCount).toBe(4);
  });

  it('auto-closes never-executed deliveries for a disabled recipient and fences re-enable races', async () => {
    await pool.query(
      `UPDATE agents SET enabled=false WHERE tenant_id='Steven' AND alias='argos';
       UPDATE memberships SET enabled=false WHERE tenant_id='Steven' AND alias='argos';`,
    );
    const offline = await seedDeadDelivery({
      status: 'dead', terminal: true, executionStarted: false, recipientAlias: 'argos',
    });
    const planned = await plan();
    expect(planned.material.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'delivery_expected_offline_v1', count: 1 }),
    ]));
    await apply(planned);
    expect((await pool.query<{ resolved: boolean; disposition: string; rule: string }>(
      `SELECT resolved_at IS NOT NULL AS resolved,disposition,resolution_rule AS rule
       FROM dead_letters WHERE id=$1`,
      [offline.letterId],
    )).rows[0]).toEqual({
      resolved: true, disposition: 'expected_offline', rule: 'delivery_expected_offline_v1',
    });

    const racing = await seedDeadDelivery({
      status: 'dead', terminal: true, executionStarted: false, recipientAlias: 'argos',
    });
    const stale = await plan();
    await pool.query(
      `UPDATE agents SET enabled=true WHERE tenant_id='Steven' AND alias='argos';
       UPDATE memberships SET enabled=true WHERE tenant_id='Steven' AND alias='argos';`,
    );
    await expect(apply(stale)).rejects.toThrow(/plan is stale/u);
    expect((await pool.query<{ resolved: boolean }>(
      `SELECT resolved_at IS NOT NULL AS resolved FROM dead_letters WHERE id=$1`,
      [racing.letterId],
    )).rows[0]?.resolved).toBe(false);
  });
});
