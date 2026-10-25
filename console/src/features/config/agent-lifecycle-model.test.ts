import { describe, expect, it } from 'vitest';
import type { FleetCapability } from '@cauce/protocol/fleet-operation';
import type { ConfigurationSnapshot } from '../../api/types';
import { agentLifecycleDraft, agentLifecycleRequest, lifecycleAccountForProvider, lifecycleOptions } from './agent-lifecycle-model';

const snapshot: ConfigurationSnapshot = { revision: 4, tenants: [{ id: 'A' }],
  rooms: [{ tenant_id: 'A', id: ' Sala ', display_name: 'Sala' }, { tenant_id: 'A', id: 'Sala', display_name: 'Sala' }],
  agents: [{ tenant_id: 'A', alias: 'one', runtime_key: 'runtime-one', host_id: 'test-host', mode: 'native', harness_id: 'codex',
    primary_room_id: ' Sala ', runtime_user: 'runner', home_directory: '/home/runner', state_directory: '/state/runtime-one' }],
  memberships: [{ tenant_id: 'A', alias: 'one', room_id: ' Sala ', role: 'rol con espacios', enabled: false }],
  harness_definitions: [{ id: 'codex' }], provider_accounts: [] };
const capability: FleetCapability = { available: true, actions: ['create', 'update'], placements: [{ host_id: 'test-host',
  modes: ['native'], runtime_users: ['runner'], systemd_users: ['runner'], home_roots: ['/home/runner'], state_roots: ['/state'] }] };

