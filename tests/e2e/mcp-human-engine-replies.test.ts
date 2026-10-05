import { randomUUID } from 'node:crypto';
import { HUMAN_MESSAGE_INITIATOR_CAPABILITY } from '@cauce/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startHumanEngineFixture, content, type HumanEngineFixture } from './mcp-human-engine-replies.fixtures.js';

let fixture: HumanEngineFixture | undefined;
beforeAll(async () => { fixture = await startHumanEngineFixture(); }, 180_000);
afterAll(async () => { await fixture?.close(); });

it('runs OAuth-owned A/B/A through isolated Engine turns and durable owner-only replies', async () => {
  if (fixture === undefined) throw new Error('Human Engine fixture is unavailable');
  const f = fixture;
  const [a, b, foreign] = f.accounts;
  const clients = await Promise.all([a, b, foreign].map((account) => f.connect(account.subject)));
  const [clientA, clientB, clientForeign] = clients;
  if (!clientA || !clientB || !clientForeign) throw new Error('Missing OAuth clients');
  const sequence = [a, b, a];
  const messages: string[] = [];
  for (const [index, account] of sequence.entries()) {
    const client = account.id === a.id ? clientA : clientB;
    const result = await f.call(client, 'cauce_submit', { request_key: randomUUID(), room_id: 'grp.steven',
      recipients: [{ tenant_id: 'Steven', alias: f.target }], body: { text: `owned turn ${String(index)}` } });
    expect(result.isError).not.toBe(true);
    const published = content(result);
    expect(published.tenant_id).toBe('Steven');
    expect(published.actor_alias).toBe(a.alias);
    const id = published.message_id;
    if (typeof id !== 'string') throw new Error('Missing publication receipt');
    messages.push(id);
    expect(content(await f.call(client, 'cauce_receipt', { message_id: id }))).toMatchObject({
      chain_open: true, deliveries: [{ status: 'pending', reply: null }],
    });
  }

  const legacy = await f.lease([]);
  const legacyClaims = await f.repository.claimDeliveries('Steven', f.target, f.instance, legacy, 10);
  expect(legacyClaims).toEqual([]);
  expect(f.requests).toHaveLength(0);
  expect(f.events).toHaveLength(0);
  const pending = await f.pool.query<{ status: string; attempt: number; execution_started_at: Date | null }>(
    'SELECT status,attempt,execution_started_at FROM deliveries WHERE message_id=ANY($1::uuid[])', [messages]);
  expect(pending.rows).toHaveLength(3);
  expect(pending.rows.every((row) => row.status === 'pending' && row.attempt === 0
    && row.execution_started_at === null)).toBe(true);
  expect(await f.repository.releaseLease('Steven', f.target, f.instance, legacy)).toBe(true);

  const epoch = await f.lease([HUMAN_MESSAGE_INITIATOR_CAPABILITY]);
  await f.activate(epoch);
  for (const [index, account] of sequence.entries()) {
    const messageId = messages[index];
    if (messageId === undefined) throw new Error('Missing expected message');
    const client = account.id === a.id ? clientA : clientB;
    const other = account.id === a.id ? clientB : clientA;
    const claims = await f.repository.claimDeliveries('Steven', f.target, f.instance, epoch, 1);
    expect(claims).toHaveLength(1);
    const claim = claims[0];
    if (claim === undefined) throw new Error('Missing canonical claim');
    expect(claim.message_id).toBe(messageId);
    expect(claim.authenticated_context?.channel).toBe('human-mcp');
    expect(claim.human_initiator).toMatchObject({ human_id: account.id, tenant_id: 'Steven', root_message_id: messageId });
    const work = f.run(claim);
    await expect.poll(() => f.events.filter((event) => event.delivery_id === claim.delivery_id)
      .map((event) => event.phase), { timeout: 10_000 }).toEqual(['accepted']);
    expect(f.requests).toHaveLength(index);
    expect(content(await f.call(client, 'cauce_receipt', { message_id: messageId }))).toMatchObject({
      chain_open: true, deliveries: [{ status: 'accepted', reply: null }],
    });
    f.advanceAccepted();
    await expect.poll(() => f.requests.length, { timeout: 10_000 }).toBe(index + 1);
    expect(content(await f.call(client, 'cauce_receipt', { message_id: messageId }))).toMatchObject({
      chain_open: true, deliveries: [{ status: 'started', reply: null }],
    });
    const observed = f.requests[index];
    if (observed === undefined) throw new Error('Missing dedicated harness invocation');
    expect(observed.humanId).toBe(account.id);
    expect(observed.channel).toBe('human-mcp');
    expect(observed.request.sessionId).toBeTruthy();
    expect(f.selections[index]?.dedicated).toBe(true);
    expect(f.selections[index]?.sessionKey).toMatch(/^auth-v3:/u);
    f.finishTurn();
    await work;
    expect(f.events.filter((event) => event.delivery_id === claim.delivery_id).map((event) => event.phase))
      .toEqual(['accepted', 'started', 'started', 'done']);
    expect(f.events.find((event) => event.delivery_id === claim.delivery_id && event.execution_started === true))
      .toMatchObject({ phase: 'started', claim_token: claim.claim_token, epoch, attempt: claim.attempt });
    const reply = `owned Engine reply ${account.id}`;
    expect(content(await f.call(client, 'cauce_receipt', { message_id: messageId }))).toMatchObject({
      message_id: messageId, chain_open: false, deliveries: [{ status: 'done', reply }],
    });
    for (const deniedClient of [other, clientForeign]) {
      const denied = await f.call(deniedClient, 'cauce_receipt', { message_id: messageId });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toEqual({ status_code: 404, error: 'not_found' });
      expect(JSON.stringify(denied)).not.toContain(reply);
      expect(JSON.stringify(denied)).not.toContain(messageId);
    }
  }
  expect(f.requests).toHaveLength(3);
  expect(f.manualInvocations()).toBe(0);
  expect(f.selections[0]?.sessionKey).not.toBe(f.selections[1]?.sessionKey);
  expect(f.selections[0]?.sessionKey).toBe(f.selections[2]?.sessionKey);
  expect(f.requests[0]?.request.sessionId).not.toBe(f.requests[1]?.request.sessionId);
  expect(f.requests[0]?.request.sessionId).toBe(f.requests[2]?.request.sessionId);
  expect(f.requests[0]?.request.args).toContain('--session-id');
  expect(f.requests[2]?.request.args).toContain('--resume');
}, 120_000);
