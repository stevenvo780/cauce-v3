import type { AnyConfigResource, ConfigAction, ConfigMutation, ConfigResource, ConfigurationSnapshot } from '../../api/types';
import { platformCatalogReason } from './config-form-access';

export const PLATFORM_CLI_REASON = 'Las definiciones de arnés y las políticas de rol se cambian con la CLI de plataforma, no desde esta consola.';

export const templates: Partial<Record<ConfigResource, ConfigMutation>> = {
  tenant: { resource: 'tenant', action: 'create', id: 'Acme', value: { display_name: 'Acme', is_hub: false, enabled: true } },
  room: { resource: 'room', action: 'create', tenant_id: 'Acme', id: 'grp.acme', value: { display_name: 'Acme room', enabled: true } },
  membership: { resource: 'membership', action: 'create', tenant_id: 'Acme', room_id: 'grp.acme', alias: 'agent', value: { role: 'agent', enabled: true } },
  acl_edge: { resource: 'acl_edge', action: 'create', from_tenant: 'Acme', to_tenant: 'Partner', value: { enabled: true, allow_route: false, allow_read: false, allow_control: false } },
  chain_policy: { resource: 'chain_policy', action: 'update', id: 'default', value: { progress_relay_enabled: true, progress_relay_max_events: 8, cycle_cut_enabled: true } },
  egress_destination: {
    resource: 'egress_destination', action: 'create', tenant_id: 'Acme', alias: 'agent', handle: 'owner_dm',
    value: {
    adapter: 'telegram', channel: 'telegram', conversation_id: '', conversation_kind: 'dm',
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
const allActions: readonly ConfigAction[] = ['create', 'update', 'delete'];

export function actionsFor(resource: ConfigResource): readonly ConfigAction[] {
  return actionsByResource[resource] ?? allActions;
}

export function mutationResourceReason(resource: string, snapshot?: ConfigurationSnapshot): string | undefined {
  if (resource === 'harness' || resource === 'role_policy') return PLATFORM_CLI_REASON;
  return platformCatalogReason(snapshot, resource);
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

function rollbackLeafPolicy(operation: unknown, snapshot?: ConfigurationSnapshot): RollbackPolicy {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    return {
      allowed: false,
      accountResource: false,
      message: 'Bloqueado: la revisión no publica una operación reconocible y no se puede acreditar que sea segura de revertir.',
    };
  }
  const candidate = operation as Record<string, unknown>;
  const resource = typeof candidate.resource === 'string' ? candidate.resource : undefined;
  const reason = resource ? mutationResourceReason(resource, snapshot) : undefined;
  if (reason) return { allowed: false, accountResource: false, message: reason };
  if (resource && ACCOUNT_RESOURCES.has(resource as AnyConfigResource)) {
    return {
      allowed: false,
      accountResource: true,
      message: `Bloqueado: esta revisión modifica ${resource}; su única autoridad es Cuentas.`,
    };
  }
  if (resource === 'agent' && candidate.action === 'delete') {
    return {
      allowed: false,
      accountResource: false,
      message: 'La eliminación definitiva de un agente no se puede deshacer. Si queda historial, su identidad conserva el alias reservado.',
    };
  }
  if (!resource || !RESOURCES.includes(resource as AnyConfigResource)
    || typeof candidate.action !== 'string'
    || (!allActions.includes(candidate.action as ConfigAction)
      && !(['tenant', 'room', 'membership'].includes(resource) && ['retire', 'restore'].includes(candidate.action)))) {
    return {
      allowed: false,
      accountResource: false,
      message: 'Bloqueado: la revisión no publica una operación reconocible y no se puede acreditar que sea segura de revertir.',
    };
  }
  return { allowed: true };
}

export function rollbackPolicy(operation: unknown, snapshot?: ConfigurationSnapshot): RollbackPolicy {
  if (operation && typeof operation === 'object' && !Array.isArray(operation)) {
    const candidate = operation as Record<string, unknown>;
    if (candidate.resource === 'batch' && candidate.action === 'apply'
      && Array.isArray(candidate.mutations) && candidate.mutations.length >= 1 && candidate.mutations.length <= 200) {
      for (const mutation of candidate.mutations) {
        const policy = rollbackLeafPolicy(mutation, snapshot);
        if (!policy.allowed) return policy;
      }
      return { allowed: true };
    }
  }
  return rollbackLeafPolicy(operation, snapshot);
}

export function mutationText(resource: ConfigResource, action: ConfigAction): string {
  const template = templates[resource];
  if (!template) throw new Error(mutationResourceReason(resource) ?? 'resource no reconocido.');
  const mutation = structuredClone(template);
  mutation.action = action;
  if (action === 'delete') delete mutation.value;
  return JSON.stringify(mutation, null, 2);
}

export function parseMutation(text: string, snapshot?: ConfigurationSnapshot): ConfigMutation {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('La mutación debe ser un objeto JSON.');
  const mutation = value as Partial<ConfigMutation>;
  if (!RESOURCES.includes(String(mutation.resource) as AnyConfigResource)) {
    throw new Error('resource no reconocido.');
  }
  const reason = mutationResourceReason(String(mutation.resource), snapshot);
  if (reason) throw new Error(reason);
  if (ACCOUNT_RESOURCES.has(String(mutation.resource) as AnyConfigResource)) {
    throw new Error(
      'Las cuentas, sus techos y sus bindings se modifican únicamente en «Cuentas». '
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