describe('agent lifecycle intent', () => {
  it('requires an explicit OpenAI model for the approved OpenClaw Codex driver before preparing', () => {
    const current = { ...snapshot, harness_definitions: [{ id: 'openclaw' }], provider_accounts: [{ id: 'account', provider: 'codex' }] };
    const draft = { ...agentLifecycleDraft(snapshot, { resource: 'agent', tenant_id: 'A', alias: 'one' }),
      harnessId: 'openclaw', primaryAccountId: 'account' };
    for (const modelId of ['', 'gpt-6', 'anthropic/claude', 'openai/', 'openai/model extra', 'openai/model?', `openai/${'m'.repeat(113)}`]) {
      expect(agentLifecycleRequest({ ...draft, modelId }, current, capability, 'update', 'request_key').error).toMatch(/modelo explícito/);
    }
    expect(agentLifecycleRequest({ ...draft, modelId: 'openai/gpt-6', reasoningEffort: 'max' }, current, capability, 'update', 'request_key').request)
      .toMatchObject({ parameters: { model_id: 'openai/gpt-6', reasoning_effort: 'max' } });
  });
  it('matches the selected account provider even when several providers share one harness and placement', () => {
    const current = { ...snapshot, harness_definitions: [{ id: 'openclaw' }], provider_accounts: [{ id: 'gemini-account', provider: 'gemini' }] };
    const runtime = { mode: 'native' as const, harness_id: 'openclaw', provider: 'codex', runtime_user: 'runner',
      home_directory: '/home/runner', state_root: '/state' };
    const catalog = { ...capability, placements: capability.placements.map(host => ({ ...host,
      runtimes: [runtime, { ...runtime, provider: 'gemini' }] })) };
    const draft = { ...agentLifecycleDraft(snapshot, { resource: 'agent', tenant_id: 'A', alias: 'one' }),
      harnessId: 'openclaw', primaryAccountId: 'gemini-account' };
    expect(agentLifecycleRequest(draft, current, catalog, 'update', 'request_key').request).toMatchObject({
      parameters: { harness_id: 'openclaw', primary_account_id: 'gemini-account' } });
    const absent = { ...catalog, placements: catalog.placements.map(host => ({ ...host, runtimes: [runtime] })) };
    expect(agentLifecycleRequest(draft, current, absent, 'update', 'request_key').error).toMatch(/proveedor/);
    expect(agentLifecycleRequest({ ...draft, primaryAccountId: '' }, current, catalog, 'update', 'request_key').error).toMatch(/cuenta principal/);
  });
  it('preserves only a compatible account and excludes disabled or unshared foreign accounts from template selection', () => {
    const accounts = { ...snapshot, provider_accounts: [{ id: 'disabled', provider: 'gemini', enabled: false },
      { id: 'foreign', provider: 'gemini', payer_tenant_id: 'B' }, { id: 'main', provider: 'gemini', payer_tenant_id: 'A' },
      { id: 'selected', provider: 'gemini', payer_tenant_id: 'B', shared_with_pool: true }] };
    expect(lifecycleAccountForProvider(accounts, 'gemini', 'selected', 'A')).toBe('selected');
    expect(lifecycleAccountForProvider(accounts, 'gemini', 'disabled', 'A')).toBe('main');
    expect(lifecycleAccountForProvider(accounts, 'codex', 'selected', 'A')).toBe('');
  });
  it('preserves exact identities, memberships and immutable physical key on update', () => {
    const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'one' };
    const draft = agentLifecycleDraft(snapshot, target);
    expect(lifecycleOptions(snapshot, 'rooms', 'A').map((option) => option.id)).toEqual([' Sala ', 'Sala']);
    const result = agentLifecycleRequest({ ...draft, runtimeKey: 'other-runtime' }, snapshot, capability, 'update', 'request_key', target);
    expect(result.error).toMatch(/inmutable/);
    const valid = agentLifecycleRequest(draft, snapshot, capability, 'update', 'request_key', target);
    expect(valid.request).toMatchObject({ target, parameters: { runtime_key: 'runtime-one', primary_room_id: ' Sala ',
      memberships: [{ room_id: ' Sala ', role: 'rol con espacios', enabled: true }] } });
  });
  it('enables the primary membership by default when it is paused in the snapshot', () => {
    const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'one' };
    const draft = agentLifecycleDraft(snapshot, target);
    expect(draft.memberships).toEqual([{ room_id: ' Sala ', role: 'rol con espacios', enabled: true }]);
    expect(draft.primaryRoomId).toBe(' Sala ');
  });
  it('omits disabled memberships to retired rooms from the desired update while preserving their history', () => {
    const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'one' };
    const historical = { tenant_id: 'A', alias: 'one', room_id: 'retired-room', role: 'agent', enabled: false };
    const current = { ...snapshot, memberships: [...(snapshot.memberships ?? []), historical,
      { tenant_id: 'A', alias: 'one', room_id: 'Sala', role: 'operator', enabled: false }],
    retired: { tenants: [], memberships: [], agents: [], rooms: [{ tenant_id: 'A', id: 'retired-room', enabled: false }] } };
    const original = structuredClone(current);
    const draft = agentLifecycleDraft(current, target);
    const originalDraft = structuredClone(draft);
    const result = agentLifecycleRequest(draft, current, capability, 'update', 'request_key', target);
    expect(result.error).toBeUndefined();
    expect(result.request).toMatchObject({ target, parameters: { primary_room_id: ' Sala ', memberships: [
      { room_id: ' Sala ', role: 'rol con espacios', enabled: true },
      { room_id: 'Sala', role: 'operator', enabled: false },
    ] } });
    expect(draft.memberships).toContainEqual({ room_id: 'retired-room', role: 'agent', enabled: false });
    expect(draft).toEqual(originalDraft);
    expect(current).toEqual(original);
  });
  it.each([
    { label: 'enabled membership to an absent room', enabled: true, retiredTenant: undefined },
    { label: 'enabled membership to a retired room', enabled: true, retiredTenant: 'A' },
    { label: 'disabled membership without retirement evidence', enabled: false, retiredTenant: undefined },
    { label: 'disabled membership whose room is retired only in another tenant', enabled: false, retiredTenant: 'B' },
  ])('rejects $label', ({ enabled, retiredTenant }) => {
    const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'one' };
    const current = { ...snapshot, memberships: [...(snapshot.memberships ?? []),
      { tenant_id: 'A', alias: 'one', room_id: 'absent-room', role: 'agent', enabled }],
    retired: { tenants: [], memberships: [], agents: [], rooms: retiredTenant ? [{ tenant_id: retiredTenant, id: 'absent-room', enabled: false }] : [] } };
    const result = agentLifecycleRequest(agentLifecycleDraft(current, target), current, capability, 'update', 'request_key', target);
    expect(result.request).toBeUndefined();
    expect(result.error).toMatch(/Una membresía apunta a grupos ausentes del inventario/);
  });
  it.each(['create', 'missing-target', 'unpublished-membership', 'changed-role'] as const)(
    'rejects treating a disabled retired-room membership as historical for %s', (scenario) => {
      const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'one' };
      const current = { ...snapshot, memberships: [...(snapshot.memberships ?? []),
        ...(scenario === 'unpublished-membership' ? [] : [{ tenant_id: 'A', alias: 'one',
          room_id: 'retired-room', role: 'agent', enabled: false }])],
      retired: { tenants: [], memberships: [], agents: [], rooms: [{ tenant_id: 'A', id: 'retired-room', enabled: false }] } };
      const draft = agentLifecycleDraft(current, target);
      if (scenario === 'unpublished-membership') draft.memberships.push({ room_id: 'retired-room', role: 'agent', enabled: false });
      if (scenario === 'changed-role') draft.memberships = draft.memberships.map(member =>
        member.room_id === 'retired-room' ? { ...member, role: 'operator' } : member);
      const result = agentLifecycleRequest(draft, current, capability, scenario === 'create' ? 'create' : 'update',
        'request_key', scenario === 'missing-target' ? undefined : target);
      expect(result.request).toBeUndefined();
      expect(result.error).toMatch(/grupos ausentes/);
    });
  it('rejects a retired primary room even when its historical membership is disabled', () => {
    const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'one' };
    const current = { ...snapshot, agents: [{ ...snapshot.agents?.[0], primary_room_id: 'retired-room' }],
      memberships: [...(snapshot.memberships ?? []),
        { tenant_id: 'A', alias: 'one', room_id: 'retired-room', role: 'agent', enabled: false }],
      retired: { tenants: [], memberships: [], agents: [], rooms: [{ tenant_id: 'A', id: 'retired-room', enabled: false }] } };
    const result = agentLifecycleRequest(agentLifecycleDraft(current, target), current, capability, 'update', 'request_key', target);
    expect(result.request).toBeUndefined();
    expect(result.error).toMatch(/grupos ausentes/);
  });
  it('requires explicit capability and approved host/user/paths before preparing an inactive agent', () => {
    const draft = { ...agentLifecycleDraft(snapshot), tenantId: 'A', alias: 'new-agent', runtimeKey: 'new-agent',
      harnessId: 'codex', hostId: 'test-host', mode: 'native' as const, runtimeUser: 'runner', homeDirectory: '/home/runner',
      stateDirectory: '/state/new-agent', primaryRoomId: ' Sala ', memberships: [{ room_id: ' Sala ', role: 'operator', enabled: true }] };
    expect(agentLifecycleRequest(draft, snapshot, undefined, 'create', 'request_key').error).toMatch(/capacidades/);
    expect(agentLifecycleRequest(draft, snapshot, capability, 'create', 'request_key').request).toBeDefined();
    expect(agentLifecycleRequest({ ...draft, homeDirectory: '/home-other/new' }, snapshot, capability, 'create', 'request_key').error).toMatch(/directorios/);
    expect(agentLifecycleRequest({ ...draft, runtimeUser: 'root' }, snapshot, capability, 'create', 'request_key').error).toMatch(/usuario/);
  });
  it('fails closed when snapshot revision is absent or the selected room disappeared', () => {
    const draft = agentLifecycleDraft(snapshot, { resource: 'agent', tenant_id: 'A', alias: 'one' });
    expect(agentLifecycleRequest(draft, { ...snapshot, revision: undefined }, capability, 'update', 'request_key').error).toMatch(/revisión/);
    expect(agentLifecycleRequest(draft, { ...snapshot, rooms: [] }, capability, 'update', 'request_key').error).toMatch(/grupos/);
  });
});
it('assigns the first runtime key only for an explicit durable null', () => {
  const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'one' };
  const inactive = { ...snapshot, agents: [{ ...snapshot.agents?.[0], runtime_key: null }] };
  const draft = { ...agentLifecycleDraft(inactive, target), runtimeKey: 'runtime-first', stateDirectory: '/state/runtime-first' };
  expect(agentLifecycleRequest(draft, inactive, capability, 'update', 'request_key', target).request).toBeDefined();
  const unknown = { ...snapshot, agents: [{ ...snapshot.agents?.[0], runtime_key: undefined }] };
  expect(agentLifecycleRequest(draft, unknown, capability, 'update', 'request_key', target).error).toMatch(/no está publicada/);
});

describe('missing role message', () => {
  it('names the membership role as the missing field', () => {
    const snapshot = { revision: 1, tenants: [{ id: 'A' }], rooms: [{ id: 'r1', tenant_id: 'A' }], harness_definitions: [{ id: 'openclaw' }] };
    const capability = { available: true, actions: ['create'], placements: [{ host_id: 'h', modes: ['native'], runtime_users: ['u'],
      systemd_users: [], home_roots: ['/home/u'], state_roots: ['/state'] }] } as never;
    const draft = { ...agentLifecycleDraft(snapshot), tenantId: 'A', alias: 'a', runtimeKey: 'a', harnessId: 'openclaw', hostId: 'h',
      runtimeUser: 'u', homeDirectory: '/home/u', stateDirectory: '/state/a', primaryRoomId: 'r1',
      memberships: [{ room_id: 'r1', role: '', enabled: true }] };
    expect(agentLifecycleRequest(draft, snapshot, capability, 'create', 'k').error).toMatch(/Falta el rol en la membresía del grupo "r1"/);
  });
});
