import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { createGatewayToolServer } from './gateway-tools.js';
import type { HumanGatewayOperations } from './gateway-operations.js';
import { HumanMcpMailboxSchema } from './gateway-mailbox.js';

it('reads complete Unicode mailbox text through MCP and rejects foreign authority arguments', async () => {
  const value = HumanMcpMailboxSchema.parse({ address: { tenant_id: 'Steven', alias: `mbx-${'a'.repeat(48)}` }, label: 'Cronos',
    items: [{ delivery_id: '30000000-0000-4000-8000-000000000001', message_id: '20000000-0000-4000-8000-000000000001',
      stored_at: '2026-10-06T01:00:00.000001Z', from: { tenant_id: 'Steven', alias: 'jarvis' }, text: '😀'.repeat(3000),
      text_truncated: false, state: 'stored' }], next_cursor: null, untrusted_fields: ['items[].text'], reading_confirms_execution: false });
  const mailbox = vi.fn(async () => value);
  const forRequest = vi.fn(async () => ({ mailbox }) as HumanGatewayOperations);
  const server = createGatewayToolServer({ factory: { forRequest }, signal: new AbortController().signal,
    identity: { kind: 'oauth', issuer: 'https://issuer.example', subject: 'owner', audience: 'https://mcp.example/mcp',
      expiresAt: 4_000_000_000, scopes: ['cauce.read'] } });
  const client = new Client({ name: 'mailbox-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    expect(await client.callTool({ name: 'cauce_mailbox', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: JSON.stringify(value) }] });
    expect(await client.callTool({ name: 'cauce_mailbox', arguments: { grant_id: 'other' } })).toMatchObject({ isError: true });
    expect(forRequest).toHaveBeenCalledOnce(); expect(mailbox).toHaveBeenCalledOnce();
  } finally { await client.close(); await server.close(); }
});
