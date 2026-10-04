import { isAnyUuid, type Tenant } from '@cauce/protocol';
import { withAbortableTransaction, withTransaction, type DatabaseClient, type DatabasePool } from '../../db.js';
import { assertPublishRoute } from '../config/publish-policy.js';
import { StoreError } from '../errors.js';
import type { HumanMessageOptions, HumanPublishProvenance } from './contracts.js';
export { assertHumanMessageRoot } from './human-initiators.js';

export async function humanMessageAuthority(
  client: DatabaseClient, options: HumanMessageOptions, tenantId?: Tenant, actorAlias?: string,
): Promise<Readonly<HumanPublishProvenance>> {
  if (typeof options.humanAuthority !== 'function') {
    throw new StoreError('forbidden', 'human message access requires cancellable durable authority');
  }
  options.signal.throwIfAborted();
  const human = await options.humanAuthority(client);
  options.signal.throwIfAborted();
  if (!isAnyUuid(human.humanId) || (tenantId !== undefined && human.tenantId !== tenantId)
      || (actorAlias !== undefined && human.actorAlias !== actorAlias)) {
    throw new StoreError('forbidden', 'human message identity is inconsistent');
  }
  return Object.freeze({ ...human });
}


export async function lockHumanMessageRead(
  client: DatabaseClient, messageId: string, human: HumanPublishProvenance,
): Promise<void> {
  const result = await client.query(
    `SELECT membership.alias FROM messages message
     JOIN memberships membership ON membership.tenant_id=message.tenant_id
       AND membership.room_id=message.room_id AND membership.alias=$3
     JOIN role_policies policy ON policy.role=membership.role
     JOIN tenants tenant ON tenant.id=membership.tenant_id
     JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
     WHERE message.id=$1::uuid AND message.tenant_id=$2 AND membership.enabled
       AND policy.allow_read AND tenant.enabled AND room.enabled
     FOR SHARE OF membership,policy,tenant,room`,
    [messageId, human.tenantId, human.actorAlias],
  );
  if (result.rowCount !== 1) throw new StoreError('not_found', 'message not found or not visible');
}

export async function lockHumanMessageRoute(
  client: DatabaseClient, messageId: string, human: HumanPublishProvenance,
): Promise<void> {
  const result = await client.query<{ room_id: string; recipients: { tenant_id: Tenant; alias: string }[] }>(
    `SELECT message.room_id,jsonb_agg(jsonb_build_object(
       'tenant_id',delivery.recipient_tenant,'alias',delivery.recipient_alias
     ) ORDER BY delivery.id) AS recipients
     FROM messages message JOIN deliveries delivery ON delivery.message_id=message.id
     WHERE message.id=$1::uuid AND message.tenant_id=$2 GROUP BY message.id`,
    [messageId, human.tenantId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new StoreError('not_found', 'message not found or not owned');
  await assertPublishRoute(client, { tenant_id: human.tenantId, actor_alias: human.actorAlias,
    room_id: row.room_id, recipients: row.recipients }, true);
}

export async function withHumanMessageTransaction<T>(
  pool: DatabasePool, options: HumanMessageOptions | undefined, tenantId: Tenant, actorAlias: string,
  work: (client: DatabaseClient, human: Readonly<HumanPublishProvenance> | undefined) => Promise<T>,
): Promise<T> {
  const guarded = async (client: DatabaseClient): Promise<T> => work(client,
    options === undefined ? undefined : await humanMessageAuthority(client, options, tenantId, actorAlias));
  return options === undefined ? withTransaction(pool, guarded) : withAbortableTransaction(pool, options.signal, guarded);
}
