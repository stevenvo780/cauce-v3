import { FleetOperationRequestSchema, matchingFleetRuntime, type FleetCapability, type FleetOperationRequest, type FleetTarget } from '@cauce/protocol/fleet-operation';
import type { ConfigurationSnapshot } from '../../api/types';

export interface AgentLifecycleDraft {
  tenantId: string; alias: string; displayName: string; runtimeKey: string; harnessId: string;
  hostId: string; mode: 'native' | 'container'; containerName: string; runtimeUser: string;
  systemdUser: string; homeDirectory: string; stateDirectory: string; primaryAccountId: string; modelId: string;
  primaryRoomId: string; memberships: { room_id: string; role: string; enabled: boolean }[];
  reasoningEffort?: string;
}
const text = (row: Record<string, unknown> | undefined, key: string) => typeof row?.[key] === 'string' ? row[key] : '';
/** Enabled, or a quota registration still awaiting its first authenticated session. */
function accountUsableForFleet(row: Record<string, unknown>): boolean {
  return row.enabled !== false || row.quota_pending === true;
}
export function lifecycleAccountProvider(snapshot: ConfigurationSnapshot, accountId: string): string | undefined {
  const account = snapshot.provider_accounts?.find(row => row.id === accountId && accountUsableForFleet(row));
  return text(account, 'provider') || undefined;
}
export function lifecycleAccountForProvider(snapshot: ConfigurationSnapshot, provider: string, currentId: string, tenantId: string): string {
  const accounts = snapshot.provider_accounts?.filter(row => row.provider === provider && accountUsableForFleet(row)
    && (typeof row.payer_tenant_id !== 'string' || row.payer_tenant_id === tenantId || row.shared_with_pool === true)) ?? [];
  return text(accounts.find(row => row.id === currentId) ?? accounts.find(row => text(row, 'id')), 'id');
}
export function lifecycleOptions(snapshot: ConfigurationSnapshot, key: 'tenants' | 'rooms' | 'harness_definitions' | 'provider_accounts', tenantId?: string) {
  return (snapshot[key] ?? []).flatMap((row) => {
    if (key === 'rooms' && row.tenant_id !== tenantId) return [];
    const id = text(row, 'id') || (key === 'harness_definitions' ? text(row, 'harness_id') : '');
    return id ? [{ id, label: text(row, 'display_name') || id }] : [];
  });
}
export function agentLifecycleDraft(snapshot: ConfigurationSnapshot, target?: FleetTarget): AgentLifecycleDraft {
  const agent = target?.resource === 'agent' ? [...(snapshot.agents ?? []), ...(snapshot.retired?.agents ?? [])]
    .find((row) => row.tenant_id === target.tenant_id && row.alias === target.alias) : undefined;
  const placement = agent?.placement && typeof agent.placement === 'object' && !Array.isArray(agent.placement)
    ? agent.placement as Record<string, unknown> : agent;
  const memberships = target?.resource === 'agent' ? (snapshot.memberships ?? []).filter((row) =>
    row.tenant_id === target.tenant_id && (typeof row.alias === 'string' ? row.alias : row.agent_alias) === target.alias).flatMap((row) =>
    typeof row.room_id === 'string' && typeof row.role === 'string' && typeof row.enabled === 'boolean'
      ? [{ room_id: row.room_id, role: row.role, enabled: row.enabled }] : []) : [];
  const primaryRoomId = text(agent, 'primary_room_id');
  const normalizedMemberships = memberships.map((member) =>
    member.room_id === primaryRoomId ? { ...member, enabled: true } : member);
  return {
    tenantId: target?.tenant_id ?? '', alias: target?.resource === 'agent' ? target.alias : '',
    displayName: text(agent, 'display_name'), runtimeKey: text(agent, 'runtime_key'), harnessId: text(agent, 'harness_id'),
    hostId: text(placement, 'host_id'), mode: (placement?.mode ?? placement?.runtime_mode) === 'container' ? 'container' : 'native',
    containerName: text(placement, 'container_name'), runtimeUser: text(placement, 'runtime_user'),
    systemdUser: text(placement, 'systemd_user'), homeDirectory: text(placement, 'home_directory'),
    stateDirectory: text(placement, 'state_directory'), primaryAccountId: text(agent, 'primary_account_id'),
    modelId: text(agent, 'model_id'), primaryRoomId: text(agent, 'primary_room_id'), memberships: normalizedMemberships,
    reasoningEffort: text(agent, 'reasoning_effort'),
  };
}
export function agentLifecycleRequest(
  draft: AgentLifecycleDraft, snapshot: ConfigurationSnapshot, capability: FleetCapability | undefined,
  kind: 'create' | 'update', key: string, target?: FleetTarget,
): { request?: FleetOperationRequest; error?: string } {
  if (!capability?.available || !capability.actions.includes(kind)) return { error: 'El servidor no acredita las capacidades de esta operación.' };
  if (!Number.isSafeInteger(snapshot.revision) || Number(snapshot.revision) < 0) return { error: 'Falta una revisión durable de configuración.' };
  if (!lifecycleOptions(snapshot, 'tenants').some((option) => option.id === draft.tenantId)) return { error: 'El espacio de trabajo ya no está publicado.' };
  if (target?.resource === 'agent' && (draft.tenantId !== target.tenant_id || draft.alias !== target.alias)) return { error: 'La identidad seleccionada es inmutable.' };
  const original = target ? agentLifecycleDraft(snapshot, target) : undefined;
  if (original?.runtimeKey && original.runtimeKey !== draft.runtimeKey) return { error: 'La clave física runtime_key es inmutable.' };
  if (target?.resource === 'agent' && !original?.runtimeKey) {
    const row = [...(snapshot.agents ?? []), ...(snapshot.retired?.agents ?? [])].find((agent) =>
      agent.tenant_id === target.tenant_id && agent.alias === target.alias);
    if (row?.runtime_key !== null) return { error: 'La clave física no está publicada; relee el registro antes de prepararlo.' };
  }
  const rooms = lifecycleOptions(snapshot, 'rooms', draft.tenantId);
  if (draft.memberships.some((member) => !rooms.some((room) => room.id === member.room_id))) return { error: 'Una membresía apunta a grupos ausentes del inventario.' };
  if (!lifecycleOptions(snapshot, 'harness_definitions').some((option) => option.id === draft.harnessId)) return { error: 'El arnés debe existir en el inventario actual.' };
  if (draft.primaryAccountId && !lifecycleOptions(snapshot, 'provider_accounts').some((option) => option.id === draft.primaryAccountId)) return { error: 'La cuenta principal ya no está publicada.' };
  const host = capability.placements.find((placement) => placement.host_id === draft.hostId);
  if (!host?.modes.includes(draft.mode)) return { error: 'Selecciona un host y modo autorizados por el servidor.' };
  if (!host.runtime_users.includes(draft.runtimeUser) || (draft.systemdUser && !host.systemd_users.includes(draft.systemdUser))) return { error: 'El usuario de ejecución o systemd no está permitido en el host.' };
  if (!host.home_roots.includes(draft.homeDirectory)
    || !host.state_roots.some(root => draft.stateDirectory === `${root.replace(/\/$/u, '')}/${draft.runtimeKey}`)) {
    return { error: 'Los directorios deben coincidir con el perfil y el estado de la clave física autorizados por el host.' };
  }
  const result = FleetOperationRequestSchema.safeParse({
    kind, target: target ?? { resource: 'agent', tenant_id: draft.tenantId, alias: draft.alias },
    expected_revision: snapshot.revision, idempotency_key: key,
    parameters: {
      runtime_key: draft.runtimeKey, harness_id: draft.harnessId, display_name: draft.displayName || null,
      primary_room_id: draft.primaryRoomId, memberships: draft.memberships,
      placement: { host_id: draft.hostId, mode: draft.mode, runtime_user: draft.runtimeUser,
        home_directory: draft.homeDirectory, state_directory: draft.stateDirectory,
        ...(draft.mode === 'container' ? { container_name: draft.containerName } : {}),
        ...(draft.systemdUser ? { systemd_user: draft.systemdUser } : {}) },
      primary_account_id: draft.primaryAccountId || null, model_id: draft.modelId || null,
      ...(draft.reasoningEffort ? { reasoning_effort: draft.reasoningEffort } : { reasoning_effort: null }),
    },
  });
  const provider = lifecycleAccountProvider(snapshot, draft.primaryAccountId);
  if (host.runtimes !== undefined && !provider) return { error: 'Selecciona una cuenta principal publicada para el proveedor de la plantilla.' };
  if (result.success && host.runtimes !== undefined && !matchingFleetRuntime(capability, result.data, provider)) {
    return { error: 'Selecciona una plantilla autorizada para este proveedor, arnés, usuario y contenedor.' };
  }
  if (draft.harnessId === 'openclaw' && provider === 'codex' && !/^openai\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,111}$/u.test(draft.modelId)) {
    return { error: 'Esta plantilla OpenClaw requiere un modelo explícito con formato openai/<modelo>.' };
  }
  if (result.success) return { request: result.data };
  return { error: missingFieldMessage(draft) ?? 'Revisa identidad, clave física, membresías, grupo primario y datos de ejecución. No se enviaron cambios.' };
}
function missingFieldMessage(draft: AgentLifecycleDraft): string | undefined {
  if (!draft.alias.trim()) return 'Falta el alias operativo del agente. No se enviaron cambios.';
  if (!draft.runtimeKey.trim()) return 'Falta la clave física de ejecución. No se enviaron cambios.';
  const roleless = draft.memberships.find((member) => !member.role.trim());
  if (roleless) return `Falta el rol en la membresía del grupo ${JSON.stringify(roleless.room_id)}. Elige un rol. No se enviaron cambios.`;
  if (!draft.primaryRoomId) return 'Falta el grupo primario: elígelo entre las membresías incluidas. No se enviaron cambios.';
  if (!draft.memberships.some((member) => member.room_id === draft.primaryRoomId)) return 'El grupo primario debe ser una de las membresías incluidas. No se enviaron cambios.';
  return undefined;
}
export const DEFAULT_MEMBERSHIP_ROLE = 'agent';
export function membershipRoleOptions(snapshot: ConfigurationSnapshot): string[] {
  const roles = (snapshot.role_policies ?? []).flatMap((row) => { const role = text(row, 'role'); return role ? [role] : []; });
  return [...new Set(roles.length ? roles : [DEFAULT_MEMBERSHIP_ROLE])];
}
export function defaultMembershipRole(snapshot: ConfigurationSnapshot): string {
  const roles = membershipRoleOptions(snapshot);
  return roles.includes(DEFAULT_MEMBERSHIP_ROLE) ? DEFAULT_MEMBERSHIP_ROLE : roles[0] ?? DEFAULT_MEMBERSHIP_ROLE;
}
/** A registry draft never ran: preparing it is a fleet `create` that adopts the draft. */
export function isRegistryDraftRow(row: Record<string, unknown> | undefined): boolean {
  return !!row && (row.runtime_key === null || row.runtime_key === undefined) && !row.retired_at
    && row.enabled === false && row.lifecycle_state === 'draft';
}
const PLACEMENT_FIELDS: readonly (readonly [string, string])[] = [['host_id', 'computadora'], ['harness_id', 'arnés'],
  ['runtime_mode', 'modo de ejecución'], ['container_name', 'contenedor'], ['runtime_user', 'usuario de ejecución'],
  ['systemd_user', 'usuario systemd'], ['home_directory', 'directorio personal'], ['state_directory', 'directorio de estado']];
