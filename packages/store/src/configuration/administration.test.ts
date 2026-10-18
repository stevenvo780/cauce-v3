import { describe, expect, it } from 'vitest';
import type { ConfigMutation } from '@cauce/protocol';
import type { CompanyAuthority, CompanyRole } from '../company-authority.js';
import type { DatabaseClient } from '../db.js';
import { authorizeConfigurationMutation, configurationCapabilities, isPlatformMutation } from './company-scope.js';
import type { ConfigurationCapabilities } from './contracts.js';
import * as shared from './shared.js';
import { ConfigurationMutations } from './mutations.js';
import { roomMutation, membershipMutation, tenantMutation } from './mutations/tenants.js';

function referenceClient(table: string, references: Record<string, unknown>[]) {
  const state = { deleted: false };
  const query = async (sql: string) => {
    if (sql.includes('FROM pg_constraint')) return { rows: [{
      table_name: table, columns: ['tenant_id', 'room_id'], target_columns: ['tenant_id', 'id'],
      identity_columns: ['id', 'tenant_id', 'room_id'],
    }], rowCount: 1 };
    if (sql.includes(' AS dependency_identity')) return { rows: references.map((identity) => ({ dependency_identity: identity })), rowCount: references.length };
    if (sql.startsWith('SELECT') && sql.includes('FROM rooms WHERE')) return { rows: [{ id: 'unused', tenant_id: 'Acme', display_name: null, enabled: true }], rowCount: 1 };
    if (sql.startsWith('DELETE')) state.deleted = true;
    return { rows: [], rowCount: 0 };
  };
  return { client: { query } as unknown as DatabaseClient, state };
}

function authority(role: CompanyRole, overrides: Partial<CompanyAuthority> = {}): CompanyAuthority {
  const scope = role === 'platform_admin' ? 'platform' : role === 'company_owner' || role === 'company_admin' ? 'company'
    : role === 'none' ? 'none' : 'tenant';
  return { humanId: null, homeTenant: 'Pablo', alias: 'midas', homeCompany: 'humanizar', actingCompany: 'humanizar',
    role, scope, platformOverride: false, ...overrides };
}

function capability(capabilities: ConfigurationCapabilities, resource: string) {
  return capabilities.resources.find((entry) => entry.resource === resource);
}

