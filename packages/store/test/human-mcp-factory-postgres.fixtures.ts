import { randomUUID } from 'node:crypto';
import { CauceRepository, type DatabaseClient, type DatabasePool } from '../src/index.js';
import type { VerifiedOAuthIdentity } from '../../../packages/mcp-fleet-monitor/src/gateway-oauth-identity.js';
import type { McpSubmitCommand } from '../../../packages/mcp-fleet-monitor/src/gateway-operations.js';
import { createHumanMcpOperationsFactory } from '../../../services/gateway/src/mcp-operations.js';
import type { HumanGatewayOperations } from '../../../packages/mcp-fleet-monitor/src/gateway-operations.js';
import { terminalAck } from './helpers/consumer.js';
import {
  databasePool, getRepository, registerHumanPublishSuite, seedHumanPublishActor,
} from './human-publish-authority-postgres.fixtures.js';

registerHumanPublishSuite(import.meta.url);

export type HumanMcpAccount = Awaited<ReturnType<typeof seedHumanPublishActor>>;
export type HumanMcpOperation = Readonly<HumanGatewayOperations>;

export function createHumanMcpIdentity(
  account: HumanMcpAccount,
  scopes: readonly ('cauce.read' | 'cauce.publish')[] = ['cauce.read', 'cauce.publish'],
  expiresAt = Date.now() / 1_000 + 60,
): VerifiedOAuthIdentity {
  return Object.freeze({ kind: 'oauth', issuer: account.key.namespace, subject: account.key.subject,
    audience: 'https://mcp.example.test/mcp', expiresAt, scopes: Object.freeze([...scopes]) });
}

export function createRealHumanMcpFactory() {
  const repository: CauceRepository = getRepository();
  const pool: DatabasePool = databasePool();
  return createHumanMcpOperationsFactory({ repository, pool,
    priorityLog: { info: () => undefined, warn: () => undefined }, logRedaction: () => undefined });
}

export async function openHumanMcpOperations(
  account: HumanMcpAccount,
  scopes: readonly ('cauce.read' | 'cauce.publish')[] = ['cauce.read', 'cauce.publish'],
  expiresAt = Date.now() / 1_000 + 60,
  signal = new AbortController().signal,
): Promise<HumanMcpOperation> {
  return createRealHumanMcpFactory().forRequest(createHumanMcpIdentity(account, scopes, expiresAt), signal);
}

export function humanMcpCommand(
  requestKey = randomUUID(),
  text = `human MCP integration ${randomUUID()}`,
): McpSubmitCommand {
  return { request_key: requestKey, room_id: 'grp.steven',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }], body: { text } };
}

export async function holdTechnicalMembership(alias: string): Promise<{
  readonly client: DatabaseClient;
  readonly pid: number;
  release(): Promise<void>;
}> {
  const client = await databasePool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE memberships SET enabled=enabled
      WHERE tenant_id='Steven' AND room_id='grp.steven' AND alias=$1`, [alias]);
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    if (pid === undefined) throw new Error('missing blocker PostgreSQL PID');
    return { client, pid, release: async () => { await client.query('ROLLBACK'); client.release(); } };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    throw error;
  }
}

export async function waitForBlockedRoute(observer: Pick<DatabaseClient, 'query'>, blockerPid: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE $1=ANY(pg_blocking_pids(pid)) AND pid<>$1
          AND query LIKE 'SELECT 1 FROM memberships m JOIN role_policies p%'
        LIMIT 1`, [blockerPid],
    );
    const pid = result.rows[0]?.pid;
    if (pid !== undefined) return pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`human publish route did not block behind PostgreSQL PID ${String(blockerPid)}`);
}

export async function assertNoHumanMcpEffects(): Promise<void> {
  const result = await databasePool().query<Record<string, string>>(`SELECT
    (SELECT count(*)::text FROM messages) AS messages,
    (SELECT count(*)::text FROM human_message_initiators) AS initiators,
    (SELECT count(*)::text FROM deliveries) AS deliveries,
    (SELECT count(*)::text FROM adapter_outbox) AS outbox,
    (SELECT count(*)::text FROM idempotency_keys) AS idempotency,
    (SELECT count(*)::text FROM audit_events WHERE action LIKE 'console.publish.%') AS console_audit,
    (SELECT count(*)::text FROM audit_events WHERE action='message.publish') AS publish_audit`);
  const counts = result.rows[0];
  if (counts === undefined) throw new Error('missing PostgreSQL effect counts');
  for (const [name, value] of Object.entries(counts)) {
    if (value !== '0') throw new Error(`unexpected ${name} durable side effect: ${value}`);
  }
}

