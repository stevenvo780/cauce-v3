import { ConfigMutationSchema } from '@cauce/protocol/configuration';
import { FleetTargetSchema, type FleetTarget } from '@cauce/protocol/fleet-operation';
import type { ConfigMutation, ConfigurationSnapshot } from '../../api/types';
import { agentLifecycleDraft, type AgentLifecycleDraft } from './agent-lifecycle-model';

export function groupOperationTarget(collection: string, row: Record<string, unknown>): FleetTarget | undefined {
  const value = collection === 'rooms' ? { resource: 'room', tenant_id: row.tenant_id, room_id: row.id }
    : collection === 'tenants' ? { resource: 'tenant', tenant_id: row.id } : undefined;
  const result = FleetTargetSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
export function groupHasRuntime(snapshot: ConfigurationSnapshot, target: FleetTarget): boolean {
  const memberships = [...(snapshot.memberships ?? []), ...(snapshot.retired?.memberships ?? [])];
  return [...(snapshot.agents ?? []), ...(snapshot.retired?.agents ?? [])].some((agent) =>
    agent.tenant_id === target.tenant_id && typeof agent.runtime_key === 'string' && !!agent.runtime_key
    && (target.resource === 'tenant' || target.resource === 'room' && (agent.primary_room_id === target.room_id
      || memberships.some((member) => member.tenant_id === target.tenant_id && member.alias === agent.alias && member.room_id === target.room_id))));
}
export function membershipMoveIntent(snapshot: ConfigurationSnapshot, tenantId: string, sourceRoom: string, alias: string, destinationRoom: string): {
  batch?: ConfigMutation; runtimeTarget?: FleetTarget; runtimeDraft?: AgentLifecycleDraft; error?: string;
} {
  if (!Array.isArray(snapshot.memberships) || !Array.isArray(snapshot.agents)) return { error: 'Falta el inventario de agentes o membresías para acreditar el movimiento.' };
  const source = snapshot.memberships.find((member) => member.tenant_id === tenantId && member.room_id === sourceRoom && member.alias === alias);
  if (!source || typeof source.role !== 'string' || typeof source.enabled !== 'boolean') return { error: 'La membresía de origen no publica rol y estado completos.' };
  if (sourceRoom === destinationRoom || !snapshot.rooms?.some((room) => room.tenant_id === tenantId && room.id === destinationRoom && room.enabled === true)) {
    return { error: 'Elige otro grupo habilitado del mismo espacio de trabajo.' };
  }
  const agent = snapshot.agents.find((row) => row.tenant_id === tenantId && row.alias === alias);
  if (!agent || !Object.hasOwn(agent, 'primary_room_id')) return { error: 'El registro no publica el grupo primario; no se puede demostrar que quede una referencia válida.' };
  const target = FleetTargetSchema.safeParse({ resource: 'agent', tenant_id: tenantId, alias });
  if (!target.success) return { error: 'La identidad del agente no es válida.' };
  const existing = snapshot.memberships.find((member) => member.tenant_id === tenantId && member.room_id === destinationRoom && member.alias === alias);
  if (existing && (typeof existing.role !== 'string' || typeof existing.enabled !== 'boolean')) return { error: 'La membresía de destino no publica rol y estado completos.' };
  const newPrimary = agent.primary_room_id === sourceRoom || agent.primary_room_id === null ? destinationRoom : agent.primary_room_id;
  if (typeof newPrimary !== 'string') return { error: 'El grupo primario actual no está acreditado.' };
  if (typeof agent.runtime_key === 'string' && agent.runtime_key) {
    const initial = agentLifecycleDraft(snapshot, target.data);
    const memberships = initial.memberships.filter((member) => member.room_id !== sourceRoom);
    if (!existing) memberships.push({ room_id: destinationRoom, role: source.role, enabled: source.enabled });
    return { runtimeTarget: target.data, runtimeDraft: { ...initial, primaryRoomId: newPrimary, memberships } };
  }
  if (agent.runtime_key !== null) return { error: 'La clave de ejecución no está publicada; no se puede usar un cambio declarativo.' };
  const mutations: Record<string, unknown>[] = [];
  if (!existing) mutations.push({ resource: 'membership', action: 'create', tenant_id: tenantId, room_id: destinationRoom,
    alias, value: { role: source.role, enabled: source.enabled } });
  if (newPrimary !== agent.primary_room_id) mutations.push({ resource: 'agent', action: 'update', tenant_id: tenantId,
    alias, value: { primary_room_id: newPrimary } });
  mutations.push({ resource: 'membership', action: 'delete', tenant_id: tenantId, room_id: sourceRoom, alias });
  const result = ConfigMutationSchema.safeParse({ resource: 'batch', action: 'apply', mutations });
  return result.success ? { batch: result.data } : { error: 'El servidor no publica todavía el contrato de movimiento atómico del grupo primario.' };
}
