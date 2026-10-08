import { z } from 'zod';

export const NATIVE_ADMIN_FEATURE = 'native_admin_v1';
export const NATIVE_ADMIN_MAX_BYTES = 16_384;
export const NativePieceKindSchema = z.enum(['skill', 'prompt', 'subagent', 'mcp']);
export type NativePieceKind = z.infer<typeof NativePieceKindSchema>;
export const NativePieceIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
export const NativeOperationIdSchema = z.uuidv4().refine(value => value === value.toLowerCase());
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().max(NATIVE_ADMIN_MAX_BYTES).refine(value => new TextEncoder().encode(value).length <= NATIVE_ADMIN_MAX_BYTES && Array.from(value).every(char => char.charCodeAt(0) >= 32 || ['\n', '\r', '\t'].includes(char)));
export const NativeMcpSchema = z.object({
  url: z.url().max(2048).refine(value => {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  }),
  bearer_token_env_var: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u).optional(),
}).strict();
export type NativeMcpDescriptor = z.infer<typeof NativeMcpSchema>;
export const NativePieceValueSchema = z.union([
  z.object({ content: text }).strict(), z.object({ mcp: NativeMcpSchema }).strict(),
]);
export const NativePieceMutationSchema = z.object({
  kind: NativePieceKindSchema, id: NativePieceIdSchema, action: z.enum(['put', 'delete']),
  expected_sha: sha.nullable(), value: NativePieceValueSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.action === 'put' && (!value.value || (value.kind === 'mcp') !== ('mcp' in value.value))) {
    context.addIssue({ code: 'custom', message: 'invalid_native_value' });
  }
  if (value.action === 'delete' && (value.expected_sha === null || value.value !== undefined)) {
    context.addIssue({ code: 'custom', message: 'invalid_native_delete' });
  }
});
export type NativePieceMutation = z.infer<typeof NativePieceMutationSchema>;
export const NativeRuntimeIdentitySchema = z.object({
  generation: z.string().min(1).max(200), container_id: z.string().min(1).max(200),
  writer_instance_id: NativeOperationIdSchema,
}).strict();
export type NativeRuntimeIdentity = z.infer<typeof NativeRuntimeIdentitySchema>;
const operation = z.object({
  operation_id: NativeOperationIdSchema, operation_token: NativeOperationIdSchema, operation_generation: NativeOperationIdSchema,
}).strict();
const wireBase = { request_id: NativeOperationIdSchema, identity: NativeRuntimeIdentitySchema };
export const NativeAdminCommandSchema = z.discriminatedUnion('op', [
  z.object({ ...wireBase, op: z.literal('list'), kind: NativePieceKindSchema }).strict(),
  z.object({ ...wireBase, op: z.literal('get'), kind: NativePieceKindSchema, id: NativePieceIdSchema }).strict(),
  z.object({ ...wireBase, op: z.literal('recognize'), kind: NativePieceKindSchema, id: NativePieceIdSchema, expected_sha: sha.nullable() }).strict(),
  z.object({ ...wireBase, op: z.literal('prepare'), mutation: NativePieceMutationSchema }).strict(),
  z.object({ ...wireBase, op: z.literal('mutate'), mutation: NativePieceMutationSchema, operation }).strict(),
  z.object({ ...wireBase, op: z.literal('status'), mutation: NativePieceMutationSchema, operation }).strict(),
]);
export type NativeAdminCommand = z.infer<typeof NativeAdminCommandSchema>;
export const NativePieceSchema = z.object({
  kind: NativePieceKindSchema, id: NativePieceIdSchema, sha: sha.nullable(), editable: z.boolean(),
  value: NativePieceValueSchema.optional(),
}).strict();
export type NativePiece = z.infer<typeof NativePieceSchema>;
export const NativeAdminOutcomeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inventory'), kind: NativePieceKindSchema,
    items: z.array(z.object({ id: NativePieceIdSchema, editable: z.boolean() }).strict()).max(100), truncated: z.boolean() }).strict(),
  z.object({ type: z.literal('piece'), piece: NativePieceSchema }).strict(),
  z.object({ type: z.literal('plan'), kind: NativePieceKindSchema, id: NativePieceIdSchema, path: z.string().min(1).max(4096),
    before_sha: sha.nullable(), target_sha: sha.nullable(), bytes: z.number().int().nonnegative().max(262_144) }).strict(),
  z.object({ type: z.literal('recognition'), kind: NativePieceKindSchema, id: NativePieceIdSchema, sha: sha.nullable(),
    state: z.enum(['available_for_new_session', 'written_pending_reload']), reason: z.enum(['provider_read_verified', 'provider_format_verified', 'provider_read_unavailable']) }).strict(),
  z.object({ type: z.literal('receipt'), state: z.literal('done'), operation_id: NativeOperationIdSchema, operation_generation: NativeOperationIdSchema,
    identity: NativeRuntimeIdentitySchema, kind: NativePieceKindSchema, id: NativePieceIdSchema,
    path: z.string().min(1).max(4096), sha: sha.nullable(), bytes: z.number().int().nonnegative().max(262_144),
    backup_id: NativeOperationIdSchema }).strict(),
  z.object({ type: z.literal('error'), error: z.enum(['unsupported', 'invalid_input', 'conflict', 'unavailable', 'not_found', 'too_large', 'unsafe_path']) }).strict(),
]);
export type NativeAdminOutcome = z.infer<typeof NativeAdminOutcomeSchema>;
export type NativeAdminTransport = (command: NativeAdminCommand, signal?: AbortSignal) => Promise<NativeAdminOutcome>;