export async function effectCounts(messageId: string, idempotencyKey: string): Promise<Record<string, string>> {
  const result = await databasePool().query<Record<string, string>>(`SELECT
    (SELECT count(*)::text FROM messages WHERE id=$1::uuid) AS messages,
    (SELECT count(*)::text FROM human_message_initiators WHERE message_id=$1::uuid) AS initiators,
    (SELECT count(*)::text FROM deliveries WHERE message_id=$1::uuid) AS deliveries,
    (SELECT count(*)::text FROM adapter_outbox WHERE message_id=$1::uuid) AS outbox,
    (SELECT count(*)::text FROM idempotency_keys WHERE message_id=$1::uuid) AS idempotency,
    (SELECT count(*)::text FROM audit_events WHERE message_id=$1::uuid AND action='message.publish') AS publish_audit,
    (SELECT count(*)::text FROM audit_events WHERE metadata->>'idempotency_key'=$2
      AND action IN ('console.publish.prepare','console.publish.confirm')) AS console_audit`, [messageId, idempotencyKey]);
  return result.rows[0] ?? {};
}

export async function finishHumanMcpRoots(
  roots: readonly { readonly messageId: string; readonly reply: string }[],
): Promise<void> {
  const repository = getRepository();
  const lease = await repository.acquireLease('Steven', 'argos', 'human-mcp-factory-fixture', [], 60_000, { resume: true });
  if (!lease.acquired || lease.epoch === undefined || lease.connection_token === undefined) {
    throw new Error('human MCP recipient agent could not acquire its delivery lease');
  }
  const deliveries = await repository.claimDeliveries('Steven', 'argos', 'human-mcp-factory-fixture',
    lease.epoch, 20, 30_000, 3, {}, lease.connection_token);
  for (const root of roots) {
    const delivery = deliveries.find((item) => item.message_id === root.messageId);
    if (!delivery) throw new Error('human MCP fixture could not claim the expected root delivery');
    const ack = await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', terminalAck(delivery,
      { instanceId: 'human-mcp-factory-fixture', epoch: lease.epoch }, { reply: root.reply }));
    if (!ack.applied) throw new Error('human MCP fixture ACK was not applied');
  }
}

export async function makeReader(account: HumanMcpAccount): Promise<void> {
  await databasePool().query(`INSERT INTO role_policies(role,allow_route,allow_read,allow_control)
    VALUES('human-reader',false,true,false) ON CONFLICT(role) DO UPDATE SET allow_route=false,allow_read=true,allow_control=false`);
  await databasePool().query(`UPDATE memberships SET role='human-reader'
    WHERE tenant_id='Steven' AND room_id='grp.steven' AND alias=$1`, [account.alias]);
  await databasePool().query("UPDATE console_users SET role='reader' WHERE id=$1", [account.humanId]);
  await databasePool().query(`UPDATE human_tenant_memberships SET role='reader',permissions=ARRAY['read']
    WHERE human_id=$1 AND tenant_id='Steven'`, [account.humanId]);
}

export async function changeAlias(account: HumanMcpAccount, alias = `human_${randomUUID().slice(0, 8)}`): Promise<string> {
  const client = await databasePool().connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO agents(tenant_id,alias) VALUES(\'Steven\',$1) ON CONFLICT DO NOTHING', [alias]);
    await client.query(`INSERT INTO memberships(tenant_id,room_id,alias,role,enabled)
      VALUES('Steven','grp.steven',$1,'operator',true)`, [alias]);
    await client.query('UPDATE console_users SET alias=$2 WHERE id=$1', [account.humanId, alias]);
    await client.query(`UPDATE human_tenant_memberships SET actor_alias=$2,revision=revision+1
      WHERE human_id=$1 AND tenant_id='Steven'`, [account.humanId, alias]);
    await client.query(`UPDATE memberships SET enabled=false
      WHERE tenant_id='Steven' AND room_id='grp.steven' AND alias=$1`, [account.alias]);
    await client.query('COMMIT');
    return alias;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export { databasePool, getRepository, registerHumanPublishSuite, seedHumanPublishActor };
