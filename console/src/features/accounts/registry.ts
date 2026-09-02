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

export const CREDENTIAL_REF_HINTS: Record<CredentialRefKind, string> = {
  env_path: 'Nombre de variable de entorno que el adapter lee en su propio proceso. Forma exigida: CAUCE_<ALGO>_PATH o CAUCE_<ALGO>_FILE.',
  file: 'Ruta absoluta en el host, sin `//` ni segmentos `.` o `..`.',
  secret_manager: 'Locator `esquema:path` con esquema vault, aws-sm, gcp-sm, op o azure-kv.',
};

// Same expressions as packages/store/migrations/010_agent_account_registry.sql and
// packages/protocol/src/schemas.ts. Validated here only to avoid spending a round-trip on an
// obviously malformed locator: the authority is still the Postgres CHECK.
const ENV_PATH_REF = /^CAUCE_[A-Z0-9_]{1,120}_(PATH|FILE)$/;
const SECRET_MANAGER_REF = /^(vault|aws-sm|gcp-sm|op|azure-kv):[a-z0-9][a-z0-9_.:/-]{0,254}$/;
// eslint-disable-next-line no-control-regex -- mirrors the CHECK `credential_ref !~ '[[:cntrl:]]'`.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DOT_SEGMENT = /(^|\/)\.\.?(\/|$)/;
const ACCOUNT_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const PROVIDER_ID = /^[a-z][a-z0-9_.-]{0,63}$/;
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
      if (!granted) return { accountId: account.id, state: 'none', borrowed: false, priority: null, rank: null };
      const binding = agentBindings.find((entry) => entry.accountId === account.id);
      const step = ordered.find((entry) => entry.accountId === account.id);
      return {
        accountId: account.id,
        borrowed: granted.borrowed,
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

export interface AccountRouteEntry {
  agent: AgentRegistration;
  cell: MatrixCell;
  ceiling: CeilingEntry;
}

export interface AccountRouteProjection {
  accountId: string;
  entries: AccountRouteEntry[];
}

interface RegistryRoutingProjection {
  matrix: MatrixRow[];
  byAccount: ReadonlyMap<string, AccountRouteProjection>;
}

function buildRegistryRouting(
  agents: AgentRegistration[],
  accounts: ProviderAccount[],
  ceiling: CeilingEntry[],
  bindings: AccountBinding[],
): RegistryRoutingProjection {
  const matrix = buildAssignmentMatrix(agents, accounts, ceiling, bindings);
  const byAccount = new Map<string, AccountRouteProjection>();
  for (const account of accounts) {
    byAccount.set(account.id, {
      accountId: account.id,
      entries: matrix.flatMap((row) => {
        const cell = row.cells.find((candidate) => candidate.accountId === account.id);
        const granted = ceiling.find((entry) => entry.tenantId === row.agent.tenantId
          && entry.alias === row.agent.alias && entry.accountId === account.id);
        return cell && cell.state !== 'none' && granted ? [{ agent: row.agent, cell, ceiling: granted }] : [];
      }),
    });
  }
  return { matrix, byAccount };
}

export interface AccountDraft {
  id: string;
  provider: string;
  externalAccountId: string;
  payerTenant: string;
  label: string;
  credentialRefKind: CredentialRefKind;
  credentialRef: string;
  sharedWithPool: boolean;
  enabled: boolean;
}

export function credentialRefError(kind: CredentialRefKind, reference: string): string | undefined {
  const value = reference.trim();
  if (!value) return 'El locator de la credencial es obligatorio: es una referencia, no el secreto.';
  if (CONTROL_CHARS.test(value)) return 'El locator no puede contener caracteres de control.';
  if (kind === 'env_path') {
    return ENV_PATH_REF.test(value)
      ? undefined
      : 'Con env_path el locator tiene que ser el nombre de una variable con forma CAUCE_<ALGO>_PATH o CAUCE_<ALGO>_FILE.';
  }
  if (kind === 'file') {
    if (!value.startsWith('/')) return 'Con file el locator tiene que ser una ruta absoluta (empieza con /).';
    if (value.length < 2 || value.length > 1024) return 'Con file la ruta tiene que medir entre 2 y 1024 caracteres.';
    if (value.includes('//')) return 'Con file la ruta no puede contener // repetidos.';
    if (DOT_SEGMENT.test(value)) return 'Con file la ruta no puede tener segmentos . ni ..';
    return undefined;
  }
  return SECRET_MANAGER_REF.test(value)
    ? undefined
    : 'Con secret_manager el locator tiene que ser esquema:path, con esquema vault, aws-sm, gcp-sm, op o azure-kv.';
}

export function accountDraftError(draft: AccountDraft): string | undefined {
  if (!ACCOUNT_ID.test(draft.id.trim())) {
    return 'El id de cuenta debe empezar con minúscula y usar sólo minúsculas, números, guion o guion bajo (máx. 64).';
  }
  if (!PROVIDER_ID.test(draft.provider.trim())) {
    return 'El proveedor debe empezar con minúscula y usar sólo minúsculas, números, punto, guion o guion bajo (máx. 64).';
  }
  const external = draft.externalAccountId.trim();
  if (external.length < 1 || external.length > 256) {
    return 'El id externo de la suscripción (uuid, mail, org id) es obligatorio y mide hasta 256 caracteres. Nunca es el secreto.';
  }
  if (!TENANT_ID.test(draft.payerTenant.trim())) {
    return 'El tenant pagador debe empezar con letra y usar sólo letras, números, guion o guion bajo (máx. 64).';
  }
  return credentialRefError(draft.credentialRefKind, draft.credentialRef);
}

export function createAccountMutation(draft: AccountDraft): ConfigMutation {
  return {
    resource: 'provider_account',
    action: 'create',
    id: draft.id.trim(),
    value: {
      provider: draft.provider.trim(),
      external_account_id: draft.externalAccountId.trim(),
      payer_tenant_id: draft.payerTenant.trim(),
      label: draft.label.trim() || null,
      credential_ref_kind: draft.credentialRefKind,
      credential_ref: draft.credentialRef.trim(),
      shared_with_pool: draft.sharedWithPool,
      enabled: draft.enabled,
    },
  };
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
    routing: buildRegistryRouting(agents.items, accounts.items, ceiling.items, bindings.items),
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
  const prefix = 'El servidor rechazó el cambio con 409 y no publica qué restricción falló.';

  if (mutation.resource === 'provider_account' && mutation.action === 'delete') {
    const id = String(mutation.id);
    const refs = context.ceiling.filter((entry) => entry.accountId === id);
    if (refs.length > 0) {
      return `No se puede borrar la cuenta «${id}»: todavía pertenece al techo de ${refs.map((entry) => `${entry.tenantId}/${entry.alias}`).join(', ')}. El foreign key de alias_routing_ceiling impide dejar esos alias apuntando a una cuenta inexistente; revocá primero esos techos y volvé a previsualizar.`;
    }
    return `${prefix} Un borrado de cuenta sólo puede chocar con un techo que todavía la referencia. El snapshot local no lo muestra: actualizá antes de repetir el retiro o la rotación.`;
  }

  if (mutation.resource === 'provider_account' && mutation.action === 'update') {
    const value = record(mutation.value);
    const id = String(mutation.id);
    if (value?.shared_with_pool === false) {
      const account = context.accounts.find((entry) => entry.id === id);
      const borrowers = borrowersOf(context, id, account?.payerTenant ?? null);
      const detail = borrowers.length
        ? ` Techos vigentes que todavía la usan: ${borrowers.map((entry) => `${entry.tenantId}/${entry.alias}`).join(', ')}.`
        : ' El snapshot local no muestra el techo que la retiene: actualizá para verlo.';
      return `No se puede despublicar la cuenta «${id}» del pool: otro tenant la tiene en el techo de alguno de sus alias, y el FK alias_routing_ceiling_borrow_requires_pool lo impide. Es la única restricción durable que un update de cuenta puede violar. Primero hay que revocar ese techo —lo que cascadea su binding— y recién después despublicarla.${detail}`;
    }
    return `${prefix} Un update de cuenta sólo toca label, shared_with_pool y enabled, así que la única restricción durable alcanzable es alias_routing_ceiling_borrow_requires_pool (despublicar mientras otro tenant la usa). Actualizá el snapshot y volvé a previsualizar.`;
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
      return `Esa suscripción externa ya está registrada como «${duplicate.id}» y la paga ${duplicate.payerTenant ?? 'un cliente que el servidor no informó'}. UNIQUE (provider, external_account_id) existe para que "quién paga qué" tenga una sola respuesta: no se puede registrar dos veces con dos pagadores.`;
    }
    if (payer !== undefined && context.tenantIds.length > 0 && !context.tenantIds.includes(payer)) {
      return `El tenant pagador «${payer}» no existe en la configuración visible, y payer_tenant_id es un foreign key contra tenants. Creá el tenant antes de registrar la cuenta.`;
    }
    return `${prefix} Un alta de cuenta puede violar tres: UNIQUE (provider, external_account_id) —la suscripción ya está registrada con otro pagador—, el foreign key de payer_tenant_id contra tenants, o el CHECK provider_accounts_credential_ref_shape sobre el locator. El snapshot local no muestra ninguna incumplida, así que el choque está del lado del servidor: actualizá y volvé a previsualizar.`;
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
      causes.push(`el alias ${tenantId}/${alias} no está registrado en \`agents\`, y alias_routing_ceiling_agent_fk lo exige`);
    }
    if (borrowed && account.sharedWithPool === false) {
      causes.push(`la cuenta «${accountId}» la paga ${account.payerTenant ?? 'UNKNOWN'} y NO está publicada al pool: prestar una suscripción lo decide su pagador con shared_with_pool, y alias_routing_ceiling_borrow_requires_pool lo verifica en Postgres`);
    }
    if (causes.length) {
      return `No se pudo otorgar el techo porque ${causes.join('; y ')}.`;
    }
    return `${prefix} Un alta de techo sólo puede violar dos: alias_routing_ceiling_agent_fk (el alias no está en \`agents\`) y alias_routing_ceiling_borrow_requires_pool (la cuenta es de otro pagador y no está publicada al pool). El snapshot local no muestra ninguna de las dos incumplida, así que cambió en el servidor: actualizá y volvé a previsualizar.`;
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
      return `La prioridad ${String(priority)} ya la usa la cuenta «${clash.accountId}» habilitada para ${tenantId}/${alias}. El índice único agent_account_bindings_order_idx existe para que el orden de fallback de un alias sea total: elegí otra prioridad o deshabilitá la otra cuenta.`;
    }
    return `${prefix} Un binding sólo puede violar dos: el índice único agent_account_bindings_order_idx (dos cuentas habilitadas con la misma prioridad para el mismo alias) o agent_account_bindings_ceiling_fk (la cuenta no está en el techo del alias, y el binding referencia al techo, no a provider_accounts). Otorgá primero el techo o cambiá la prioridad.`;
  }

  return `${prefix} Mutación rechazada por una restricción durable de Postgres; el snapshot local no permite atribuirla a una sola. Actualizá el snapshot y volvé a previsualizar.`;
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
  const base = describeConfigError(error, 'El servidor rechazó el cambio y no dijo por qué');
  if (base.conflict) return base;
  if (!(error instanceof ApiError)) return base;
  if (error.status === 403) {
    return {
      conflict: false,
      message: `Rechazado con 403. Los cuatro recursos del registro (agent, provider_account, alias_routing_ceiling, agent_account_binding) son hub-only: prestar una suscripción decide sobre la plata de otro tenant y no quedó como self-service. Respuesta del servidor: «${error.message}».`,
    };
  }
  if (error.status === 409 && IMMUTABLE_ACCOUNT.test(error.message)) {
    return {
      conflict: false,
      message: 'El proveedor, el id externo, el tenant pagador y el locator de la credencial son inmutables después del alta: el id de cuenta está referenciado desde los techos, y repuntarlo cambiaría retroactivamente qué significa cada préstamo existente. Rotar es dar de baja y volver a crear, no editar.',
    };
  }
  if (error.status === 409 && DURABLE_CONSTRAINT.test(error.message)) {
    return { conflict: false, message: constraintCause(mutation, context) };
  }
  return base;
}
