import { describe, expect, it } from 'vitest';
import type { ConfigurationSnapshot } from '../../api/types';
import { groupHasRuntime, groupOperationTarget, membershipMoveIntent } from './GroupMembershipModel';

const snapshot: ConfigurationSnapshot = { revision: 4,
  tenants: [{ id: 'A' }], rooms: [{ tenant_id: 'A', id: ' Sala ', enabled: true }, { tenant_id: 'A', id: 'Sala', enabled: true }],
  memberships: [{ tenant_id: 'A', room_id: ' Sala ', alias: 'one', role: 'agent', enabled: true }],
  agents: [{ tenant_id: 'A', alias: 'one', runtime_key: null, primary_room_id: ' Sala ' }] };
describe('group intent', () => {
  it('preserves exact room and tenant targets, and identifies physical dependents', () => {
    expect(groupOperationTarget('rooms', { tenant_id: 'A', id: ' Sala ' })).toEqual({ resource: 'room', tenant_id: 'A', room_id: ' Sala ' });
    expect(groupOperationTarget('tenants', { id: 'A' })).toEqual({ resource: 'tenant', tenant_id: 'A' });
    expect(groupOperationTarget('rooms', { tenant_id: 'A' })).toBeUndefined();
    expect(groupHasRuntime({ ...snapshot, agents: [{ ...snapshot.agents?.[0], runtime_key: 'physical-one' }] },
      { resource: 'room', tenant_id: 'A', room_id: ' Sala ' })).toBe(true);
  });
  it('moves inactive membership and primary FK atomically, without trimming the source key', () => {
    const result = membershipMoveIntent(snapshot, 'A', ' Sala ', 'one', 'Sala');
    expect(result.batch).toEqual({ resource: 'batch', action: 'apply', mutations: [
      { resource: 'membership', action: 'create', tenant_id: 'A', room_id: 'Sala', alias: 'one', value: { role: 'agent', enabled: true } },
      { resource: 'agent', action: 'update', tenant_id: 'A', alias: 'one', value: { primary_room_id: 'Sala' } },
      { resource: 'membership', action: 'delete', tenant_id: 'A', room_id: ' Sala ', alias: 'one' },
    ] });
  });
  it('moves a physical agent through fleet update and refuses unknown primary/runtime facts', () => {
    const physical = { ...snapshot, agents: [{ ...snapshot.agents?.[0], runtime_key: 'physical-one', harness_id: 'codex' }] };
    const result = membershipMoveIntent(physical, 'A', ' Sala ', 'one', 'Sala');
    expect(result.batch).toBeUndefined();
    expect(result.runtimeTarget).toEqual({ resource: 'agent', tenant_id: 'A', alias: 'one' });
    expect(result.runtimeDraft).toMatchObject({ runtimeKey: 'physical-one', primaryRoomId: 'Sala',
      memberships: [{ room_id: 'Sala', role: 'agent', enabled: true }] });
    expect(membershipMoveIntent({ ...snapshot, agents: [] }, 'A', ' Sala ', 'one', 'Sala').error).toMatch(/grupo primario/);
    expect(membershipMoveIntent({ ...snapshot, agents: [{ ...snapshot.agents?.[0], runtime_key: undefined }] }, 'A', ' Sala ', 'one', 'Sala').error).toMatch(/ejecución no está publicada/);
  });
});
