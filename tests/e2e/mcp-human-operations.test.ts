import { randomUUID } from 'node:crypto';
import { HUMAN_MESSAGE_INITIATOR_CAPABILITY } from '@cauce/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildGateway } from '../../services/gateway/src/app.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import { createHumanGatewayAuthorization } from '../../packages/mcp-fleet-monitor/src/gateway-http.js';
import {
  connectSdkClient, startHttpsForwarder, startHumanOperationsFixture, trustFixtureCa,
  type HumanMcpClient, type HumanOperationsFixture, type HttpsForwarder,
} from './mcp-human-operations.fixtures.js';

interface ToolResult { readonly isError?: boolean; readonly content: readonly { type: string; text?: string }[] }
let fixture: HumanOperationsFixture | undefined;
let forwarder: HttpsForwarder | undefined;
let app: FastifyInstance | undefined;
let restoreTrust: (() => void) | undefined;
const clients: HumanMcpClient[] = [];

function parseContent(result: ToolResult): Record<string, unknown> {
  const text = result.content.find((part) => part.type === 'text')?.text;
  if (text === undefined) throw new Error('MCP tool result did not contain text');
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('MCP tool content was not an object');
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== 'string') throw new Error(`MCP result field ${field} was not text`);
  return result;
}

async function connect(subject: string, scopes: readonly string[], claims: Readonly<Record<string, unknown>> = {}) {
  if (!fixture || !forwarder) throw new Error('MCP fixture is not ready');
  const token = await fixture.issuer.issue(subject, scopes, `${forwarder.origin}/mcp`, claims);
  const client = await connectSdkClient(forwarder.origin, token);
  clients.push(client);
  return client;
}

function publishArguments(requestKey: string, recipient: { tenant_id: string; alias: string }, text: string) {
  return { request_key: requestKey, room_id: 'grp.steven', recipients: [recipient], body: { text } };
}

async function call(client: HumanMcpClient, name: string, args: Readonly<Record<string, unknown>> = {}) {
  return client.callTool({ name, arguments: args });
}

beforeAll(async () => {
  fixture = await startHumanOperationsFixture();
  restoreTrust = await trustFixtureCa(fixture.issuer.ca);
  forwarder = await startHttpsForwarder(fixture.issuer.tlsKey, fixture.issuer.tlsCertificate, '127.0.0.1');
  const authorization = createHumanGatewayAuthorization(forwarder.origin, {
    issuer: fixture.issuer.issuer, jwksUri: fixture.issuer.jwksUri,
  });
  app = await buildGateway({
    pool: fixture.pool,
    authProvider: DevOnlyAuthProvider.forTests(),
    humanMcp: { publicOrigin: forwarder.origin, authorization },
  });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const port = Number(new URL(address).port);
  if (!Number.isSafeInteger(port) || port < 1) throw new Error('MCP gateway listener did not expose an ephemeral port');
  forwarder.setTarget(port);
}, 180_000);

afterAll(async () => {
  const failures: unknown[] = [];
  for (const client of clients.splice(0)) {
    try { await client.close(); } catch (error) { failures.push(error); }
  }
  for (const cleanup of [
    async () => { await app?.close(); },
    async () => { await forwarder?.close(); },
    async () => { restoreTrust?.(); },
    async () => { await fixture?.close(); },
  ]) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'MCP human E2E teardown failed');
});