describe('configuration capabilities by company role', () => {
  it.each(['reader', 'none'] as const)('keeps a %s unable to mutate every configuration resource', (role) => {
    const capabilities = configurationCapabilities(authority(role));
    expect(capabilities.actor).toEqual({ tenant_id: 'Pablo', alias: 'midas', can_control: false, role, scope: role === 'none' ? 'none' : 'tenant',
      company_id: 'humanizar', platform_override: false });
    expect(capabilities.resources.every((resource) => resource.actions.length === 0 && resource.scope === 'none')).toBe(true);
  });

  it('gives a tenant operator its own tenant and outgoing ACL without registry, accounts or catalogs', () => {
    const capabilities = configurationCapabilities(authority('tenant_operator', { homeTenant: 'Steven', alias: 'kant' }));
    expect(capability(capabilities, 'room')).toEqual({ resource: 'room', actions: ['create', 'update', 'delete', 'retire', 'restore'], scope: 'tenant', tenant_id: 'Steven' });
    expect(capability(capabilities, 'acl_edge')).toMatchObject({ scope: 'outgoing_acl', tenant_id: 'Steven' });
    for (const resource of ['tenant', 'agent', 'provider_account', 'alias_routing_ceiling', 'agent_account_binding', 'chain_policy', 'fleet_host']) {
      expect(capability(capabilities, resource), resource).toMatchObject({ actions: [], scope: 'none' });
    }
  });

  it.each(['company_owner', 'company_admin', 'platform_admin'] as const)('opens the whole company to a %s', (role) => {
    const capabilities = configurationCapabilities(authority(role));
    for (const resource of ['tenant', 'room', 'membership', 'acl_edge', 'egress_destination', 'agent', 'agent_account_binding']) {
      expect(capability(capabilities, resource), resource).toMatchObject({ scope: 'company' });
    }
    expect(capability(capabilities, 'alias_routing_ceiling')).toMatchObject({ actions: ['create', 'delete'], scope: 'company' });
    expect(capability(capabilities, 'provider_account')).toMatchObject(role === 'company_admin'
      ? { actions: [], scope: 'none' } : { actions: ['create', 'update', 'delete'], scope: 'company' });
    expect(capability(capabilities, 'fleet_host')).toMatchObject(role === 'platform_admin'
      ? { actions: ['create', 'update', 'delete'], scope: 'platform' } : { actions: ['update', 'delete'], scope: 'company' });
    expect(capability(capabilities, 'chain_policy')).toMatchObject(role === 'platform_admin'
      ? { actions: ['update'], scope: 'platform' } : { actions: [], scope: 'none' });
  });

  it('never offers harnesses, role policies or canonical profiles, not even to the platform', () => {
    const capabilities = configurationCapabilities(authority('platform_admin', { actingCompany: 'praxis', platformOverride: true }));
    expect(capabilities.actor).toMatchObject({ company_id: 'praxis', platform_override: true, scope: 'platform' });
    for (const resource of ['harness', 'role_policy', 'agent_profile']) {
      expect(capability(capabilities, resource), resource).toMatchObject({ actions: [], scope: 'none' });
    }
    expect(JSON.stringify(capabilities)).not.toContain('hub');
  });

  it('authorizes leaves against the scope and rejects mixed or catalog batches', () => {
    const operator = configurationCapabilities(authority('tenant_operator'));
    const platform = configurationCapabilities(authority('platform_admin'));
    const room = { resource: 'room', action: 'create', tenant_id: 'Pablo', id: 'own', value: {} } as const;
    expect(() => { authorizeConfigurationMutation(room, operator); }).not.toThrow();
    expect(() => { authorizeConfigurationMutation({ ...room, tenant_id: 'Steven' }, operator); }).toThrow(/outside the actor tenant/u);
    expect(() => { authorizeConfigurationMutation({ resource: 'acl_edge', action: 'create', from_tenant: 'Steven', to_tenant: 'Pablo', value: {} }, operator); })
      .toThrow(/outside the actor tenant/u);
    expect(() => { authorizeConfigurationMutation({ resource: 'egress_destination', action: 'create', tenant_id: 'Pablo', alias: 'midas', handle: 'group',
      value: { require_prior_contact: false } }, operator); }).toThrow(/prior contact/u);
    expect(() => { authorizeConfigurationMutation({ resource: 'harness', action: 'update', id: 'codex', value: {} }, platform); })
      .toThrow(/platform CLI/u);
    expect(() => { authorizeConfigurationMutation({ resource: 'batch', action: 'apply', mutations: [
      { resource: 'chain_policy', action: 'update', id: 'default', value: {} }, room,
    ] }, platform); }).toThrow(/cannot mix platform catalogs and company resources/u);
    expect(isPlatformMutation({ resource: 'chain_policy', action: 'update', id: 'default', value: {} })).toBe(true);
  });
});

describe('configuration delete dependencies', () => {
  const mutation: ConfigMutation = { resource: 'room', action: 'delete', tenant_id: 'Acme', id: 'unused' };

  it('reports completed historical messages using only permitted identity fields', async () => {
    const { client } = referenceClient('messages', [{ id: 'message-1', tenant_id: 'Acme', room_id: 'unused', body: 'PRIVATE_BODY', credential_ref: 'PRIVATE_REF' }]);
    const dependencies = await shared.configurationDependencies(client, mutation);
    expect(dependencies).toEqual([{ type: 'messages', identity: { id: 'message-1', tenant_id: 'Acme', room_id: 'unused' }, blocking: true }]);
    expect(JSON.stringify(dependencies)).not.toContain('PRIVATE');
  });

  it('blocks physical room deletion even when the only reference is historical', async () => {
    const { client, state } = referenceClient('messages', [{ id: 'done-message', tenant_id: 'Acme', room_id: 'unused' }]);
    await expect(roomMutation(client, mutation)).rejects.toMatchObject({ code: 'conflict', dependencies: [{ type: 'messages', identity: { id: 'done-message', tenant_id: 'Acme', room_id: 'unused' }, blocking: true }] });
    expect(state.deleted).toBe(false);
  });

  it('deletes a room once every explicit dependency has been removed and preserves its inverse', async () => {
    const { client, state } = referenceClient('messages', []);
    expect(await roomMutation(client, mutation)).toEqual({
      inverse: { resource: 'room', action: 'create', tenant_id: 'Acme', id: 'unused', value: { display_name: null, enabled: true } },
      summary: 'delete room unused',
    });
    expect(state.deleted).toBe(true);
  });

  it.each(['tenant', 'membership'] as const)('allows deleting unused %s after explicit dependencies are removed', async (resource) => {
    let deleted = false;
    const query = async (sql: string) => {
      if (sql.startsWith('SELECT id,display_name')) return { rows: [{ id: 'Acme', display_name: null, is_hub: false, enabled: true }], rowCount: 1 };
      if (sql.startsWith('SELECT role,enabled')) return { rows: [{ role: 'agent', enabled: true }], rowCount: 1 };
      if (sql.startsWith('DELETE')) deleted = true;
      return { rows: [], rowCount: 0 };
    };
    const client = { query } as unknown as DatabaseClient;
    const result = resource === 'tenant'
      ? await tenantMutation(client, { resource, action: 'delete', id: 'Acme' }, 'humanizar')
      : await membershipMutation(client, { resource, action: 'delete', tenant_id: 'Acme', room_id: 'unused', alias: 'unused' });
    expect(result.inverse).toMatchObject({ resource, action: 'create', value: { enabled: true } });
    expect(deleted).toBe(true);
  });
});

