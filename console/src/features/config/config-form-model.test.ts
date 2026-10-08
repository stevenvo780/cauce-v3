import { describe, expect, it } from 'vitest';
import type { ConfigAction, ConfigurationSnapshot } from '../../api/types';
import { buildFormMutation, configFormDefinition, configFormValues } from './config-form-model';

const existingActions = ['update', 'delete', 'retire', 'restore'] as const;

function definition(collection: string) {
  const result = configFormDefinition(collection);
  if (!result) throw new Error('form definition missing');
  return result;
}

function changedValues(action: ConfigAction, initial: Record<string, string>): Record<string, string> {
  return action === 'update' ? { ...initial, display_name: 'Nombre actualizado', role: 'observer', enabled: 'false' } : initial;
}

describe('existing configuration identity', () => {
  it.each(existingActions)('keeps the exact room key for %s when a trimmed sibling has the same label', (action) => {
    const snapshot: ConfigurationSnapshot = { rooms: [
      { tenant_id: 'Miguel', id: ' Sala ', display_name: 'Sala compartida', enabled: true },
      { tenant_id: 'Miguel', id: 'Sala', display_name: 'Sala compartida', enabled: true },
    ] };
    const form = definition('rooms');
    const initial = configFormValues(form, action, snapshot.rooms?.[0]);
    const mutation = buildFormMutation(form, action, changedValues(action, initial), initial);
    expect(mutation).toMatchObject({ resource: 'room', action, tenant_id: 'Miguel', id: ' Sala ' });
    expect(mutation.id).not.toBe(snapshot.rooms?.[1]?.id);
  });

  it.each(existingActions)('uses the snapshot identity rather than changed form keys for %s', (action) => {
    const form = definition('rooms');
    const initial = configFormValues(form, action, { tenant_id: 'Miguel', id: ' Sala ', display_name: 'Nombre', enabled: true });
    const values = { ...changedValues(action, initial), tenant_id: 'Steven', id: 'Sala' };
    expect(buildFormMutation(form, action, values, initial)).toMatchObject({ tenant_id: 'Miguel', id: ' Sala ' });
  });

  it.each(existingActions)('preserves every membership key for %s including whitespace in room_id', (action) => {
    const form = definition('memberships');
    const initial = configFormValues(form, action, { tenant_id: 'Miguel', room_id: ' Sala ', alias: 'jarvis', role: 'agent', enabled: true });
    const values = { ...changedValues(action, initial), tenant_id: 'Steven', room_id: 'Sala', alias: 'another' };
    expect(buildFormMutation(form, action, values, initial)).toMatchObject({ resource: 'membership', action,
      tenant_id: 'Miguel', room_id: ' Sala ', alias: 'jarvis' });
  });

  it.each(existingActions)('preserves a tenant key for %s even if the form state contains another valid tenant', (action) => {
    const form = definition('tenants');
    const initial = configFormValues(form, action, { id: 'Miguel', display_name: 'Nombre', enabled: true });
    expect(buildFormMutation(form, action, { ...changedValues(action, initial), id: 'Steven' }, initial)).toMatchObject({ id: 'Miguel' });
  });

  it.each([
    ['tenants', { id: ' Miguel ', display_name: 'Nombre', enabled: true }],
    ['memberships', { tenant_id: 'Miguel', room_id: ' Sala ', alias: ' jarvis ', role: 'agent', enabled: true }],
  ] as const)('does not normalize an invalid legacy identity from %s into another valid target', (collection, row) => {
    const form = definition(collection);
    const initial = configFormValues(form, 'delete', row);
    expect(() => buildFormMutation(form, 'delete', initial, initial)).toThrow(/valor no válido/i);
  });

  it('trims newly entered create identities and edited labels while keeping existing keys exact', () => {
    const form = definition('rooms');
    const initial = configFormValues(form, 'create');
    expect(buildFormMutation(form, 'create', { ...initial, tenant_id: ' Miguel ', id: ' Sala ', display_name: ' Nombre ' }, initial))
      .toMatchObject({ tenant_id: 'Miguel', id: 'Sala', value: { display_name: 'Nombre' } });
  });
});