describe('human MCP operations over real OAuth, SDK transport and PostgreSQL', () => {
  it('closes concurrent same-human submissions with one durable effect and an explicit same-key retry', async () => {
    if (!fixture || !forwarder) throw new Error('MCP fixture is not ready');
    const [stevenA] = fixture.accounts;
    const scopes = ['cauce.read', 'cauce.publish'] as const;
    const [clientA1, clientA2] = await Promise.all([
      connect(stevenA.subject, scopes), connect(stevenA.subject, scopes),
    ]);
    const command = publishArguments(randomUUID(),
      { tenant_id: 'Steven', alias: 'mcp_target_steven' }, `concurrent same owner ${randomUUID()}`);
    const concurrent = await Promise.all([
      call(clientA1, 'cauce_submit', command), call(clientA2, 'cauce_submit', command),
    ]);
    const accepted: Record<string, unknown>[] = [];
    for (const result of concurrent) {
      if (result.isError === true) {
        expect(result.structuredContent, JSON.stringify(result)).toEqual({
          status_code: 409, error: 'operation_conflict', safe_to_retry_same_request_key: true,
        });
      } else {
        accepted.push(parseContent(result));
      }
    }
    console.info(`MCP same-human race: ${String(accepted.length)} accepted, ${String(concurrent.length - accepted.length)} retryable conflicts`);
    const acceptedIds = accepted.map((receipt) => stringField(receipt, 'message_id'));
    expect(new Set(acceptedIds).size).toBeLessThanOrEqual(1);

    const retry = await call(clientA1, 'cauce_submit', command);
    expect(retry.isError, JSON.stringify(retry)).not.toBe(true);
    const retriedReceipt = parseContent(retry);
    const messageId = stringField(retriedReceipt, 'message_id');
    expect(acceptedIds.every((id) => id === messageId)).toBe(true);
    const idempotencyKey = stringField(retriedReceipt, 'idempotency_key');
    const journal = await fixture.pool.query<{ count: number; message_id: string | null }>(
      `SELECT count(*)::int AS count, min(message_id::text) AS message_id
         FROM idempotency_keys
        WHERE tenant_id='Steven' AND actor_alias=$1 AND idempotency_key=$2`,
      [stevenA.alias, idempotencyKey],
    );
    expect(journal.rows[0]).toEqual({ count: 1, message_id: messageId });
    const effects = await fixture.pool.query<{ messages: number; deliveries: number }>(
      `SELECT (SELECT count(*)::int FROM messages WHERE id=$1::uuid) AS messages,
              (SELECT count(*)::int FROM deliveries WHERE message_id=$1::uuid) AS deliveries`,
      [messageId],
    );
    expect(effects.rows[0]).toEqual({ messages: 1, deliveries: 1 });
    const receipt = await call(clientA2, 'cauce_receipt', { message_id: messageId });
    expect(receipt.isError, JSON.stringify(receipt)).not.toBe(true);
    expect(stringField(parseContent(receipt), 'message_id')).toBe(messageId);
  }, 120_000);

  it('isolates same-alias users, enforces scopes and revocation, and returns only the owner receipt', async () => {
    if (!fixture || !forwarder) throw new Error('MCP fixture is not ready');
    const [stevenA, stevenB, isa] = fixture.accounts;
    const identityClaims = { tenant_id: 'Isa', alias: 'kant', roles: ['operator'], permissions: ['route', 'read'] };
    const [clientA, clientB, clientIsa] = await Promise.all([
      connect(stevenA.subject, ['cauce.read', 'cauce.publish'], identityClaims),
      connect(stevenB.subject, ['cauce.read', 'cauce.publish']),
      connect(isa.subject, ['cauce.read', 'cauce.publish']),
    ]);
    const listed = await clientA.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      'cauce_agents', 'cauce_connection_identity', 'cauce_inbox', 'cauce_receipt', 'cauce_status', 'cauce_submit',
    ]);
    const submitTool = listed.tools.find((tool) => tool.name === 'cauce_submit');
    expect(submitTool).toBeDefined();
    const inputSchema = submitTool?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(Object.keys(inputSchema.properties ?? {}).sort()).toEqual(['body', 'recipients', 'request_key', 'room_id']);
    expect([...inputSchema.required ?? []].sort()).toEqual(['body', 'recipients', 'request_key', 'room_id']);

    const statusA = parseContent(await call(clientA, 'cauce_status'));
    const statusIsa = parseContent(await call(clientIsa, 'cauce_status'));
    expect(statusA.tenant_id).toBe('Steven');
    expect(statusIsa.tenant_id).toBe('Isa');
    expect((await call(clientA, 'cauce_agents')).isError).not.toBe(true);

    const requestKey = randomUUID();
    const bodyText = `same key different account ${randomUUID()}`;
    const commandA = publishArguments(requestKey, { tenant_id: 'Steven', alias: 'mcp_target_steven' }, bodyText);
    const [firstA, firstB] = await Promise.all([
      call(clientA, 'cauce_submit', commandA),
      call(clientB, 'cauce_submit', commandA),
    ]);
    expect(firstA.isError, JSON.stringify(firstA)).not.toBe(true);
    expect(firstB.isError, JSON.stringify(firstB)).not.toBe(true);
    const sameA = await call(clientA, 'cauce_submit', commandA);
    expect(sameA.isError, JSON.stringify(sameA)).not.toBe(true);
    const receiptA = parseContent(firstA);
    const repeatedA = parseContent(sameA);
    const receiptB = parseContent(firstB);
    const receiptAId = stringField(receiptA, 'message_id');
    const repeatedAId = stringField(repeatedA, 'message_id');
    const receiptBId = stringField(receiptB, 'message_id');
    expect(repeatedAId).toBe(receiptAId);
    expect(receiptBId).not.toBe(receiptAId);
    expect((await fixture.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM messages WHERE id=ANY($1::uuid[])',
      [[receiptAId, receiptBId]],
    )).rows[0]?.count).toBe(2);

    const otherOwner = await call(clientB, 'cauce_receipt', { message_id: receiptAId });
    expect(otherOwner.isError).toBe(true);
    expect(otherOwner.structuredContent, JSON.stringify(otherOwner)).toEqual({ status_code: 404, error: 'not_found' });
    expect(JSON.stringify(otherOwner)).not.toContain(receiptAId);
    const ownReceiptB = await call(clientB, 'cauce_receipt', { message_id: receiptBId });
    expect(ownReceiptB.isError).not.toBe(true);
    expect(stringField(parseContent(ownReceiptB), 'message_id')).toBe(receiptBId);
    const crossTenantOwner = await call(clientIsa, 'cauce_receipt', { message_id: receiptAId });
    expect(crossTenantOwner.isError).toBe(true);
    expect(crossTenantOwner.structuredContent, JSON.stringify(crossTenantOwner))
      .toEqual({ status_code: 404, error: 'not_found' });
    const claimInstance = `mcp-human-${randomUUID()}`;
    const lease = await fixture.repository.acquireLease('Steven', 'mcp_target_steven', claimInstance,
      [HUMAN_MESSAGE_INITIATOR_CAPABILITY], 60_000);
    if (!lease.acquired || lease.epoch === undefined) throw new Error('recipient lease was not acquired');
    const claims = await fixture.repository.claimDeliveries('Steven', 'mcp_target_steven', claimInstance, lease.epoch, 5);
    const delivery = claims.find((candidate) => candidate.message_id === receiptAId);
    if (!delivery) throw new Error('published human MCP delivery was not claimed');
    expect(delivery.human_initiator?.human_id).toBe(stevenA.id);
    const deliveryB = claims.find((candidate) => candidate.message_id === receiptBId);
    expect(deliveryB?.human_initiator?.human_id).toBe(stevenB.id);
    expect(deliveryB?.human_initiator?.human_id).not.toBe(delivery.human_initiator?.human_id);
    const ackBase = { version: '3.0' as const, instance_id: claimInstance, epoch: lease.epoch,
      claim_token: delivery.claim_token, attempt: delivery.attempt, retryable: false };
    await expect(fixture.repository.ackDelivery(delivery.delivery_id, 'Steven', 'mcp_target_steven', {
      ...ackBase, status: 'started', event_id: randomUUID(), execution_started: true,
    })).resolves.toMatchObject({ applied: true, status: 'started' });
    const during = parseContent(await call(clientA, 'cauce_receipt', { message_id: receiptAId }));
    expect(during).toMatchObject({ message_id: receiptAId, chain_open: true,
      deliveries: [{ delivery_id: delivery.delivery_id, status: 'started', reply: null }] });
    const canonicalReply = `acknowledged-reply-${randomUUID()}`;
    await expect(fixture.repository.ackDelivery(delivery.delivery_id, 'Steven', 'mcp_target_steven', {
      ...ackBase, status: 'done', event_id: randomUUID(), result: { output: { reply: canonicalReply } },
    })).resolves.toMatchObject({ applied: true, status: 'done' });
    const completed = parseContent(await call(clientA, 'cauce_receipt', { message_id: receiptAId }));
    expect(completed).toMatchObject({ message_id: receiptAId, chain_open: false,
      deliveries: [{ delivery_id: delivery.delivery_id, status: 'done', reply: canonicalReply }] });
    const hiddenReply = await call(clientB, 'cauce_receipt', { message_id: receiptAId });
    expect(hiddenReply.isError).toBe(true);
    expect(hiddenReply.structuredContent).toEqual({ status_code: 404, error: 'not_found' });
    expect(JSON.stringify(hiddenReply)).not.toContain(canonicalReply);
    const inboxA = parseContent(await call(clientA, 'cauce_inbox', { limit: 10 }));
    const inboxItems = Array.isArray(inboxA.items) ? inboxA.items as Record<string, unknown>[] : [];
    expect(inboxItems.find((item) => item.message_id === receiptAId)).toMatchObject({ chain_open: false,
      deliveries: [{ delivery_id: delivery.delivery_id, status: 'done', reply: canonicalReply, reply_truncated: false }] });
    expect(JSON.stringify(inboxA)).not.toContain(receiptBId);
    for (const other of [clientB, clientIsa]) {
      const page = await call(other, 'cauce_inbox');
      expect(page.isError, JSON.stringify(page)).not.toBe(true);
      expect(JSON.stringify(page)).not.toContain(receiptAId);
      expect(JSON.stringify(page)).not.toContain(canonicalReply);
    }

    const readOnly = await connect(stevenA.subject, ['cauce.read']);
    const publishDenied = await call(readOnly, 'cauce_submit', publishArguments(randomUUID(),
      { tenant_id: 'Steven', alias: 'mcp_target_steven' }, 'scope must deny this send'));
    expect(publishDenied.isError).toBe(true);
    const publishOnly = await connect(stevenA.subject, ['cauce.publish']);
    const readDenied = await call(publishOnly, 'cauce_status');
    expect(readDenied.isError).toBe(true);
    expect((await call(publishOnly, 'cauce_inbox')).isError).toBe(true);
    const roleChange = await fixture.pool.query(
      `UPDATE human_tenant_memberships SET role='reader', permissions=ARRAY['read']::text[], revision=revision+1
        WHERE human_id=$1::uuid AND tenant_id=$2`,
      [stevenA.id, stevenA.tenant],
    );
    expect(roleChange.rowCount).toBe(1);
    const roleDenied = await call(clientA, 'cauce_submit', publishArguments(randomUUID(),
      { tenant_id: 'Steven', alias: 'mcp_target_steven' }, 'database role must deny this send'));
    expect(roleDenied.isError).toBe(true);
    expect(roleDenied.structuredContent).toEqual({ status_code: 403, error: 'forbidden' });
    const revokedBinding = await fixture.pool.query(
      `UPDATE human_external_identities SET enabled=false, revoked_at=now(), revision=revision+1
        WHERE human_id=$1::uuid AND provider='oauth' AND namespace=$2 AND subject=$3 AND enabled=true`,
      [stevenB.id, fixture.issuer.issuer, stevenB.subject],
    );
    expect(revokedBinding.rowCount).toBe(1);
    const revoked = await call(clientB, 'cauce_status');
    expect(revoked.isError).toBe(true);
    expect(JSON.stringify(revoked)).not.toContain('Steven');
  }, 120_000);
});