describe('recoverable configuration retirement', () => {
  it.each([['tenant', false], ['room', false], ['membership', false], ['tenant', true], ['room', true], ['membership', true]] as const)('retires and restores %s with previous enabled=%s', async (resource, previouslyEnabled) => {
    const row = { id: 'unused', tenant_id: 'Acme', role: 'agent', display_name: null, is_hub: false,
      enabled: previouslyEnabled, retired_at: null as string | null, retired_enabled: null as boolean | null };
    const query = async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('SELECT')) return { rows: [{ ...row }], rowCount: 1 };
      if (sql.startsWith('UPDATE')) {
        const values = params.slice(-3);
        row.enabled = values[0] as boolean;
        row.retired_at = values[1] as string | null;
        row.retired_enabled = values[2] as boolean | null;
      }
      return { rows: [], rowCount: 0 };
    };
    const client = { query } as unknown as DatabaseClient;
    const invoke = async (action: 'retire' | 'restore') => {
      if (resource === 'tenant') return tenantMutation(client, { resource, action, id: 'Acme' }, 'humanizar');
      if (resource === 'room') return roomMutation(client, { resource, action, tenant_id: 'Acme', id: 'unused' });
      return membershipMutation(client, { resource, action, tenant_id: 'Acme', room_id: 'unused', alias: 'unused' });
    };
    const retired = await invoke('retire');
    expect(retired.inverse).toMatchObject({ resource, action: 'restore' });
    expect(row).toMatchObject({ enabled: false, retired_enabled: previouslyEnabled });
    expect(typeof row.retired_at).toBe('string');
    const restored = await invoke('restore');
    expect(restored.inverse).toMatchObject({ resource, action: 'retire' });
    expect(row).toMatchObject({ enabled: previouslyEnabled, retired_enabled: null, retired_at: null });
  });
});

class MutationExecutor extends ConfigurationMutations {
  run(client: DatabaseClient, mutation: ConfigMutation) { return this.execute(client, mutation, 'humanizar'); }
}

describe('atomic configuration inverse composition', () => {
  it('restores cascaded account bindings with their previous priority and disabled flag', async () => {
    const state = { ceiling: true, binding: { priority: 7, enabled: false } as { priority: number; enabled: boolean } | null };
    const query = async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('SELECT 1 FROM alias_routing_ceiling')) return { rows: state.ceiling ? [{}] : [], rowCount: state.ceiling ? 1 : 0 };
      if (sql.includes('SELECT priority,enabled FROM agent_account_bindings')) return { rows: state.binding ? [{ ...state.binding }] : [], rowCount: state.binding ? 1 : 0 };
      if (sql.includes('SELECT payer_tenant_id')) return { rows: [{ payer_tenant_id: 'Steven' }], rowCount: 1 };
      if (sql.startsWith('DELETE FROM alias_routing_ceiling')) { state.ceiling = false; state.binding = null; }
      if (sql.includes('INSERT INTO alias_routing_ceiling')) state.ceiling = true;
      if (sql.includes('INSERT INTO agent_account_bindings')) state.binding = { priority: params[3] as number, enabled: params[4] as boolean };
      return { rows: [], rowCount: 0 };
    };
    const client = { query } as unknown as DatabaseClient;
    const executor = new MutationExecutor();
    const deleted = await executor.run(client, { resource: 'alias_routing_ceiling', action: 'delete', tenant_id: 'Steven', alias: 'kant', account_id: 'codex' });
    expect(state).toEqual({ ceiling: false, binding: null });
    expect(deleted.inverse).toEqual({ resource: 'batch', action: 'apply', mutations: [
      { resource: 'alias_routing_ceiling', action: 'create', tenant_id: 'Steven', alias: 'kant', account_id: 'codex' },
      { resource: 'agent_account_binding', action: 'create', tenant_id: 'Steven', agent_alias: 'kant', account_id: 'codex', value: { priority: 7, enabled: false } },
    ] });
    await executor.run(client, deleted.inverse);
    expect(state).toEqual({ ceiling: true, binding: { priority: 7, enabled: false } });
  });
});