function placementGaps(row: Record<string, unknown>): string[] {
  return PLACEMENT_FIELDS.filter(([field]) => typeof row[field] !== 'string' || row[field] === ''
    || (field === 'runtime_mode' && !['container', 'native'].includes(row[field]))).map(([, label]) => label);
}
/**
 * Why the fleet executor cannot operate the agents in scope: an agent installed before the fleet has a runtime
 * but not the exact placement the host needs to stop, revoke or update it, and the server refuses every operation.
 */
export function fleetScopeGap(snapshot: ConfigurationSnapshot, target: FleetTarget | undefined): string | undefined {
  if (!target) return undefined;
  const room = target.resource === 'room' ? target.room_id : undefined;
  const agents = (snapshot.agents ?? []).filter((row) => row.tenant_id === target.tenant_id && typeof row.runtime_key === 'string'
    && (target.resource === 'agent' ? row.alias === target.alias : room !== undefined && (row.primary_room_id === room
      || (snapshot.memberships ?? []).some((member) => member.tenant_id === row.tenant_id && member.alias === row.alias && member.room_id === room))));
  const legacy = agents.flatMap((row) => { const gaps = placementGaps(row); return gaps.length ? [{ alias: String(row.alias), gaps }] : []; });
  const first = legacy.at(0);
  if (!first) return undefined;
  const pause = 'Mientras tanto puedes pausar su admisión de entregas en la pestaña Registro; para darlo de baja hay que retirarlo en su computadora';
  if (target.resource === 'agent') {
    return `Este agente se instaló antes del ejecutor de flota y su registro no tiene ${first.gaps.length > 1 ? `${first.gaps.slice(0, -1).join(', ')} ni ${String(first.gaps.at(-1))}` : first.gaps.join('')}. `
      + `La consola no puede detenerlo, retirarlo, actualizarlo ni eliminarlo hasta adoptarlo en la flota. ${pause} con «cauce ${first.alias} retirar».`;
  }
  return `El grupo incluye agentes instalados antes del ejecutor de flota (${legacy.map((entry) => entry.alias).join(', ')}): `
    + 'la consola no puede retirarlos ni purgarlos hasta adoptarlos en la flota, ni eliminar el grupo mientras los tenga.';
}
export const FLEET_ACTION_LABELS = { create: 'Preparar agente', update: 'Actualizar ejecución', start: 'Iniciar', stop: 'Detener',
  retire: 'Retirar', restore: 'Restaurar', purge: 'Purgar' };
