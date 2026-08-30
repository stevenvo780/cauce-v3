import { z } from 'zod';
import { AliasSchema, TenantSchema } from './core.js';
import { EgressHandleSchema, NotifyKindSchema } from './messages.js';

const ConfigActionSchema = z.enum(['create', 'update', 'delete']);
const ConfigRevisionSchema = z.number().int().nonnegative();
const OptionalLabelSchema = z.string().trim().min(1).max(128).nullable().optional();

const TenantConfigMutationSchema = z.object({
  resource: z.literal('tenant'), action: ConfigActionSchema, id: TenantSchema,
  value: z.object({ display_name: OptionalLabelSchema, is_hub: z.boolean().optional(), enabled: z.boolean().optional() }).strict().optional()
}).strict();
const RoomConfigMutationSchema = z.object({
  resource: z.literal('room'), action: ConfigActionSchema, tenant_id: TenantSchema,
  id: z.string().min(1).max(128),
  value: z.object({ display_name: OptionalLabelSchema, enabled: z.boolean().optional() }).strict().optional()
}).strict();
const MembershipConfigMutationSchema = z.object({
  resource: z.literal('membership'), action: ConfigActionSchema, tenant_id: TenantSchema,
  room_id: z.string().min(1).max(128), alias: AliasSchema,
  value: z.object({ role: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(), enabled: z.boolean().optional() }).strict().optional()
}).strict();
const AclEdgeConfigMutationSchema = z.object({
  resource: z.literal('acl_edge'), action: ConfigActionSchema,
  from_tenant: TenantSchema, to_tenant: TenantSchema,
  value: z.object({
    enabled: z.boolean().optional(), allow_route: z.boolean().optional(),
    allow_read: z.boolean().optional(), allow_control: z.boolean().optional()
  }).strict().optional()
}).strict();
export const HarnessConfigMutationSchema = z.object({
  resource: z.literal('harness'), action: ConfigActionSchema,
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  value: z.object({
    display_name: z.string().trim().min(1).max(128).optional(),
    command: z.string().min(1).max(512).nullable().optional(),
    capabilities: z.array(z.string().min(1).max(80)).max(100).optional(), enabled: z.boolean().optional()
  }).strict().optional()
}).strict();
const RolePolicyConfigMutationSchema = z.object({
  resource: z.literal('role_policy'), action: ConfigActionSchema,
  role: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  value: z.object({
    allow_route: z.boolean().optional(), allow_read: z.boolean().optional(),
    allow_control: z.boolean().optional(), allow_notify: z.boolean().optional()
  }).strict().optional()
}).strict();
/** The proactive-egress allowlist is versioned configuration, not runtime data. */
const EgressDestinationConfigMutationSchema = z.object({
  resource: z.literal('egress_destination'), action: ConfigActionSchema,
  tenant_id: TenantSchema, alias: AliasSchema, handle: EgressHandleSchema,
  value: z.object({
    adapter: z.literal('telegram').optional(),
    channel: z.string().min(1).max(128).optional(),
    conversation_id: z.string().regex(/^-?[1-9][0-9]{0,19}$/).optional(),
    conversation_kind: z.enum(['dm', 'group']).optional(),
    display_label: OptionalLabelSchema,
    allow_kinds: z.array(NotifyKindSchema).min(1).max(4).optional(),
    require_prior_contact: z.boolean().optional(),
    contact_ttl_days: z.number().int().min(1).max(3650).optional(),
    min_interval_seconds: z.number().int().min(0).max(86_400).optional(),
    max_per_hour: z.number().int().min(0).max(60).optional(),
    max_per_day: z.number().int().min(0).max(500).optional(),
    max_per_root: z.number().int().min(0).max(20).optional(),
    quiet_hours_start: z.number().int().min(0).max(23).nullable().optional(),
    quiet_hours_end: z.number().int().min(0).max(23).nullable().optional(),
    quiet_hours_tz: z.string().min(1).max(64).optional(),
    enabled: z.boolean().optional()
  }).strict().optional()
}).strict();

/**
 * Chain visibility policy. It is a hub-only singleton: the store reads it once per
 * terminal ACK, so it inherits optimistic revision locking, preview, audit and rollback
 * instead of living in an environment variable or in raw SQL.
 */
export const ChainPolicyConfigMutationSchema = z.object({
  resource: z.literal('chain_policy'), action: z.literal('update'), id: z.literal('default'),
  value: z.object({
    progress_relay_enabled: z.boolean().optional(),
    progress_relay_max_events: z.number().int().min(1).max(64).optional(),
    cycle_cut_enabled: z.boolean().optional(),
    // Coalescing of failure notices. 0 is allowed and means "null window": it is the soft
    // disabling mode (stops folding without erasing the accumulated history), distinct from
    // failure_coalesce_enabled=false, which switches the whole machinery off.
    failure_coalesce_enabled: z.boolean().optional(),
    failure_coalesce_window_seconds: z.number().int().min(0).max(86_400).optional(),
    /*
     * THE FIVE CAPS FROM MIGRATION 019, already APPLIED by the server and untouchable from the console.
     *
     * `repository.ts` reads them and cuts delegations with them; their only change path was a
     * raw `UPDATE` against the database — which 019 itself documents as the emergency kill
     * switch — i.e. without revision, without an inverse mutation reaching the undo button,
     * without an entry in `audit_events`, and without knowing who did it.
     *
     * THE RANGES ARE THOSE OF THE POSTGRES CHECK, copied one for one: fanout 1-100, edge
     * repeats 1-1000, delegations per root 1-10000. Matching them is what makes an out-of-range
     * value be rejected with a message naming the field, instead of blowing up as a constraint
     * error mid-transaction. In a disagreement THE SQL WINS: the column is what cannot move
     * without a migration.
     */
    delegation_caps_enabled: z.boolean().optional(),
    max_fanout_per_turn: z.number().int().min(1).max(100).optional(),
    max_edge_repeats_per_root: z.number().int().min(1).max(1_000).optional(),
    max_delegations_per_root: z.number().int().min(1).max(10_000).optional(),
    human_gate_enabled: z.boolean().optional()
  }).strict().optional()
}).strict();

const AccountIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

/** The runtime/harness binding for an alias. Placement fields travel together (see the
 *  migration's agents_placement_atomic CHECK): partial placement is rejected by Postgres. */
export const AgentConfigMutationSchema = z.object({
  resource: z.literal('agent'), action: ConfigActionSchema,
  tenant_id: TenantSchema, alias: AliasSchema,
  value: z.object({
    harness_id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).nullable().optional(),
    display_name: OptionalLabelSchema,
    enabled: z.boolean().optional(),
    container_name: z.string().trim().min(1).max(256).nullable().optional(),
    runtime_user: z.string().trim().min(1).max(64).nullable().optional(),
    home_directory: z.string().trim().min(1).max(512).nullable().optional(),
    state_directory: z.string().trim().min(1).max(512).nullable().optional(),
    // `role_brief` is a legacy projection of `agent_profiles.role_summary` from migration 028.
    // NOT accepted in this mutation: persisting it via the generic editor would only certify a
    // Postgres row while the file the harness reads stays on the previous revision. The only
    // public write is the canonical profile PUT, which requires CAS and runtime ACK.
    /*
     * The REAL cap on in-flight deliveries for this agent (column `max_concurrent_deliveries`,
     * migration 015). `repository.ts` applies it when allocating quota, and there was no UI
     * for it: its only change path was a hand-rolled `UPDATE`.
     *
     * `null` is NOT "undeclared": it means NO CAP, the emergency escape that 015 documents
     * — "if this change strangles an agent that can actually parallelize (or if the cap must
     * be disabled hot without a deploy)". That is why it is `.nullable()`, not just
     * `.optional()`: two distinct states, collapsing them would lose the escape hatch.
     *
     * The 1-100 range is the `agents_max_concurrent_deliveries_sane` CHECK, copied verbatim.
     */
    max_concurrent_deliveries: z.number().int().min(1).max(100).nullable().optional()
  }).strict().optional()
}).strict();

/**
 * A provider subscription. The id is global — an account is not owned by the tenant that uses
 * it, it is PAID FOR by payer_tenant_id and lent to whoever the hub puts it in front of.
 * credential_ref is a locator (env var name, file path, secret-manager path), never the secret
 * itself; provider, external_account_id, payer_tenant_id and the credential locator are
 * immutable after create, so rotation is delete+create (enforced in configuration.ts).
 */
export const ProviderAccountConfigMutationSchema = z.object({
  resource: z.literal('provider_account'), action: ConfigActionSchema, id: AccountIdSchema,
  value: z.object({
    provider: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/).optional(),
    external_account_id: z.string().trim().min(1).max(256).optional(),
    payer_tenant_id: TenantSchema.optional(),
    label: OptionalLabelSchema,
    credential_ref_kind: z.enum(['env_path', 'file', 'secret_manager']).optional(),
    credential_ref: z.string().min(1).max(1024).optional(),
    shared_with_pool: z.boolean().optional(),
    enabled: z.boolean().optional()
  }).strict().optional()
}).strict();

/** The exhaustive set of accounts an alias may ever be routed to. It carries no mutable state,
 *  so it is granted and revoked, never updated. */
export const AliasRoutingCeilingConfigMutationSchema = z.object({
  resource: z.literal('alias_routing_ceiling'), action: z.enum(['create', 'delete']),
  tenant_id: TenantSchema, alias: AliasSchema, account_id: AccountIdSchema
}).strict();

/** Fallback order within the ceiling; lower priority is tried first. There is no 'main' entry
 *  here by design — see the migration and ADR-006. */
export const AgentAccountBindingConfigMutationSchema = z.object({
  resource: z.literal('agent_account_binding'), action: ConfigActionSchema,
  tenant_id: TenantSchema, agent_alias: AliasSchema, account_id: AccountIdSchema,
  value: z.object({
    priority: z.number().int().min(0).max(32_767).optional(), enabled: z.boolean().optional()
  }).strict().optional()
}).strict();

export const ConfigMutationSchema = z.discriminatedUnion('resource', [
  TenantConfigMutationSchema, RoomConfigMutationSchema, MembershipConfigMutationSchema,
  AclEdgeConfigMutationSchema, HarnessConfigMutationSchema, RolePolicyConfigMutationSchema,
  ChainPolicyConfigMutationSchema, EgressDestinationConfigMutationSchema,
  AgentConfigMutationSchema, ProviderAccountConfigMutationSchema,
  AliasRoutingCeilingConfigMutationSchema, AgentAccountBindingConfigMutationSchema
]);
export const ConfigChangeRequestSchema = z.object({
  dry_run: z.boolean().default(true), expected_revision: ConfigRevisionSchema.optional(), mutation: ConfigMutationSchema
}).strict();
export const ConfigRollbackRequestSchema = z.object({
  dry_run: z.boolean().default(true), expected_revision: ConfigRevisionSchema.optional()
}).strict();