describe('configuration dependency completeness', () => {
  it('detects composite foreign keys with immutable columns absent from the mutation', async () => {
    const query = async (sql: string) => {
      if (sql.includes('FROM pg_constraint')) return { rows: [{ table_name: 'alias_routing_ceiling', columns: ['account_id', 'account_payer_tenant'], target_columns: ['id', 'payer_tenant_id'], identity_columns: ['tenant_id', 'alias', 'account_id'] }], rowCount: 1 };
      if (sql.includes(' AS dependency_identity')) return { rows: [{ dependency_identity: { tenant_id: 'Isa', alias: 'iris', account_id: 'codex' } }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    expect(await shared.configurationDependencies({ query } as unknown as DatabaseClient, { resource: 'provider_account', action: 'delete', id: 'codex' }))
      .toEqual([{ type: 'alias_routing_ceiling', identity: { tenant_id: 'Isa', alias: 'iris', account_id: 'codex' }, blocking: true }]);
  });

  it('preserves revoked historical alias identities even when their journal has no foreign key', async () => {
    const query = async (sql: string) => {
      if (sql.includes('FROM pg_class source')) return { rows: [{ table_name: 'agent_document_revisions', columns: ['tenant_id', 'alias'], target_columns: ['tenant_id', 'alias'], identity_columns: ['id'] }], rowCount: 1 };
      if (sql.includes(' AS dependency_identity')) return { rows: [{ dependency_identity: { id: '77', path: 'PRIVATE_PATH', body: 'PRIVATE_BODY' } }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    expect(await shared.configurationDependencies({ query } as unknown as DatabaseClient, { resource: 'agent', action: 'delete', tenant_id: 'Steven', alias: 'kant' }))
      .toEqual([{ type: 'agent_document_revisions', identity: { id: '77' }, blocking: true }]);
  });

  it('keeps a deleted retired room retired in its composed inverse', async () => {
    const query = async (sql: string) => {
      if (sql.startsWith('SELECT id,tenant_id')) return { rows: [{ id: 'retired', tenant_id: 'Acme', display_name: null, enabled: false, retired_at: '2026-10-07T00:00:00.000Z', retired_enabled: true }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    expect((await roomMutation({ query } as unknown as DatabaseClient, { resource: 'room', action: 'delete', tenant_id: 'Acme', id: 'retired' })).inverse)
      .toEqual({ resource: 'batch', action: 'apply', mutations: [
        { resource: 'room', action: 'create', tenant_id: 'Acme', id: 'retired', value: { display_name: null, enabled: true } },
        { resource: 'room', action: 'retire', tenant_id: 'Acme', id: 'retired' },
      ] });
  });
});

describe('routing ceiling dependency preview', () => {
  it('shows bindings affected by revocation as restorable dependencies', async () => {
    const query = async (sql: string) => {
      if (sql.includes('FROM pg_constraint')) return { rows: [{ table_name: 'agent_account_bindings', columns: ['tenant_id', 'agent_alias', 'account_id'], target_columns: ['tenant_id', 'alias', 'account_id'], identity_columns: ['tenant_id', 'agent_alias', 'account_id'] }], rowCount: 1 };
      if (sql.includes(' AS dependency_identity')) return { rows: [{ dependency_identity: { tenant_id: 'Steven', agent_alias: 'kant', account_id: 'codex' } }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    expect(await shared.configurationDependencies({ query } as unknown as DatabaseClient, { resource: 'alias_routing_ceiling', action: 'delete', tenant_id: 'Steven', alias: 'kant', account_id: 'codex' }))
      .toEqual([{ type: 'agent_account_bindings', identity: { tenant_id: 'Steven', agent_alias: 'kant', account_id: 'codex' }, blocking: false }]);
  });
});
