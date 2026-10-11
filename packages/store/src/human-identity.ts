import { StoreError } from './repository/errors.js';
import { isAnyUuid } from '@cauce/protocol';
import { withAbortableTransaction, type DatabaseClient, type DatabasePool } from './db.js';

export interface HumanIdentityKey {
  readonly provider: 'oauth';
  readonly namespace: string;
  readonly subject: string;
}

export interface HumanIdentitySnapshot extends HumanIdentityKey {
  readonly humanId: string;
  readonly bindingId: string;
  readonly bindingRevision: string;
  readonly account: Readonly<{
    active: boolean;
    role: string;
    defaultTenant: string;
    displayName: string;
  }>;
  readonly membership: Readonly<{
    tenantId: string;
    actorAlias: string;
    role: string;
    permissions: readonly string[];
    enabled: boolean;
    revision: string;
  }>;
}

interface AccountRow { id: string; active: boolean; role: string; tenant_id: string; display_name: string }
interface BindingRow { id: string; human_id: string; revision: string; enabled: boolean; revoked_at: Date | null }
interface MembershipRow {
  tenant_id: string; actor_alias: string; role: string; permissions: string[];
  enabled: boolean; revision: string; revoked_at: Date | null;
}

const BINDING_KEY = 'provider=$1 AND namespace=$2 COLLATE "C" AND subject=$3 COLLATE "C"';

async function lockHomeMembership(
  client: DatabaseClient, humanId: string, tenantId: string,
): Promise<HumanIdentitySnapshot['membership'] | undefined> {
  const membership = (await client.query<MembershipRow>(
    `SELECT human.tenant_id, human.actor_alias, human.role, human.permissions, human.enabled, human.revision::text, human.revoked_at
     FROM human_tenant_memberships human JOIN tenants tenant ON tenant.id=human.tenant_id
     JOIN companies company ON company.id=tenant.company_id
     WHERE human.human_id=$1 AND human.tenant_id=$2 AND tenant.enabled AND tenant.retired_at IS NULL
       AND company.enabled AND company.retired_at IS NULL FOR SHARE OF human,tenant`,
    [humanId, tenantId],
  )).rows[0];
  if (!membership?.enabled || membership.revoked_at !== null) return undefined;
  return Object.freeze({ tenantId: membership.tenant_id, actorAlias: membership.actor_alias,
    role: membership.role, permissions: Object.freeze([...membership.permissions]),
    enabled: membership.enabled, revision: membership.revision });
}

function validKey(key: { provider: unknown; namespace: unknown; subject: unknown }): boolean {
  return key.provider === 'oauth' && typeof key.namespace === 'string' && typeof key.subject === 'string'
    && Buffer.byteLength(key.namespace) > 0 && Buffer.byteLength(key.namespace) <= 1024
    && Buffer.byteLength(key.subject) > 0 && Buffer.byteLength(key.subject) <= 512;
}

async function readLockedIdentity(
  client: DatabaseClient,
  key: HumanIdentityKey,
  expectedHumanId?: string,
): Promise<HumanIdentitySnapshot | undefined> {
  if (!validKey(key) || (expectedHumanId !== undefined && !isAnyUuid(expectedHumanId))) return undefined;
  await client.query('SELECT cauce_lock_authority_read_guard()');
  const { provider, namespace, subject } = key;
  const values = [provider, namespace, subject];
  const lookup = await client.query<{ human_id: string }>(
    `SELECT human_id FROM human_external_identities WHERE ${BINDING_KEY}`, values,
  );
  const humanId = lookup.rows[0]?.human_id;
  if (humanId === undefined || (expectedHumanId !== undefined && humanId !== expectedHumanId)) return undefined;
  const account = (await client.query<AccountRow>(
    'SELECT id, active, role, tenant_id, display_name FROM console_users WHERE id=$1 FOR SHARE', [humanId],
  )).rows[0];
  const binding = (await client.query<BindingRow>(
    `SELECT id, human_id, revision::text, enabled, revoked_at FROM human_external_identities
     WHERE ${BINDING_KEY} FOR SHARE`, values,
  )).rows[0];
  if (!account?.active || !binding?.enabled || binding.revoked_at !== null || binding.human_id !== account.id
      || account.id !== humanId) return undefined;
  const membership = await lockHomeMembership(client, humanId, account.tenant_id);
  if (!membership) return undefined;
  return Object.freeze({
    humanId, bindingId: binding.id, provider, namespace, subject,
    bindingRevision: binding.revision,
    account: Object.freeze({ active: account.active, role: account.role,
      defaultTenant: account.tenant_id, displayName: account.display_name }),
    membership,
  });
}

export async function resolveHumanIdentity(
  pool: DatabasePool,
  key: HumanIdentityKey,
  signal: AbortSignal,
): Promise<HumanIdentitySnapshot | undefined> {
  const externalKey = Object.freeze({ provider: key.provider, namespace: key.namespace, subject: key.subject });
  return withAbortableTransaction(pool, signal, async (client) => {
    await client.query("SELECT set_config('statement_timeout', '5000', true), set_config('lock_timeout', '5000', true)");
    return readLockedIdentity(client, externalKey);
  });
}

