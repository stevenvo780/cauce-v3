import { z } from 'zod';
import { AliasSchema, TenantSchema } from './schemas/core.js';
import { FleetEvidenceSchema, FleetRecoveryReasonSchema } from './fleet-operation.js';

export { FleetExecutionReasonSchema, FleetRecoveryReasonSchema, type FleetExecutionReason } from './fleet-operation.js';
export const FleetRecoveryPreflightSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), recovery: FleetEvidenceSchema.shape.recovery.unwrap() }).strict(),
  z.object({ status: z.literal('update_required'), reason_code: z.enum(['runtime_mounts_differ', 'runtime_without_shared_tui']),
    reason: z.string().min(1).max(500).regex(/^[^\p{Cc}]+$/u), next_action: z.literal('update') }).strict(),
  z.object({ status: z.literal('unsupported'),
    reason_code: z.enum(['shared_tui_disabled', 'harness_unsupported', 'runtime_without_shared_tui', 'executor_unavailable']),
    reason: z.string().min(1).max(500).regex(/^[^\p{Cc}]+$/u), next_action: z.literal('stop_start') }).strict(),
]);
const Preview = { tenant_id: TenantSchema, alias: AliasSchema, transport: z.literal('fleet'),
  expected_revision: z.number().int().nonnegative(), in_flight: z.number().int().nonnegative() };
export const FleetRecoveryPreviewSchema = z.discriminatedUnion('status', [
  FleetRecoveryPreflightSchema.options[0].extend(Preview), FleetRecoveryPreflightSchema.options[1].extend(Preview),
  FleetRecoveryPreflightSchema.options[2].extend(Preview),
]);
export type FleetRecoveryReason = z.infer<typeof FleetRecoveryReasonSchema>;
export type FleetRecoveryPreflight = z.infer<typeof FleetRecoveryPreflightSchema>;
export type FleetRecoveryPreview = z.infer<typeof FleetRecoveryPreviewSchema>;
