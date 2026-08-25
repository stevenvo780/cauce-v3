import { randomUUID } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import {
  isSystemGateProbeBody, NON_HUMAN_DELIVERY_MESSAGE_TYPES, SYSTEM_PRINCIPAL_ALIASES,
  type PublishMessage,
} from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '@cauce/store';

function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  const nonce = '0123456789abcdef0123456789abcdef';
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `gate-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'kant' }],
    body: { type: 'system.gate.probe', nonce, timeout_ms: 5_000 },
    idempotency_key: `gate:Steven:kant:${nonce}`,
    authenticated_context: { session_id: 'gate-probe', channel: 'gate' },
    lane: 'interactive',
    priority: -100,
    ...overrides,
  };
}

describe('reserved system gate probe authority', () => {
  test('recognizes only the exact body and classifies it outside the human admission band', () => {
    expect(isSystemGateProbeBody(command().body)).toBe(true);
    expect(isSystemGateProbeBody({ ...command().body, text: 'not canonical' })).toBe(false);
    expect(NON_HUMAN_DELIVERY_MESSAGE_TYPES).toContain('system.gate.probe');
    expect(SYSTEM_PRINCIPAL_ALIASES).toEqual(['gate-probe', 'quota-collector']);
  });

  test('store rejects forged gate authority before opening a transaction', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const repository = new CauceRepository({ query } as unknown as DatabasePool);
    for (const forged of [
      command({ actor_alias: 'quota-collector' }),
      command({ authenticated_context: { session_id: 'gate-probe', channel: 'adapter' } }),
      command({ priority: 0 }),
      command({ recipients: [{ tenant_id: 'Steven', alias: 'kant' }, { tenant_id: 'Steven', alias: 'argos' }] }),
    ]) {
      await expect(repository.publish(forged)).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(query).not.toHaveBeenCalled();
  });
});
