import type { ConfigurationSnapshot } from '../../api/types';

type AgentRegistryEntry =
  | { state: 'registry-unavailable' }
  | { state: 'agent-missing' }
  | { state: 'found'; row: Record<string, unknown>; roleBrief: string };

/** Keeps an unavailable registry, a missing row and an explicitly empty role as distinct facts. */
export function selectAgentRegistryEntry(
  snapshot: ConfigurationSnapshot | undefined,
  tenantId: string,
  alias: string,
): AgentRegistryEntry {
  const agents = snapshot?.agents;
  if (!Array.isArray(agents)) return { state: 'registry-unavailable' };

  const row = agents.find((candidate) => (
    candidate.tenant_id === tenantId && candidate.alias === alias
  ));
  if (!row) return { state: 'agent-missing' };

  return {
    state: 'found',
    row,
    roleBrief: typeof row.role_brief === 'string' ? row.role_brief : '',
  };
}
