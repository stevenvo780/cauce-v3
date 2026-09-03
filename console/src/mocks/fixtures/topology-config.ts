import type { TopologySnapshot } from '../../api/types';

/**
 * Demonstration topology, traced from the real fleet: 5 tenants and 15 aliases.
 */
export const topology: TopologySnapshot = {
  observed_at: '2026-07-22T16:12:08.000Z',
  tenants: [
    {
      id: 'Steven', label: 'Steven', rooms: [
        { id: 'grp.steven', label: 'grp.steven', members: [{ alias: 'zeus', enabled: true }, { alias: 'kant', enabled: true }, { alias: 'socrates', enabled: true }, { alias: 'jarvis', enabled: true }, { alias: 'argos', enabled: true }] },
        { id: 'ops.infra', label: 'ops.infra', members: [{ alias: 'zeus', enabled: true }, { alias: 'argos', enabled: true }] },
      ],
    },
    {
      id: 'Miguel', label: 'Miguel', rooms: [
        { id: 'grp.miguel', label: 'grp.miguel', members: [{ alias: 'janus', enabled: true }, { alias: 'kratos', enabled: true }, { alias: 'iza', enabled: true }] },
        { id: 'ops.miguel', label: 'ops.miguel', members: [{ alias: 'kratos', enabled: true }, { alias: 'atlas', enabled: false }] },
      ],
    },
    {
      id: 'Pablo', label: 'Pablo', rooms: [
        { id: 'grp.pablo', label: 'grp.pablo', members: [{ alias: 'dedalo', enabled: true }, { alias: 'midas', enabled: true }, { alias: 'seneca', enabled: true }] },
        { id: 'marcas.pablo', label: 'marcas.pablo', members: [{ alias: 'midas', enabled: true }, { alias: 'vulcano', enabled: false }] },
      ],
    },
    { id: 'Isa', label: 'Isa', rooms: [{ id: 'grp.isa', label: 'grp.isa', members: [{ alias: 'salva', enabled: true }] }] },
    { id: 'Jhon', label: 'Jhon', rooms: [{ id: 'grp.jhon', label: 'grp.jhon', members: [{ alias: 'hegel', enabled: true }] }] },
  ],
  acl_edges: [
    { from_tenant: 'Steven', to_tenant: 'Miguel', enabled: true, allow_route: true, allow_read: true, allow_control: true, policy: 'explicit-cross-tenant' },
    { from_tenant: 'Miguel', to_tenant: 'Steven', enabled: true, allow_route: true, allow_read: true, allow_control: false, policy: 'explicit-cross-tenant' },
    { from_tenant: 'Steven', to_tenant: 'Pablo', enabled: true, allow_route: true, allow_read: true, allow_control: true, policy: 'explicit-cross-tenant' },
    { from_tenant: 'Pablo', to_tenant: 'Steven', enabled: true, allow_route: true, allow_read: true, allow_control: false, policy: 'explicit-cross-tenant' },
    { from_tenant: 'Steven', to_tenant: 'Jhon', enabled: true, allow_route: true, allow_read: true, allow_control: true, policy: 'explicit-cross-tenant' },
    { from_tenant: 'Miguel', to_tenant: 'Pablo', enabled: false, allow_route: false, allow_read: false, allow_control: false, policy: 'default-deny' },
  ],
};

const ALTA_DEMO = '2026-07-01T10:00:00.000Z';

export const configTenants = (topology.tenants ?? []).map((tenant) => ({
  id: tenant.id, display_name: tenant.label ?? null,
  is_hub: tenant.id === 'Steven', enabled: true, created_at: ALTA_DEMO,
}));

export const configRooms = (topology.tenants ?? []).flatMap((tenant) => (tenant.rooms ?? []).map((room) => ({
  id: room.id, tenant_id: tenant.id, display_name: room.label ?? null, enabled: true, created_at: ALTA_DEMO,
})));

export const configMemberships = (topology.tenants ?? []).flatMap((tenant) => (tenant.rooms ?? [])
  .flatMap((room) => (room.members ?? []).map((member) => ({
    tenant_id: tenant.id, room_id: room.id, alias: member.alias,
    role: tenant.id === 'Steven' ? 'operator' : 'agent',
    enabled: member.enabled ?? true, created_at: ALTA_DEMO,
  }))));

