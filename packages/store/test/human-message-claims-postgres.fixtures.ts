import { randomUUID } from 'node:crypto';
import type { DeliveryEnvelope, Tenant } from '@cauce/protocol';
import { HUMAN_MESSAGE_INITIATOR_CAPABILITY } from '@cauce/protocol';
import {
  consoleIntent, databasePool, getRepository, HUMAN_PUBLISH_SCOPE,
  publishCommand, publishOptions, seedHumanPublishActor,
} from './human-publish-authority-postgres.fixtures.js';
import type { Consumer } from './helpers/consumer.js';

export { databasePool, getRepository, seedHumanPublishActor };
export type HumanAccount = Awaited<ReturnType<typeof seedHumanPublishActor>>;
export interface ClaimConsumer extends Consumer { connectionToken: string }

export async function publishRoot(account: HumanAccount, recipientTenant: 'Steven' | 'Isa' = 'Steven') {
  const repository = getRepository();
  const intent = consoleIntent(account, recipientTenant);
  const options = publishOptions(account);
  const { humanAuthority, signal } = options;
  if (humanAuthority === undefined || signal === undefined) throw new Error('human publication authority missing');
  const prepared = await repository.prepareConsolePublishIntent(intent, HUMAN_PUBLISH_SCOPE, { humanAuthority, signal });
  if (prepared.state !== 'prepared') throw new Error('human publication intent was not prepared');
  const command = publishCommand(intent, prepared.idempotency_key);
  const receipt = await repository.publish(command, options);
  const ledger = await databasePool().query<{ conversation_id: string }>(
    'SELECT conversation_id FROM human_message_initiators WHERE message_id=$1', [receipt.message_id],
  );
  const row = ledger.rows[0];
  if (row === undefined) throw new Error('real human publication did not persist its initiator');
  return {
    receipt, command, options,
    initiator: { human_id: account.humanId, tenant_id: 'Steven',
      conversation_id: row.conversation_id, root_message_id: receipt.message_id },
  };
}

export async function claimConsumer(
  alias = 'argos', capabilities: string[] = [HUMAN_MESSAGE_INITIATOR_CAPABILITY],
  tenant: Tenant = 'Steven', instanceId = `human-claim-${randomUUID()}`,
): Promise<ClaimConsumer> {
  const lease = await getRepository().acquireLease(tenant, alias, instanceId, capabilities, 60_000);
  if (!lease.acquired || lease.epoch === undefined || lease.connection_token === undefined) {
    throw new Error('human claim consumer did not acquire its lease');
  }
  return { tenant, alias, instanceId, epoch: lease.epoch, connectionToken: lease.connection_token };
}

export function claims(target: ClaimConsumer, signal?: AbortSignal) {
  return getRepository().claimDeliveries(target.tenant, target.alias, target.instanceId,
    target.epoch, 10, 30_000, 3, {}, target.connectionToken, signal);
}

export async function nextClaim(target: ClaimConsumer, messageId?: string): Promise<DeliveryEnvelope> {
  const delivery = (await claims(target)).find((item) => messageId === undefined || item.message_id === messageId);
  if (delivery === undefined) throw new Error('expected real durable delivery');
  return delivery;
}

export async function deliverySnapshot(messageId: string) {
  return (await databasePool().query<Record<string, unknown>>(
    `SELECT status,attempt,claim_token,consumer_instance_id,consumer_epoch,ack_deadline_at
       FROM deliveries WHERE message_id=$1 ORDER BY id`, [messageId],
  )).rows;
}

export async function fairnessSnapshot(target: ClaimConsumer) {
  return (await databasePool().query<{ interactive_streak: number }>(
    'SELECT interactive_streak FROM delivery_lane_fairness WHERE tenant_id=$1 AND alias=$2',
    [target.tenant, target.alias],
  )).rows;
}

export async function withLedgerView<T>(invalidConversation: boolean, work: () => Promise<T>): Promise<T> {
  const pool = databasePool();
  await pool.query('ALTER TABLE human_message_initiators RENAME TO fixture_human_message_initiators');
  try {
    if (invalidConversation) {
      await pool.query(`CREATE VIEW human_message_initiators AS SELECT message_id,message_tenant_id,
        initiating_human_id,initiating_tenant_id,root_message_id,repeat('é',257) AS conversation_id
        FROM fixture_human_message_initiators`);
    }
    return await work();
  } finally {
    if (invalidConversation) await pool.query('DROP VIEW IF EXISTS human_message_initiators');
    await pool.query('ALTER TABLE fixture_human_message_initiators RENAME TO human_message_initiators');
  }
}
