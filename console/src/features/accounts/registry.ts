import { ApiError } from '../../api/client';
import type {
  ConfigMutation,
  ConfigurationChangeResult,
  ConfigurationSnapshot,
} from '../../api/types';
import { describeConfigError } from '../config/config-change';

/**
 * Reading of the subscription pool as published by `GET /v3/console/config`
 * (packages/store/src/configuration.ts). There is no dedicated endpoint: the four tables from
 * migration 010 travel inside the same versioned snapshot, and all writes return via
 * `POST /v3/console/config/changes`.
 *
 * Honesty rules this module makes explicit in the type, not in the render:
 *  - `credential_ref` does NOT exist in the response: the server does not return it, not even to its payer.
 *  - `external_account_id` / `credential_ref_kind` come as `null` when the account is paid by another
 *    tenant. That is a server redaction, not an empty value, and is modelled as `'redacted'`.
 *  - A key absent from the snapshot (old gateway) is `'absent'`: it is never confused with zero.
 */

export type CredentialRefKind = 'env_path' | 'file' | 'secret_manager';

export const CREDENTIAL_REF_KINDS: readonly CredentialRefKind[] = ['env_path', 'file', 'secret_manager'];

const ACCOUNT_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const TENANT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ALIAS_ID = /^[a-z][a-z0-9_-]{0,63}$/;

/** State of a field the server may null out because it belongs to the payer. */
type FieldVisibility = 'visible' | 'redacted' | 'absent';

