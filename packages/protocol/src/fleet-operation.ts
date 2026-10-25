import { z } from 'zod';
import { RESERVED_ALIAS_MESSAGE, isReservedAlias } from './patterns.js';
import { AliasSchema, TenantSchema, Sha256HexSchema } from './schemas/core.js';
import { ConfigurationDependencySchema } from './configuration-identity.js';
import {
  AgentExtensionsSchema, ExtensionPreparationReceiptSchema, ExtensionsAllowedSchema, agentExtensionsHarnessViolation,
} from './agent-extensions.js';

export const RuntimeKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const IdentifierSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const ReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const LEGACY_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function supportsReasoningEffort(harness: string, effort: string | null | undefined): boolean {
  if (effort == null) return true;
  const supported: readonly string[] = harness === 'muse' ? ReasoningEffortSchema.options
    : harness === 'codex' || harness === 'openclaw' ? LEGACY_EFFORTS
    : harness === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : [];
  return supported.includes(effort);
}
const DirectorySchema = z.string().min(2).max(512).regex(/^\/(?!.*(?:\/\/|(?:^|\/)\.\.?\/))[^\p{Cc}]+$/u)
  .refine((value) => !/(?:^|\/)\.\.?$/u.test(value));
export const FleetPlacementSchema = z.object({
  host_id: IdentifierSchema, mode: z.enum(['container', 'native']),
  container_name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/).optional(),
  runtime_user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),
  home_directory: DirectorySchema, state_directory: DirectorySchema,
  systemd_user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).optional(),
}).strict().refine((value) => value.mode !== 'container' || value.container_name !== undefined);

