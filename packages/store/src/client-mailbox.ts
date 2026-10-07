import { createHash } from 'node:crypto';
import { isAnyUuid, isTenant, type Tenant } from '@cauce/protocol';
import type { DatabaseClient } from './db.js';
import { StoreError } from './repository/errors.js';

export const CLIENT_MAILBOX_CAPACITY = 1000;
export const CLIENT_MAILBOX_MESSAGE_BYTES = 16 * 1024;
const ADDRESS = /^mbx-[a-f0-9]{48}$/u;
const MAILBOX_ALIAS_SQL = `'mbx-'||left(encode(digest('cauce-v3:client-mailbox:v1:'||grant_row.tenant_id||':'||grant_row.id::text,'sha256'),'hex'),48)`;
export function clientMailboxAddress(grantId: string, tenant: Tenant): string {
  if (!isAnyUuid(grantId)) throw new StoreError('invalid_input', 'invalid mailbox grant');
  if (!isTenant(tenant)) throw new StoreError('invalid_input', 'invalid mailbox tenant');
  return `mbx-${createHash('sha256').update(`cauce-v3:client-mailbox:v1:${tenant}:${grantId.toLowerCase()}`).digest('hex').slice(0, 48)}`;
}
export function isClientMailboxAlias(alias: string): boolean { return ADDRESS.test(alias); }
export interface ClientMailbox {
  readonly tenant_id: Tenant; readonly alias: string; readonly label: string;
  readonly grant_id: string; readonly human_id: string; readonly actor_alias: string;
}

const ACTIVE_MAILBOX_SQL = `FROM console_users account
  JOIN human_external_identities binding ON binding.human_id=account.id
  JOIN human_tenant_memberships human_member ON human_member.human_id=account.id AND human_member.tenant_id=account.tenant_id
  JOIN cauce_oauth_grants grant_row ON grant_row.human_id=account.id AND grant_row.binding_id=binding.id
    AND grant_row.tenant_id=human_member.tenant_id AND grant_row.actor_alias=human_member.actor_alias
    AND grant_row.binding_revision=binding.revision AND grant_row.membership_revision=human_member.revision
  JOIN human_oauth_client_delegations declaration ON declaration.local_oauth_grant_id=grant_row.id
    AND declaration.human_id=grant_row.human_id AND declaration.tenant_id=grant_row.tenant_id
  JOIN tenants tenant ON tenant.id=grant_row.tenant_id
  WHERE account.active AND binding.enabled AND binding.revoked_at IS NULL
    AND binding.provider='oauth' AND binding.namespace=grant_row.issuer AND binding.subject=account.id::text
    AND human_member.enabled AND human_member.revoked_at IS NULL AND 'read'=ANY(human_member.permissions)
    AND declaration.revoked_at IS NULL AND tenant.enabled AND 'cauce.read'=ANY(grant_row.scopes)
    AND grant_row.expires_at>clock_timestamp()
    AND EXISTS (SELECT 1 FROM memberships membership JOIN role_policies policy ON policy.role=membership.role
      JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
      WHERE membership.tenant_id=grant_row.tenant_id AND membership.alias=grant_row.actor_alias
        AND membership.enabled AND policy.allow_read AND room.enabled)
    AND NOT EXISTS (SELECT 1 FROM cauce_oauth_grant_revocations revoked WHERE revoked.grant_id=grant_row.id)
    AND NOT EXISTS (SELECT 1 FROM agents agent WHERE agent.tenant_id=grant_row.tenant_id
      AND agent.alias=${MAILBOX_ALIAS_SQL})`;
const MAILBOX_COLUMNS = `grant_row.tenant_id,${MAILBOX_ALIAS_SQL} AS alias,
  declaration.label,grant_row.id AS grant_id,grant_row.human_id,grant_row.actor_alias`;

