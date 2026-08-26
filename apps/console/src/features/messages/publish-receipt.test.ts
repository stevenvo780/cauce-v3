import { describe, expect, it } from 'vitest';
import {
  exactConfirmedPublishIntent, exactPreparedPublishIntent, exactPublishReceipt,
} from './publish-receipt';

const exact = {
  message_id: 'a0000000-0000-4000-8000-000000000001',
  delivery_ids: ['b0000000-0000-4000-8000-000000000001'],
  duplicate: false,
  request_id: 'c0000000-0000-4000-8000-000000000001',
  trace_id: 'trace-1',
  idempotency_key: 'publish-this-request',
  tenant_id: 'Steven',
  actor_alias: 'kant',
  request_hash: 'a'.repeat(64),
  causal_hash: 'b'.repeat(64),
};
const subject = 'Steven:kant';

describe('exact publish receipt', () => {
  it('requires one distinct durable delivery for every requested recipient', () => {
    expect(exactPublishReceipt(exact, 1, exact.idempotency_key, subject)).toBe(true);
    expect(exactPublishReceipt({ ...exact, delivery_ids: [] }, 1, exact.idempotency_key, subject)).toBe(false);
    expect(exactPublishReceipt({
      ...exact, delivery_ids: [exact.delivery_ids[0], exact.delivery_ids[0]],
    }, 2, exact.idempotency_key, subject)).toBe(false);
    expect(exactPublishReceipt(exact, 2, exact.idempotency_key, subject)).toBe(false);
  });

  it('accepts historical deterministic UUIDv5 request ids while effect ids remain UUIDv4', () => {
    const deterministicRequestId = 'c0000000-0000-5000-8000-000000000001';
    expect(exactPublishReceipt(
      { ...exact, request_id: deterministicRequestId }, 1, exact.idempotency_key, subject,
    )).toBe(true);
    expect(exactPublishReceipt(
      { ...exact, request_id: deterministicRequestId.toUpperCase() },
      1,
      exact.idempotency_key,
      subject,
    )).toBe(true);
    expect(exactPublishReceipt(
      { ...exact, message_id: exact.message_id.replace(/-4/u, '-5') },
      1,
      exact.idempotency_key,
      subject,
    )).toBe(false);
  });

  it('accepts only the exact prepared or committed server-journal envelope', () => {
    const prepared = {
      version: 1, state: 'prepared', idempotency_key: exact.idempotency_key, receipt: null,
    };
    const committed = {
      version: 1, state: 'committed', idempotency_key: exact.idempotency_key, receipt: exact,
    };
    expect(exactPreparedPublishIntent(prepared, 1, subject)).toBe(true);
    expect(exactPreparedPublishIntent(committed, 1, subject)).toBe(true);
    expect(exactPreparedPublishIntent({ ...prepared, extra: true }, 1, subject)).toBe(false);
    expect(exactPreparedPublishIntent({ ...prepared, receipt: exact }, 1, subject)).toBe(false);
    expect(exactPreparedPublishIntent({ ...committed, receipt: null }, 1, subject)).toBe(false);
    expect(exactPreparedPublishIntent({
      ...committed,
      receipt: { ...exact, idempotency_key: 'another-key' },
    }, 1, subject)).toBe(false);
  });

  it('accepts only a confirmation bound to the exact durable receipt', () => {
    const confirmation = {
      version: 1,
      confirmed: true,
      idempotency_key: exact.idempotency_key,
      message_id: exact.message_id,
      causal_hash: exact.causal_hash,
    };
    expect(exactConfirmedPublishIntent(confirmation, exact)).toBe(true);
    expect(exactConfirmedPublishIntent({ ...confirmation, extra: true }, exact)).toBe(false);
    expect(exactConfirmedPublishIntent({ ...confirmation, message_id: crypto.randomUUID() }, exact)).toBe(false);
    expect(exactConfirmedPublishIntent({ ...confirmation, confirmed: false }, exact)).toBe(false);
  });

  it('rejects a structurally valid receipt from another tenant, actor or request', () => {
    expect(exactPublishReceipt(exact, 1, 'another-publish', subject)).toBe(false);
    expect(exactPublishReceipt({
      ...exact, idempotency_key: 'another-publish',
    }, 1, exact.idempotency_key, subject)).toBe(false);
    expect(exactPublishReceipt({ ...exact, tenant_id: 'Pablo' }, 1, exact.idempotency_key, subject)).toBe(false);
    expect(exactPublishReceipt({ ...exact, actor_alias: 'argos' }, 1, exact.idempotency_key, subject)).toBe(false);
    expect(exactPublishReceipt(exact, 1, exact.idempotency_key, 'Pablo:midas')).toBe(false);
  });

  it('rejects extra keys, partial values and invalid durable-effect UUID case/version/variant', () => {
    expect(exactPublishReceipt({ message_id: exact.message_id }, 1, exact.idempotency_key, subject)).toBe(false);
    expect(exactPublishReceipt({ ...exact, extra: true }, 1, exact.idempotency_key, subject)).toBe(false);
    expect(exactPublishReceipt(null, 1, exact.idempotency_key, subject)).toBe(false);
    expect(exactPublishReceipt({ ...exact, request_id: null }, 1, exact.idempotency_key, subject)).toBe(false);
    expect(exactPublishReceipt({ ...exact, duplicate: null }, 1, exact.idempotency_key, subject)).toBe(false);
    expect(exactPublishReceipt({ ...exact, trace_id: '' }, 1, exact.idempotency_key, subject)).toBe(false);
    for (const messageId of [
      exact.message_id.toUpperCase(),
      exact.message_id.replace(/-4/u, '-7'),
      exact.message_id.replace(/-8/u, '-c'),
    ]) {
      expect(exactPublishReceipt(
        { ...exact, message_id: messageId }, 1, exact.idempotency_key, subject,
      ), messageId).toBe(false);
    }
    expect(exactPublishReceipt({
      ...exact, request_id: exact.request_id.replace(/-4/u, '-f'),
    }, 1, exact.idempotency_key, subject)).toBe(false);
    expect(exactPublishReceipt({
      ...exact, delivery_ids: [exact.delivery_ids[0].replace(/-8/u, '-f')],
    }, 1, exact.idempotency_key, subject)).toBe(false);
  });
});
