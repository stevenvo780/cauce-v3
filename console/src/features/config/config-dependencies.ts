import type { ApiDependency } from '../../api/client/core';

const LABELS: Record<string, string> = {
  memberships: 'membresías en grupos', agent_profiles: 'perfil del agente', agent_profile_revisions: 'historial del perfil',
  agent_appearances: 'apariencia', agent_account_bindings: 'cuentas vinculadas', alias_routing_ceiling: 'techos de ruteo',
  egress_destinations: 'destinos de avisos', agent_sealing_keys: 'llaves de sellado', console_agent_favorites: 'favoritos',
  agent_context_state: 'estado de contexto', agent_context_versions: 'versiones de contexto', agent_context_outbox: 'cola de contexto',
  agent_role_brief_history: 'historial del rol', audit_events: 'auditoría', messages: 'mensajes', deliveries: 'entregas',
  connection_leases: 'conexiones activas', terminal_sessions: 'sesiones de terminal', config_revisions: 'revisiones de configuración',
  human_tenant_memberships: 'personas del espacio', console_users: 'cuentas de personas', company_agent_roles: 'roles de la empresa',
  fleet_runtime_identities: 'identidad de ejecución', agent_quota_observations: 'observaciones de cuota', rooms: 'grupos', agents: 'agentes',
  acl_edges: 'permisos entre clientes', provider_accounts: 'cuentas de proveedor', delivery_lane_fairness: 'reparto de entregas',
  agent_chain_closures: 'cierres de cadenas', agent_chain_progress: 'progreso de cadenas',
};

function detail(type: string, entries: readonly ApiDependency[]): string {
  const rooms = type === 'memberships' ? entries.flatMap((entry) => typeof entry.identity.room_id === 'string' ? [entry.identity.room_id] : []) : [];
  const listed = rooms.length ? `: ${[...new Set(rooms)].slice(0, 5).join(', ')}` : '';
  return `${LABELS[type] ?? type} (${String(entries.length)}${entries.length > 100 ? '+' : ''}${listed})`;
}

/** The blocking dependencies the server returned with a 409, grouped by what they are, in Spanish. */
export function dependencySummary(dependencies: readonly ApiDependency[]): string | undefined {
  const blocking = dependencies.filter((dependency) => dependency.blocking);
  if (!blocking.length) return undefined;
  const groups = new Map<string, ApiDependency[]>();
  for (const dependency of blocking) groups.set(dependency.type, [...groups.get(dependency.type) ?? [], dependency]);
  return [...groups].map(([type, entries]) => detail(type, entries)).join(', ');
}
