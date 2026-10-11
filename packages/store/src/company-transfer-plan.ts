import { sha256Hex, type ConfigLeafMutation, type FleetOperationRequest } from '@cauce/protocol';
import { ConfigurationError } from './configuration/contracts.js';
import type { CompanyTransferBundle, CompanyTransferPlan, CompanyTransferRuntime } from './company-transfer-model.js';

function same(first: unknown, second: unknown): boolean { return sha256Hex(first) === sha256Hex(second); }
function key(...parts: string[]): string { return JSON.stringify(parts); }
function runtimeEqual(first: CompanyTransferRuntime | null, second: CompanyTransferRuntime): boolean {
  if (first === null) return false;
  const sorted = (runtime: CompanyTransferRuntime) => ({ ...runtime, memberships: [...runtime.memberships].sort((a, b) => a.room_id.localeCompare(b.room_id)) });
  return same(sorted(first), sorted(second));
}
export function buildCompanyTransferPlan(bundle: CompanyTransferBundle, current: CompanyTransferBundle, expectedRevision: number): CompanyTransferPlan {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ConfigurationError('invalid_input', 'expected revision is required');
  if (bundle.company_id !== current.company_id) throw new ConfigurationError('forbidden', 'company bundle cannot be cloned into another company');
  if (bundle.schema_version !== current.schema_version) throw new ConfigurationError('conflict', 'company bundle schema version differs');
  if (current.source_revision !== expectedRevision) throw new ConfigurationError('conflict', 'company configuration changed; generate a new import plan');
  const mutations: ConfigLeafMutation[] = [];
  const requests: FleetOperationRequest[] = [];
  const oldTenants = new Map(current.records.tenants.map(row => [row.id, row]));
  for (const row of bundle.records.tenants) {
    const old = oldTenants.get(row.id); const { id, ...value } = row;
    if (!same(row, old ?? null)) mutations.push({ resource: 'tenant', action: old ? 'update' : 'create', id, value });
  }
  const oldRooms = new Map(current.records.rooms.map(row => [key(row.tenant_id, row.id), row]));
  for (const row of bundle.records.rooms) {
    const old = oldRooms.get(key(row.tenant_id, row.id)); const { tenant_id, id, ...value } = row;
    if (!same(row, old ?? null)) mutations.push({ resource: 'room', action: old ? 'update' : 'create', tenant_id, id, value });
  }
  const oldAgents = new Map(current.records.agents.map(row => [key(row.tenant_id, row.alias), row]));
  for (const row of bundle.records.agents) {
    const old = oldAgents.get(key(row.tenant_id, row.alias));
    const value = { display_name: row.display_name, max_concurrent_deliveries: row.max_concurrent_deliveries };
    if (!old || !same(value, { display_name: old.display_name, max_concurrent_deliveries: old.max_concurrent_deliveries })) {
      mutations.push({ resource: 'agent', action: old ? 'update' : 'create', tenant_id: row.tenant_id, alias: row.alias, value });
    }
    if (row.runtime !== null && (old === undefined || !runtimeEqual(old.runtime, row.runtime))) {
      if (old?.runtime !== null && old?.runtime !== undefined && old.runtime.placement.host_id !== row.runtime.placement.host_id) {
        throw new ConfigurationError('conflict', 'host relocation requires an explicit multi-host migration operation');
      }
      requests.push({ kind: old?.runtime ? 'update' : 'create', target: { resource: 'agent', tenant_id: row.tenant_id, alias: row.alias },
        parameters: { ...row.runtime, display_name: row.display_name }, expected_revision: expectedRevision,
        idempotency_key: `import_${sha256Hex([bundle.bundle_sha256, row.tenant_id, row.alias])}` });
    }
  }
  const oldMembers = new Map(current.records.memberships.map(row => [key(row.tenant_id, row.alias, row.room_id), row]));
  const desiredAgents = new Map(bundle.records.agents.map(row => [key(row.tenant_id, row.alias), row]));
  for (const row of bundle.records.memberships) {
    const old = oldMembers.get(key(row.tenant_id, row.alias, row.room_id)); const { tenant_id, room_id, alias, ...value } = row;
    if (oldAgents.get(key(tenant_id, alias))?.runtime != null && !same(row, old ?? null)) {
      if (desiredAgents.get(key(tenant_id, alias))?.runtime == null) {
        throw new ConfigurationError('conflict', 'physical membership changes require a complete runtime descriptor');
      }
      continue;
    }
    if (!same(row, old ?? null)) mutations.push({ resource: 'membership', action: old ? 'update' : 'create', tenant_id, room_id, alias, value });
  }
  const oldEdges = new Map(current.records.acl_edges.map(row => [key(row.from_tenant, row.to_tenant), row]));
  for (const row of bundle.records.acl_edges) {
    const old = oldEdges.get(key(row.from_tenant, row.to_tenant)); const { from_tenant, to_tenant, ...value } = row;
    if (!same(row, old ?? null)) mutations.push({ resource: 'acl_edge', action: old ? 'update' : 'create', from_tenant, to_tenant, value });
  }
  const payload = { version: 1 as const, company_id: bundle.company_id, bundle_sha256: bundle.bundle_sha256,
    expected_revision: expectedRevision, mutations, fleet_requests: requests };
  return { ...payload, plan_sha256: sha256Hex(payload) };
}
