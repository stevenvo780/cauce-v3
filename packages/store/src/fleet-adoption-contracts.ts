import { z } from 'zod';
import { AliasSchema, FleetPlacementSchema, RuntimeKeySchema, Sha256HexSchema, TenantSchema } from '@cauce/protocol';
import type { DatabaseClient } from './db.js';

const Identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
export const LegacyAdoptionTargetSchema = z.object({ tenant_id: TenantSchema, alias: AliasSchema }).strict();
export const LegacyAdoptionTargetsSchema = z.array(LegacyAdoptionTargetSchema).min(1).max(100)
  .refine(rows => new Set(rows.map(row => JSON.stringify(row))).size === rows.length);
export type LegacyAdoptionTarget = z.infer<typeof LegacyAdoptionTargetSchema>;
export const LegacyAdoptionFactsSchema = z.object({
  source: z.literal('measured'), target: LegacyAdoptionTargetSchema, runtime_key: RuntimeKeySchema,
  harness_id: Identifier, placement: FleetPlacementSchema,
  primary_account_id: Identifier.nullable(), account_provider: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u).nullable(), account_binding_approved: z.boolean(),
  physical_identity_sha256: Sha256HexSchema, supervisor_fenced: z.literal(true),
}).strict().refine(facts => facts.primary_account_id === null ? facts.account_provider === null && !facts.account_binding_approved
  : facts.account_provider !== null && facts.account_binding_approved);
export type LegacyAdoptionFacts = z.infer<typeof LegacyAdoptionFactsSchema>;
export const LEGACY_ADOPTION_FIELDS = ['host_id', 'runtime_mode', 'container_name', 'runtime_user',
  'home_directory', 'state_directory', 'systemd_user', 'primary_account_id'] as const;
export type LegacyAdoptionField = typeof LEGACY_ADOPTION_FIELDS[number];
const FieldSchema = z.enum(LEGACY_ADOPTION_FIELDS);
const ValuesSchema = z.object({
  host_id: z.string().nullable(), runtime_mode: z.string().nullable(), container_name: z.string().nullable(),
  runtime_user: z.string().nullable(), home_directory: z.string().nullable(), state_directory: z.string().nullable(),
  systemd_user: z.string().nullable(), primary_account_id: z.string().nullable(),
}).strict();
export type LegacyAdoptionValues = z.infer<typeof ValuesSchema>;
export const LegacyAdoptionBlockerSchema = z.object({
  target: LegacyAdoptionTargetSchema,
  code: z.enum(['agent_missing', 'not_legacy_baseline', 'retired_identity', 'runtime_identity_changed',
    'contradictory_field', 'membership_ambiguous', 'primary_membership_changed', 'account_not_authorized',
    'facts_unavailable', 'supervisor_not_fenced', 'active_fleet_cohort', 'active_delivery', 'active_context_job',
    'legacy_placement_unrepresentable']),
  field: FieldSchema.optional(),
}).strict();
export type LegacyAdoptionBlocker = z.infer<typeof LegacyAdoptionBlockerSchema>;
const RowSchema = z.object({ target: LegacyAdoptionTargetSchema, runtime_key: RuntimeKeySchema,
  before: ValuesSchema, patch: ValuesSchema.partial(), guard_sha256: Sha256HexSchema,
  facts_sha256: Sha256HexSchema,
}).strict();
export type LegacyAdoptionRow = z.infer<typeof RowSchema>;
export const LegacyAdoptionPreviewSchema = z.object({
  revision: z.number().int().nonnegative(), targets: LegacyAdoptionTargetsSchema,
  rows: z.array(RowSchema).max(100), blockers: z.array(LegacyAdoptionBlockerSchema).max(2000),
  can_apply: z.boolean(), plan_sha256: Sha256HexSchema,
}).strict();
export type LegacyAdoptionPreview = z.infer<typeof LegacyAdoptionPreviewSchema>;
export interface LegacyAdoptionActor {
  tenant_id: string; alias: string; subject: string;
  authorize(client: DatabaseClient): Promise<void>;
}
export interface LegacyAdoptionFence {
  measure(target: LegacyAdoptionTarget): Promise<unknown>;
  assertHeld(): Promise<void>;
}
export interface LegacyAdoptionProbe {
  withSupervisorFence<T>(targets: readonly LegacyAdoptionTarget[], work: (fence: LegacyAdoptionFence) => Promise<T>): Promise<T>;
}
export class LegacyAdoptionError extends Error {
  constructor(readonly code: 'invalid_input' | 'forbidden' | 'conflict' | 'unavailable',
    readonly blockers: readonly LegacyAdoptionBlocker[] = []) {
    super(`legacy fleet adoption ${code}`); this.name = 'LegacyAdoptionError';
  }
}