export const FleetTargetSchema = z.discriminatedUnion('resource', [
  z.object({ resource: z.literal('agent'), tenant_id: TenantSchema, alias: AliasSchema }).strict(),
  z.object({ resource: z.literal('room'), tenant_id: TenantSchema, room_id: z.string().min(1).max(128) }).strict(),
  z.object({ resource: z.literal('tenant'), tenant_id: TenantSchema }).strict(),
]);
const AgentTargetSchema = FleetTargetSchema.options[0];
const AgentParametersSchema = z.object({
  runtime_key: RuntimeKeySchema, harness_id: IdentifierSchema,
  display_name: z.string().trim().min(1).max(128).nullable().optional(),
  primary_room_id: z.string().min(1).max(128),
  memberships: z.array(z.object({ room_id: z.string().min(1).max(128), role: z.string().trim().min(1).max(64).regex(/^[^\p{Cc}]+$/u), enabled: z.boolean().optional() }).strict()).min(1).max(100),
  placement: FleetPlacementSchema,
  primary_account_id: IdentifierSchema.nullable().optional(),
  model_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,127}$/).nullable().optional(),
  reasoning_effort: ReasoningEffortSchema.nullable().optional(),
  extensions: AgentExtensionsSchema.optional(),
}).strict().refine((value) => {
  const rooms = value.memberships.map((membership) => membership.room_id);
  return new Set(rooms).size === rooms.length && rooms.includes(value.primary_room_id)
    && supportsReasoningEffort(value.harness_id, value.reasoning_effort)
    && (value.placement.mode === 'container' || (value.extensions?.length ?? 0) === 0)
    && agentExtensionsHarnessViolation(value.extensions ?? [], value.harness_id) === undefined;
});
const RequestBase = {
  expected_revision: z.number().int().nonnegative(),
  idempotency_key: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/),
};
export const FleetRecoveryIdentitySchema = z.object({
  generation: Sha256HexSchema, container_id: Sha256HexSchema, writer_instance_id: z.uuid(),
}).strict();
const FleetRecoveryParametersSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('probe') }).strict(),
  z.object({ action: z.literal('apply'), expected_fingerprint: Sha256HexSchema,
    force: z.boolean(), identity: FleetRecoveryIdentitySchema }).strict(),
]);
export const FleetOperationRequestSchema = z.union([
  z.object({ ...RequestBase, kind: z.enum(['create', 'update']), target: AgentTargetSchema, parameters: AgentParametersSchema }).strict()
    .superRefine((request, context) => {
      if (request.kind !== 'create') return;
      if (isReservedAlias(request.target.alias)) context.addIssue({ code: 'custom', path: ['target', 'alias'], message: RESERVED_ALIAS_MESSAGE });
      if (isReservedAlias(request.parameters.runtime_key)) context.addIssue({ code: 'custom', path: ['parameters', 'runtime_key'], message: RESERVED_ALIAS_MESSAGE });
    }),
  z.object({ ...RequestBase, kind: z.enum(['start', 'stop']), target: AgentTargetSchema, parameters: z.object({}).strict() }).strict(),
  z.object({ ...RequestBase, kind: z.enum(['retire', 'restore', 'purge']), target: FleetTargetSchema,
    parameters: z.object({ confirm_alias: z.string().optional() }).strict() }).strict(),
  z.object({ ...RequestBase, kind: z.literal('recover'), target: AgentTargetSchema, parameters: FleetRecoveryParametersSchema }).strict(),
]);
// Persisted requests keep their original shape and hash; only new submissions require confirmation.
export const FleetOperationSubmissionSchema = z.union([
  FleetOperationRequestSchema.options[0], FleetOperationRequestSchema.options[1],
  FleetOperationRequestSchema.options[2].extend({ kind: z.enum(['retire', 'restore']), parameters: z.object({}).strict() }),
  FleetOperationRequestSchema.options[2].extend({ kind: z.literal('purge'), target: AgentTargetSchema,
    parameters: z.object({ confirm_alias: z.string() }).strict() }).superRefine((request, context) => {
    if (request.parameters.confirm_alias !== request.target.alias) {
      context.addIssue({ code: 'custom', path: ['parameters', 'confirm_alias'], message: 'confirm_alias must exactly match target.alias' });
    }
  }),
  FleetOperationRequestSchema.options[2].extend({ kind: z.literal('purge'),
    target: z.union([FleetTargetSchema.options[1], FleetTargetSchema.options[2]]), parameters: z.object({}).strict() }),
  FleetOperationRequestSchema.options[3],
]);
export const FleetOperationControlSchema = z.object({ expected_version: z.number().int().nonnegative() }).strict();
export const FleetOperationRecentQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();
export type FleetOperationRecentQuery = z.infer<typeof FleetOperationRecentQuerySchema>;
export const FleetOperationStatusSchema = z.enum(['queued', 'running', 'awaiting_auth', 'cancelling', 'cancelled', 'failed', 'succeeded']);
export const AgentLifecycleSchema = z.enum(['draft', 'provisioning', 'auth_pending', 'verifying', 'ready', 'failed', 'retiring', 'retired']);
export const FleetStepNameSchema = z.enum(['prepare', 'artifacts', 'credentials', 'runtime', 'authenticate', 'profile', 'verify', 'admission', 'fence', 'stop', 'revoke', 'purge']);
export const FleetEvidenceSchema = z.object({
  recovery: z.object({ identity: FleetRecoveryIdentitySchema,
    session: z.object({ type: z.literal('session'),
      state: z.enum(['present', 'absent', 'resumed', 'recreated', 'unsupported', 'conflict', 'failed']),
      resumable: z.boolean(), fingerprint: Sha256HexSchema.nullable(),
      reason: z.string().min(1).max(500).regex(/^[^\p{Cc}]+$/u),
    }).strict(), strategy: z.literal('shared_tui'), preserves_conversation: z.literal(true), recreates_container: z.literal(false),
  }).strict().optional(),
  recovery_compensated: z.boolean().optional(),
  extensions_receipt: ExtensionPreparationReceiptSchema.optional(),
  artifact_sha256: Sha256HexSchema.optional(), runtime_digest: Sha256HexSchema.optional(),
  certificate_fingerprint: Sha256HexSchema.optional(), authority_verified: z.boolean().optional(),
  provider_verified: z.boolean().optional(), hello_verified: z.boolean().optional(),
  bootstrap_verified: z.boolean().optional(),
  profile_verified: z.boolean().optional(), roundtrip_verified: z.boolean().optional(),
  stopped_verified: z.boolean().optional(), revocation_verified: z.boolean().optional(),
  native_decommissioned: z.boolean().optional(),
  removed: z.array(z.object({
    type: z.enum(['container', 'volume', 'directory', 'network', 'unit', 'file']), name: z.string().min(1).max(512),
  }).strict()).max(51_200).optional(),
}).strict();
export const FleetStepSchema = z.object({
  name: FleetStepNameSchema, status: z.enum(['pending', 'running', 'waiting', 'succeeded', 'failed', 'compensated']),
  evidence: FleetEvidenceSchema.optional(),
}).strict();
export const FleetRecoveryReasonSchema = z.enum(['runtime_mounts_differ', 'shared_tui_disabled',
  'harness_unsupported', 'runtime_without_shared_tui']);
export const FleetExecutionReasonSchema = z.enum([...FleetRecoveryReasonSchema.options,
  'runtime_identity_mismatch', 'runtime_security_mismatch', 'runtime_bundle_changed',
  'runtime_stop_unverified', 'provider_functional_proof_failed']);
export type FleetExecutionReason = z.infer<typeof FleetExecutionReasonSchema>;
export const FleetErrorSchema = z.object({
  code: z.enum(['AUTHORITY_REVOKED', 'REVISION_CONFLICT', 'HOST_UNAVAILABLE', 'DEPENDENCIES_PRESENT',
    'STEP_FAILED', 'PROVIDER_AUTH_REQUIRED', 'RUNTIME_DRIFT', 'UNSUPPORTED_RUNTIME', 'VERIFICATION_FAILED', 'CANCELLED']),
  step: FleetStepNameSchema.optional(), retryable: z.boolean(), reason: FleetExecutionReasonSchema.optional(),
}).strict();
/**
 * The physical resources a purge plans to touch, computed by the server with the executor's rules. It is the plan,
 * not the outcome: the executor only removes what exists with the expected ownership labels. The `purge` step
 * evidence field `removed` lists the resources that removal actually deleted.
 */
