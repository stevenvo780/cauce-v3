import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createGatewayToolServer } from './gateway-tools.js';
import { McpConnectionIdentitySchema, type HumanGatewayOperations } from './gateway-operations.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });
async function fixture(result: unknown, scopes: string[] = ['cauce.read']) {
  const connectionIdentity = vi.fn(async () => result);
  const denied = () => Promise.reject(new Error('unrelated operation'));
  const operations: HumanGatewayOperations = { connectionIdentity, status: denied, agents: denied,
    submit: denied, receipt: denied, inbox: denied };
  const forRequest = vi.fn(async () => operations);
  const server = createGatewayToolServer({ factory: { forRequest }, signal: new AbortController().signal,
    identity: { kind: 'oauth', subject: 'synthetic', issuer: 'https://cauce.example',
      audience: 'https://cauce.example/mcp', expiresAt: 4000000000, scopes } });
  const client = new Client({ name: 'connection-identity-fixture', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  cleanup.push(async () => { await client.close(); await server.close(); });
  await server.connect(right); await client.connect(left);
  return { client, connectionIdentity, forRequest };
}
it('reads public connection metadata with only read scope and no authority arguments', async () => {
  const value = { client: { kind: 'oauth_client', verification: 'local_grant', issuer: 'https://cauce.example',
    client_id: 'https://chatgpt.com/oauth/client.json', instance: 'unknown' },
    connection_ref: 'a'.repeat(64), expires_at: '2030-01-01T00:00:00Z' };
  const f = await fixture(value);
  expect(await f.client.callTool({ name: 'cauce_connection_identity', arguments: {} }))
    .toMatchObject({ content: [{ text: JSON.stringify(value) }] });
  expect(f.connectionIdentity).toHaveBeenCalledOnce();
  expect((await f.client.callTool({ name: 'cauce_connection_identity', arguments: { label: 'Dots' } })).isError).toBe(true);
  expect(f.connectionIdentity).toHaveBeenCalledOnce();
});
it.each([{ client: { kind: 'unknown' }, connection_ref: 'a'.repeat(64), expires_at: null },
  { client: { kind: 'unknown' }, connection_ref: null, expires_at: null, bearer: 'synthetic' }])(
  'rejects fabricated unknown references and private output fields %#', async value => {
    const f = await fixture(value);
    expect((await f.client.callTool({ name: 'cauce_connection_identity' })).isError).toBe(true);
  },
);
it('does not resolve authority without read scope and supports explicit unknown clients', async () => {
  const value = { client: { kind: 'unknown' }, connection_ref: null, expires_at: null };
  const f = await fixture(value, ['cauce.publish']);
  expect((await f.client.callTool({ name: 'cauce_connection_identity' })).isError).toBe(true);
  expect(f.forRequest).not.toHaveBeenCalled();
  expect(McpConnectionIdentitySchema.safeParse(value).success).toBe(true);
});
