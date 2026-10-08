import { ConfigMutationSchema } from '@cauce/protocol/configuration';
import type { ConfigAction, ConfigMutation, ConfigResource, ConfigurationSnapshot } from '../../api/types';

export interface ConfigFormField {
  key: string;
  label: string;
  kind?: 'boolean' | 'number' | 'list' | 'select';
  identity?: boolean;
  nullable?: boolean;
  choices?: readonly string[];
  min?: number;
  max?: number;
  initial?: string;
  suggestions?: keyof ConfigurationSnapshot;
  suggestionKey?: string;
  requiredOnCreate?: boolean;
}

export interface ConfigFormDefinition {
  resource: ConfigResource;
  label: string;
  fields: readonly ConfigFormField[];
  singleton?: boolean;
}

const enabled: ConfigFormField = { key: 'enabled', label: 'Habilitado', kind: 'boolean', initial: 'true' };
const name: ConfigFormField = { key: 'display_name', label: 'Nombre visible', nullable: true };
const tenant: ConfigFormField = { key: 'tenant_id', label: 'Espacio', identity: true, suggestions: 'tenants', suggestionKey: 'id' };
const alias: ConfigFormField = { key: 'alias', label: 'Alias del agente', identity: true, suggestions: 'agents', suggestionKey: 'alias' };
const permission = (key: string, label: string): ConfigFormField => ({ key, label, kind: 'boolean', initial: 'false' });
const limit = (key: string, label: string, min: number, max: number, initial?: string): ConfigFormField => ({ key, label, kind: 'number', min, max, initial });

const DEFINITIONS: Record<string, ConfigFormDefinition> = {
  tenants: { resource: 'tenant', label: 'espacio', fields: [
    { key: 'id', label: 'Id del espacio', identity: true }, name,
    permission('is_hub', 'Hub'), enabled,
  ] },
  rooms: { resource: 'room', label: 'sala/grupo', fields: [
    tenant, { key: 'id', label: 'Id de la sala/grupo', identity: true }, name, enabled,
  ] },
  memberships: { resource: 'membership', label: 'membresía', fields: [
    tenant, { key: 'room_id', label: 'Sala/grupo', identity: true, suggestions: 'rooms', suggestionKey: 'id' }, alias,
    { key: 'role', label: 'Rol de permisos', initial: 'agent', suggestions: 'role_policies', suggestionKey: 'role' }, enabled,
  ] },
  acl_edges: { resource: 'acl_edge', label: 'ACL', fields: [
    { ...tenant, key: 'from_tenant', label: 'Desde el espacio' },
    { ...tenant, key: 'to_tenant', label: 'Hacia el espacio' }, enabled,
    permission('allow_route', 'Permitir ruta'), permission('allow_read', 'Permitir lectura'), permission('allow_control', 'Permitir control'),
  ] },
  harness_definitions: { resource: 'harness', label: 'harness', fields: [
    { key: 'id', label: 'Id del harness', identity: true }, { ...name, nullable: false, requiredOnCreate: true },
    { key: 'capabilities', label: 'Capacidades (separadas por coma)', kind: 'list' }, enabled,
  ] },
  role_policies: { resource: 'role_policy', label: 'política de rol', fields: [
    { key: 'role', label: 'Id del rol', identity: true }, permission('allow_route', 'Permitir ruta'),
    permission('allow_read', 'Permitir lectura'), permission('allow_control', 'Permitir control'), permission('allow_notify', 'Permitir aviso proactivo'),
  ] },
  chain_policies: { resource: 'chain_policy', label: 'política de cadena', singleton: true, fields: [
    { key: 'id', label: 'Id de la política', identity: true, initial: 'default' },
    permission('progress_relay_enabled', 'Mostrar progreso'), limit('progress_relay_max_events', 'Máximo de eventos de progreso', 1, 64),
    permission('cycle_cut_enabled', 'Cortar ciclos'), permission('failure_coalesce_enabled', 'Agrupar fallos'),
    limit('failure_coalesce_window_seconds', 'Ventana para agrupar fallos (segundos)', 0, 86400),
    permission('delegation_caps_enabled', 'Aplicar topes de delegación'),
    limit('max_fanout_per_turn', 'Máximo de delegaciones por turno', 1, 100),
    limit('max_edge_repeats_per_root', 'Máximo de repeticiones por raíz', 1, 1000),
    limit('max_delegations_per_root', 'Máximo de delegaciones por raíz', 1, 10000),
    permission('human_gate_enabled', 'Requerir compuerta humana'),
  ] },
  egress_destinations: { resource: 'egress_destination', label: 'destino de avisos', fields: [
    tenant, alias, { key: 'handle', label: 'Identificador del destino', identity: true },
    { key: 'adapter', label: 'Adaptador', kind: 'select', choices: ['telegram'], initial: 'telegram' },
    { key: 'channel', label: 'Canal', initial: 'telegram' }, { key: 'conversation_id', label: 'Id numérico de conversación', requiredOnCreate: true },
    { key: 'conversation_kind', label: 'Tipo de conversación', kind: 'select', choices: ['dm', 'group'], initial: 'dm', requiredOnCreate: true },
    { key: 'display_label', label: 'Etiqueta visible', nullable: true },
    { key: 'allow_kinds', label: 'Tipos de aviso (separados por coma)', kind: 'list', initial: 'task_complete', requiredOnCreate: true },
    { key: 'require_prior_contact', label: 'Requerir contacto previo', kind: 'boolean', initial: 'true' },
    limit('contact_ttl_days', 'Vigencia del contacto (días)', 1, 3650, '30'),
    limit('min_interval_seconds', 'Intervalo mínimo (segundos)', 0, 86400, '300'),
    limit('max_per_hour', 'Máximo por hora', 0, 60, '2'), limit('max_per_day', 'Máximo por día', 0, 500, '8'),
    limit('max_per_root', 'Máximo por raíz', 0, 20, '1'),
    { ...limit('quiet_hours_start', 'Inicio del horario silencioso (hora)', 0, 23), nullable: true },
    { ...limit('quiet_hours_end', 'Fin del horario silencioso (hora)', 0, 23), nullable: true },
    { key: 'quiet_hours_tz', label: 'Zona horaria del silencio', initial: 'UTC' }, enabled,
  ] },
};

