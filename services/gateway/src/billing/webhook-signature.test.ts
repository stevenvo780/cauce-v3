import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature, webhookManifest, WEBHOOK_TOLERANCE_MS } from './webhook-signature.js';

const SECRET = 'webhook-fixture-secret';
const NOW = 1_790_000_000_000;
const TS = String(NOW / 1000);

function signed(dataId: string, requestId: string | undefined, ts = TS, secret = SECRET): string {
  return `ts=${ts},v1=${createHmac('sha256', secret).update(webhookManifest(dataId, requestId, ts)).digest('hex')}`;
}

describe('Mercado Pago webhook signature', () => {
  it('accepts the HMAC of id, request id and timestamp', () => {
    expect(webhookManifest('ABC123', 'req-1', TS)).toBe(`id:abc123;request-id:req-1;ts:${TS};`);
    expect(verifyWebhookSignature({ secret: SECRET, signature: signed('abc123', 'req-1'), requestId: 'req-1', dataId: 'abc123', nowMs: NOW })).toBe(true);
    expect(verifyWebhookSignature({ secret: SECRET, signature: ` v1=${signed('abc123', undefined).split('v1=')[1] ?? ''} , ts=${TS}`,
      requestId: undefined, dataId: 'abc123', nowMs: NOW })).toBe(true);
  });

  it('rejects a tampered id, request id, digest or secret', () => {
    const signature = signed('abc123', 'req-1');
    expect(verifyWebhookSignature({ secret: SECRET, signature, requestId: 'req-1', dataId: 'abc124', nowMs: NOW })).toBe(false);
    expect(verifyWebhookSignature({ secret: SECRET, signature, requestId: 'req-2', dataId: 'abc123', nowMs: NOW })).toBe(false);
    expect(verifyWebhookSignature({ secret: SECRET, signature: signature.replace(/.$/u, c => (c === '0' ? '1' : '0')),
      requestId: 'req-1', dataId: 'abc123', nowMs: NOW })).toBe(false);
    expect(verifyWebhookSignature({ secret: SECRET, signature: signed('abc123', 'req-1', TS, 'other'), requestId: 'req-1', dataId: 'abc123', nowMs: NOW }))
      .toBe(false);
  });

  it('rejects a timestamp outside the ten minute window in either direction', () => {
    for (const offset of [WEBHOOK_TOLERANCE_MS + 1000, -(WEBHOOK_TOLERANCE_MS + 1000)]) {
      const ts = String(Math.floor((NOW - offset) / 1000));
      expect(verifyWebhookSignature({ secret: SECRET, signature: signed('abc123', 'req-1', ts), requestId: 'req-1', dataId: 'abc123', nowMs: NOW }))
        .toBe(false);
    }
    const recent = String(Math.floor((NOW - WEBHOOK_TOLERANCE_MS + 5000) / 1000));
    expect(verifyWebhookSignature({ secret: SECRET, signature: signed('abc123', 'req-1', recent), requestId: 'req-1', dataId: 'abc123', nowMs: NOW }))
      .toBe(true);
    const milliseconds = String(NOW - 1000);
    expect(verifyWebhookSignature({ secret: SECRET, signature: signed('abc123', 'req-1', milliseconds), requestId: 'req-1', dataId: 'abc123', nowMs: NOW }))
      .toBe(true);
  });

  it('rejects malformed or incomplete signatures', () => {
    for (const signature of [undefined, '', `ts=${TS}`, 'v1=' + 'a'.repeat(64), `ts=${TS},v1=zz`, `ts=abc,v1=${'a'.repeat(64)}`,
      `ts=${TS},v1=${'a'.repeat(62)}`]) {
      expect(verifyWebhookSignature({ secret: SECRET, signature, requestId: 'req-1', dataId: 'abc123', nowMs: NOW })).toBe(false);
    }
    expect(verifyWebhookSignature({ secret: SECRET, signature: signed('abc123', 'req-1'), requestId: 'req-1', dataId: undefined, nowMs: NOW })).toBe(false);
    expect(verifyWebhookSignature({ secret: '', signature: signed('abc123', 'req-1', TS, ''), requestId: 'req-1', dataId: 'abc123', nowMs: NOW })).toBe(false);
  });
});
