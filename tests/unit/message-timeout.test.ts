import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AuthenticatedPublishSchema, MAX_MESSAGE_TIMEOUT_MS, messageTimeoutMs, PublishMessageSchema
} from '@cauce/protocol';

function publish(body: Record<string, unknown>): Record<string, unknown> {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: 'trace-timeout',
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
    body,
    idempotency_key: 'idem-timeout'
  };
}

describe('body.timeout_ms como parte del contrato', () => {
  it('acepta un presupuesto declarado por mensaje', () => {
    expect(PublishMessageSchema.parse(publish({ text: 'hola', timeout_ms: 300_000 })).body)
      .toMatchObject({ timeout_ms: 300_000 });
    expect(PublishMessageSchema.parse(publish({ text: 'hola', timeout_ms: MAX_MESSAGE_TIMEOUT_MS }))
      .body).toMatchObject({ timeout_ms: MAX_MESSAGE_TIMEOUT_MS });
    // Without declaring it, it is still valid: the cap falls back to the configured default.
    expect(PublishMessageSchema.parse(publish({ text: 'hola' })).body).toEqual({ text: 'hola' });
  });

  /**
   * Before this patch the SDK rejected these same values, but only at EXECUTION time and with a
   * non-retryable error: a typo from the publisher was paid as a dead delivery instead of a 400
   * at the door.
   */
  it.each([
    0,
    -1,
    1.5,
    MAX_MESSAGE_TIMEOUT_MS + 1,
    '300000',
    null
  ])('rechaza un timeout_ms inválido en la puerta: %p', (timeout) => {
    expect(() => PublishMessageSchema.parse(publish({ text: 'hola', timeout_ms: timeout })))
      .toThrow(/timeout_ms/u);
    expect(() => AuthenticatedPublishSchema.parse({
      room_id: 'grp.steven',
      recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
      body: { text: 'hola', timeout_ms: timeout }
    })).toThrow(/timeout_ms/u);
  });

  it('lee el presupuesto de una fila ya persistida sin lanzar nunca', () => {
    expect(messageTimeoutMs({ timeout_ms: 60_000 })).toBe(60_000);
    expect(messageTimeoutMs({ text: 'sin declarar' })).toBeUndefined();
    // "I don't know" and "garbage" must yield the same result: the reaper runs over rows that
    // were written before this schema existed and cannot be broken by one of them.
    expect(messageTimeoutMs({ timeout_ms: 'pronto' })).toBeUndefined();
    expect(messageTimeoutMs({ timeout_ms: MAX_MESSAGE_TIMEOUT_MS + 1 })).toBeUndefined();
    expect(messageTimeoutMs(undefined)).toBeUndefined();
    expect(messageTimeoutMs('no soy un cuerpo')).toBeUndefined();
    expect(messageTimeoutMs([{ timeout_ms: 1 }])).toBeUndefined();
  });
});
