import { z } from 'zod';

const Commit = z.string().regex(/^[a-f0-9]{40,64}$/u);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Company = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
export const ContextRetirementPreviewRequestSchema = z.object({
  company_id: Company, action: z.enum(['retire', 'restore']), retirement_commit: Commit.optional(),
}).strict().refine(value => value.action === 'restore' ? value.retirement_commit !== undefined : value.retirement_commit === undefined);
export const ContextRetirementPreviewSchema = z.object({
  version: z.literal(1), company_id: Company, action: z.enum(['retire', 'restore']),
  head: Commit, remote_head: z.union([Commit, z.literal('')]), tree_oid: Commit,
  entry_count: z.number().int().nonnegative(), logical_bytes: z.number().int().nonnegative(),
  db_pin_sha256: Digest, can_apply: z.boolean(), blockers: z.array(z.string().max(128)),
  retirement_commit: Commit.optional(), preview_sha256: Digest,
}).strict();
export const ContextRetirementApplySchema = z.object({
  company_id: Company, expected_head: Commit, preview_sha256: Digest,
  operation_id: z.uuid(), retirement_commit: Commit.optional(),
}).strict();
export const ContextRetirementReceiptSchema = z.object({
  version: z.literal(1), operation_id: z.uuid(), company_id: Company, action: z.enum(['retire', 'restore']),
  before_head: Commit, commit: Commit, tree_oid: Commit, preview_sha256: Digest,
  entry_count: z.number().int().nonnegative(), logical_bytes: z.number().int().nonnegative(),
  pushed: z.boolean(), idempotent_replay: z.boolean(), retirement_commit: Commit.optional(),
}).strict();
export type ContextRetirementPreviewRequest = z.infer<typeof ContextRetirementPreviewRequestSchema>;
export type ContextRetirementPreview = z.infer<typeof ContextRetirementPreviewSchema>;
export type ContextRetirementApply = z.infer<typeof ContextRetirementApplySchema>;
export type ContextRetirementReceipt = z.infer<typeof ContextRetirementReceiptSchema>;
