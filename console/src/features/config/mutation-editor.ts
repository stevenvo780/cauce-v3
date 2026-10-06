import type { AnyConfigResource, ConfigAction, ConfigMutation, ConfigResource } from '../../api/types';

export const templates: Record<ConfigResource, ConfigMutation> = {
  tenant: { resource: 'tenant', action: 'create', id: 'Acme', value: { display_name: 'Acme', is_hub: false, enabled: true } },
  room: { resource: 'room', action: 'create', tenant_id: 'Acme', id: 'grp.acme', value: { display_name: 'Acme room', enabled: true } },
  membership: { resource: 'membership', action: 'create', tenant_id: 'Acme', room_id: 'grp.acme', alias: 'agent', value: { role: 'agent', enabled: true } },
  acl_edge: { resource: 'acl_edge', action: 'create', from_tenant: 'Acme', to_tenant: 'Steven', value: { enabled: true, allow_route: false, allow_read: false, allow_control: false } },
  // No `command`, same as the harness step of the wizard: the column is stored and no execution path reads it (see
  // `campos-inertes.ts`). The schema still accepts it—whoever needs it writes it by hand right here, that is what
  // the escape hatch is for—, but the template no longer offers it pre-filled: a template is a suggestion, and we
  // don't suggest what does nothing.
  harness: { resource: 'harness', action: 'create', id: 'custom', value: { display_name: 'Custom harness', capabilities: [], enabled: true } },
  role_policy: { resource: 'role_policy', action: 'create', role: 'observer', value: { allow_route: false, allow_read: false, allow_control: false } },
  chain_policy: { resource: 'chain_policy', action: 'update', id: 'default', value: { progress_relay_enabled: true, progress_relay_max_events: 8, cycle_cut_enabled: true } },
  egress_destination: {
    resource: 'egress_destination', action: 'create', tenant_id: 'Acme', alias: 'agent', handle: 'owner_dm',
    value: {
    adapter: 'telegram', channel: 'telegram', conversation_id: 'synthetic-dm', conversation_kind: 'dm',
      display_label: 'DM del dueño', allow_kinds: ['task_complete'], require_prior_contact: true,
      contact_ttl_days: 30, min_interval_seconds: 300, max_per_hour: 2, max_per_day: 8, max_per_root: 1,
      enabled: true
    }
  },
};

/**
 * `chain_policy` is a singleton: `ChainPolicyConfigMutationSchema` only accepts `update` on the `default` id.
 * Offering create/delete would be sending the operator straight into a sure 400.
 */
const actionsByResource: Partial<Record<ConfigResource, readonly ConfigAction[]>> = {
  chain_policy: ['update'],
};
export const allActions: readonly ConfigAction[] = ['create', 'update', 'delete'];

export function actionsFor(resource: ConfigResource): readonly ConfigAction[] {
  return actionsByResource[resource] ?? allActions;
}

/**
 * Everything `ConfigMutationSchema` accepts on the server. `parseMutation` deliberately rejects the three account
 * registry resources after recognizing them: their typed and confirmed authority is `/accounts`, while `agent`
 * remains available here for fields that have no specialized editor.
 */
const RESOURCES: readonly AnyConfigResource[] = [
  'tenant', 'room', 'membership', 'acl_edge', 'harness', 'role_policy',
  'chain_policy', 'egress_destination',
  'agent', 'provider_account', 'alias_routing_ceiling', 'agent_account_binding',
];

const ACCOUNT_RESOURCES = new Set<AnyConfigResource>([
  'provider_account', 'alias_routing_ceiling', 'agent_account_binding',
]);

type RollbackPolicy =
  | { allowed: true }
  | { allowed: false; accountResource: boolean; message: string };

export function rollbackPolicy(operation: unknown): RollbackPolicy {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    return {
      allowed: false,
      accountResource: false,
      message: 'Bloqueado: la revisión no publica una operación reconocible y no se puede acreditar que sea segura de revertir.',
    };
  }
  const candidate = operation as Record<string, unknown>;
  const resource = typeof candidate.resource === 'string' ? candidate.resource : undefined;
  if (resource && ACCOUNT_RESOURCES.has(resource as AnyConfigResource)) {
    return {
      allowed: false,
      accountResource: true,
      message: `Bloqueado: esta revisión modifica ${resource}; su única autoridad es Cuentas y cuotas.`,
    };
  }
  if (!resource || !RESOURCES.includes(resource as AnyConfigResource)
    || typeof candidate.action !== 'string'
    || !allActions.includes(candidate.action as ConfigAction)) {
    return {
      allowed: false,
      accountResource: false,
      message: 'Bloqueado: la revisión no publica una operación reconocible y no se puede acreditar que sea segura de revertir.',
    };
  }
  return { allowed: true };
}

export function mutationText(resource: ConfigResource, action: ConfigAction): string {
  const mutation = structuredClone(templates[resource]);
  mutation.action = action;
  if (action === 'delete') delete mutation.value;
  return JSON.stringify(mutation, null, 2);
}

export function parseMutation(text: string): ConfigMutation {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('La mutación debe ser un objeto JSON.');
  const mutation = value as Partial<ConfigMutation>;
  if (!RESOURCES.includes(String(mutation.resource) as AnyConfigResource)) {
    throw new Error('resource no reconocido.');
  }
  if (ACCOUNT_RESOURCES.has(String(mutation.resource) as AnyConfigResource)) {
    throw new Error(
      'Las cuentas, sus techos y sus bindings se modifican únicamente en «Cuentas y cuotas». '
      + 'Abrí /accounts para usar formularios tipados, confirmación y dry-run.',
    );
  }
  if (!allActions.includes(String(mutation.action) as ConfigAction)) throw new Error('action no reconocida.');
  const rawValue = (value as Record<string, unknown>).value;
  if (mutation.resource === 'agent' && rawValue !== null && typeof rawValue === 'object'
    && !Array.isArray(rawValue) && Object.hasOwn(rawValue, 'role_brief')) {
    throw new Error(
      '`agents.role_brief` es una proyección diagnóstica de sólo lectura. '
      + 'Modificá el contexto del agente en su página «Perfil y contexto».',
    );
  }
  return mutation as ConfigMutation;
}