export function configFormDefinition(collection: string): ConfigFormDefinition | undefined {
  return Object.hasOwn(DEFINITIONS, collection) ? DEFINITIONS[collection] : undefined;
}

export function configFormValues(definition: ConfigFormDefinition, action: ConfigAction, row?: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(definition.fields.map((field) => {
    const value = row?.[field.key];
    const text = Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value.join(', ')
      : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
    return [field.key, row && Object.hasOwn(row, field.key) ? text : action === 'create' ? field.initial ?? '' : ''];
  }));
}

export function buildFormMutation(definition: ConfigFormDefinition, action: ConfigAction, values: Record<string, string>, initial: Record<string, string>): ConfigMutation {
  const mutation: ConfigMutation = { resource: definition.resource, action };
  const value: Record<string, unknown> = {};
  for (const field of definition.fields) {
    if (field.identity) {
      mutation[field.key] = action === 'create' ? (values[field.key] ?? '').trim() : initial[field.key] ?? '';
      continue;
    }
    const text = (values[field.key] ?? '').trim();
    if (action === 'create' && field.requiredOnCreate && text === '') throw new Error(`${field.label}: completá este campo obligatorio.`);
    if (['delete', 'retire', 'restore'].includes(action) || (action === 'update' && values[field.key] === initial[field.key])) continue;
    if (text === '' && !field.nullable && field.kind !== 'list') {
      if (action === 'update') throw new Error(`${field.label}: completá el valor antes de previsualizar.`);
      continue;
    }
    value[field.key] = text === '' && field.nullable ? null
      : field.kind === 'boolean' ? text === 'true'
        : field.kind === 'number' ? Number(text)
          : field.kind === 'list' ? text.split(',').map((item) => item.trim()).filter(Boolean)
            : text;
  }
  if (!['delete', 'retire', 'restore'].includes(action)) {
    if (action === 'update' && !Object.keys(value).length) throw new Error('Modificá al menos un campo antes de previsualizar.');
    mutation.value = value;
  }
  const parsed = ConfigMutationSchema.safeParse(mutation);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = String(issue.path.at(-1) ?? '');
    const field = definition.fields.find((entry) => entry.key === key);
    throw new Error(`${field?.label ?? 'Configuración'}: valor no válido. Revisá el formato y los límites del campo.`);
  }
  return mutation;
}

export interface ConfigFormTarget {
  collection: string;
  action: ConfigAction;
  row?: Record<string, unknown>;
}
