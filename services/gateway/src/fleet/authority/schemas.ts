import { z } from 'zod';
import { RuntimeKeySchema } from '@cauce/protocol';

export const AuthorityDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const AuthorityHostSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
export const RuntimeAuthorityRequestSchema = z.object({ action: z.literal('resolve_runtime_authority'),
  certificate_sha256: AuthorityDigestSchema }).strict();
export const RuntimeAuthoritySchema = z.object({ identity: z.object({ host_id: AuthorityHostSchema,
  runtime_key: RuntimeKeySchema, tenant_id: z.string(), alias: z.string(), expires_at: z.iso.datetime(),
}).strict().nullable() }).strict();
export const AuthorityScopeSchema = z.object({
  operation_id: z.uuidv4(), host_id: AuthorityHostSchema, scope_sha256: AuthorityDigestSchema,
  runtime_key: RuntimeKeySchema, claim_epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  worker_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u), claim_token: z.uuidv4(),
  prepared_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const AuthorityIdSchema = z.enum(['base_mtls', 'base_token', 'fleet_mtls', 'fleet_token', 'pty']);
function completeAuthorities(rows: { id: string }[]): boolean {
  const ids = new Set(rows.map(row => row.id));
  return ids.size === rows.length && ['base_mtls', 'base_token', 'fleet_mtls', 'fleet_token'].every(id => ids.has(id));
}
export const AuthorityInventoryPinsSchema = z.array(z.object({ id: AuthorityIdSchema, sha256: AuthorityDigestSchema }).strict())
  .min(4).max(5).refine(completeAuthorities);
export const AuthorityInventorySchema = z.object({ authorities: z.array(z.object({
  id: AuthorityIdSchema, sha256: AuthorityDigestSchema,
  matching_records: z.array(z.record(z.string(), z.unknown())).max(64),
  preserved: z.literal(true).optional(),
}).strict().refine(row => row.preserved === undefined || row.id.startsWith('base_') || row.id === 'pty')).min(4).max(5)
  .refine(completeAuthorities) }).strict();
export const AuthorityIssueSchema = z.object({
  phase: z.enum(['bootstrap', 'normal']), csr_pem: z.string().min(1).max(16_384), csr_sha256: AuthorityDigestSchema,
  idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
}).strict();
export const AuthorityIssuedSchema = z.object({
  certificate_pem: z.string().min(1).max(16_384), ca_pem: z.string().min(1).max(16_384),
  token: AuthorityDigestSchema, certificate_sha256: AuthorityDigestSchema, token_sha256: AuthorityDigestSchema,
  expires_at: z.iso.datetime(),
}).strict();
export const TerminalIssueSchema = AuthorityIssueSchema.omit({ phase: true });
export const TerminalGrantSchema = z.object({
  certificate_pem: z.string().min(1).max(16_384), ca_pem: z.string().min(1).max(16_384),
  certificate_sha256: AuthorityDigestSchema, expires_at: z.iso.datetime(), alias_key_hex: AuthorityDigestSchema,
  grant_id: AuthorityDigestSchema, relay_host: z.string().regex(/^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])$/u),
  relay_port: z.number().int().min(1).max(65_535), relay_server_name: z.string().regex(/^[A-Za-z0-9.:-]+$/u).optional(),
}).strict();
export const TerminalRevocationSchema = z.object({ grant_id: AuthorityDigestSchema,
  certificate_sha256: AuthorityDigestSchema }).strict();
export const TerminalRevokedSchema = TerminalRevocationSchema.extend({ revoked: z.literal(true) });
export const TerminalReceiptSchema = z.object({ grant: TerminalGrantSchema.nullable(), registered: z.boolean(), revoked: z.boolean() }).strict();
export const AuthorityRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('inventory'), scope: AuthorityScopeSchema }).strict(),
  z.object({ action: z.literal('verify_absent'), scope: AuthorityScopeSchema }).strict(),
  z.object({ action: z.literal('revoke'), scope: AuthorityScopeSchema, expected_inventory: AuthorityInventoryPinsSchema }).strict(),
  AuthorityIssueSchema.extend({ action: z.literal('issue'), scope: AuthorityScopeSchema }),
  TerminalIssueSchema.extend({ action: z.literal('issue_terminal'), scope: AuthorityScopeSchema }),
  TerminalIssueSchema.extend({ action: z.literal('terminal_receipt'), scope: AuthorityScopeSchema }),
  TerminalRevocationSchema.extend({ action: z.literal('revoke_terminal'), scope: AuthorityScopeSchema }),
]);
export type AuthorityScope = z.infer<typeof AuthorityScopeSchema>;
export type AuthorityRequest = z.infer<typeof AuthorityRequestSchema>;
export type AuthorityIssue = z.infer<typeof AuthorityIssueSchema>;
export type AuthorityInventory = z.infer<typeof AuthorityInventorySchema>;
export type AuthorityIssued = z.infer<typeof AuthorityIssuedSchema>;
export type AuthorityInventoryPins = z.infer<typeof AuthorityInventoryPinsSchema>;
export type TerminalIssue = z.infer<typeof TerminalIssueSchema>;
export type TerminalRevocation = z.infer<typeof TerminalRevocationSchema>;
export class FleetAuthorityError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'AUTHORITY_REVOKED' | 'AUTHORITY_UNAVAILABLE') {
    super(`Fleet authority ${code}`); this.name = 'FleetAuthorityError';
  }
}