export const FleetPurgeResourceSchema = z.object({
  type: z.enum(['container', 'volume', 'directory', 'network', 'unit', 'file']), name: z.string().min(1).max(512),
  action: z.enum(['delete', 'keep']), reason: z.string().min(1).max(256),
}).strict();
export const FleetOperationPreviewSchema = z.object({
  request_sha256: Sha256HexSchema,
  expected_revision: z.number().int().nonnegative(), target: FleetTargetSchema,
  kind: z.enum(['create', 'update', 'start', 'stop', 'retire', 'restore', 'purge', 'recover']),
  steps: z.array(FleetStepNameSchema), dependencies: z.array(ConfigurationDependencySchema), can_apply: z.boolean(),
  resources: z.array(FleetPurgeResourceSchema).max(16).default([]),
}).strict();
export const FleetOperationSchema = z.object({
  request_sha256: Sha256HexSchema,
  id: z.uuid(), status: FleetOperationStatusSchema, version: z.number().int().nonnegative(),
  target: FleetTargetSchema, kind: FleetOperationPreviewSchema.shape.kind,
  actor: z.object({ tenant_id: TenantSchema, alias: AliasSchema, actor_subject: z.string().min(1).max(256).optional() }).strict(),
  expected_revision: z.number().int().nonnegative(),
  desired_revision: z.number().int().nonnegative().nullable(),
  applied_revision: z.number().int().nonnegative().nullable(),
  steps: z.array(FleetStepSchema), error: FleetErrorSchema.nullable(),
  created_at: z.iso.datetime({ offset: true }), updated_at: z.iso.datetime({ offset: true }),
}).strict();
export type FleetOperationRequest = z.infer<typeof FleetOperationRequestSchema>;
export type FleetOperation = z.infer<typeof FleetOperationSchema>;
export type FleetPurgeResource = z.infer<typeof FleetPurgeResourceSchema>;
export type FleetOperationPreview = z.infer<typeof FleetOperationPreviewSchema>;
export type FleetTarget = z.infer<typeof FleetTargetSchema>;
export type FleetStepName = z.infer<typeof FleetStepNameSchema>;
export type FleetEvidence = z.infer<typeof FleetEvidenceSchema>;
export type FleetError = z.infer<typeof FleetErrorSchema>;

export const FleetRuntimeCapabilitySchema = z.object({
  mode: z.enum(['container', 'native']), harness_id: IdentifierSchema, provider: IdentifierSchema,
  runtime_user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),
  systemd_user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).nullable().optional(),
  home_directory: DirectorySchema, state_root: DirectorySchema,
  container_name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/).optional(),
  container_prefix: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/).optional(),
  reasoning_efforts: z.array(ReasoningEffortSchema).optional(),
}).strict().refine(value => value.mode === 'container'
  ? (value.container_name !== undefined) !== (value.container_prefix !== undefined)
  : value.container_name === undefined && value.container_prefix === undefined)
  .refine(value => value.reasoning_efforts?.every(effort => supportsReasoningEffort(value.harness_id, effort)) !== false);
export const FleetCapabilitySchema = z.object({
  available: z.boolean(),
  actions: z.array(FleetOperationPreviewSchema.shape.kind),
  placements: z.array(z.object({
    host_id: IdentifierSchema, modes: z.array(z.enum(['container', 'native'])).min(1),
    runtime_users: z.array(z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/)).min(1),
    systemd_users: z.array(z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/)),
    home_roots: z.array(DirectorySchema).min(1), state_roots: z.array(DirectorySchema).min(1),
    runtimes: z.array(FleetRuntimeCapabilitySchema).max(1000).optional(),
    extensions_allowed: ExtensionsAllowedSchema.optional(),
  }).strict()),
  reason: z.enum(['executor_unconfigured', 'unsupported_schema']).optional(),
}).strict().refine((value) => value.available || (value.actions.length === 0 && value.placements.length === 0));
export type FleetCapability = z.infer<typeof FleetCapabilitySchema>;

export function matchingFleetRuntime(capability: FleetCapability, request: FleetOperationRequest, provider?: string) {
  if (request.kind !== 'create' && request.kind !== 'update') return undefined;
  const { parameters } = request;
  const { placement, runtime_key } = parameters;
  const host = capability.placements.find(candidate => candidate.host_id === placement.host_id);
  return host?.runtimes?.find(runtime => (provider === undefined || runtime.provider === provider)
    && runtime.mode === placement.mode && runtime.harness_id === parameters.harness_id
    && runtime.runtime_user === placement.runtime_user && (runtime.systemd_user ?? null) === (placement.systemd_user ?? null)
    && runtime.home_directory === placement.home_directory
    && placement.state_directory === `${runtime.state_root.replace(/\/$/u, '')}/${runtime_key}`
    && (runtime.mode !== 'container' || placement.container_name === (runtime.container_name ?? `${runtime.container_prefix ?? ''}${runtime_key}`))
    && supportsReasoningEffort(parameters.harness_id, parameters.reasoning_effort)
    && (parameters.reasoning_effort == null || runtime.reasoning_efforts?.includes(parameters.reasoning_effort) === true));
}
