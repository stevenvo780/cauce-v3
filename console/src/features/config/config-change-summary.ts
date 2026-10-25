import { ConfigMutationSchema, type ConfigLeafMutation, type ConfigMutation } from '@cauce/protocol/configuration';
import type { ConfigurationSnapshot } from '../../api/types';
import { nombreDeRol } from './efecto-de-rol';

export const CONFIG_ACTION_LABELS = {
  create: 'Crear', update: 'Actualizar', delete: 'Eliminar', retire: 'Retirar', restore: 'Restaurar',
  set: 'Configurar', apply: 'Aplicar',
};

export const CONFIG_RESOURCE_LABELS: Record<ConfigMutation['resource'], string> = {
  tenant: 'Espacio', room: 'Sala', membership: 'Miembro de una sala', acl_edge: 'Permisos entre espacios',
  harness: 'Tipo de agente', role_policy: 'Permisos de un rol', chain_policy: 'Seguimiento de conversaciones',
  egress_destination: 'Destino de avisos', agent: 'Agente', provider_account: 'Cuenta de proveedor',
  alias_routing_ceiling: 'Acceso a una cuenta', agent_account_binding: 'Cuenta de cuotas',
  agent_extensions: 'Ampliaciones de un agente', host_extensions_allowed: 'Ampliaciones de una computadora', batch: 'Conjunto de cambios',
};

function verb(mutation: ConfigLeafMutation): string {
  const value = 'value' in mutation ? mutation.value : undefined;
  if (mutation.action === 'update' && value && Object.keys(value).length === 1 && 'enabled' in value) {
    return value.enabled ? 'Habilitar' : 'Deshabilitar';
  }
  return CONFIG_ACTION_LABELS[mutation.action];
}

function displayName(snapshot: ConfigurationSnapshot | undefined, collection: 'tenants' | 'rooms' | 'provider_accounts' | 'harness_definitions', id: string, tenantId?: string): string {
  const row = snapshot?.[collection]?.find(row => row.id === id && (tenantId === undefined || row.tenant_id === tenantId));
  const name = row?.display_name ?? row?.label;
  return typeof name === 'string' && name.trim() ? name.trim() : id;
}

function summarizeMutation(mutation: ConfigMutation, snapshot?: ConfigurationSnapshot): string {
  if (mutation.resource === 'batch') return mutation.mutations.map(item => summarizeMutation(item, snapshot)).join('; ');
  const action = verb(mutation);
  const tenant = (id: string) => displayName(snapshot, 'tenants', id);
  const account = (id: string) => displayName(snapshot, 'provider_accounts', id);
  switch (mutation.resource) {
    case 'tenant': return `${action} el espacio «${mutation.value?.display_name ?? tenant(mutation.id)}»`;
    case 'room': return `${action} la sala «${mutation.value?.display_name ?? displayName(snapshot, 'rooms', mutation.id, mutation.tenant_id)}» del espacio «${tenant(mutation.tenant_id)}»`;
    case 'membership': {
      const role = mutation.value?.role ? ` con el rol ${nombreDeRol(mutation.value.role)}` : '';
      const room = `la sala «${displayName(snapshot, 'rooms', mutation.room_id, mutation.tenant_id)}» del espacio «${tenant(mutation.tenant_id)}»`;
      return mutation.action === 'create' ? `Añadir a «${mutation.alias}» a ${room}${role}` : `${action} la pertenencia de «${mutation.alias}» a ${room}${role}`;
    }
    case 'acl_edge': return `${action} los permisos del espacio «${tenant(mutation.from_tenant)}» hacia «${tenant(mutation.to_tenant)}»`;
    case 'harness': return `${action} el tipo de agente «${mutation.value?.display_name ?? displayName(snapshot, 'harness_definitions', mutation.id)}»`;
    case 'role_policy': return `${action} los permisos del rol ${nombreDeRol(mutation.role)}`;
    case 'chain_policy': return 'Actualizar el seguimiento de las conversaciones';
    case 'egress_destination': return `${action} el destino de avisos «${mutation.value?.display_label ?? mutation.handle}» de «${mutation.alias}» del espacio «${tenant(mutation.tenant_id)}»`;
    case 'agent': return `${action} el agente «${mutation.alias}» del espacio «${tenant(mutation.tenant_id)}»`;
    case 'provider_account': return `${action} la cuenta «${mutation.value?.label ?? account(mutation.id)}»`;
    case 'alias_routing_ceiling': return `${mutation.action === 'create' ? 'Dar a' : 'Quitar a'} «${mutation.alias}» del espacio «${tenant(mutation.tenant_id)}» acceso a la cuenta «${account(mutation.account_id)}»`;
    case 'agent_account_binding': return `${mutation.action === 'delete' ? 'Quitar' : mutation.action === 'create' ? 'Vincular' : 'Actualizar'} la cuenta de cuotas «${account(mutation.account_id)}» de «${mutation.agent_alias}» del espacio «${tenant(mutation.tenant_id)}»${mutation.value?.priority === undefined ? '' : ` con orden de consulta ${String(mutation.value.priority)}`}${mutation.value?.enabled === undefined ? '' : mutation.value.enabled ? ' y consulta activa' : ' y consulta pausada'}`;
    case 'agent_extensions': return `Configurar las ampliaciones de «${mutation.alias}» del espacio «${tenant(mutation.tenant_id)}»`;
    case 'host_extensions_allowed': return `Configurar las ampliaciones permitidas en la computadora «${mutation.host_id}»`;
  }
}

export function configMutationSummary(operation: unknown, snapshot?: ConfigurationSnapshot): string {
  const parsed = ConfigMutationSchema.safeParse(operation);
  return parsed.success ? summarizeMutation(parsed.data, snapshot) : 'Cambio de configuración sin detalle disponible';
}

export const configHistorySummary = configMutationSummary;