export async function resolveClientMailbox(client: DatabaseClient, tenant: Tenant, alias: string): Promise<ClientMailbox | undefined> {
  if (!isClientMailboxAlias(alias)) return undefined;
  const mailbox = (await client.query<ClientMailbox>(`SELECT ${MAILBOX_COLUMNS} ${ACTIVE_MAILBOX_SQL}
    AND grant_row.tenant_id=$1 AND ${MAILBOX_ALIAS_SQL}=$2
    FOR SHARE OF account,binding,human_member,grant_row,declaration,tenant`, [tenant, alias])).rows[0];
  if (!mailbox) return undefined;
  const membership = await client.query(`SELECT 1 FROM memberships member JOIN role_policies policy ON policy.role=member.role
    JOIN rooms room ON room.id=member.room_id AND room.tenant_id=member.tenant_id
    WHERE member.tenant_id=$1 AND member.alias=$2 AND member.enabled AND policy.allow_read AND room.enabled
    FOR SHARE OF member,policy,room`, [tenant, mailbox.actor_alias]);
  return membership.rowCount === 0 ? undefined : mailbox;
}
export async function clientMailboxRoutingTargets(client: DatabaseClient, tenant: Tenant, alias?: string): Promise<{
  tenant_id: Tenant; alias: string; online: false; client_mailbox: { label: string; available: true };
}[]> {
  const rows = await client.query<ClientMailbox>(`SELECT ${MAILBOX_COLUMNS} ${ACTIVE_MAILBOX_SQL}
    AND (grant_row.tenant_id=$1 OR EXISTS (SELECT 1 FROM acl_edges edge JOIN tenants source ON source.id=edge.from_tenant
      WHERE edge.from_tenant=$1 AND edge.to_tenant=grant_row.tenant_id AND source.enabled
        AND edge.enabled AND edge.allow_route AND (source.is_hub OR tenant.is_hub)))
    AND ($2::text IS NULL OR ${MAILBOX_ALIAS_SQL}=$2)
    ORDER BY grant_row.tenant_id,grant_row.id LIMIT CASE WHEN $2::text IS NULL THEN 100 ELSE NULL END`, [tenant, alias ?? null]);
  return rows.rows.map((row) => ({ tenant_id: row.tenant_id, alias: row.alias, online: false,
    client_mailbox: { label: row.label, available: true } }));
}

export async function insertClientMailboxDelivery(client: DatabaseClient, messageId: string,
  tenant: Tenant, alias: string): Promise<{ id: string }> {
  if (!await resolveClientMailbox(client, tenant, alias)) throw new StoreError('no_route', 'client mailbox is unavailable');
  const message = (await client.query<{ body: Record<string, unknown> }>('SELECT body FROM messages WHERE id=$1', [messageId])).rows[0];
  if (!message || typeof message.body.text !== 'string' || message.body.text.trim().length === 0
      || message.body.attachments_v1 !== undefined || message.body.artifacts_v1 !== undefined
      || Buffer.byteLength(JSON.stringify(message.body)) > CLIENT_MAILBOX_MESSAGE_BYTES) {
    throw new StoreError('invalid_input', 'client mailboxes accept bounded text messages without attachments');
  }
  if (!await clientMailboxHasCapacity(client, tenant, alias)) throw new StoreError('conflict', 'client mailbox capacity exhausted');
  const mailbox = await resolveClientMailbox(client, tenant, alias);
  if (mailbox === undefined) throw new StoreError('no_route', 'client mailbox is unavailable');
  const result = { kind: 'client_mailbox', state: 'stored', label: mailbox.label,
    owner_human_id: mailbox.human_id, grant_id: mailbox.grant_id };
  const row = (await client.query<{ id: string }>(`INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,
    status,terminal_at,result) VALUES($1,$2,$3,'done',clock_timestamp(),$4::jsonb) RETURNING id`,
  [messageId, tenant, alias, JSON.stringify(result)])).rows[0];
  if (!row) throw new Error('mailbox delivery insert returned no id');
  await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,message_id,delivery_id,metadata)
    VALUES($1,$2,'client_mailbox.store','allow',$3,$4,$5::jsonb)`,
  [tenant, alias, messageId, row.id, JSON.stringify({ state: 'stored', label: mailbox.label })]);
  return row;
}

export async function clientMailboxHasCapacity(client: DatabaseClient, tenant: Tenant, alias: string): Promise<boolean> {
  await lockClientMailboxes(client, [{ tenant_id: tenant, alias }]);
  const count = (await client.query<{ count: number }>(`SELECT count(*)::integer AS count FROM deliveries
    WHERE recipient_tenant=$1 AND recipient_alias=$2`, [tenant, alias])).rows[0]?.count ?? 0;
  return count < CLIENT_MAILBOX_CAPACITY;
}

export function clientMailboxStoredSql(alias: string): string {
  return `COALESCE(${alias}.result->>'kind'='client_mailbox' AND ${alias}.result->>'state'='stored'
    AND ${alias}.status='done' AND ${alias}.attempt=0,false)`;
}
export const CLIENT_MAILBOX_DELIVERY_VIEW_SQL = `CASE WHEN ${clientMailboxStoredSql('d')}
  THEN jsonb_build_object('label',d.result->>'label','state','stored') ELSE NULL END`;

export async function lockClientMailboxes(client: DatabaseClient, targets: readonly { tenant_id: Tenant; alias: string }[]): Promise<void> {
  const keys = [...new Set(targets.filter(target => isClientMailboxAlias(target.alias))
    .map(target => `client-mailbox:${target.tenant_id}:${target.alias}`))].sort();
  for (const key of keys) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
}
