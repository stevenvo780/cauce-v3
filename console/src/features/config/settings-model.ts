import type { ConfigurationSnapshot } from '../../api/types';

type Row = Record<string, unknown>;
interface SettingsGroup {
  id: string;
  label: string;
  enabled: boolean | undefined;
}
export interface SettingsAgent {
  key: string;
  tenantId: string;
  alias: string;
  name: string;
  registered: boolean;
  enabled: boolean | undefined;
  harness: string | undefined;
  responsibility: string | undefined;
  groups: SettingsGroup[];
  groupsKnown: boolean;
}

function text(row: Row | undefined, key: string): string | undefined {
  const value = row?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function flag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
function identity(row: Row): [string, string] | undefined {
  const tenant = text(row, 'tenant_id');
  const alias = text(row, 'alias');
  return tenant && alias ? [tenant, alias] : undefined;
}

export function settingsAgents(snapshot: ConfigurationSnapshot): SettingsAgent[] {
  const identities = new Map<string, [string, string]>();
  for (const row of [...snapshot.agents ?? [], ...snapshot.memberships ?? []]) {
    const pair = identity(row);
    if (pair) identities.set(JSON.stringify(pair), pair);
  }
  return [...identities].map(([key, [tenantId, alias]]) => {
    const matches = (row: Row) => row.tenant_id === tenantId && row.alias === alias;
    const agent = snapshot.agents?.find(matches);
    const profile = snapshot.agent_profiles?.find(matches);
    const groups = new Map<string, SettingsGroup>();
    for (const membership of snapshot.memberships?.filter(matches) ?? []) {
      const id = text(membership, 'room_id');
      if (!id) continue;
      const room = snapshot.rooms?.find((row) => row.tenant_id === tenantId && row.id === id);
      groups.set(id, { id, label: text(room, 'display_name') ?? id, enabled: flag(membership.enabled) });
    }
    return {
      key, tenantId, alias, name: text(agent, 'display_name') ?? alias,
      registered: agent !== undefined, enabled: flag(agent?.enabled),
      harness: text(agent, 'harness_id'), responsibility: text(profile, 'role_summary'),
      groups: [...groups.values()].sort((a, b) => a.label.localeCompare(b.label)),
      groupsKnown: Array.isArray(snapshot.memberships),
    };
  }).sort((a, b) => a.tenantId.localeCompare(b.tenantId) || a.alias.localeCompare(b.alias));
}

export function filterSettingsAgents(agents: readonly SettingsAgent[], query: string): SettingsAgent[] {
  const term = query.trim().toLocaleLowerCase();
  return agents.filter((agent) => [
    agent.name, agent.alias, agent.tenantId, agent.harness ?? '', agent.responsibility ?? '',
    ...agent.groups.flatMap((group) => [group.id, group.label]),
  ].some((value) => value.toLocaleLowerCase().includes(term)));
}
