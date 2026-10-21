import {
  AgentExtensionsSchema, ExtensionsAllowedSchema, agentExtensionsHarnessViolation, agentExtensionsPolicyViolation,
  type AgentExtensions, type ConfigMutation, type ExtensionsAllowed,
} from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { runtimePrincipalScopeSql } from '../../repository/system-principal-scope.js';
import { ConfigurationError, type ConfigurationLeafMutation } from '../contracts.js';

export async function agentExtensionsMutation(
  client: DatabaseClient, mutation: Extract<ConfigurationLeafMutation, { resource: 'agent_extensions' }>, company: string,
): Promise<{ inverse: ConfigMutation; summary: string }> {
  const parsed = AgentExtensionsSchema.safeParse(mutation.extensions);
  if (!parsed.success) throw new ConfigurationError('invalid_input', parsed.error.message);
  const agent = (await client.query<{ host_id: string | null; harness_id: string; extensions: AgentExtensions; retired_at: Date | null; runtime_mode: string | null }>(
    `SELECT host_id,harness_id,extensions,retired_at,runtime_mode FROM agents WHERE tenant_id=$1 AND alias=$2 AND company_id=$3 AND purged_at IS NULL
      AND ${runtimePrincipalScopeSql('agents.tenant_id', 'agents.alias')} FOR UPDATE`,
    [mutation.tenant_id, mutation.alias, company],
  )).rows[0];
  if (!agent) throw new ConfigurationError('not_found', 'agent was not found');
  if (agent.retired_at) throw new ConfigurationError('conflict', 'restore the retired agent before editing its extensions');
  if (parsed.data.length > 0 && agent.runtime_mode !== 'container') {
    throw new ConfigurationError('conflict', 'Las ampliaciones requieren un agente en contenedor.');
  }
  const harnessViolation = agentExtensionsHarnessViolation(parsed.data, agent.harness_id);
  if (harnessViolation) throw new ConfigurationError('conflict', harnessViolation);
  const host = agent.host_id === null ? undefined : (await client.query<{ extensions_allowed: ExtensionsAllowed }>(
    'SELECT extensions_allowed FROM fleet_hosts WHERE host_id=$1 AND company_id=$2 FOR SHARE', [agent.host_id, company],
  )).rows[0];
  const violation = agentExtensionsPolicyViolation(parsed.data,
    host?.extensions_allowed ?? { types: [], mount_roots: [], networks: [] });
  if (violation) throw new ConfigurationError('conflict', `El ordenador del agente ${mutation.alias} no admite la ampliación: ${violation}`);
  await client.query('UPDATE agents SET extensions=$4::jsonb,updated_at=now() WHERE tenant_id=$1 AND alias=$2 AND company_id=$3',
    [mutation.tenant_id, mutation.alias, company, JSON.stringify(parsed.data)]);
  return {
    inverse: { resource: 'agent_extensions', action: 'set', tenant_id: mutation.tenant_id, alias: mutation.alias, extensions: agent.extensions },
    summary: `set extensions for agent ${mutation.alias}; recreate its container preserving volumes before runtime adoption`,
  };
}

export async function hostExtensionsAllowedMutation(
  client: DatabaseClient, mutation: Extract<ConfigurationLeafMutation, { resource: 'host_extensions_allowed' }>, company: string,
): Promise<{ inverse: ConfigMutation; summary: string }> {
  const parsed = ExtensionsAllowedSchema.safeParse(mutation.extensions_allowed);
  if (!parsed.success) throw new ConfigurationError('invalid_input', parsed.error.message);
  const host = (await client.query<{ extensions_allowed: ExtensionsAllowed }>(
    'SELECT extensions_allowed FROM fleet_hosts WHERE host_id=$1 AND company_id=$2 FOR UPDATE', [mutation.host_id, company],
  )).rows[0];
  if (!host) throw new ConfigurationError('not_found', 'fleet host was not found');
  const agents = await client.query<{ tenant_id: string; alias: string; extensions: AgentExtensions }>(
    'SELECT tenant_id,alias,extensions FROM agents WHERE host_id=$1 AND company_id=$2 AND purged_at IS NULL ORDER BY tenant_id,alias FOR SHARE',
    [mutation.host_id, company],
  );
  for (const agent of agents.rows) {
    const violation = agentExtensionsPolicyViolation(agent.extensions, parsed.data);
    if (violation) throw new ConfigurationError('conflict',
      `La política dejaría sin permiso al agente ${agent.tenant_id}/${agent.alias}: ${violation} Quita primero su ampliación y recrea su contenedor.`);
  }
  await client.query('UPDATE fleet_hosts SET extensions_allowed=$3::jsonb,version=version+1,updated_at=now() WHERE host_id=$1 AND company_id=$2',
    [mutation.host_id, company, JSON.stringify(parsed.data)]);
  return {
    inverse: { resource: 'host_extensions_allowed', action: 'set', host_id: mutation.host_id, extensions_allowed: host.extensions_allowed },
    summary: `set allowed extensions for host ${mutation.host_id}; download its signed setup package before runtime adoption`,
  };
}