export const configAclEdges = (topology.acl_edges ?? []).map((edge) => ({
  from_tenant: edge.from_tenant, to_tenant: edge.to_tenant, enabled: edge.enabled,
  allow_route: edge.allow_route, allow_read: edge.allow_read, allow_control: edge.allow_control,
  created_at: ALTA_DEMO,
}));

export const registryAgents: Record<string, unknown>[] = [
  { tenant_id: 'Steven', alias: 'kant', harness_id: 'claude-code', display_name: 'Kant', enabled: true, role_brief: 'Sos kant, el hub de coordinacion de la flota.', container_name: 'ws-kant', runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/var/lib/kant', created_at: '2026-07-20T10:00:00.000Z', updated_at: '2026-07-22T10:00:00.000Z' },
  { tenant_id: 'Miguel', alias: 'iza', harness_id: 'hermes', display_name: 'Iza', enabled: false, role_brief: null, container_name: 'ws-humanizar', runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/var/lib/iza', created_at: '2026-07-23T10:00:00.000Z', updated_at: '2026-07-23T10:00:00.000Z' },
  { tenant_id: 'Pablo', alias: 'midas', harness_id: 'openclaw', display_name: null, enabled: true, container_name: 'ws-midas', runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/var/lib/midas', created_at: '2026-07-19T10:00:00.000Z', updated_at: '2026-07-21T10:00:00.000Z' },
];

export const providerAccounts: Record<string, unknown>[] = [
  { id: 'codex-steven', provider: 'codex', payer_tenant_id: 'Steven', label: 'Codex del hub', shared_with_pool: true, enabled: true, external_account_id: 'org-steven-9f21', credential_ref_kind: 'env_path', created_at: '2026-07-18T10:00:00.000Z', updated_at: '2026-07-22T10:00:00.000Z' },
  { id: 'gemini-steven', provider: 'gemini', payer_tenant_id: 'Steven', label: 'Antigravity', shared_with_pool: false, enabled: true, external_account_id: 'antigravity-4410', credential_ref_kind: 'file', created_at: '2026-07-18T11:00:00.000Z', updated_at: '2026-07-18T11:00:00.000Z' },
  { id: 'minimax-pablo', provider: 'minimax', payer_tenant_id: 'Pablo', label: 'MiniMax de Pablo', shared_with_pool: true, enabled: true, external_account_id: null, credential_ref_kind: null, created_at: '2026-07-17T10:00:00.000Z', updated_at: '2026-07-20T10:00:00.000Z' },
];

export const routingCeiling: Record<string, unknown>[] = [
  { tenant_id: 'Steven', alias: 'kant', account_id: 'codex-steven', account_payer_tenant: 'Steven', created_by_tenant: 'Steven', created_at: '2026-07-20T12:00:00.000Z' },
  { tenant_id: 'Steven', alias: 'kant', account_id: 'minimax-pablo', account_payer_tenant: 'Pablo', created_by_tenant: 'Steven', created_at: '2026-07-20T12:05:00.000Z' },
  { tenant_id: 'Miguel', alias: 'iza', account_id: 'codex-steven', account_payer_tenant: 'Steven', created_by_tenant: 'Miguel', created_at: '2026-07-23T12:00:00.000Z' },
];

export const agentAccountBindings: Record<string, unknown>[] = [
  { tenant_id: 'Steven', agent_alias: 'kant', account_id: 'codex-steven', priority: 10, enabled: true, created_at: '2026-07-20T12:01:00.000Z', updated_at: '2026-07-20T12:01:00.000Z' },
  { tenant_id: 'Steven', agent_alias: 'kant', account_id: 'minimax-pablo', priority: 50, enabled: true, created_at: '2026-07-20T12:06:00.000Z', updated_at: '2026-07-20T12:06:00.000Z' },
  { tenant_id: 'Miguel', agent_alias: 'iza', account_id: 'codex-steven', priority: 100, enabled: false, created_at: '2026-07-23T12:01:00.000Z', updated_at: '2026-07-23T12:01:00.000Z' },
];

