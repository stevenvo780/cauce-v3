import { strictEqual } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { HUMAN_MESSAGE_INITIATOR_CAPABILITY } from '@cauce/protocol';
import type { HumanGatewayOperations, McpSubmitCommand } from '../../mcp-fleet-monitor/src/gateway-operations.js';
import type { VerifiedOAuthIdentity } from '../../mcp-fleet-monitor/src/gateway-oauth-identity.js';
import { createHumanMcpOperationsFactory, type HumanMcpRepository } from '../../../services/gateway/src/mcp-operations.js';
import { consolePublishIntentNonceHash } from '../src/repository/config.js';
import { terminalAck } from './helpers/consumer.js';
import {
  consoleIntent, databasePool, getRepository, HUMAN_PUBLISH_SCOPE, registerHumanPublishSuite, seedHumanPublishActor,
} from './human-publish-authority-postgres.fixtures.js';

registerHumanPublishSuite(import.meta.url);
export type HumanFixture = Awaited<ReturnType<typeof seedHumanPublishActor>>;
export type InterruptedPhase = 'prepare' | 'publish';
interface SubmitPhaseBarriers {
  readonly afterPrepare?: () => Promise<void>;
  readonly beforeConfirm?: () => Promise<void>;
}

export function phaseBarrier(participants: number) {
  let arrivals = 0;
  let markArrived = (): void => undefined;
  let release = (): void => undefined;
  const ready = new Promise<void>((resolve) => { markArrived = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return {
    wait: async (): Promise<void> => {
      arrivals += 1;
      if (arrivals > participants) throw new Error('too many requests reached the phase barrier');
      if (arrivals === participants) markArrived();
      await released;
    },
    arrived: async (): Promise<void> => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([ready, new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => { reject(new Error('requests did not reach the phase barrier')); }, 5_000);
        })]);
      } finally { clearTimeout(timeout); }
    },
    release: () => { release(); },
  };
}

export function submitCommand(overrides: Partial<McpSubmitCommand> = {}): McpSubmitCommand {
  return {
    request_key: randomUUID(), room_id: 'grp.steven',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'independent human intent' }, ...overrides,
  };
}

export async function operations(
  account: HumanFixture, interruptAfter?: InterruptedPhase, barriers: SubmitPhaseBarriers = {},
): Promise<Readonly<HumanGatewayOperations>> {
  const repository = getRepository();
  const faultBoundary: HumanMcpRepository = {
    prepareConsolePublishIntent: async (...args) => {
      const result = await repository.prepareConsolePublishIntent(...args);
      await barriers.afterPrepare?.();
      if (interruptAfter === 'prepare') throw new Error('fixture lost prepare response after commit');
      return result;
    },
    publish: async (...args) => {
      const result = await repository.publish(...args);
      if (interruptAfter === 'publish') throw new Error('fixture lost publish response after commit');
      return result;
    },
    confirmConsolePublishIntent: async (...args) => {
      await barriers.beforeConfirm?.();
      return repository.confirmConsolePublishIntent(...args);
    },
    verifyPublishReceipt: (...args) => repository.verifyPublishReceipt(...args),
    listPresence: (...args) => repository.listPresence(...args),
    listAgents: (...args) => repository.listAgents(...args),
    getHumanMessage: (...args) => repository.getHumanMessage(...args),
    listHumanInbox: (...args) => repository.listHumanInbox(...args),
  };
  const identity: VerifiedOAuthIdentity = Object.freeze({
    kind: 'oauth', issuer: account.key.namespace, subject: account.key.subject,
    audience: 'https://mcp.example.test/mcp', expiresAt: (Date.now() + 60_000) / 1_000,
    scopes: Object.freeze(['cauce.read', 'cauce.publish']),
  });
  return createHumanMcpOperationsFactory({
    pool: databasePool(), repository: faultBoundary,
    priorityLog: { info: () => undefined, warn: () => undefined }, logRedaction: () => undefined,
  }).forRequest(identity, new AbortController().signal);
}