/** The caller owns the transaction and retains these locks through its authorized write. */
export async function lockHumanIdentity(
  client: DatabaseClient,
  key: HumanIdentityKey,
  expectedHumanId: string,
): Promise<HumanIdentitySnapshot> {
  const snapshot = await readLockedIdentity(client, key, expectedHumanId);
  if (!snapshot) throw new StoreError('forbidden', 'human identity is unavailable');
  return snapshot;
}

export interface ConsoleHumanSnapshot {
  readonly humanId: string;
  readonly account: Readonly<{ active: boolean; role: string; defaultTenant: string;
    actorAlias: string; passwordChangedAt: number }>;
  readonly membership: HumanIdentitySnapshot['membership'];
}

export interface ConsoleCredentialSnapshot {
  readonly userId: string;
  readonly passwordHash: string;
  readonly passwordChangedAtUs: string;
}

export type ConsoleCredentialStampVerifier = (
  stamp: string,
  current: Readonly<ConsoleCredentialSnapshot>,
) => boolean;

export interface ConsoleCredentialStampCheck {
  readonly credentialStamp: string;
  readonly verifyCredentialStamp: ConsoleCredentialStampVerifier;
}

function credentialVerifierAccepted(value: unknown): value is true {
  return value === true;
}

export async function lockConsoleHuman(
  client: DatabaseClient,
  humanId: string,
  credentialCheck?: Readonly<ConsoleCredentialStampCheck>,
): Promise<ConsoleHumanSnapshot> {
  if (!isAnyUuid(humanId)) throw new StoreError('forbidden', 'console human authority is unavailable');
  if (credentialCheck !== undefined && (typeof credentialCheck.credentialStamp !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/u.test(credentialCheck.credentialStamp)
      || typeof credentialCheck.verifyCredentialStamp !== 'function')) {
    throw new StoreError('forbidden', 'console human authority is unavailable');
  }
  await client.query('SELECT cauce_lock_authority_read_guard()');
  const credentialColumns = credentialCheck === undefined ? '' :
    ', password_hash, (extract(epoch FROM password_changed_at)*1000000)::numeric(20,0)::text AS password_changed_at_us';
  const account = (await client.query<AccountRow & {
    alias: string; password_changed_at: Date; password_hash?: string; password_changed_at_us?: string;
  }>(
    `SELECT id, active, role, tenant_id, alias, password_changed_at${credentialColumns}
     FROM console_users WHERE id=$1 FOR SHARE`,
    [humanId],
  )).rows[0];
  if (!account?.active) throw new StoreError('forbidden', 'console human authority is unavailable');
  if (credentialCheck !== undefined) {
    if (typeof account.password_hash !== 'string' || typeof account.password_changed_at_us !== 'string') {
      throw new StoreError('forbidden', 'console human authority is unavailable');
    }
    const credential: Readonly<ConsoleCredentialSnapshot> = Object.freeze({ userId: account.id,
      passwordHash: account.password_hash, passwordChangedAtUs: account.password_changed_at_us });
    let verified = false;
    try {
      verified = credentialVerifierAccepted(
        credentialCheck.verifyCredentialStamp(credentialCheck.credentialStamp, credential),
      );
    } catch {
      verified = false;
    }
    if (!verified) throw new StoreError('forbidden', 'console human authority is unavailable');
  }
  const membership = await lockHomeMembership(client, humanId, account.tenant_id);
  if (!membership) throw new StoreError('forbidden', 'console human authority is unavailable');
  return Object.freeze({ humanId: account.id,
    account: Object.freeze({ active: account.active, role: account.role, defaultTenant: account.tenant_id,
      actorAlias: account.alias, passwordChangedAt: account.password_changed_at.getTime() }),
    membership,
  });
}

export interface ConsolePersonSnapshot {
  readonly humanId: string;
  readonly account: Readonly<{ active: boolean; role: string; defaultTenant: string; actorAlias: string; company: string }>;
  /** Absent while the home membership is missing, disabled or revoked. */
  readonly membership?: HumanIdentitySnapshot['membership'];
}

/** Locks a console person and its home membership without judging either; the caller decides. */
export async function lockConsolePerson(client: DatabaseClient, humanId: string): Promise<ConsolePersonSnapshot | undefined> {
  if (!isAnyUuid(humanId)) return undefined;
  await client.query('SELECT cauce_lock_authority_read_guard()');
  const account = (await client.query<AccountRow & { alias: string; company_id: string }>(
    'SELECT id, active, role, tenant_id, alias, company_id FROM console_users WHERE id=$1 FOR SHARE', [humanId],
  )).rows[0];
  if (!account) return undefined;
  const membership = await lockHomeMembership(client, humanId, account.tenant_id);
  return Object.freeze({ humanId: account.id,
    account: Object.freeze({ active: account.active, role: account.role, defaultTenant: account.tenant_id,
      actorAlias: account.alias, company: account.company_id }),
    ...(membership === undefined ? {} : { membership }) });
}
