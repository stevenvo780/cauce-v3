import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { publishReceiptCausalHash } from '@cauce/protocol';
import { PublishIntentExpiredError, PublishIntentReconciliationRequired } from '../src/index.js';
import { resetTestDatabase } from '../../../tests/helpers/postgres.js';
import { requireValue } from './helpers.js';
import {
  command, confirm, intent, OPERATOR_SCOPE, OTHER_OPERATOR_SCOPE, pool, prepare, publishConsole,
  registerConsolePublishSuite, repository,
} from './console-publish-intent-postgres-helpers.js';

registerConsolePublishSuite(import.meta.url);

describe('durable console publish intents', () => {
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
      body: { text: `bounded meaning ${String(index)}` },
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
  });});
