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
export function lifecycleAccountProvider(snapshot: ConfigurationSnapshot, accountId: string): string | undefined {
  const account = snapshot.provider_accounts?.find(row => row.id === accountId && row.enabled !== false);
  return text(account, 'provider') || undefined;
}
export function lifecycleAccountForProvider(snapshot: ConfigurationSnapshot, provider: string, currentId: string, tenantId: string): string {
  const accounts = snapshot.provider_accounts?.filter(row => row.provider === provider && row.enabled !== false
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
  return {
    tenantId: target?.tenant_id ?? '', alias: target?.resource === 'agent' ? target.alias : '',
    displayName: text(agent, 'display_name'), runtimeKey: text(agent, 'runtime_key'), harnessId: text(agent, 'harness_id'),
    hostId: text(placement, 'host_id'), mode: (placement?.mode ?? placement?.runtime_mode) === 'container' ? 'container' : 'native',
    containerName: text(placement, 'container_name'), runtimeUser: text(placement, 'runtime_user'),
    systemdUser: text(placement, 'systemd_user'), homeDirectory: text(placement, 'home_directory'),
    stateDirectory: text(placement, 'state_directory'), primaryAccountId: text(agent, 'primary_account_id'),
    modelId: text(agent, 'model_id'), primaryRoomId: text(agent, 'primary_room_id'), memberships,
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
  return result.success ? { request: result.data } : { error: 'Revisa identidad, clave física, membresías, grupo primario y datos de ejecución. No se enviaron cambios.' };
}
export const FLEET_ACTION_LABELS = { create: 'Preparar agente', update: 'Actualizar ejecución', start: 'Iniciar', stop: 'Detener',
  retire: 'Retirar', restore: 'Restaurar', purge: 'Purgar' };
