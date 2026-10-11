import { z } from 'zod';
import { AliasSchema, ConfigLeafMutationSchema, FleetOperationRequestSchema, TenantSchema, sha256Hex } from '@cauce/protocol';
import { ConfigurationError } from './configuration/contracts.js';

const company = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const label = z.string().trim().min(1).max(128).nullable();
const revision = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const identifier = z.string().min(1).max(128);
const parameters = FleetOperationRequestSchema.options[0].shape.parameters.shape;
export const CompanyTransferRuntimeSchema = z.object({
  runtime_key: parameters.runtime_key, harness_id: parameters.harness_id,
  primary_room_id: parameters.primary_room_id, memberships: parameters.memberships, placement: parameters.placement,
}).strict().refine(value => FleetOperationRequestSchema.safeParse({ kind: 'create', target: { resource: 'agent', tenant_id: 'Transfer', alias: 'draft' },
  expected_revision: 0, idempotency_key: 'transfer_validation', parameters: value }).success);
export const CompanyTransferRecordsSchema = z.object({
  tenants: z.array(z.object({ id: TenantSchema, display_name: label, is_hub: z.boolean(), enabled: z.boolean() }).strict()).max(1000),
  rooms: z.array(z.object({ tenant_id: TenantSchema, id: identifier, display_name: label, enabled: z.boolean() }).strict()).max(10000),
  agents: z.array(z.object({ tenant_id: TenantSchema, alias: AliasSchema, display_name: label,
    max_concurrent_deliveries: z.number().int().min(1).max(100).nullable(), runtime: CompanyTransferRuntimeSchema.nullable() }).strict()).max(10000),
  memberships: z.array(z.object({ tenant_id: TenantSchema, room_id: identifier, alias: AliasSchema,
    role: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u), enabled: z.boolean() }).strict()).max(10000),
  acl_edges: z.array(z.object({ from_tenant: TenantSchema, to_tenant: TenantSchema, enabled: z.boolean(),
    allow_route: z.boolean(), allow_read: z.boolean(), allow_control: z.boolean() }).strict()).max(10000),
}).strict();
export const CompanyTransferPayloadSchema = z.object({
  format: z.literal('cauce-company-configuration'), version: z.literal(1), company_id: company,
  schema_version: z.string().min(1).max(128), source_revision: revision,
  mode: z.literal('upsert_only'), records: CompanyTransferRecordsSchema,
}).strict();
export const CompanyTransferBundleSchema = CompanyTransferPayloadSchema.extend({ bundle_sha256: digest }).strict();
export const CompanyTransferPlanPayloadSchema = z.object({
  version: z.literal(1), company_id: company, bundle_sha256: digest, expected_revision: revision,
  mutations: z.array(ConfigLeafMutationSchema).max(50000), fleet_requests: z.array(FleetOperationRequestSchema).max(10000),
}).strict();
export const CompanyTransferPlanSchema = CompanyTransferPlanPayloadSchema.extend({ plan_sha256: digest }).strict();
export type CompanyTransferRecords = z.infer<typeof CompanyTransferRecordsSchema>;
export type CompanyTransferRuntime = z.infer<typeof CompanyTransferRuntimeSchema>;
export type CompanyTransferPayload = z.infer<typeof CompanyTransferPayloadSchema>;
export type CompanyTransferBundle = z.infer<typeof CompanyTransferBundleSchema>;
export type CompanyTransferPlan = z.infer<typeof CompanyTransferPlanSchema>;

function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new ConfigurationError('invalid_input', 'company bundle has duplicate resource identities');
}
export function validateTransferRecords(records: CompanyTransferRecords): void {
  const tenants = new Set(records.tenants.map(row => row.id));
  const rooms = new Set(records.rooms.map(row => JSON.stringify([row.tenant_id, row.id])));
  const agents = new Set(records.agents.map(row => JSON.stringify([row.tenant_id, row.alias])));
  unique([...records.tenants.map(row => JSON.stringify(['tenant', row.id])), ...records.rooms.map(row => JSON.stringify(['room', row.tenant_id, row.id])),
    ...records.agents.map(row => JSON.stringify(['agent', row.tenant_id, row.alias])),
    ...records.memberships.map(row => JSON.stringify(['membership', row.tenant_id, row.room_id, row.alias])),
    ...records.acl_edges.map(row => JSON.stringify(['acl', row.from_tenant, row.to_tenant]))]);
  const owned = records.rooms.every(row => tenants.has(row.tenant_id)) && records.agents.every(row => tenants.has(row.tenant_id))
    && records.memberships.every(row => rooms.has(JSON.stringify([row.tenant_id, row.room_id])) && agents.has(JSON.stringify([row.tenant_id, row.alias])))
    && records.acl_edges.every(row => tenants.has(row.from_tenant) && tenants.has(row.to_tenant));
  if (!owned) throw new ConfigurationError('invalid_input', 'company bundle references resources outside its tenant set');
  for (const agent of records.agents) {
    if (agent.runtime === null) continue;
    const expected = records.memberships.filter(row => row.tenant_id === agent.tenant_id && row.alias === agent.alias)
      .map(({ room_id, role, enabled }) => ({ room_id, role, enabled }));
    if (sha256Hex(expected) !== sha256Hex(agent.runtime.memberships)) {
      throw new ConfigurationError('invalid_input', 'physical descriptor memberships differ from company configuration');
    }
  }
}
export function parseCompanyTransferBundle(input: unknown): CompanyTransferBundle {
  const parsed = CompanyTransferBundleSchema.safeParse(input);
  if (!parsed.success) throw new ConfigurationError('invalid_input', 'company bundle is invalid or contains excluded data');
  const { bundle_sha256, ...payload } = parsed.data;
  if (sha256Hex(payload) !== bundle_sha256) throw new ConfigurationError('invalid_input', 'company bundle checksum differs');
  validateTransferRecords(payload.records);
  return parsed.data;
}
export function parseCompanyTransferPlan(input: unknown): CompanyTransferPlan {
  const parsed = CompanyTransferPlanSchema.safeParse(input);
  if (!parsed.success) throw new ConfigurationError('invalid_input', 'company import plan is invalid');
  const { plan_sha256, ...payload } = parsed.data;
  if (sha256Hex(payload) !== plan_sha256) throw new ConfigurationError('invalid_input', 'company import plan checksum differs');
  return parsed.data;
}
