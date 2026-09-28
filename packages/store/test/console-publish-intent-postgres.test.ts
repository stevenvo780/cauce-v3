import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CauceRepository, PublishIntentRateLimitedError, PublishIntentReconciliationRequired,
  type DatabaseClient, type DatabasePool,
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

  it('drains retained multiple committed unconfirmed meanings in durable head order', async () => {
    const first = intent({ body: { text: 'ordered reconciliation marker' } });
    const second = intent({ body: first.body, requested_priority: 11 });
    const firstPrepared = await prepare(first);
    const secondPrepared = await prepare(second);
    const firstReceipt = await publishConsole(first, firstPrepared.idempotency_key);
    const secondReceipt = await publishConsole(second, secondPrepared.idempotency_key);
    const firstRequested = await pool.query<{ requested_hash: string }>(
      `SELECT metadata->>'requested_hash' AS requested_hash
         FROM audit_events
        WHERE action='console.publish.prepare'
          AND metadata->>'idempotency_key'=$1`,
      [firstPrepared.idempotency_key],
    );
    const retainedRequestedHash = firstRequested.rows[0]?.requested_hash;
    if (retainedRequestedHash === undefined) throw new Error('missing retained requested hash');
    // Model a consistent retained pre-coalescing head. Runtime rows are append-only; this direct
    // rewrite is test setup only, used to prove deterministic recovery if such state is imported.
    await pool.query(
      `UPDATE audit_events
          SET metadata=jsonb_set(metadata,'{requested_hash}',to_jsonb($2::text))
        WHERE action='console.publish.prepare'
          AND metadata->>'idempotency_key'=$1`,
      [secondPrepared.idempotency_key, retainedRequestedHash],
    );
    await pool.query(
      `UPDATE audit_events
          SET metadata=jsonb_set(metadata,'{intents,1,requested_hash}',to_jsonb($2::text))
        WHERE action='console.publish.head'
          AND jsonb_array_length(metadata->'intents')=2
          AND metadata->'intents'->1->>'idempotency_key'=$1`,
      [secondPrepared.idempotency_key, retainedRequestedHash],
    );

    const firstReload = intent({ body: first.body });
    const firstError = await prepare(firstReload).catch((error: unknown) => error);
    expect(firstError).toBeInstanceOf(PublishIntentReconciliationRequired);
    expect(firstError).toMatchObject({
      reconciliation: {
        idempotency_key: firstPrepared.idempotency_key,
        receipt: firstReceipt,
      },
    });
    await confirm('Steven', 'kant', {
      idempotency_key: firstReceipt.idempotency_key,
      message_id: firstReceipt.message_id,
      causal_hash: firstReceipt.causal_hash,
    });

    const secondReload = intent({ body: first.body });
    const secondError = await prepare(secondReload).catch((error: unknown) => error);
    expect(secondError).toBeInstanceOf(PublishIntentReconciliationRequired);
    expect(secondError).toMatchObject({
      reconciliation: {
        idempotency_key: secondPrepared.idempotency_key,
        receipt: secondReceipt,
      },
    });
    await confirm('Steven', 'kant', {
      idempotency_key: secondReceipt.idempotency_key,
      message_id: secondReceipt.message_id,
      causal_hash: secondReceipt.causal_hash,
    });

    const fresh = await prepare(intent({ body: first.body }));
    expect(fresh).toMatchObject({ state: 'prepared', receipt: null });
    expect(fresh.idempotency_key).not.toBe(firstPrepared.idempotency_key);
    expect(fresh.idempotency_key).not.toBe(secondPrepared.idempotency_key);
    expect((await pool.query(`SELECT 1 FROM messages`)).rowCount).toBe(2);
  });

  it('coalesces a lost prepare response under a new nonce without another journal write', async () => {
    const beforeReload = intent({ body: { text: 'lost prepare response' } });
    const lost = await prepare(beforeReload);
    const afterReload = intent({ body: beforeReload.body });
    const replacement = await prepare(afterReload);
    expect(replacement.state).toBe('prepared');
    expect(replacement.idempotency_key).toBe(lost.idempotency_key);
    expect((await pool.query(`SELECT 1 FROM messages`)).rowCount).toBe(0);
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='console.publish.prepare'`,
    )).rowCount).toBe(1);
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='console.publish.head'`,
    )).rowCount).toBe(1);
    const receipts = await Promise.all([
      publishConsole(beforeReload, lost.idempotency_key),
      publishConsole(afterReload, replacement.idempotency_key),
    ]);
    expect(new Set(receipts.map((receipt) => receipt.message_id)).size).toBe(1);
    expect((await pool.query(`SELECT 1 FROM messages`)).rowCount).toBe(1);
  });

  it('coalesces reload prepare before an older in-flight publish reaches the actor lock', async () => {
    const beforeReload = intent({ body: { text: 'in-flight prepare race marker' } });
    const prepared = await prepare(beforeReload);
    let releasePublish = (): void => {
      throw new Error('publish lock pause was not initialized');
    };
    let markPublishPaused = (): void => {
      throw new Error('publish lock signal was not initialized');
    };
    const publishPaused = new Promise<void>((resolve) => {
      markPublishPaused = resolve;
    });
    const publishReleased = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    let interceptNextConsoleLock = true;
    const racePool = {
      connect: async (): Promise<DatabaseClient> => {
        const client = await pool.connect();
        const wrappedQuery = (async (queryText: string, values?: unknown[]) => {
          if (interceptNextConsoleLock
              && queryText.includes('pg_advisory_xact_lock(hashtextextended($1,0))')) {
            interceptNextConsoleLock = false;
            markPublishPaused();
            await publishReleased;
          }
          return values === undefined
            ? client.query(queryText)
            : client.query(queryText, values);
        }) as DatabaseClient['query'];
        return {
          query: wrappedQuery,
          on: client.on.bind(client),
          off: client.off.bind(client),
          release: client.release.bind(client),
        } as DatabaseClient;
      },
    } as DatabasePool;
    const racingRepository = new CauceRepository(racePool);
    const inFlight = racingRepository.publish(
      command(beforeReload, prepared.idempotency_key),
      { requirePreparedConsoleIntent: true, consoleIntentOperatorScope: OPERATOR_SCOPE },
    );
    await publishPaused;

    const afterReload = intent({ body: beforeReload.body });
    let coalesced: Awaited<ReturnType<typeof prepare>>;
    try {
      coalesced = await racingRepository.prepareConsolePublishIntent(afterReload, OPERATOR_SCOPE);
    } finally {
      releasePublish();
    }
    const firstReceipt = await inFlight;
    expect(coalesced.idempotency_key).toBe(prepared.idempotency_key);
    const retryReceipt = await racingRepository.publish(
      command(afterReload, coalesced.idempotency_key),
      { requirePreparedConsoleIntent: true, consoleIntentOperatorScope: OPERATOR_SCOPE },
    );
    expect(retryReceipt).toEqual({ ...firstReceipt, duplicate: true });
    expect((await pool.query(`SELECT 1 FROM messages`)).rowCount).toBe(1);
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='console.publish.prepare'`,
    )).rowCount).toBe(1);
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
  });

  it('returns explicit reconciliation for a committed meaning under a new nonce', async () => {
    const original = intent({ body: { text: 'committed reconciliation marker' } });
    const prepared = await prepare(original);
    const receipt = await publishConsole(original, prepared.idempotency_key);
    const reloaded = intent({ body: original.body });
    await expect(prepare(reloaded)).rejects.toEqual(expect.objectContaining({
      reconciliation: {
        version: 1,
        error: 'publish_intent_reconciliation_required',
        state: 'committed',
        idempotency_key: prepared.idempotency_key,
        receipt,
      },
    }));
    await expect(prepare(reloaded)).rejects.toBeInstanceOf(PublishIntentReconciliationRequired);
    expect((await pool.query(`SELECT 1 FROM messages`)).rowCount).toBe(1);
  });});