export interface ProviderAccount {
  id: string;
  provider: string | null;
  label: string | null;
  payerTenant: string | null;
  sharedWithPool: boolean | null;
  enabled: boolean | null;
  externalAccountId: string | null;
  credentialRefKind: CredentialRefKind | null;
  /** `visible` only when the snapshot brought the value; `redacted` when the server nulled it
   *  because the account is paid by another tenant; `absent` when the gateway did not even publish the key. */
  payerFields: FieldVisibility;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AgentRegistration {
  tenantId: string;
  alias: string;
  harnessId: string | null;
  displayName: string | null;
  enabled: boolean | null;
  containerName: string | null;
  runtimeUser: string | null;
}

interface CeilingEntry {
  tenantId: string;
  alias: string;
  accountId: string;
  accountPayerTenant: string | null;
  createdByTenant: string | null;
  /** Derived from the server: the account is paid by a tenant different from the one routing the alias. */
  borrowed: boolean;
}

export interface AccountBinding {
  tenantId: string;
  agentAlias: string;
  accountId: string;
  priority: number | null;
  enabled: boolean | null;
}

/** A section of the snapshot: distinguishes "the gateway does not publish this" from "there are zero rows". */
interface SnapshotSection<T> {
  available: boolean;
  items: T[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function flag(row: Record<string, unknown>, key: string): boolean | null {
  const value = row[key];
  return typeof value === 'boolean' ? value : null;
}

function integer(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function credentialRefKind(row: Record<string, unknown>): CredentialRefKind | null {
  const value = row.credential_ref_kind;
  return typeof value === 'string' && (CREDENTIAL_REF_KINDS as readonly string[]).includes(value)
    ? value as CredentialRefKind
    : null;
}

/**
 * `external_account_id` is NOT NULL in the database, so a `null` can only come from the CASE that limits
 * it to the payer. An absent key, on the other hand, means the gateway does not publish the field.
 */
function payerFieldVisibility(row: Record<string, unknown>): FieldVisibility {
  if (!Object.prototype.hasOwnProperty.call(row, 'external_account_id')) return 'absent';
  return row.external_account_id === null || row.external_account_id === undefined ? 'redacted' : 'visible';
}

function section<T>(
  snapshot: ConfigurationSnapshot | null | undefined,
  key: 'agents' | 'provider_accounts' | 'alias_routing_ceiling' | 'agent_account_bindings',
  map: (row: Record<string, unknown>) => T | undefined,
): SnapshotSection<T> {
  const raw = snapshot?.[key];
  if (!Array.isArray(raw)) return { available: false, items: [] };
  const items: T[] = [];
  for (const entry of raw) {
    const row = record(entry);
    if (!row) continue;
    const mapped = map(row);
    if (mapped !== undefined) items.push(mapped);
  }
  return { available: true, items };
}

export function readProviderAccounts(snapshot?: ConfigurationSnapshot | null): SnapshotSection<ProviderAccount> {
  return section(snapshot, 'provider_accounts', (row) => {
    const id = text(row, 'id');
    if (!id || !ACCOUNT_ID.test(id)) return undefined;
    return {
      id,
      provider: text(row, 'provider'),
      label: text(row, 'label'),
      payerTenant: text(row, 'payer_tenant_id'),
      sharedWithPool: flag(row, 'shared_with_pool'),
      enabled: flag(row, 'enabled'),
      externalAccountId: text(row, 'external_account_id'),
      credentialRefKind: credentialRefKind(row),
      payerFields: payerFieldVisibility(row),
      createdAt: text(row, 'created_at'),
      updatedAt: text(row, 'updated_at'),
    };
  });
}

function readAgents(snapshot?: ConfigurationSnapshot | null): SnapshotSection<AgentRegistration> {
  return section(snapshot, 'agents', (row) => {
    const tenantId = text(row, 'tenant_id');
    const alias = text(row, 'alias');
    if (!tenantId || !TENANT_ID.test(tenantId) || !alias || !ALIAS_ID.test(alias)) return undefined;
    return {
      tenantId,
      alias,
      harnessId: text(row, 'harness_id'),
      displayName: text(row, 'display_name'),
      enabled: flag(row, 'enabled'),
      containerName: text(row, 'container_name'),
      runtimeUser: text(row, 'runtime_user'),
    };
  });
}

export function readCeiling(snapshot?: ConfigurationSnapshot | null): SnapshotSection<CeilingEntry> {
  return section(snapshot, 'alias_routing_ceiling', (row) => {
    const tenantId = text(row, 'tenant_id');
    const alias = text(row, 'alias');
    const accountId = text(row, 'account_id');
    if (!tenantId || !TENANT_ID.test(tenantId) || !alias || !ALIAS_ID.test(alias)
      || !accountId || !ACCOUNT_ID.test(accountId)) return undefined;
    const accountPayerTenant = text(row, 'account_payer_tenant');
    return {
      tenantId,
      alias,
      accountId,
      accountPayerTenant,
      createdByTenant: text(row, 'created_by_tenant'),
      borrowed: accountPayerTenant !== null && accountPayerTenant !== tenantId,
    };
  });
}

function readBindings(snapshot?: ConfigurationSnapshot | null): SnapshotSection<AccountBinding> {
  return section(snapshot, 'agent_account_bindings', (row) => {
    const tenantId = text(row, 'tenant_id');
    const agentAlias = text(row, 'agent_alias');
    const accountId = text(row, 'account_id');
    if (!tenantId || !TENANT_ID.test(tenantId) || !agentAlias || !ALIAS_ID.test(agentAlias)
      || !accountId || !ACCOUNT_ID.test(accountId)) return undefined;
    return {
      tenantId,
      agentAlias,
      accountId,
      priority: integer(row, 'priority'),
      enabled: flag(row, 'enabled'),
    };
  });
}

/** The actor's tenant comes from the `subject` signed by the server (`tenant:alias`), never from the client. */
export function viewerTenant(subject: unknown): string | undefined {
  if (typeof subject !== 'string') return undefined;
  const tenant = subject.split(':')[0]?.trim();
  return tenant && TENANT_ID.test(tenant) ? tenant : undefined;
}

type MatrixCellState = 'none' | 'ceiling-only' | 'bound-disabled' | 'bound-enabled';

export interface MatrixCell {
  accountId: string;
  state: MatrixCellState;
  /** The account is paid by another tenant. Only meaningful when there is a ceiling. */
  borrowed: boolean;
  grantedBy: string | null;
  priority: number | null;
  /** Position 1..n within the effective fallback order of the alias; null if it does not participate. */
  rank: number | null;
}

interface FallbackStep {
  rank: number;
  accountId: string;
  priority: number | null;
  borrowed: boolean;
}

interface MatrixRow {
  agent: AgentRegistration;
  cells: MatrixCell[];
  /** Retries, in order. Attempt 1 never goes through here: it runs without override and the CLI
   *  resolves the credential already logged into the container (ADR-006). */
  fallback: FallbackStep[];
  /** Accounts inside the ceiling that no enabled binding uses: reachable but never picked. */
  idleCeiling: string[];
}

function compareBindings(
  left: { priority: number | null; accountId: string },
  right: { priority: number | null; accountId: string },
): number {
  const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
  const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  return left.accountId.localeCompare(right.accountId);
}

/**
 * Agent x account matrix. The columns are the visible accounts from the snapshot; a cell only has
 * a state when the ceiling row exists, because `agent_account_bindings` references the ceiling and
 * not `provider_accounts`: without a ceiling there can be no binding.
 */
export function buildAssignmentMatrix(
  agents: AgentRegistration[],
  accounts: ProviderAccount[],
  ceiling: CeilingEntry[],
  bindings: AccountBinding[],
): MatrixRow[] {
  return agents.map((agent) => {
    const agentCeiling = ceiling.filter((entry) => entry.tenantId === agent.tenantId && entry.alias === agent.alias);
    const agentBindings = bindings.filter((entry) => entry.tenantId === agent.tenantId && entry.agentAlias === agent.alias);
    const ordered = agentBindings
      .filter((binding) => binding.enabled === true
        && agentCeiling.some((entry) => entry.accountId === binding.accountId))
      .sort(compareBindings)
      .map((binding, index): FallbackStep => ({
        rank: index + 1,
        accountId: binding.accountId,
        priority: binding.priority,
        borrowed: agentCeiling.find((entry) => entry.accountId === binding.accountId)?.borrowed ?? false,
      }));

    const cells = accounts.map((account): MatrixCell => {
      const granted = agentCeiling.find((entry) => entry.accountId === account.id);
      if (!granted) return { accountId: account.id, state: 'none', borrowed: false, grantedBy: null, priority: null, rank: null };
      const binding = agentBindings.find((entry) => entry.accountId === account.id);
      const step = ordered.find((entry) => entry.accountId === account.id);
      return {
        accountId: account.id,
        borrowed: granted.borrowed,
        grantedBy: granted.createdByTenant,
        priority: binding?.priority ?? null,
        rank: step?.rank ?? null,
        state: !binding ? 'ceiling-only' : binding.enabled === true ? 'bound-enabled' : 'bound-disabled',
      };
    });

    return {
      agent,
      cells,
      fallback: ordered,
      idleCeiling: agentCeiling
        .filter((entry) => !ordered.some((step) => step.accountId === entry.accountId))
        .map((entry) => entry.accountId)
        .sort((left, right) => left.localeCompare(right)),
    };
  });
}

interface RegistryRoutingProjection {
  matrix: MatrixRow[];
}

/** Only update accepted by the server: identity, payer, and locator are immutable. */
export function updateAccountMutation(
  id: string,
  patch: { label: string | null; sharedWithPool: boolean; enabled: boolean },
): ConfigMutation {
  return {
    resource: 'provider_account',
    action: 'update',
    id,
    value: { label: patch.label, shared_with_pool: patch.sharedWithPool, enabled: patch.enabled },
  };
}

export function deleteAccountMutation(id: string): ConfigMutation {
  return { resource: 'provider_account', action: 'delete', id };
}

export function ceilingMutation(
  action: 'create' | 'delete',
  tenantId: string,
  alias: string,
  accountId: string,
): ConfigMutation {
  return { resource: 'alias_routing_ceiling', action, tenant_id: tenantId, alias, account_id: accountId };
}

export function bindingMutation(
  action: 'create' | 'update' | 'delete',
  tenantId: string,
  agentAlias: string,
  accountId: string,
  value?: { priority: number; enabled: boolean },
): ConfigMutation {
  const identity = {
    resource: 'agent_account_binding' as const,
    action,
    tenant_id: tenantId,
    agent_alias: agentAlias,
    account_id: accountId,
  };
  return action === 'delete' ? identity : { ...identity, value };
}

/**
 * The server preview returns the mutation exactly as sent. `credential_ref` is a locator and not
 * a secret, but a value like that on screen reads as one: the console does not reprint it.
 */
export function redactPreview(result: ConfigurationChangeResult): string {
  return JSON.stringify(
    result,
    (key, value: unknown) => (key === 'credential_ref' ? '‹locator no reimpreso por la consola›' : value),
    2,
  );
}

export interface RegistryContext {
  accounts: ProviderAccount[];
  agents: AgentRegistration[];
  ceiling: CeilingEntry[];
  bindings: AccountBinding[];
  tenantIds: string[];
}

export interface RegistryModel {
  accounts: SnapshotSection<ProviderAccount>;
  agents: SnapshotSection<AgentRegistration>;
  ceiling: SnapshotSection<CeilingEntry>;
  bindings: SnapshotSection<AccountBinding>;
  tenantIds: string[];
  routing: RegistryRoutingProjection;
  context: RegistryContext;
}

export function readRegistry(snapshot?: ConfigurationSnapshot | null): RegistryModel {
  const accounts = readProviderAccounts(snapshot);
  const agents = readAgents(snapshot);
  const ceiling = readCeiling(snapshot);
  const bindings = readBindings(snapshot);
  const tenantRows = snapshot?.tenants;
  const tenantIds = Array.isArray(tenantRows)
    ? tenantRows.flatMap((entry) => {
      const row = record(entry);
      const id = row ? text(row, 'id') : null;
      return id && TENANT_ID.test(id) ? [id] : [];
    })
    : [];
  const context: RegistryContext = {
    accounts: accounts.items,
    agents: agents.items,
    ceiling: ceiling.items,
    bindings: bindings.items,
    tenantIds,
  };
  return {
    accounts,
    agents,
    ceiling,
    bindings,
    tenantIds,
    routing: { matrix: buildAssignmentMatrix(agents.items, accounts.items, ceiling.items, bindings.items) },
    context,
  };
}

const DURABLE_CONSTRAINT = /violates a durable constraint/i;
const IMMUTABLE_ACCOUNT = /identity and credential rotation/i;

function borrowersOf(context: RegistryContext, accountId: string, payerTenant: string | null): CeilingEntry[] {
  return context.ceiling.filter((entry) => entry.accountId === accountId
    && payerTenant !== null && entry.tenantId !== payerTenant);
}

/**
 * The store collapses 23503/23505/23514/23P01 into a single 409 "configuration change violates a
 * durable constraint", so the server message does not say which one failed. What IS determinable
 * is WHICH constraints each mutation can violate: those are named, and when the snapshot shows
 * which one is being broken, it is pointed out. A cause that cannot be sustained is never made up.
 */
function constraintCause(mutation: ConfigMutation, context: RegistryContext): string {
  const prefix = 'El servidor rechazó el cambio porque choca con otro dato y no dice con cuál.';

  if (mutation.resource === 'provider_account' && mutation.action === 'delete') {
    const id = String(mutation.id);
    const refs = context.ceiling.filter((entry) => entry.accountId === id);
    if (refs.length > 0) {
      return `No se puede borrar la cuenta «${id}»: todavía figura en el límite de ${refs.map((entry) => `${entry.tenantId}/${entry.alias}`).join(', ')}. Retirarla dejaría a esos agentes apuntando a una cuenta que no existe; quita primero esos límites y vuelve a revisar el cambio.`;
    }
    return `${prefix} Un borrado de cuenta solo puede chocar con un techo que todavía la referencia. Esta vista no lo muestra: actualiza antes de repetir el retiro o la rotación.`;
  }

  if (mutation.resource === 'provider_account' && mutation.action === 'update') {
    const value = record(mutation.value);
    const id = String(mutation.id);
    if (value?.shared_with_pool === false) {
      const account = context.accounts.find((entry) => entry.id === id);
      const borrowers = borrowersOf(context, id, account?.payerTenant ?? null);
      const detail = borrowers.length
        ? ` Límites vigentes que todavía la usan: ${borrowers.map((entry) => `${entry.tenantId}/${entry.alias}`).join(', ')}.`
        : ' Esta vista no muestra el límite que la retiene: actualiza para verlo.';
      return `No se puede dejar de compartir la cuenta «${id}»: otra empresa la tiene en el límite de alguno de sus agentes. Primero quita ese límite, lo que también quita su orden de consulta, y después deja de compartirla.${detail}`;
    }
    return `${prefix} Este cambio solo toca la etiqueta, si se comparte y si está habilitada, así que lo único que puede chocar es dejar de compartir una cuenta que otra empresa está usando. Actualiza la vista y vuelve a revisar el cambio.`;
  }

  if (mutation.resource === 'provider_account' && mutation.action === 'create') {
    const value = record(mutation.value);
    const provider = typeof value?.provider === 'string' ? value.provider : undefined;
    const external = typeof value?.external_account_id === 'string' ? value.external_account_id : undefined;
    const payer = typeof value?.payer_tenant_id === 'string' ? value.payer_tenant_id : undefined;
    const duplicate = provider !== undefined && external !== undefined
      ? context.accounts.find((entry) => entry.provider === provider && entry.externalAccountId === external)
      : undefined;
    if (duplicate) {
      return `Esa suscripción externa ya está registrada como «${duplicate.id}» y la paga ${duplicate.payerTenant ?? 'un cliente que el servidor no informó'}. Dentro de una empresa solo puede haber una cuenta por suscripción; la misma suscripción sí puede registrarse en otra empresa.`;
    }
    if (payer !== undefined && context.tenantIds.length > 0 && !context.tenantIds.includes(payer)) {
      return `El cliente pagador «${payer}» no existe en la configuración visible. Créalo antes de registrar la cuenta.`;
    }
    return `${prefix} Un alta de cuenta puede chocar por tres motivos: la suscripción ya está registrada en esta empresa, el cliente pagador no existe o la referencia de la credencial no tiene el formato esperado. Esta vista no muestra ninguno, así que el choque está en el servidor: actualiza y vuelve a revisar el cambio.`;
  }

  if (mutation.resource === 'alias_routing_ceiling' && mutation.action === 'create') {
    const tenantId = String(mutation.tenant_id);
    const alias = String(mutation.alias);
    const accountId = String(mutation.account_id);
    const agent = context.agents.find((entry) => entry.tenantId === tenantId && entry.alias === alias);
    const account = context.accounts.find((entry) => entry.id === accountId);
    const borrowed = account?.payerTenant !== null && account?.payerTenant !== undefined
      && account.payerTenant !== tenantId;
    const causes: string[] = [];
    if (!agent) {
      causes.push(`el agente ${tenantId}/${alias} no está registrado`);
    }
    if (borrowed && account.sharedWithPool === false) {
      causes.push(`la cuenta «${accountId}» la paga ${account.payerTenant ?? 'un cliente que el servidor no informó'} y NO está compartida: prestar una suscripción lo decide quien la paga`);
    }
    if (causes.length) {
      return `No se pudo otorgar el techo porque ${causes.join('; y ')}.`;
    }
    return `${prefix} Un límite nuevo solo puede chocar por dos motivos: el agente no está registrado, o la cuenta es de otro pagador y no está compartida. Esta vista no muestra ninguno, así que cambió en el servidor: actualiza y vuelve a revisar el cambio.`;
  }

  if (mutation.resource === 'agent_account_binding' && mutation.action !== 'delete') {
    const value = record(mutation.value);
    const tenantId = String(mutation.tenant_id);
    const alias = String(mutation.agent_alias);
    const accountId = String(mutation.account_id);
    const priority = typeof value?.priority === 'number' ? value.priority : undefined;
    const clash = value?.enabled === true && priority !== undefined
      ? context.bindings.find((entry) => entry.tenantId === tenantId && entry.agentAlias === alias
        && entry.accountId !== accountId && entry.enabled === true && entry.priority === priority)
      : undefined;
    if (clash) {
      return `La prioridad ${String(priority)} ya la usa la cuenta «${clash.accountId}» habilitada para ${tenantId}/${alias}. El orden de consulta de un agente no admite dos cuentas con la misma prioridad: elige otra prioridad o deshabilita la otra cuenta.`;
    }
    return `${prefix} Un acceso solo puede chocar por dos motivos: dos cuentas habilitadas con la misma prioridad para el mismo agente, o que la cuenta no esté en el límite de ese agente. Concede primero el límite o cambia la prioridad.`;
  }

  return `${prefix} El servidor rechazó el cambio por una restricción que esta vista no puede atribuir a una sola causa. Actualiza y vuelve a revisar el cambio.`;
}

/**
 * Honest translation of control-plane rejections for the registry's resources. Reuses
 * `describeConfigError` for the optimistic-revision clash, which is identical across every
 * configuration screen.
 */
export function describeRegistryError(
  error: unknown,
  mutation: ConfigMutation,
  context: RegistryContext,
): { message: string; conflict: boolean } {
  const aliasPrefix = 'quota account alias must be deleted with canonical account ';
  const aliasSuffix = ' from My quotas';
  if (error instanceof ApiError && error.status === 409 && error.message.startsWith(aliasPrefix)
    && error.message.endsWith(aliasSuffix) && error.message.length > aliasPrefix.length + aliasSuffix.length) {
    const canonical = error.message.slice(aliasPrefix.length, -aliasSuffix.length);
    return {
      conflict: false,
      message: `Esta fila es un alias de la cuenta «${canonical}» y no aparece en «Mis cuotas». Se elimina al eliminar esa cuenta en «Mis cuotas».`,
    };
  }
  if (error instanceof ApiError && error.status === 409
    && error.message === 'quota accounts must be deleted from My quotas') {
    return { conflict: false, message: 'Esta cuenta se administra en «Mis cuotas». Usa «Eliminar en Mis cuotas» para comprobar sus dependencias y eliminarla con su historial de cuotas.' };
  }
  if (error instanceof ApiError && error.status === 409
    && error.message === 'quota account must be authenticated before it can be enabled') {
    return {
      conflict: false,
      message: 'Esta cuenta todavía no inició sesión. Primero pulsa «Iniciar sesión» en su tarjeta de «Mis cuotas» o en el agente que la usa: la cuenta se habilita sola cuando el proveedor confirma la sesión.',
    };
  }
  const base = describeConfigError(error, 'El servidor rechazó el cambio y no dijo por qué');
  if (base.conflict) return base;
  if (!(error instanceof ApiError)) return base;
  if (error.status === 403) {
    return {
      conflict: false,
      message: `El servidor lo rechazó (403). Este cambio no está autorizado para tu rol y alcance de empresa. Revisa los permisos para este recurso. Respuesta del servidor: «${error.message}».`,
    };
  }
  if (error.status === 409 && IMMUTABLE_ACCOUNT.test(error.message)) {
    return {
      conflict: false,
      message: 'El proveedor, el id externo, el cliente pagador y la referencia de la credencial no se pueden cambiar después del alta, porque otros datos ya apuntan a la cuenta y cambiarlos alteraría los préstamos existentes. Para rotar, da de baja la cuenta y vuelve a crearla; no se edita.',
    };
  }
  if (error.status === 409 && DURABLE_CONSTRAINT.test(error.message)) {
    return { conflict: false, message: constraintCause(mutation, context) };
  }
  return base;
}
