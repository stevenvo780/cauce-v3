import { sha256Hex } from '@cauce/protocol';
import type { DatabaseClient } from './db.js';
import { CompanyTransferPayloadSchema, CompanyTransferRuntimeSchema,
  type CompanyTransferBundle, type CompanyTransferRecords } from './company-transfer-model.js';
import { companyRevision } from './company-authority.js';

interface RuntimeRow {
  tenant_id: string; alias: string; display_name: string | null; max_concurrent_deliveries: number | null;
  harness_id: string | null; runtime_key: string | null; primary_room_id: string | null; host_id: string | null;
  runtime_mode: string | null; container_name: string | null; runtime_user: string | null; home_directory: string | null;
  state_directory: string | null; systemd_user: string | null;
}
export async function readCompanyTransferSnapshot(client: DatabaseClient, company: string): Promise<CompanyTransferBundle> {
  const tenants = await client.query<CompanyTransferRecords['tenants'][number]>(`SELECT id,display_name,is_hub,enabled FROM tenants
    WHERE company_id=$1 AND retired_at IS NULL AND purged_at IS NULL ORDER BY id`, [company]);
  const rooms = await client.query<CompanyTransferRecords['rooms'][number]>(`SELECT room.tenant_id,room.id,room.display_name,room.enabled FROM rooms room
    JOIN tenants tenant ON tenant.id=room.tenant_id WHERE tenant.company_id=$1 AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL
    AND room.retired_at IS NULL AND room.purged_at IS NULL ORDER BY room.tenant_id,room.id`, [company]);
  const agents = await client.query<RuntimeRow>(`SELECT agent.tenant_id,agent.alias,agent.display_name,agent.max_concurrent_deliveries,
    agent.harness_id,agent.runtime_key,agent.primary_room_id,agent.host_id,agent.runtime_mode,agent.container_name,
    agent.runtime_user,agent.home_directory,agent.state_directory,agent.systemd_user FROM agents agent
    JOIN tenants tenant ON tenant.id=agent.tenant_id WHERE tenant.company_id=$1 AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL
    AND agent.retired_at IS NULL AND agent.purged_at IS NULL ORDER BY agent.tenant_id,agent.alias`, [company]);
  const memberships = await client.query<CompanyTransferRecords['memberships'][number]>(`SELECT member.tenant_id,member.room_id,member.alias,member.role,member.enabled
    FROM memberships member JOIN tenants tenant ON tenant.id=member.tenant_id
    JOIN rooms room ON room.id=member.room_id AND room.tenant_id=member.tenant_id
    JOIN agents agent ON agent.tenant_id=member.tenant_id AND agent.alias=member.alias
    WHERE tenant.company_id=$1 AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL
    AND member.retired_at IS NULL AND room.retired_at IS NULL AND room.purged_at IS NULL AND agent.retired_at IS NULL AND agent.purged_at IS NULL
    ORDER BY member.tenant_id,member.alias,member.room_id`, [company]);
  const edges = await client.query<CompanyTransferRecords['acl_edges'][number]>(`SELECT edge.from_tenant,edge.to_tenant,edge.enabled,edge.allow_route,edge.allow_read,edge.allow_control
    FROM acl_edges edge JOIN tenants source ON source.id=edge.from_tenant JOIN tenants target ON target.id=edge.to_tenant
    WHERE source.company_id=$1 AND target.company_id=$1 AND source.retired_at IS NULL AND source.purged_at IS NULL
    AND target.retired_at IS NULL AND target.purged_at IS NULL ORDER BY edge.from_tenant,edge.to_tenant`, [company]);
  const version = (await client.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')).rows[0]?.version;
  const records: CompanyTransferRecords = {
    tenants: tenants.rows, rooms: rooms.rows, memberships: memberships.rows, acl_edges: edges.rows,
    agents: agents.rows.map(row => {
      const runtime = CompanyTransferRuntimeSchema.safeParse({ runtime_key: row.runtime_key, harness_id: row.harness_id,
        primary_room_id: row.primary_room_id,
        memberships: memberships.rows.filter(member => member.tenant_id === row.tenant_id && member.alias === row.alias)
          .map(({ room_id, role, enabled }) => ({ room_id, role, enabled })),
        placement: { host_id: row.host_id, mode: row.runtime_mode, runtime_user: row.runtime_user,
          home_directory: row.home_directory, state_directory: row.state_directory,
          ...(row.runtime_mode !== 'container' || row.container_name === null ? {} : { container_name: row.container_name }),
          ...(row.systemd_user === null ? {} : { systemd_user: row.systemd_user }) },
      });
      return { tenant_id: row.tenant_id, alias: row.alias, display_name: row.display_name,
        max_concurrent_deliveries: row.max_concurrent_deliveries, runtime: runtime.success ? runtime.data : null };
    }),
  };
  const payload = CompanyTransferPayloadSchema.parse({ format: 'cauce-company-configuration', version: 1,
    company_id: company, schema_version: version, source_revision: await companyRevision(client, company), mode: 'upsert_only', records });
  return { ...payload, bundle_sha256: sha256Hex(payload) };
}
