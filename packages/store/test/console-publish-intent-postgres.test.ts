import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  publishReceiptCausalHash, type ConsolePublishIntentCommand, type PublishMessage,
} from '@cauce/protocol';
import {
  CauceRepository, PublishIntentExpiredError, PublishIntentRateLimitedError,
  PublishIntentReconciliationRequired, type DatabaseClient, type DatabasePool,
} from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';
import { requireValue } from './helpers.js';
let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

const OPERATOR_SCOPE = 'a'.repeat(64);
const OTHER_OPERATOR_SCOPE = 'b'.repeat(64);

function intent(
  overrides: Partial<ConsolePublishIntentCommand> = {},
): ConsolePublishIntentCommand {
  const base: ConsolePublishIntentCommand = {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `intent-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'durable intent marker' },
    lane: 'interactive',
    priority: 80,
    requested_priority: 10,
    authenticated_context: {
      session_id: 'console-session-before-refresh',
      channel: 'console',
    },
    intent_nonce: randomUUID(),
  };
  return {
    ...base,
    ...overrides,
    intent_nonce: overrides.intent_nonce ?? base.intent_nonce,
  };
}

function command(
  prepared: ConsolePublishIntentCommand,
  idempotencyKey: string,
  overrides: Partial<PublishMessage> = {},
): PublishMessage {
  const {
    intent_nonce: _intentNonce,
    requested_priority: _requestedPriority,
    ...publishable
  } = prepared;
  void _intentNonce;
  void _requestedPriority;
  return {
    ...publishable,
    idempotency_key: idempotencyKey,
    request_id: randomUUID(),
    trace_id: `publish-${randomUUID()}`,
    ...overrides,
  };
}

function prepare(
  input: ConsolePublishIntentCommand,
  scope = OPERATOR_SCOPE,
) {
  return repository.prepareConsolePublishIntent(input, scope);
}

function publishConsole(
  input: ConsolePublishIntentCommand,
  idempotencyKey: string,
  scope = OPERATOR_SCOPE,
  overrides: Partial<PublishMessage> = {},
) {
  return repository.publish(command(input, idempotencyKey, overrides), {
    requirePreparedConsoleIntent: true,
    consoleIntentOperatorScope: scope,
  });
}

function confirm(
  tenantId: 'Steven' | 'Miguel' | 'Pablo' | 'Isa' | 'Jhon',
  actorAlias: string,
  input: Parameters<CauceRepository['confirmConsolePublishIntent']>[3],
  scope = OPERATOR_SCOPE,
) {
  return repository.confirmConsolePublishIntent(tenantId, actorAlias, scope, input);
}

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  repository = new CauceRepository(pool);
});

afterAll(async () => {
  await pool.end();
  await database.container.stop();
});

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
        intents?: Array<Record<string, unknown>>;
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
  });

  it('reconciles a committed requested meaning across effective priority policy drift', async () => {
    const original = intent({
      body: { text: 'priority policy rollout marker' },
      priority: 80,
      requested_priority: 10,
    });
    const prepared = await prepare(original);
    const receipt = await publishConsole(original, prepared.idempotency_key);
    const driftedExactRetry = intent({
      ...original,
      request_id: randomUUID(),
      trace_id: `policy-drift-exact-${randomUUID()}`,
      priority: 90,
      intent_nonce: original.intent_nonce,
    });
    expect(await prepare(driftedExactRetry)).toEqual({
      version: 1,
      state: 'committed',
      idempotency_key: prepared.idempotency_key,
      receipt,
    });

    const afterRollout = intent({
      ...driftedExactRetry,
      request_id: randomUUID(),
      trace_id: `policy-drift-reload-${randomUUID()}`,
      intent_nonce: randomUUID(),
    });
    await expect(prepare(afterRollout)).rejects.toEqual(expect.objectContaining({
      reconciliation: {
        version: 1,
        error: 'publish_intent_reconciliation_required',
        state: 'committed',
        idempotency_key: prepared.idempotency_key,
        receipt,
      },
    }));
    expect((await pool.query(`SELECT 1 FROM messages`)).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM deliveries`)).rowCount).toBe(1);
  });

  it('fails closed when the effective policy drifts before a prepared intent has an effect', async () => {
    const original = intent({
      body: { text: 'uncommitted priority drift marker' },
      priority: 80,
      requested_priority: 10,
    });
    const originalPrepared = await prepare(original);
    await expect(prepare({
      ...original,
      request_id: randomUUID(),
      trace_id: `uncommitted-policy-drift-${randomUUID()}`,
      priority: 90,
    })).rejects.toMatchObject({ code: 'conflict' });
    const replacementInput = intent({
      ...original,
      request_id: randomUUID(),
      trace_id: `uncommitted-policy-reload-${randomUUID()}`,
      priority: 90,
      intent_nonce: randomUUID(),
    });
    const replacement = await prepare(replacementInput);
    expect(replacement.idempotency_key).not.toBe(originalPrepared.idempotency_key);
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='console.publish.expire'
        AND metadata->>'idempotency_key'=$1`,
      [originalPrepared.idempotency_key],
    )).rowCount).toBe(1);
    await expect(publishConsole(original, originalPrepared.idempotency_key))
      .rejects.toBeInstanceOf(PublishIntentExpiredError);
    await expect(publishConsole(replacementInput, replacement.idempotency_key))
      .resolves.toMatchObject({ duplicate: false });
    expect((await pool.query(`SELECT 1 FROM messages`)).rowCount).toBe(1);
  });

  it('canonicalizes recipient order across lost-202 retry and relogin', async () => {
    const original = intent({
      recipients: [
        { tenant_id: 'Steven', alias: 'jarvis' },
        { tenant_id: 'Steven', alias: 'argos' },
      ],
      body: { text: 'recipient set order marker' },
    });
    const prepared = await prepare(original);
    const receipt = await publishConsole(original, prepared.idempotency_key);
    const reorderedRetry = intent({
      ...original,
      request_id: randomUUID(),
      trace_id: `reordered-retry-${randomUUID()}`,
      recipients: [...original.recipients].reverse(),
    });
    expect(await publishConsole(reorderedRetry, prepared.idempotency_key))
      .toEqual({ ...receipt, duplicate: true });
    const relogin = intent({
      ...reorderedRetry,
      request_id: randomUUID(),
      trace_id: `relogin-${randomUUID()}`,
      authenticated_context: { session_id: 'reordered-relogin', channel: 'console' },
    });
    const recovered = await prepare(relogin);
    expect(recovered).toEqual({
      version: 1,
      state: 'committed',
      idempotency_key: prepared.idempotency_key,
      receipt,
    });
    expect((await pool.query(`SELECT 1 FROM messages`)).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM deliveries`)).rowCount).toBe(2);
  });

  it('isolates identical tenant and alias journals by stable operator scope', async () => {
    const input = intent({ body: { text: 'operator scope marker' } });
    const first = await prepare(input, OPERATOR_SCOPE);
    const second = await prepare({
      ...input,
      request_id: randomUUID(),
      trace_id: `other-operator-${randomUUID()}`,
    }, OTHER_OPERATOR_SCOPE);
    expect(second.idempotency_key).not.toBe(first.idempotency_key);
    await expect(publishConsole(input, first.idempotency_key, OTHER_OPERATOR_SCOPE))
      .rejects.toMatchObject({ code: 'conflict' });
    const receipt = await publishConsole(input, first.idempotency_key, OPERATOR_SCOPE);
    await expect(confirm('Steven', 'kant', {
      idempotency_key: receipt.idempotency_key,
      message_id: receipt.message_id,
      causal_hash: receipt.causal_hash,
    }, OTHER_OPERATOR_SCOPE)).rejects.toMatchObject({ code: 'conflict' });
    const relogin = await prepare({
      ...input,
      request_id: randomUUID(),
      trace_id: `same-operator-relogin-${randomUUID()}`,
      authenticated_context: { session_id: 'new-session', channel: 'console' },
    }, OPERATOR_SCOPE);
    expect(relogin).toEqual({
      version: 1,
      state: 'committed',
      idempotency_key: first.idempotency_key,
      receipt,
    });
  });

  it('fails closed for forged confirmation fields and isolates actors and tenants', async () => {
    const input = intent({ body: { text: 'isolated marker' } });
    const prepared = await prepare(input);
    if (prepared.state !== 'prepared') throw new Error('expected a fresh prepared intent');
    const receipt = await publishConsole(input, prepared.idempotency_key);

    await expect(confirm('Steven', 'kant', {
      idempotency_key: prepared.idempotency_key,
      message_id: randomUUID(),
      causal_hash: receipt.causal_hash,
    })).rejects.toMatchObject({ code: 'conflict' });
    await expect(confirm('Steven', 'kant', {
      idempotency_key: prepared.idempotency_key,
      message_id: receipt.message_id,
      causal_hash: 'f'.repeat(64),
    })).rejects.toMatchObject({ code: 'conflict' });
    await expect(confirm('Steven', 'socrates', {
      idempotency_key: prepared.idempotency_key,
      message_id: receipt.message_id,
      causal_hash: receipt.causal_hash,
    })).rejects.toMatchObject({ code: 'conflict' });
    await expect(confirm('Pablo', 'dedalo', {
      idempotency_key: prepared.idempotency_key,
      message_id: receipt.message_id,
      causal_hash: receipt.causal_hash,
    })).rejects.toMatchObject({ code: 'conflict' });

    const anotherActor = await prepare(intent({
      actor_alias: 'socrates',
      authenticated_context: { session_id: 'socrates-session', channel: 'console' },
    }));
    const anotherTenant = await prepare(intent({
      tenant_id: 'Pablo',
      room_id: 'grp.pablo',
      actor_alias: 'dedalo',
      recipients: [{ tenant_id: 'Pablo', alias: 'midas' }],
      authenticated_context: { session_id: 'dedalo-session', channel: 'console' },
    }));
    expect(anotherActor.idempotency_key).not.toBe(prepared.idempotency_key);
    expect(anotherTenant.idempotency_key).not.toBe(prepared.idempotency_key);
  });

  it('bounds churn at 32 by expiring only the oldest reservation without an effect', async () => {
    const inputs = Array.from({ length: 40 }, (_, index) => intent({
      body: { text: `bounded meaning ${index}` },
    }));
    const prepared = [];
    for (const input of inputs) prepared.push(await prepare(input));
    expect(new Set(prepared.map((entry) => entry.idempotency_key)).size).toBe(40);
    const active = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_events prepared
        WHERE prepared.action='console.publish.prepare'
          AND NOT EXISTS (
            SELECT 1 FROM audit_events expired
             WHERE expired.action='console.publish.expire'
               AND expired.metadata->>'idempotency_key'=
                   prepared.metadata->>'idempotency_key'
          )`,
    );
    expect(Number(active.rows[0]?.count)).toBe(32);
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='console.publish.expire'`,
    )).rowCount).toBe(8);
    const evicted = await publishConsole(requireValue(inputs[0], 'inputs'), requireValue(prepared[0], 'prepared').idempotency_key)
      .catch((error: unknown) => error);
    expect(evicted).toBeInstanceOf(PublishIntentExpiredError);
    expect(evicted).toMatchObject({
      expiration: {
        version: 1,
        error: 'publish_intent_expired',
        state: 'expired',
        idempotency_key: requireValue(prepared[0], 'prepared').idempotency_key,
        safe_to_resubmit: true,
      },
    });
    await expect(publishConsole(requireValue(inputs.at(-1), 'value'), requireValue(prepared.at(-1), 'value').idempotency_key))
      .resolves.toMatchObject({ duplicate: false });
  });

  it('fails closed on extra journal metadata instead of ignoring corrupted capacity state', async () => {
    const input = intent({ body: { text: 'metadata exactness marker' } });
    const prepared = await prepare(input);
    await pool.query(
      `UPDATE audit_events SET metadata=metadata || '{"body":"forbidden"}'::jsonb
        WHERE action='console.publish.prepare'
          AND metadata->>'idempotency_key'=$1`,
      [prepared.idempotency_key],
    );
    await expect(prepare(input))
      .rejects.toMatchObject({ code: 'conflict' });
    await expect(prepare(intent({
      body: { text: 'another meaning in the corrupted conversation' },
    }))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('fails closed on malformed head sequence, metadata and prepare binding', async () => {
    const sequenceInput = intent({ body: { text: 'head sequence marker' } });
    await prepare(sequenceInput);
    await pool.query(
      `UPDATE audit_events SET metadata=jsonb_set(metadata,'{sequence}','99'::jsonb)
        WHERE action='console.publish.head'`,
    );
    await expect(prepare(sequenceInput)).rejects.toMatchObject({ code: 'conflict' });

    await resetTestDatabase(pool);
    const extraInput = intent({ body: { text: 'head extra metadata marker' } });
    await prepare(extraInput);
    await pool.query(
      `UPDATE audit_events SET metadata=metadata || '{"body":"forbidden"}'::jsonb
        WHERE action='console.publish.head'`,
    );
    await expect(prepare(extraInput)).rejects.toMatchObject({ code: 'conflict' });

    await resetTestDatabase(pool);
    const bindingInput = intent({ body: { text: 'head binding marker' } });
    await prepare(bindingInput);
    await pool.query(
      `UPDATE audit_events
          SET metadata=jsonb_set(metadata,'{intents,0,prepare_audit_id}','"999999"'::jsonb)
        WHERE action='console.publish.head'`,
    );
    await expect(prepare(bindingInput)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('does not let an invalid closure hide a prepare from the durable head', async () => {
    const input = intent({ body: { text: 'invalid closure marker' } });
    const prepared = await prepare(input);
    const metadata = await pool.query<{ metadata: unknown }>(
      `SELECT metadata FROM audit_events
        WHERE action='console.publish.prepare'
          AND metadata->>'idempotency_key'=$1`,
      [prepared.idempotency_key],
    );
    await pool.query(
      `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
       VALUES('Steven','kant','console.publish.confirm','allow',
              $1::jsonb || jsonb_build_object('causal_hash',repeat('a',64)))`,
      [JSON.stringify(metadata.rows[0]?.metadata)],
    );
    await expect(prepare({ ...input, intent_nonce: randomUUID() }))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('revalidates message and delivery rows on first and repeated confirmation', async () => {
    const input = intent({ body: { text: 'durable confirmation marker' } });
    const prepared = await prepare(input);
    if (prepared.state !== 'prepared') throw new Error('expected a fresh prepared intent');
    const receipt = await publishConsole(input, prepared.idempotency_key);
    const confirmation = {
      idempotency_key: receipt.idempotency_key,
      message_id: receipt.message_id,
      causal_hash: receipt.causal_hash,
    };
    await confirm('Steven', 'kant', confirmation);
    expect(await confirm('Steven', 'kant', confirmation))
      .toMatchObject({ version: 1, confirmed: true, ...confirmation });

    await pool.query(
      `UPDATE audit_events SET metadata=metadata || '{"body":"forbidden"}'::jsonb
        WHERE action='console.publish.confirm'
          AND metadata->>'idempotency_key'=$1`,
      [receipt.idempotency_key],
    );
    await expect(confirm('Steven', 'kant', confirmation))
      .rejects.toMatchObject({ code: 'conflict' });
    await pool.query(
      `UPDATE audit_events SET metadata=metadata-'body'
        WHERE action='console.publish.confirm'
          AND metadata->>'idempotency_key'=$1`,
      [receipt.idempotency_key],
    );

    const other = await repository.publish(command(intent({
      body: { text: 'alien durable delivery' },
    }), 'machine-alien-delivery'));
    const forgedBase = { ...receipt, delivery_ids: other.delivery_ids };
    const forged = { ...forgedBase, causal_hash: publishReceiptCausalHash(forgedBase) };
    await pool.query(
      `UPDATE idempotency_keys SET response=$4::jsonb
        WHERE tenant_id=$1 AND actor_alias=$2 AND idempotency_key=$3`,
      ['Steven', 'kant', receipt.idempotency_key, JSON.stringify(forged)],
    );
    await expect(confirm('Steven', 'kant', confirmation))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('expires reservations after 15 minutes only when no idempotency row exists', async () => {
    const input = intent({ body: { text: 'abandoned prepare marker' } });
    const abandoned = await prepare(input);
    await pool.query(
      `UPDATE audit_events SET created_at=now()-interval '16 minutes'
        WHERE action='console.publish.prepare'
          AND metadata->>'idempotency_key'=$1`,
      [abandoned.idempotency_key],
    );
    const replacement = await prepare({ ...input, intent_nonce: randomUUID() });
    expect(replacement.state).toBe('prepared');
    expect(replacement.idempotency_key).not.toBe(abandoned.idempotency_key);
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='console.publish.expire'
        AND metadata->>'idempotency_key'=$1`,
      [abandoned.idempotency_key],
    )).rowCount).toBe(1);
    const expired = await publishConsole(input, abandoned.idempotency_key)
      .catch((error: unknown) => error);
    expect(expired).toBeInstanceOf(PublishIntentExpiredError);
    expect(expired).toMatchObject({
      expiration: {
        version: 1,
        error: 'publish_intent_expired',
        state: 'expired',
        idempotency_key: abandoned.idempotency_key,
        safe_to_resubmit: true,
      },
    });
  });

  it('never expires an old prepare once any durable idempotency effect exists', async () => {
    const input = intent({ body: { text: 'old committed marker' } });
    const prepared = await prepare(input);
    if (prepared.state !== 'prepared') throw new Error('expected a fresh prepared intent');
    const receipt = await publishConsole(input, prepared.idempotency_key);
    expect((await pool.query<{ expires_at: string }>(
      `SELECT expires_at::text AS expires_at FROM idempotency_keys
        WHERE tenant_id='Steven' AND actor_alias='kant' AND idempotency_key=$1`,
      [prepared.idempotency_key],
    )).rows).toEqual([{ expires_at: 'infinity' }]);
    await pool.query(
      `UPDATE audit_events SET created_at=now()-interval '16 minutes'
        WHERE action='console.publish.prepare'
          AND metadata->>'idempotency_key'=$1`,
      [prepared.idempotency_key],
    );
    const recovered = await repository.prepareConsolePublishIntent(intent({
      body: input.body,
      intent_nonce: input.intent_nonce,
      authenticated_context: { session_id: 'later-login', channel: 'console' },
    }), OPERATOR_SCOPE);
    expect(recovered).toEqual({
      version: 1,
      state: 'committed',
      idempotency_key: prepared.idempotency_key,
      receipt,
    });
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='console.publish.expire'
        AND metadata->>'idempotency_key'=$1`,
      [prepared.idempotency_key],
    )).rowCount).toBe(0);
    expect((await pool.query(
      `DELETE FROM idempotency_keys WHERE expires_at<=now() RETURNING 1`,
    )).rowCount).toBe(0);
    const reloaded = intent({ body: input.body });
    const cleanupError = await prepare(reloaded).catch((error: unknown) => error);
    expect(cleanupError).toBeInstanceOf(PublishIntentReconciliationRequired);
    if (!(cleanupError instanceof PublishIntentReconciliationRequired)) {
      throw new Error('expected committed reconciliation after cleanup candidate');
    }
    expect(cleanupError.reconciliation).toEqual({
      version: 1,
      error: 'publish_intent_reconciliation_required',
      state: 'committed',
      idempotency_key: prepared.idempotency_key,
      receipt,
    });
  });

  it('keeps prepare, confirm and expire audit state outside observability pruning', async () => {
    const abandonedInput = intent({ body: { text: 'retained abandoned marker' } });
    const abandoned = await prepare(abandonedInput);
    await pool.query(
      `UPDATE audit_events SET created_at=now()-interval '16 minutes'
        WHERE action='console.publish.prepare'
          AND metadata->>'idempotency_key'=$1`,
      [abandoned.idempotency_key],
    );
    const replacement = await prepare({ ...abandonedInput, intent_nonce: randomUUID() });
    if (replacement.state !== 'prepared') throw new Error('expected replacement prepare');
    const receipt = await publishConsole(abandonedInput, replacement.idempotency_key);
    await confirm('Steven', 'kant', {
      idempotency_key: receipt.idempotency_key,
      message_id: receipt.message_id,
      causal_hash: receipt.causal_hash,
    });
    await pool.query(
      `UPDATE audit_events SET created_at=now()-interval '400 days'
        WHERE action LIKE 'console.publish.%'`,
    );

    await repository.pruneObservability();

    const actions = await pool.query<{ action: string }>(
      `SELECT action FROM audit_events
        WHERE action LIKE 'console.publish.%' ORDER BY id`,
    );
    expect(actions.rows.map((row) => row.action)).toEqual([
      'console.publish.prepare',
      'console.publish.head',
      'console.publish.expire',
      'console.publish.head',
      'console.publish.prepare',
      'console.publish.head',
      'console.publish.confirm',
      'console.publish.head',
    ]);
  });
});
