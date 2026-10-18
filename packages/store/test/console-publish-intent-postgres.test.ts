import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PublishIntentRateLimitedError,
} from '../src/index.js';
import {
  command, confirm, intent, OPERATOR_SCOPE, pool, prepare, publishConsole,
  registerConsolePublishSuite, repository,
} from './console-publish-intent-postgres-helpers.js';

registerConsolePublishSuite(import.meta.url);

describe('durable console publish intents', () => {
  it('replays a lost prepare response and stores hashes, never message or auth data', async () => {
    const input = intent();
    const first = await prepare(input);
    const retry = await prepare({
      ...input,
      request_id: randomUUID(),
      trace_id: `retry-${randomUUID()}`,
    });
    expect(retry).toEqual(first);
    expect(first).toMatchObject({ version: 1, state: 'prepared', receipt: null });

    const audits = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action='console.publish.prepare'`,
    );
    expect(audits.rowCount).toBe(1);
    expect(Object.keys(audits.rows[0]?.metadata ?? {}).sort()).toEqual([
      'conversation_hash', 'idempotency_key', 'intent_nonce_hash',
      'operator_scope_hash', 'requested_hash', 'semantic_hash', 'version',
    ]);
    const heads = await pool.query<{
      metadata: Record<string, unknown> & {
        intents?: Record<string, unknown>[];
      };
    }>(
      `SELECT metadata FROM audit_events WHERE action='console.publish.head'`,
    );
    expect(heads.rowCount).toBe(1);
    expect(Object.keys(heads.rows[0]?.metadata ?? {}).sort()).toEqual([
      'conversation_hash', 'intents', 'operator_scope_hash', 'sequence', 'version',
    ]);
    const headIntents = heads.rows[0]?.metadata.intents;
    expect(Object.keys(headIntents?.[0] ?? {}).sort()).toEqual([
      'idempotency_key', 'intent_nonce_hash', 'prepare_audit_id', 'requested_hash',
      'semantic_hash',
    ]);
    const encoded = JSON.stringify([audits.rows[0]?.metadata, heads.rows[0]?.metadata]);
    expect(encoded).not.toContain('durable intent marker');
    expect(encoded).not.toContain('console-session-before-refresh');
  });

  it('requires a matching prepared key only on the console publish path', async () => {
    const input = intent();
    const forged = command(input, 'console:forged');
    await expect(repository.publish(forged, {
      requirePreparedConsoleIntent: true,
      consoleIntentOperatorScope: OPERATOR_SCOPE,
    }))
      .rejects.toMatchObject({ code: 'conflict' });

    const machine = await repository.publish(command(input, 'machine-owned-key'));
    expect(machine.duplicate).toBe(false);

    const changed = intent({
      body: { text: 'exact semantic body' },
    });
    const prepared = await prepare(changed);
    if (prepared.state !== 'prepared') throw new Error('expected a fresh prepared intent');
    await expect(publishConsole(
      intent({ body: { text: 'changed semantic body' } }),
      prepared.idempotency_key,
    ))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('recovers a lost 202 for an exact retry across session rotation, then confirms', async () => {
    const beforeRefresh = intent({ body: { text: 'lost 202 marker' } });
    const prepared = await prepare(beforeRefresh);
    if (prepared.state !== 'prepared') throw new Error('expected a fresh prepared intent');
    const publishedCommand = command(beforeRefresh, prepared.idempotency_key);
    const receipt = await publishConsole(beforeRefresh, prepared.idempotency_key);

    const duplicate = await repository.publish({
      ...publishedCommand,
      request_id: randomUUID(),
      trace_id: `retry-${randomUUID()}`,
    }, {
      requirePreparedConsoleIntent: true,
      consoleIntentOperatorScope: OPERATOR_SCOPE,
    });
    expect(duplicate).toEqual({ ...receipt, duplicate: true });

    const afterRelogin = intent({
      body: beforeRefresh.body,
      intent_nonce: beforeRefresh.intent_nonce,
      authenticated_context: {
        session_id: 'console-session-after-refresh',
        channel: 'console',
      },
    });
    const recovered = await prepare(afterRelogin);
    expect(recovered).toEqual({
      version: 1,
      state: 'committed',
      idempotency_key: prepared.idempotency_key,
      receipt,
    });

    const confirmation = {
      idempotency_key: receipt.idempotency_key,
      message_id: receipt.message_id,
      causal_hash: receipt.causal_hash,
    };
    const confirmed = await confirm('Steven', 'kant', confirmation);
    expect(await confirm('Steven', 'kant', confirmation))
      .toEqual(confirmed);
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='console.publish.head'`,
    )).rowCount).toBe(2);

    const next = await prepare({ ...afterRelogin, intent_nonce: randomUUID() });
    expect(next.state).toBe('prepared');
    expect(next.idempotency_key).not.toBe(prepared.idempotency_key);
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='console.publish.confirm'`,
    )).rowCount).toBe(1);
    expect((await pool.query<{ expires_at: string }>(
      `SELECT expires_at::text AS expires_at FROM idempotency_keys
        WHERE tenant_id='Steven' AND actor_alias='kant' AND idempotency_key=$1`,
      [receipt.idempotency_key],
    )).rows).toEqual([{ expires_at: 'infinity' }]);
  });

  it('serializes retries with the same nonce onto one key and one durable effect', async () => {
    const input = intent({ body: { text: 'concurrent marker' } });
    const results = await Promise.all(
      Array.from({ length: 12 }, async () => prepare({
        ...input,
        request_id: randomUUID(),
        trace_id: `parallel-${randomUUID()}`,
      })),
    );
    expect(new Set(results.map((result) => result.idempotency_key)).size).toBe(1);
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='console.publish.prepare'`,
    )).rowCount).toBe(1);
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='console.publish.head'`,
    )).rowCount).toBe(1);
    const receipts = await Promise.all(
      results.map(async (result) => publishConsole(input, result.idempotency_key)),
    );
    expect(new Set(receipts.map((receipt) => receipt.message_id)).size).toBe(1);
    expect(receipts.filter((receipt) => !receipt.duplicate)).toHaveLength(1);
    expect((await pool.query(`SELECT 1 FROM messages`)).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM deliveries`)).rowCount).toBe(1);
  });

  it('keeps concurrent distinct requested meanings as distinct effects', async () => {
    const first = intent({ body: { text: 'first deliberate meaning' } });
    const second = intent({ body: { text: 'second deliberate meaning' } });
    const [firstPrepared, secondPrepared] = await Promise.all([
      prepare(first),
      prepare(second),
    ]);
    expect(firstPrepared.idempotency_key).not.toBe(secondPrepared.idempotency_key);
    const [firstReceipt, secondReceipt] = await Promise.all([
      publishConsole(first, firstPrepared.idempotency_key),
      publishConsole(second, secondPrepared.idempotency_key),
    ]);
    expect(firstReceipt.message_id).not.toBe(secondReceipt.message_id);
    expect((await pool.query(`SELECT 1 FROM messages`)).rowCount).toBe(2);
    expect((await pool.query(`SELECT 1 FROM deliveries`)).rowCount).toBe(2);
  });

  it('allows an identical deliberate submit after the prior effect is confirmed', async () => {
    const first = intent({ body: { text: 'sequential deliberate duplicate' } });
    const firstPrepared = await prepare(first);
    const firstReceipt = await publishConsole(first, firstPrepared.idempotency_key);
    await confirm('Steven', 'kant', {
      idempotency_key: firstReceipt.idempotency_key,
      message_id: firstReceipt.message_id,
      causal_hash: firstReceipt.causal_hash,
    });

    const second = intent({ body: first.body });
    const secondPrepared = await prepare(second);
    expect(secondPrepared.idempotency_key).not.toBe(firstPrepared.idempotency_key);
    const secondReceipt = await publishConsole(second, secondPrepared.idempotency_key);
    expect(secondReceipt.message_id).not.toBe(firstReceipt.message_id);
    expect((await pool.query(`SELECT 1 FROM messages`)).rowCount).toBe(2);
  });

  it('durably rate-limits new nonces at exactly 60/10m and 200/day, exempting retries', async () => {
    const original = intent({ body: { text: 'rate-limit marker' } });
    const prepared = await prepare(original);
    const seed = async (from: number, to: number, age: string): Promise<void> => {
      await pool.query(
        `INSERT INTO audit_events(
           tenant_id,actor_alias,action,decision,created_at,metadata
         )
         SELECT 'Steven','kant','console.publish.prepare','allow',now()-$3::interval,
                jsonb_build_object(
                  'version',1,
                  'idempotency_key','console:rate-' || sequence,
                  'semantic_hash',lpad(to_hex(sequence),64,'0'),
                  'requested_hash',lpad(to_hex(sequence+20000),64,'0'),
                  'conversation_hash',repeat('c',64),
                  'intent_nonce_hash',lpad(to_hex(sequence+10000),64,'0'),
                  'operator_scope_hash',$4::text
                )
           FROM generate_series($1::integer,$2::integer) AS sequence`,
        [from, to, age, OPERATOR_SCOPE],
      );
    };
    await seed(1, 59, '0 seconds');
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='console.publish.prepare'`,
    )).rowCount).toBe(60);
    expect(await prepare(original)).toEqual(prepared);
    const shortLimited = await prepare(intent({ body: { text: 'short-window overflow' } }))
      .catch((error: unknown) => error);
    expect(shortLimited).toBeInstanceOf(PublishIntentRateLimitedError);
    expect(shortLimited).toMatchObject({
      rateLimit: {
        version: 1,
        error: 'publish_intent_rate_limited',
        safe_to_retry: true,
      },
    });
    expect((shortLimited as PublishIntentRateLimitedError).rateLimit.retry_after_seconds)
      .toBeGreaterThanOrEqual(1);
    expect((shortLimited as PublishIntentRateLimitedError).rateLimit.retry_after_seconds)
      .toBeLessThanOrEqual(600);

    await pool.query(
      `UPDATE audit_events SET created_at=now()-interval '11 minutes'
        WHERE action='console.publish.prepare'`,
    );
    await seed(60, 199, '11 minutes');
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='console.publish.prepare'`,
    )).rowCount).toBe(200);
    expect(await prepare(original)).toEqual(prepared);
    const dailyLimited = await prepare(intent({ body: { text: 'daily overflow' } }))
      .catch((error: unknown) => error);
    expect(dailyLimited).toBeInstanceOf(PublishIntentRateLimitedError);
    expect((dailyLimited as PublishIntentRateLimitedError).rateLimit.retry_after_seconds)
      .toBeGreaterThan(600);
    expect((dailyLimited as PublishIntentRateLimitedError).rateLimit.retry_after_seconds)
      .toBeLessThanOrEqual(86_400);
  });});
