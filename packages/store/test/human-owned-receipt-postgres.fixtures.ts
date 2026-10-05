import { randomUUID } from 'node:crypto';
import { strictEqual } from 'node:assert';
import { HUMAN_MESSAGE_INITIATOR_CAPABILITY, type ConsolePublishIntentCommand, type PublishMessage, type Tenant } from '@cauce/protocol';
import type { DatabaseClient, PublishOptions } from '../src/index.js';
import { createHumanPublishAuthority, createHumanReadAuthority } from '../../../services/gateway/src/human-mcp-authority.js';
import type { VerifiedOAuthIdentity } from '../../../packages/mcp-fleet-monitor/src/gateway-oauth-identity.js';
import { terminalAck } from './helpers/consumer.js';
import {
  authorFor, consoleIntent, databasePool, getRepository, HUMAN_PUBLISH_SCOPE,
  publishCommand, registerHumanPublishSuite, seedHumanPublishActor,
} from './human-publish-authority-postgres.fixtures.js';

registerHumanPublishSuite(import.meta.url);

export type HumanFixture = Awaited<ReturnType<typeof seedHumanPublishActor>>;
export interface HumanReceiptAuthority {
  readonly humanId: string;
  readonly tenantId: Tenant;
  readonly actorAlias: string;
}
export interface HumanReceiptOptions {
  readonly humanAuthority: (client: DatabaseClient) => Promise<Readonly<HumanReceiptAuthority>>;
  readonly signal: AbortSignal;
}
export interface HumanReceiptRoot {
  readonly account: HumanFixture;
  readonly intent: ConsolePublishIntentCommand;
  readonly command: PublishMessage;
  readonly receipt: Awaited<ReturnType<ReturnType<typeof getRepository>['publish']>>;
  readonly options: PublishOptions;
}

export async function seededHuman(alias?: string): Promise<HumanFixture> {
  return seedHumanPublishActor(alias);
}

export function verifiedIdentity(
  account: HumanFixture, scopes: readonly ('cauce.read' | 'cauce.publish')[] = ['cauce.read', 'cauce.publish'],
  expiresAt = (Date.now() + 60_000) / 1_000,
): VerifiedOAuthIdentity {
  return Object.freeze({
    kind: 'oauth', issuer: account.key.namespace, subject: account.key.subject,
    audience: 'https://mcp.example.test/mcp', expiresAt, scopes: Object.freeze([...scopes]),
  });
}

export function humanOptions(
  account: HumanFixture,
  access: 'read' | 'publish',
  signal: AbortSignal = new AbortController().signal,
): HumanReceiptOptions {
  const identity = verifiedIdentity(account, access === 'read' ? ['cauce.read'] : ['cauce.read', 'cauce.publish']);
  const pinned = Object.freeze({ humanId: account.humanId, tenantId: 'Steven' as const, actorAlias: account.alias });
  return {
    signal,
    humanAuthority: access === 'read'
      ? createHumanReadAuthority(identity, pinned, signal)
      : createHumanPublishAuthority(identity, pinned, signal),
  };
}

export function humanPublishOptions(
  account: HumanFixture, signal: AbortSignal = new AbortController().signal,
): PublishOptions {
  return {
    ...humanOptions(account, 'publish', signal), requirePreparedConsoleIntent: true,
    consoleIntentOperatorScope: HUMAN_PUBLISH_SCOPE, consoleAuthor: authorFor(account),
  };
}

export async function publishHumanRoot(account: HumanFixture): Promise<HumanReceiptRoot> {
  const repository = getRepository();
  const intent = consoleIntent(account);
  const authorityOptions = humanOptions(account, 'publish');
  const options: PublishOptions = {
    ...authorityOptions, requirePreparedConsoleIntent: true,
    consoleIntentOperatorScope: HUMAN_PUBLISH_SCOPE, consoleAuthor: authorFor(account),
  };
  const prepared = await repository.prepareConsolePublishIntent(intent, HUMAN_PUBLISH_SCOPE, authorityOptions);
  if (prepared.state !== 'prepared') throw new Error('expected a newly prepared human publication');
  const command = publishCommand(intent, prepared.idempotency_key);
  const receipt = await repository.publish(command, options);
  if (!(await repository.verifyPublishReceipt(command, receipt, options))) {
    throw new Error('human publish receipt did not verify for its owner');
  }
  const confirmation = await repository.confirmConsolePublishIntent(
    intent.tenant_id, intent.actor_alias, HUMAN_PUBLISH_SCOPE,
      { idempotency_key: receipt.idempotency_key,
        message_id: receipt.message_id, causal_hash: receipt.causal_hash }, authorityOptions,
  );
  strictEqual(confirmation.confirmed, true);
  if (confirmation.message_id !== receipt.message_id) {
    throw new Error('human publish intent confirmation did not match its receipt');
  }
  return { account, intent, command, receipt, options };
}

export { databasePool, getRepository };

export async function finishRoots(roots: readonly { messageId: string; humanId: string; reply: string }[]): Promise<void> {
  const repository = getRepository();
  const connection = await repository.acquireLease('Steven', 'argos', 'owned-human-receipt-agent',
    [HUMAN_MESSAGE_INITIATOR_CAPABILITY], 60_000, { resume: true });
  if (!connection.acquired || connection.epoch === undefined || connection.connection_token === undefined) {
    throw new Error('fixture agent could not acquire its real delivery lease');
  }
  const deliveries = await repository.claimDeliveries(
    'Steven', 'argos', 'owned-human-receipt-agent', connection.epoch, 10, 30_000,
    3, {}, connection.connection_token,
  );
  for (const root of roots) {
    const delivery = deliveries.find((item) => item.message_id === root.messageId);
    if (!delivery) throw new Error('fixture agent could not claim the durable root delivery');
    strictEqual(delivery.human_initiator?.human_id, root.humanId);
    const ack = await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos',
      terminalAck(delivery, { instanceId: 'owned-human-receipt-agent', epoch: connection.epoch }, { reply: root.reply }));
    if (!ack.applied) throw new Error('fixture agent ACK was not applied');
  }
}

export async function seedLegacyRoot(alias: string): Promise<string> {
  const result = await databasePool().query<{ id: string }>(
    `INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,priority)
     VALUES($1,$2,'Steven','grp.steven',$3,$4::jsonb,'interactive',1) RETURNING id`,
    [randomUUID(), `legacy-owned-receipt-${randomUUID()}`, alias,
      JSON.stringify({ text: 'legacy root without durable human initiator' })],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('legacy root fixture insert returned no message id');
  return id;
}

export async function switchHumanToReader(account: HumanFixture): Promise<void> {
  await databasePool().query("INSERT INTO role_policies(role,allow_route,allow_read,allow_control) VALUES('human-reader',false,true,false) ON CONFLICT(role) DO UPDATE SET allow_route=false,allow_read=true,allow_control=false");
  await databasePool().query("UPDATE memberships SET role='human-reader' WHERE tenant_id='Steven' AND room_id='grp.steven' AND alias=$1", [account.alias]);
  await databasePool().query("UPDATE console_users SET role='reader' WHERE id=$1", [account.humanId]);
  await databasePool().query("UPDATE human_tenant_memberships SET role='reader',permissions=ARRAY['read'] WHERE human_id=$1 AND tenant_id='Steven'", [account.humanId]);
}
