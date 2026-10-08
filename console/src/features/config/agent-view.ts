import type { FleetHost } from '@cauce/protocol/fleet-hosts';
import type { ConfigurationSnapshot } from '../../api/types';
import type { Tone } from '../../status-tone';
import { agentHostIdOf, agentHostRow } from './agent-registry-create';
import { insigniaDeComputadora } from './fleet-host-model';
import type { SettingsAgent } from './settings-model';
import { hostById } from './use-fleet-hosts';

export interface AgentView {
  ref: string;
  row: Record<string, unknown> | undefined;
  hostId: string | undefined;
  host: FleetHost | undefined;
  hostName: string;
  hasRuntime: boolean;
  state: { label: string; tone: Tone };
}

/** What a tile and the sheet header both say about an agent, derived once. */
export function agentView(agent: SettingsAgent, snapshot: ConfigurationSnapshot, hosts: FleetHost[] | undefined): AgentView {
  const row = agentHostRow(snapshot, agent.tenantId, agent.alias);
  const hostId = agentHostIdOf(row);
  const host = hostById(hosts, hostId);
  const badge = insigniaDeComputadora(host);
  const state: AgentView['state'] = badge ? { label: badge, tone: 'warn' }
    : !agent.registered ? { label: 'Solo miembro', tone: 'neutral' }
      : agent.enabled === false ? { label: 'Registro deshabilitado', tone: 'warn' }
        : agent.enabled ? { label: 'Habilitado', tone: 'ok' } : { label: 'Estado desconocido', tone: 'neutral' };
  return {
    ref: `${agent.tenantId}/${agent.alias}`, row, hostId, host,
    hostName: host?.display_name ?? hostId ?? 'Sin computadora',
    hasRuntime: row?.runtime_key !== undefined && row.runtime_key !== null,
    state,
  };
}

export type SheetTab = 'resumen' | 'registro' | 'operacion' | 'grupos';

/** `Tenant/alias` from the deep-link value; both halves must be present. */
export function parseAgentRef(value: string | null | undefined): { tenantId: string; alias: string } | undefined {
  const at = value?.indexOf('/') ?? -1;
  if (!value || at <= 0 || at === value.length - 1) return undefined;
  return { tenantId: value.slice(0, at), alias: value.slice(at + 1) };
}
