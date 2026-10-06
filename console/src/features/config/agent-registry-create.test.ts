import { describe, expect, it } from 'vitest';
import type { ConfigurationSnapshot } from '../../api/types';
import {
  agentRegistryCreateError, createAgentRegistryMutation, EMPTY_AGENT_REGISTRY_DRAFT,
  registryHarnessOptions, registryTenantOptions,
} from './agent-registry-create';

describe('agent registry create draft', () => {
  it('validates alias, capacity and all-or-nothing placement', () => {
    expect(agentRegistryCreateError(EMPTY_AGENT_REGISTRY_DRAFT))
      .toBe('Elige un espacio de trabajo del registro actual.');
    expect(agentRegistryCreateError({ ...EMPTY_AGENT_REGISTRY_DRAFT, tenantId: 'A', alias: 'good', displayName: 'Agent', harnessId: 'Bad' }))
      .toBe('El tipo de agente debe empezar con una letra minúscula y usar sólo letras minúsculas, números, guiones o guiones bajos, hasta 64 caracteres.');
    expect(agentRegistryCreateError({ ...EMPTY_AGENT_REGISTRY_DRAFT, tenantId: 'A', alias: 'Bad', displayName: 'Agent' }))
      .toBe('El alias debe empezar con una letra minúscula y usar sólo letras minúsculas, números, guiones o guiones bajos, hasta 64 caracteres.');
    expect(agentRegistryCreateError({ ...EMPTY_AGENT_REGISTRY_DRAFT, tenantId: 'A', alias: 'good', displayName: 'Agent', capacity: '0' }))
      .toMatch(/entre 1 y 100/);
    expect(agentRegistryCreateError({ ...EMPTY_AGENT_REGISTRY_DRAFT, tenantId: 'A', alias: 'good', displayName: 'Agent', containerName: 'container' }))
      .toBe('Completa los cuatro campos del entorno de ejecución o déjalos vacíos.');
  });

  it('rejects a previously selected tenant that is missing from the current snapshot', () => {
    const snapshot: ConfigurationSnapshot = { revision: 5, tenants: [{ id: 'B', display_name: 'Tenant B' }] };
    const draft = { ...EMPTY_AGENT_REGISTRY_DRAFT, tenantId: 'A', alias: 'worker', displayName: 'Worker' };
    expect(agentRegistryCreateError(draft, snapshot)).toBe('El espacio de trabajo elegido ya no está disponible. Elige uno del inventario actual para continuar.');
    expect(draft).toMatchObject({ tenantId: 'A', alias: 'worker', displayName: 'Worker' });
  });

  it('creates a disabled agent record with explicit capacity and no membership mutation', () => {
    const mutation = createAgentRegistryMutation({
      ...EMPTY_AGENT_REGISTRY_DRAFT, tenantId: 'Tenant', alias: 'worker_1', displayName: 'Worker',
    });
    expect(mutation).toEqual({
      resource: 'agent', action: 'create', tenant_id: 'Tenant', alias: 'worker_1',
      value: { display_name: 'Worker', enabled: false, max_concurrent_deliveries: 2 },
    });
    expect(mutation).not.toHaveProperty('room_id');
    expect(mutation).not.toHaveProperty('membership');
  });

  it('omits an unchosen harness and includes placement only as a complete tuple', () => {
    const mutation = createAgentRegistryMutation({
      ...EMPTY_AGENT_REGISTRY_DRAFT, tenantId: 'Tenant', alias: 'worker', displayName: 'Worker',
      harnessId: 'codex', containerName: 'worker-box', runtimeUser: 'runner',
      homeDirectory: '/home/runner', stateDirectory: '/var/lib/runner',
    });
    expect(mutation.value).toMatchObject({
      harness_id: 'codex', container_name: 'worker-box', runtime_user: 'runner',
      home_directory: '/home/runner', state_directory: '/var/lib/runner',
    });
  });

  it('uses only tenant and harness choices published in the snapshot', () => {
    const snapshot: ConfigurationSnapshot = {
      tenants: [{ id: 'Tenant', display_name: 'Visible tenant' }, { display_name: 'Missing id' }],
      harness_definitions: [{ id: 'codex' }, { harness_id: 'claude-code' }],
    };
    expect(registryTenantOptions(snapshot)).toEqual([{ id: 'Tenant', label: 'Visible tenant' }]);
    expect(registryHarnessOptions(snapshot)).toEqual(['claude-code', 'codex']);
  });
});
