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
  const membership = (await client.query<MembershipRow>(
    `SELECT tenant_id, actor_alias, role, permissions, enabled, revision::text, revoked_at
     FROM human_tenant_memberships WHERE human_id=$1 AND tenant_id=$2 FOR SHARE`,
    [humanId, account.tenant_id],
  )).rows[0];
  if (!membership?.enabled || membership.revoked_at !== null) return undefined;
  return Object.freeze({
    humanId, bindingId: binding.id, provider, namespace, subject,
    bindingRevision: binding.revision,
    account: Object.freeze({ active: account.active, role: account.role,
      defaultTenant: account.tenant_id, displayName: account.display_name }),
    membership: Object.freeze({ tenantId: membership.tenant_id, actorAlias: membership.actor_alias,
      role: membership.role, permissions: Object.freeze([...membership.permissions]),
      enabled: membership.enabled, revision: membership.revision }),
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
