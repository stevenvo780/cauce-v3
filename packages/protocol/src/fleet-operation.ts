import { z } from 'zod';
import { AliasSchema, TenantSchema, Sha256HexSchema } from './schemas/core.js';
import { ConfigurationDependencySchema } from './configuration-identity.js';

export const RuntimeKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const IdentifierSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
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
  reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
}).strict().refine((value) => {
  const rooms = value.memberships.map((membership) => membership.room_id);
  return new Set(rooms).size === rooms.length && rooms.includes(value.primary_room_id);
});
const RequestBase = {
  expected_revision: z.number().int().nonnegative(),
  idempotency_key: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/),
};
export const FleetOperationRequestSchema = z.union([
  z.object({ ...RequestBase, kind: z.enum(['create', 'update']), target: AgentTargetSchema, parameters: AgentParametersSchema }).strict(),
  z.object({ ...RequestBase, kind: z.enum(['start', 'stop']), target: AgentTargetSchema, parameters: z.object({}).strict() }).strict(),
  z.object({ ...RequestBase, kind: z.enum(['retire', 'restore', 'purge']), target: FleetTargetSchema, parameters: z.object({}).strict() }).strict(),
]);
export const FleetOperationControlSchema = z.object({ expected_version: z.number().int().nonnegative() }).strict();
export const FleetOperationStatusSchema = z.enum(['queued', 'running', 'awaiting_auth', 'cancelling', 'cancelled', 'failed', 'succeeded']);
export const AgentLifecycleSchema = z.enum(['draft', 'provisioning', 'auth_pending', 'verifying', 'ready', 'failed', 'retiring', 'retired']);
export const FleetStepNameSchema = z.enum(['prepare', 'artifacts', 'credentials', 'runtime', 'authenticate', 'profile', 'verify', 'admission', 'fence', 'stop', 'revoke', 'purge']);
export const FleetEvidenceSchema = z.object({
  artifact_sha256: Sha256HexSchema.optional(), runtime_digest: Sha256HexSchema.optional(),
  certificate_fingerprint: Sha256HexSchema.optional(), authority_verified: z.boolean().optional(),
  provider_verified: z.boolean().optional(), hello_verified: z.boolean().optional(),
  bootstrap_verified: z.boolean().optional(),
  profile_verified: z.boolean().optional(), roundtrip_verified: z.boolean().optional(),
  stopped_verified: z.boolean().optional(), revocation_verified: z.boolean().optional(),
}).strict();
export const FleetStepSchema = z.object({
  name: FleetStepNameSchema, status: z.enum(['pending', 'running', 'waiting', 'succeeded', 'failed', 'compensated']),
  evidence: FleetEvidenceSchema.optional(),
}).strict();
export const FleetErrorSchema = z.object({
  code: z.enum(['AUTHORITY_REVOKED', 'REVISION_CONFLICT', 'HOST_UNAVAILABLE', 'DEPENDENCIES_PRESENT',
    'STEP_FAILED', 'PROVIDER_AUTH_REQUIRED', 'UNSUPPORTED_RUNTIME', 'VERIFICATION_FAILED', 'CANCELLED']),
  step: FleetStepNameSchema.optional(), retryable: z.boolean(),
}).strict();
export const FleetOperationPreviewSchema = z.object({
  request_sha256: Sha256HexSchema,
  expected_revision: z.number().int().nonnegative(), target: FleetTargetSchema,
  kind: z.enum(['create', 'update', 'start', 'stop', 'retire', 'restore', 'purge']),
  steps: z.array(FleetStepNameSchema), dependencies: z.array(ConfigurationDependencySchema), can_apply: z.boolean(),
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
  reasoning_efforts: z.array(z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])).optional(),
}).strict().refine(value => value.mode === 'container'
  ? (value.container_name !== undefined) !== (value.container_prefix !== undefined)
  : value.container_name === undefined && value.container_prefix === undefined);
export const FleetCapabilitySchema = z.object({
  available: z.boolean(),
  actions: z.array(FleetOperationPreviewSchema.shape.kind),
  placements: z.array(z.object({
    host_id: IdentifierSchema, modes: z.array(z.enum(['container', 'native'])).min(1),
    runtime_users: z.array(z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/)).min(1),
    systemd_users: z.array(z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/)),
    home_roots: z.array(DirectorySchema).min(1), state_roots: z.array(DirectorySchema).min(1),
    runtimes: z.array(FleetRuntimeCapabilitySchema).max(1000).optional(),
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
    && (parameters.reasoning_effort == null || runtime.reasoning_efforts?.includes(parameters.reasoning_effort) === true));
}
