import { z } from 'zod';

export const QuotaAuthFenceSchema = z.object({ id: z.uuid(), environment_id: z.uuid(), claim_token: z.uuid(),
  claim_epoch: z.number().int().positive(), worker_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u) }).strict();
const Base64 = z.string().max(87_384).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);
export const QuotaAuthCommandSchema = z.discriminatedUnion('type', [
  z.object({ id: z.uuid(), type: z.enum(['start','close','cancel','verify']) }).strict(),
  z.object({ id: z.uuid(), type: z.literal('input'), data: Base64.refine(value => Buffer.byteLength(value, 'base64') <= 4096) }).strict(),
  z.object({ id: z.uuid(), type: z.literal('resize'), cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) }).strict(),
]);
export const QuotaAuthEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('output'), sequence: z.number().int().positive(), data: Base64 }).strict(),
  z.object({ type: z.literal('result'), id: z.uuid(), ok: z.boolean() }).strict(),
]);
export const QuotaAuthPacketSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('register'), claim: QuotaAuthFenceSchema, expires_at: z.iso.datetime({ offset: true }),
    method: z.enum(['device','terminal']) }).strict(),
  z.object({ action: z.literal('exchange'), claim: QuotaAuthFenceSchema, events: z.array(QuotaAuthEventSchema).max(32) }).strict(),
]);
export const QuotaAuthExchangeSchema = z.object({ commands: z.array(QuotaAuthCommandSchema).max(32),
  output_sequence: z.number().int().nonnegative(), finished: z.boolean() }).strict();
export type QuotaAuthCommand = z.infer<typeof QuotaAuthCommandSchema>;
export type QuotaAuthEvent = z.infer<typeof QuotaAuthEventSchema>;
