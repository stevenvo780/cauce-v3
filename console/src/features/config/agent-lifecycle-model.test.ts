import { describe, expect, it } from 'vitest';
import type { FleetCapability } from '@cauce/protocol/fleet-operation';
import type { ConfigurationSnapshot } from '../../api/types';
import { agentLifecycleDraft, agentLifecycleRequest, lifecycleOptions } from './agent-lifecycle-model';

const snapshot: ConfigurationSnapshot = { revision: 4, tenants: [{ id: 'A' }],
  rooms: [{ tenant_id: 'A', id: ' Sala ', display_name: 'Sala' }, { tenant_id: 'A', id: 'Sala', display_name: 'Sala' }],
  agents: [{ tenant_id: 'A', alias: 'one', runtime_key: 'runtime-one', host_id: 'test-host', mode: 'native', harness_id: 'codex',
    primary_room_id: ' Sala ', runtime_user: 'runner', home_directory: '/home/runner', state_directory: '/state/runtime-one' }],
  memberships: [{ tenant_id: 'A', alias: 'one', room_id: ' Sala ', role: 'rol con espacios', enabled: false }],
  harness_definitions: [{ id: 'codex' }], provider_accounts: [] };
const capability: FleetCapability = { available: true, actions: ['create', 'update'], placements: [{ host_id: 'test-host',
  modes: ['native'], runtime_users: ['runner'], systemd_users: ['runner'], home_roots: ['/home/runner'], state_roots: ['/state'] }] };

describe('agent lifecycle intent', () => {
  it('preserves exact identities, memberships and immutable physical key on update', () => {
    const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'one' };
    const draft = agentLifecycleDraft(snapshot, target);
    expect(lifecycleOptions(snapshot, 'rooms', 'A').map((option) => option.id)).toEqual([' Sala ', 'Sala']);
    const result = agentLifecycleRequest({ ...draft, runtimeKey: 'other-runtime' }, snapshot, capability, 'update', 'request_key', target);
    expect(result.error).toMatch(/inmutable/);
    const valid = agentLifecycleRequest(draft, snapshot, capability, 'update', 'request_key', target);
    expect(valid.request).toMatchObject({ target, parameters: { runtime_key: 'runtime-one', primary_room_id: ' Sala ',
      memberships: [{ room_id: ' Sala ', role: 'rol con espacios', enabled: false }] } });
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
