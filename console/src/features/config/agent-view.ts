import type { FleetHost } from '@cauce/protocol/fleet-hosts';
import type { ConfigurationSnapshot } from '../../api/types';
import type { Tone } from '../../status-tone';
import type { LiveState } from '../live/agent-state';
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

/** Line under the agent name. The raw tenant id stays in `title` via `AgentView.ref`. */
export function subtituloDeAgente(agent: SettingsAgent, snapshot: ConfigurationSnapshot): string {
  const fila = snapshot.tenants?.find((row) => row.id === agent.tenantId);
  const nombre = typeof fila?.display_name === 'string' ? fila.display_name.trim() : '';
  if (nombre !== '' && nombre !== agent.name.trim()) return `${nombre} · ${agent.alias}`;
  return agent.alias;
}

/** What a tile and the sheet header both say about an agent, derived once. */
export function agentView(agent: SettingsAgent, snapshot: ConfigurationSnapshot, hosts: FleetHost[] | undefined): AgentView {
  const row = agentHostRow(snapshot, agent.tenantId, agent.alias);
  const hostId = agentHostIdOf(row);
  const host = hostById(hosts, hostId);
  const badge = insigniaDeComputadora(host);
  const state: AgentView['state'] = badge ? { label: badge, tone: 'warn' }
    : !agent.registered ? { label: 'Solo en grupos', tone: 'neutral' }
      : agent.enabled === false ? { label: 'En pausa', tone: 'warn' }
        : agent.enabled ? { label: 'Activo', tone: 'ok' } : { label: 'Estado desconocido', tone: 'neutral' };
  return {
    ref: `${agent.tenantId}/${agent.alias}`, row, hostId, host,
    hostName: host?.display_name ?? hostId ?? 'Sin computadora',
    hasRuntime: row?.runtime_key !== undefined && row.runtime_key !== null,
    state,
  };
}

const LIFECYCLE_LABEL: Record<string, string> = {
  draft: 'En borrador',
  ready: 'Listo para trabajar',
  auth_pending: 'Esperando inicio de sesión',
  retired: 'Retirado',
  failed: 'Con error',
};

/** Human label of the durable lifecycle state; an unknown value stays available via `title`, never as the main text. */
export function lifecycleLabel(state: string): string {
  return LIFECYCLE_LABEL[state] ?? 'Estado sin traducir';
}

/** Visible name of a tenant/space: its display name when it differs from the raw id. */
export function tenantName(snapshot: ConfigurationSnapshot, tenantId: string | null | undefined): string | undefined {
  if (!tenantId) return undefined;
  const row = snapshot.tenants?.find((entry) => entry.id === tenantId);
  const name = typeof row?.display_name === 'string' ? row.display_name.trim() : '';
  return name && name !== tenantId ? name : undefined;
}

export type SheetTab = 'resumen' | 'registro' | 'operacion' | 'grupos' | 'ampliaciones';

export const SHEET_TAB_LABEL: Record<SheetTab, string> = {
  resumen: 'Estado', registro: 'Ajustes', operacion: 'Ejecución', ampliaciones: 'Ampliaciones', grupos: 'Grupos',
};

/** One answer of the agent's status panel: a short verdict, its tone and one plain sentence. */
export interface StatusAnswer { label: string; tone: Tone; detail: string }

const RESPONDS: Record<LiveState, StatusAnswer> = {
  down: { label: 'No responde', tone: 'danger', detail: 'No está conectado: no va a tomar mensajes nuevos.' },
  blocked: { label: 'Trabado', tone: 'warn', detail: 'Tomó un mensaje y no avanza.' },
  delegating: { label: 'Responde', tone: 'ok', detail: 'Está trabajando junto con otro agente.' },
  settled: { label: 'Responde', tone: 'ok', detail: 'Acaba de terminar un mensaje.' },
  receiving: { label: 'Responde', tone: 'ok', detail: 'Le acaba de llegar un mensaje.' },
  thinking: { label: 'Responde', tone: 'ok', detail: 'Está trabajando en un mensaje.' },
  idle: { label: 'Responde', tone: 'ok', detail: 'Conectado y libre, esperando mensajes.' },
  unprepared: { label: 'Sin preparar', tone: 'neutral', detail: 'Su entorno todavía no está listo para trabajar.' },
};

/** Whether the agent answers, read from the shared fleet activity; the technical reason stays in `title`. */
export function respondsAnswer(state: LiveState | undefined): StatusAnswer {
  return state ? RESPONDS[state]
    : { label: 'Sin dato', tone: 'neutral', detail: 'La actividad de la flota no informa de este agente ahora mismo.' };
}

const SESSION: Record<string, StatusAnswer> = {
  ready: { label: 'Sesión activa', tone: 'ok', detail: 'Terminó de prepararse con la cuenta de su proveedor.' },
  auth_pending: { label: 'Falta iniciar sesión', tone: 'warn', detail: 'Pulsa «Iniciar sesión» para conectar la cuenta del proveedor.' },
  draft: { label: 'Sin preparar', tone: 'neutral', detail: 'Prepáralo desde «Ejecución» antes de iniciar sesión.' },
  failed: { label: 'Con error', tone: 'danger', detail: 'La última preparación falló. Revisa «Ejecución».' },
  retired: { label: 'Retirado', tone: 'neutral', detail: 'El agente está retirado y no usa su sesión.' },
};

/** The provider session as far as the durable lifecycle state tells it. */
export function sessionAnswer(lifecycleState: string | undefined): StatusAnswer {
  return (lifecycleState ? SESSION[lifecycleState] : undefined)
    ?? { label: 'Sin dato', tone: 'neutral', detail: 'El servidor no publicó el estado de su sesión.' };
}

/** `Tenant/alias` from the deep-link value; both halves must be present. */
export function parseAgentRef(value: string | null | undefined): { tenantId: string; alias: string } | undefined {
  const at = value?.indexOf('/') ?? -1;
  if (!value || at <= 0 || at === value.length - 1) return undefined;
  return { tenantId: value.slice(0, at), alias: value.slice(at + 1) };
}
