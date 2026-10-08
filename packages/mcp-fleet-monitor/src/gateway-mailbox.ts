import { z } from 'zod';
import { AliasSchema, CanonicalUuidV4Schema, TenantSchema } from '@cauce/protocol';

export const MailboxInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u).optional(),
}).strict();
export type HumanMcpMailboxQuery = z.infer<typeof MailboxInputSchema>;
export const HumanMcpMailboxSchema = z.object({
  address: z.object({ tenant_id: TenantSchema, alias: AliasSchema }).strict(),
  label: z.string().min(1).max(128),
  items: z.array(z.object({
    delivery_id: CanonicalUuidV4Schema, message_id: CanonicalUuidV4Schema,
    stored_at: z.iso.datetime({ offset: true }),
    from: z.object({ tenant_id: TenantSchema, alias: AliasSchema }).strict(),
    text: z.string().max(16384), text_truncated: z.boolean(), state: z.literal('stored'),
  }).strict()).max(50),
  next_cursor: z.string().max(512).nullable(),
  untrusted_fields: z.tuple([z.literal('items[].text')]),
  reading_confirms_execution: z.literal(false),
}).strict();
export type HumanMcpMailbox = z.infer<typeof HumanMcpMailboxSchema>;
