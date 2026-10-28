import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_TOLERANCE_MS = 10 * 60_000;
const HEX_DIGEST = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^[0-9]{1,16}$/u;

export interface WebhookSignatureInput {
  readonly secret: string;
  /** Raw `x-signature` header: `ts=<timestamp>,v1=<hex HMAC>`. */
  readonly signature: string | undefined;
  readonly requestId: string | undefined;
  /** The `data.id` query parameter of the notification. */
  readonly dataId: string | undefined;
  readonly nowMs?: number;
}

function signatureParts(header: string): { ts: string; v1: string } | undefined {
  const parts = new Map<string, string>();
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    parts.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  const ts = parts.get('ts');
  const v1 = parts.get('v1')?.toLowerCase();
  return ts === undefined || v1 === undefined ? undefined : { ts, v1 };
}

/** Mercado Pago sends seconds; a millisecond timestamp is accepted as well. */
function timestampMs(ts: string): number {
  const value = Number(ts);
  return ts.length > 11 ? value : value * 1000;
}

/** Manifest `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`; an absent request id drops its part, as the provider does. */
export function webhookManifest(dataId: string, requestId: string | undefined, ts: string): string {
  const id = /^[A-Za-z0-9]+$/u.test(dataId) ? dataId.toLowerCase() : dataId;
  return `id:${id};${requestId === undefined || requestId === '' ? '' : `request-id:${requestId};`}ts:${ts};`;
}

export function verifyWebhookSignature(input: WebhookSignatureInput): boolean {
  if (input.secret.length === 0 || input.signature === undefined || input.dataId === undefined || input.dataId.length === 0) return false;
  const parts = signatureParts(input.signature);
  if (parts === undefined || !TIMESTAMP.test(parts.ts) || !HEX_DIGEST.test(parts.v1)) return false;
  const age = Math.abs((input.nowMs ?? Date.now()) - timestampMs(parts.ts));
  if (!Number.isFinite(age) || age > WEBHOOK_TOLERANCE_MS) return false;
  const expected = createHmac('sha256', input.secret).update(webhookManifest(input.dataId, input.requestId, parts.ts)).digest();
  return timingSafeEqual(expected, Buffer.from(parts.v1, 'hex'));
}