export async function preparedKey(account: HumanFixture, requestKey: string): Promise<string> {
  const result = await databasePool().query<{ idempotency_key: string }>(
    `SELECT metadata->>'idempotency_key' AS idempotency_key FROM audit_events
      WHERE tenant_id='Steven' AND actor_alias=$1 AND action='console.publish.prepare'
        AND metadata->>'intent_nonce_hash'=$2`,
    [account.alias, consolePublishIntentNonceHash(requestKey)],
  );
  if (result.rowCount !== 1 || result.rows[0] === undefined) throw new Error('expected one durable nonce binding');
  return result.rows[0].idempotency_key;
}

export async function agePrepare(account: HumanFixture, requestKey: string): Promise<void> {
  const result = await databasePool().query(
    `UPDATE audit_events SET created_at=now()-interval '16 minutes'
      WHERE tenant_id='Steven' AND actor_alias=$1 AND action='console.publish.prepare'
        AND metadata->>'intent_nonce_hash'=$2`,
    [account.alias, consolePublishIntentNonceHash(requestKey)],
  );
  if (result.rowCount !== 1) throw new Error('expected one isolated prepare row to age');
}

export async function counts(account: HumanFixture): Promise<Record<string, number>> {
  const result = await databasePool().query<Record<string, number>>(
    `SELECT
       (SELECT count(*)::int FROM messages WHERE tenant_id='Steven' AND actor_alias=$1) AS messages,
       (SELECT count(*)::int FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE m.tenant_id='Steven' AND m.actor_alias=$1) AS deliveries,
       (SELECT count(*)::int FROM adapter_outbox o JOIN messages m ON m.id=o.message_id WHERE m.tenant_id='Steven' AND m.actor_alias=$1) AS outbox,
       (SELECT count(*)::int FROM human_message_initiators WHERE initiating_human_id=$2) AS initiators,
       (SELECT count(*)::int FROM idempotency_keys WHERE tenant_id='Steven' AND actor_alias=$1) AS idempotency,
       (SELECT count(*)::int FROM audit_events WHERE tenant_id='Steven' AND actor_alias=$1 AND action='message.publish') AS publications,
       (SELECT count(*)::int FROM audit_events WHERE tenant_id='Steven' AND actor_alias=$1 AND action='console.publish.prepare') AS prepares,
       (SELECT count(*)::int FROM audit_events WHERE tenant_id='Steven' AND actor_alias=$1 AND action='console.publish.confirm') AS confirms,
       (SELECT count(*)::int FROM audit_events WHERE tenant_id='Steven' AND actor_alias=$1 AND action='console.publish.expire') AS expirations`,
    [account.alias, account.humanId],
  );
  if (result.rows[0] === undefined) throw new Error('missing durable counts');
  return result.rows[0];
}

export async function publishedContext(messageId: string): Promise<Record<string, unknown>> {
  const result = await databasePool().query<Record<string, unknown>>(
    'SELECT auth_session_id,auth_channel,tenant_id,actor_alias FROM messages WHERE id=$1', [messageId],
  );
  if (result.rows[0] === undefined) throw new Error('missing durable message context');
  return result.rows[0];
}

export async function finishRoot(messageId: string, humanId: string): Promise<void> {
  const repository = getRepository();
  const instanceId = `human-intent-consumer-${randomUUID()}`;
  const connection = await repository.acquireLease('Steven', 'argos', instanceId,
    [HUMAN_MESSAGE_INITIATOR_CAPABILITY], 60_000, { resume: true });
  if (!connection.acquired || connection.epoch === undefined || connection.connection_token === undefined) {
    throw new Error('fixture agent could not acquire its delivery lease');
  }
  const deliveries = await repository.claimDeliveries(
    'Steven', 'argos', instanceId, connection.epoch, 10, 30_000, 3, {}, connection.connection_token,
  );
  const delivery = deliveries.find((item) => item.message_id === messageId);
  if (!delivery) throw new Error('fixture agent could not claim the root delivery');
  strictEqual(delivery.human_initiator?.human_id, humanId);
  const ack = await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos',
    terminalAck(delivery, { instanceId, epoch: connection.epoch }, { reply: 'intent completed' }));
  if (!ack.applied) throw new Error('fixture terminal ACK was not applied');
}

export { consoleIntent, databasePool, getRepository, HUMAN_PUBLISH_SCOPE, seedHumanPublishActor };
