import { z } from 'zod';
import { ProviderAuthRequestSchema } from '../console/provider-auth.contracts.js';

export const HostActorSchema = z.object({
  subject: z.string().regex(/^console:[0-9a-f-]{36}$/u),
  tenant_id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
  alias: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
}).strict();
const actor = { actor: HostActorSchema };
const session = { ...actor, id: z.uuid() };
export const HostAuthRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), ...actor, request: ProviderAuthRequestSchema }).strict(),
  z.object({ action: z.enum(['get', 'verify', 'cancel', 'ticket']), ...session }).strict(),
  z.object({ action: z.literal('consume'), ...session, ticket: z.uuid() }).strict(),
  z.object({ action: z.literal('revoke'), operation_id: z.uuid() }).strict(),
  z.object({ action: z.literal('scope'), ...actor, operation_id: z.uuid() }).strict(),
]);
export const HostAuthAttachSchema = z.object({ type: z.literal('attach'), ...session }).strict();
export const HostAuthResizeSchema = z.object({ type: z.literal('resize'), cols: z.number().int().min(20).max(400),
  rows: z.number().int().min(5).max(200) }).strict();
export const HostAuthSnapshotSchema = z.object({
  session_id: z.uuid(), operation_id: z.uuid(), provider_id: ProviderAuthRequestSchema.shape.provider_id,
  account_id: ProviderAuthRequestSchema.shape.account_id, harness_id: ProviderAuthRequestSchema.shape.harness_id,
  host_id: ProviderAuthRequestSchema.shape.host_id, runtime_user: ProviderAuthRequestSchema.shape.runtime_user,
  profile_id: ProviderAuthRequestSchema.shape.profile_id, method: z.enum(['device', 'terminal']),
  status: z.enum(['opening', 'awaiting_login', 'verifying', 'authenticated', 'cancelled', 'expired', 'failed']),
  expires_at: z.iso.datetime(), cleanup_pending: z.boolean(),
  error: z.enum(['AUTHORITY_REVOKED', 'SESSION_CONFLICT', 'INVALID_REQUEST', 'HOST_UNAVAILABLE', 'STOP_UNCONFIRMED',
    'IDENTITY_MISMATCH', 'FUNCTIONAL_CHECK_FAILED', 'LOGIN_FAILED', 'SESSION_EXPIRED']).nullable(),
}).strict();
export const HostAuthTicketSchema = z.object({ ticket: z.uuid(), expires_at: z.iso.datetime() }).strict();
