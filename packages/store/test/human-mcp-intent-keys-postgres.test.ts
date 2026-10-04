import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GatewayOperationError, type GatewayOperationFailure } from '../../mcp-fleet-monitor/src/gateway-operations.js';
import {
  agePrepare, consoleIntent, counts, databasePool, finishRoot, getRepository, HUMAN_PUBLISH_SCOPE,
  operations, phaseBarrier, preparedKey, publishedContext, seedHumanPublishActor, submitCommand,
} from './human-mcp-intent-keys-postgres.fixtures.js';

async function failureOf(pending: Promise<unknown>): Promise<Readonly<GatewayOperationFailure>> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayOperationError);
    if (error instanceof GatewayOperationError) return error.failure;
    throw error;
  }
  throw new Error('expected a gateway operation failure');
}

const interrupted = { status_code: 503, error: 'operation_unavailable', safe_to_retry_same_request_key: true };
const durableEffect = { messages: 1, deliveries: 1, outbox: 1, initiators: 1, idempotency: 1, publications: 1 };

describe('human MCP request-key intents on isolated PostgreSQL', () => {
  it('persists different keys for identical content before either effect and recovers both retries', async () => {
    const account = await seedHumanPublishActor();
    const first = submitCommand();
    const second = { ...first, request_key: randomUUID() };
    const interruptedOperations = await operations(account, 'prepare');
    expect(await failureOf(interruptedOperations.submit(first))).toEqual(interrupted);
    expect(await failureOf(interruptedOperations.submit(second))).toEqual(interrupted);
    const firstKey = await preparedKey(account, first.request_key);
    const secondKey = await preparedKey(account, second.request_key);
    expect(firstKey).not.toBe(secondKey);
    expect(await counts(account)).toMatchObject({ prepares: 2, messages: 0, idempotency: 0 });

    const renewed = await operations(account);
    const firstReceipt = await renewed.submit(first);
    const secondReceipt = await renewed.submit(second);
    expect(firstReceipt.idempotency_key).toBe(firstKey);
    expect(secondReceipt.idempotency_key).toBe(secondKey);
    expect(firstReceipt.message_id).not.toBe(secondReceipt.message_id);
    expect(await renewed.submit(first)).toEqual(firstReceipt);
    expect(await renewed.submit(second)).toEqual(secondReceipt);
    expect(await counts(account)).toEqual({ messages: 2, deliveries: 2, outbox: 2, initiators: 2,
      idempotency: 2, publications: 2, prepares: 2, confirms: 2, expirations: 0 });
  });

  it('serializes concurrent reservations of the same key into one durable binding and effect', async () => {
    const account = await seedHumanPublishActor();
    const command = submitCommand();
    const requests = await Promise.all(Array.from({ length: 4 }, () => operations(account, 'prepare')));
    expect(await Promise.all(requests.map((request) => failureOf(request.submit(command)))))
      .toEqual(Array.from({ length: 4 }, () => interrupted));
    const key = await preparedKey(account, command.request_key);
    expect(await counts(account)).toMatchObject({ prepares: 1, messages: 0 });
    const renewed = await operations(account);
    const receipt = await renewed.submit(command);
    expect(receipt.idempotency_key).toBe(key);
    for (let retry = 0; retry < 3; retry += 1) expect(await renewed.submit(command)).toEqual(receipt);
    expect(await counts(account)).toEqual({ ...durableEffect, prepares: 1, confirms: 1, expirations: 0 });
  });

  it('races publication for the same key and converges parallel retries onto one confirmed effect', async () => {
    const account = await seedHumanPublishActor();
    const command = submitCommand();
    const prepared = phaseBarrier(2);
    const requests = await Promise.all(Array.from({ length: 2 }, () =>
      operations(account, undefined, { afterPrepare: prepared.wait })));
    const pending = Promise.allSettled(requests.map((request) => request.submit(command)));
    try {
      await prepared.arrived();
      expect(await counts(account)).toMatchObject({ prepares: 1, messages: 0, confirms: 0 });
    } finally { prepared.release(); await pending; }
    const outcomes = await pending;
    const receipts = outcomes.flatMap((outcome) => outcome.status === 'fulfilled' ? [outcome.value] : []);
    const receipt = receipts[0];
    if (receipt === undefined) throw new Error('no concurrent submit committed its intent');
    expect(new Set(receipts.map((value) => value.message_id)).size).toBe(1);
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') continue;
      const error: unknown = outcome.reason;
      expect(error).toBeInstanceOf(GatewayOperationError);
      if (!(error instanceof GatewayOperationError)) throw error;
      expect(error.failure).toEqual({ status_code: 409, error: 'operation_conflict', safe_to_retry_same_request_key: true });
    }
    expect(receipt.idempotency_key).toBe(await preparedKey(account, command.request_key));
    expect(await counts(account)).toEqual({ ...durableEffect, prepares: 1, confirms: 1, expirations: 0 });

    const confirming = phaseBarrier(2);
    const retries = await Promise.all(Array.from({ length: 2 }, () =>
      operations(account, undefined, { beforeConfirm: confirming.wait })));
    const recoveryAttempts = retries.map((retry) => retry.submit(command));
    const recovered = Promise.all(recoveryAttempts);
    void recovered.catch(() => undefined);
    try {
      await confirming.arrived();
      expect(await counts(account)).toEqual({ ...durableEffect, prepares: 1, confirms: 1, expirations: 0 });
    } finally { confirming.release(); await Promise.allSettled(recoveryAttempts); }
    for (const value of await recovered) expect(value).toMatchObject({
      message_id: receipt.message_id, idempotency_key: receipt.idempotency_key, causal_hash: receipt.causal_hash,
    });
    expect(await counts(account)).toEqual({ ...durableEffect, prepares: 1, confirms: 1, expirations: 0 });
  });

  it('publishes and confirms distinct keys in parallel then retries both without a third effect', async () => {
    const account = await seedHumanPublishActor();
    const first = submitCommand();
    const second = { ...first, request_key: randomUUID() };
    const prepared = phaseBarrier(2);
    const confirming = phaseBarrier(2);
    const requests = await Promise.all(Array.from({ length: 2 }, () => operations(account, undefined,
      { afterPrepare: prepared.wait, beforeConfirm: confirming.wait })));
    const attempts = requests.map((request, index) => request.submit(index === 0 ? first : second));
    const pending = Promise.all(attempts);
    void pending.catch(() => undefined);
    try {
      await prepared.arrived();
      expect(await counts(account)).toMatchObject({ prepares: 2, messages: 0, confirms: 0 });
      prepared.release();
      await confirming.arrived();
      expect(await counts(account)).toEqual({ messages: 2, deliveries: 2, outbox: 2, initiators: 2,
        idempotency: 2, publications: 2, prepares: 2, confirms: 0, expirations: 0 });
    } finally { prepared.release(); confirming.release(); await Promise.allSettled(attempts); }
    const [firstReceipt, secondReceipt] = await pending;
    if (firstReceipt === undefined || secondReceipt === undefined) throw new Error('missing concurrent receipts');
    expect(firstReceipt.idempotency_key).toBe(await preparedKey(account, first.request_key));
    expect(secondReceipt.idempotency_key).toBe(await preparedKey(account, second.request_key));
    expect(firstReceipt.idempotency_key).not.toBe(secondReceipt.idempotency_key);
    expect(firstReceipt.message_id).not.toBe(secondReceipt.message_id);
    const renewed = await Promise.all([operations(account), operations(account)]);
    const retryAttempts = renewed.map((request, index) => request.submit(index === 0 ? first : second));
    await Promise.allSettled(retryAttempts);
    const retried = await Promise.all(retryAttempts);
    expect(retried).toEqual([firstReceipt, secondReceipt]);
    expect(await counts(account)).toEqual({ messages: 2, deliveries: 2, outbox: 2, initiators: 2,
      idempotency: 2, publications: 2, prepares: 2, confirms: 2, expirations: 0 });
  });

  it('confirms an unconfirmed effect once when two same-key recovery requests race', async () => {
    const account = await seedHumanPublishActor();
    const command = submitCommand();
    expect(await failureOf((await operations(account, 'publish')).submit(command))).toEqual(interrupted);
    const key = await preparedKey(account, command.request_key);
    const confirming = phaseBarrier(2);
    const requests = await Promise.all(Array.from({ length: 2 }, () =>
      operations(account, undefined, { beforeConfirm: confirming.wait })));
    const attempts = requests.map((request) => request.submit(command));
    const pending = Promise.all(attempts);
    void pending.catch(() => undefined);
    try {
      await confirming.arrived();
      expect(await counts(account)).toEqual({ ...durableEffect, prepares: 1, confirms: 0, expirations: 0 });
    } finally { confirming.release(); await Promise.allSettled(attempts); }
    const [first, second] = await pending;
    if (first === undefined) throw new Error('missing recovered receipt');
    expect(second).toEqual(first);
    expect(first.idempotency_key).toBe(key);
    expect(await (await operations(account)).submit(command)).toEqual(first);
    expect(await counts(account)).toEqual({ ...durableEffect, prepares: 1, confirms: 1, expirations: 0 });
  });

  it('keeps a new key independent of an identical committed but unconfirmed intent', async () => {
    const account = await seedHumanPublishActor();
    const first = submitCommand();
    expect(await failureOf((await operations(account, 'publish')).submit(first))).toEqual(interrupted);
    expect(await counts(account)).toEqual({ ...durableEffect, prepares: 1, confirms: 0, expirations: 0 });
    const second = { ...first, request_key: randomUUID() };
    const renewed = await operations(account);
    const secondReceipt = await renewed.submit(second);
    const firstReceipt = await renewed.submit(first);
    expect(firstReceipt.idempotency_key).not.toBe(secondReceipt.idempotency_key);
    expect(firstReceipt.message_id).not.toBe(secondReceipt.message_id);
    expect(await renewed.submit(second)).toEqual(secondReceipt);
    expect(await counts(account)).toEqual({ messages: 2, deliveries: 2, outbox: 2, initiators: 2,
      idempotency: 2, publications: 2, prepares: 2, confirms: 2, expirations: 0 });
  });

  it('recovers the same key after a renewed identity and terminal conversation without changing its historical session', async () => {
    const account = await seedHumanPublishActor();
    const command = submitCommand();
    const receipt = await (await operations(account)).submit(command);
    const originalContext = await publishedContext(receipt.message_id);
    expect(originalContext).toMatchObject({ auth_channel: 'human-mcp', tenant_id: 'Steven', actor_alias: account.alias });
    expect(originalContext.auth_session_id).toEqual(expect.stringMatching(/^human-mcp:/u));
    await finishRoot(receipt.message_id);
    await databasePool().query('UPDATE console_users SET display_name=$2 WHERE id=$1', [account.humanId, 'Renamed operator']);
    const renewed = await operations(account);
    expect(await renewed.receipt(receipt.message_id)).toMatchObject({ chain_open: false });
    expect(await renewed.submit(command)).toEqual(receipt);
    expect(await publishedContext(receipt.message_id)).toEqual(originalContext);
    expect(await counts(account)).toMatchObject({ ...durableEffect, prepares: 1, confirms: 1 });
  });

  it('returns terminal 410 before an effect and requires a new key without reviving the old intent', async () => {
    const account = await seedHumanPublishActor();
    const command = submitCommand();
    expect(await failureOf((await operations(account, 'prepare')).submit(command))).toEqual(interrupted);
    const key = await preparedKey(account, command.request_key);
    await agePrepare(account, command.request_key);
    const expired = { status_code: 410, version: 1, error: 'publish_intent_expired', state: 'expired',
      idempotency_key: key, safe_to_resubmit: true };
    const renewed = await operations(account);
    expect(await failureOf(renewed.submit(command))).toEqual(expired);
    expect(await failureOf(renewed.submit(command))).toEqual(expired);
    expect(await counts(account)).toMatchObject({ messages: 0, idempotency: 0, prepares: 1 });
    const replacement = await renewed.submit({ ...command, request_key: randomUUID() });
    expect(replacement.idempotency_key).not.toBe(key);
    expect(await failureOf(renewed.submit(command))).toEqual(expired);
    expect(await preparedKey(account, command.request_key)).toBe(key);
    expect(await counts(account)).toEqual({ ...durableEffect, prepares: 2, confirms: 1, expirations: 1 });
  });

  it.each(['unconfirmed', 'confirmed'] as const)('recovers a %s effect after its prepare timestamp expires', async (state) => {
    const account = await seedHumanPublishActor();
    const command = submitCommand();
    if (state === 'unconfirmed') {
      expect(await failureOf((await operations(account, 'publish')).submit(command))).toEqual(interrupted);
    } else {
      await (await operations(account)).submit(command);
    }
    const key = await preparedKey(account, command.request_key);
    const before = await databasePool().query<{ message_id: string }>(
      'SELECT message_id FROM idempotency_keys WHERE tenant_id=$1 AND actor_alias=$2 AND idempotency_key=$3',
      ['Steven', account.alias, key],
    );
    const messageId = before.rows[0]?.message_id;
    expect(messageId).toEqual(expect.any(String));
    await agePrepare(account, command.request_key);
    const renewed = await operations(account);
    const recovered = await renewed.submit(command);
    expect(recovered).toMatchObject({ idempotency_key: key, message_id: messageId });
    expect(await renewed.submit(command)).toEqual(recovered);
    expect(await counts(account)).toEqual({ ...durableEffect, prepares: 1, confirms: 1, expirations: 0 });
  });

  it('rejects inconsistent content for an existing key without adding an effect', async () => {
    const account = await seedHumanPublishActor();
    const command = submitCommand();
    const renewed = await operations(account);
    const receipt = await renewed.submit(command);
    expect(await failureOf(renewed.submit({ ...command, body: { text: 'different meaning' } })))
      .toMatchObject({ status_code: 409, error: 'operation_conflict' });
    expect(await renewed.submit(command)).toEqual(receipt);
    expect(await counts(account)).toEqual({ ...durableEffect, prepares: 1, confirms: 1, expirations: 0 });
  });

  it('keeps default console reload coalescing for identical content under different nonces', async () => {
    const account = await seedHumanPublishActor();
    const intent = consoleIntent(account);
    const first = await getRepository().prepareConsolePublishIntent(intent, HUMAN_PUBLISH_SCOPE);
    const second = await getRepository().prepareConsolePublishIntent({ ...intent, intent_nonce: randomUUID() }, HUMAN_PUBLISH_SCOPE);
    expect(second).toEqual(first);
    expect(await counts(account)).toMatchObject({ prepares: 1, messages: 0, idempotency: 0 });
  });

  it.each(['account', 'room', 'cross-tenant ACL'] as const)('requires current %s authority to recover an aged committed intent', async (revocation) => {
    const account = await seedHumanPublishActor();
    const command = submitCommand(revocation === 'cross-tenant ACL'
      ? { recipients: [{ tenant_id: 'Isa', alias: 'salva' }] } : {});
    const receipt = await (await operations(account)).submit(command);
    await agePrepare(account, command.request_key);
    const renewed = await operations(account);
    if (revocation === 'account') {
      await databasePool().query('UPDATE console_users SET active=false WHERE id=$1', [account.humanId]);
    } else if (revocation === 'room') {
      await databasePool().query("UPDATE memberships SET enabled=false WHERE tenant_id='Steven' AND room_id='grp.steven' AND alias=$1", [account.alias]);
    } else {
      await databasePool().query("UPDATE acl_edges SET enabled=false WHERE from_tenant='Steven' AND to_tenant='Isa'");
    }
    expect(await failureOf(renewed.submit(command))).toMatchObject({ status_code: revocation === 'account' ? 401 : revocation === 'room' ? 400 : 403 });
    expect(await counts(account)).toMatchObject({ ...durableEffect, prepares: 1, confirms: 1, expirations: 0 });
    expect((await publishedContext(receipt.message_id)).actor_alias).toBe(account.alias);
  });
});
