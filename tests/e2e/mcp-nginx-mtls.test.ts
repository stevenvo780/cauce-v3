import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectSdkClient, type HumanMcpClient } from './mcp-human-operations.fixtures.js';
import { startNginxMcpFixture, type NginxMcpFixture } from './mcp-nginx-mtls.fixtures.js';

interface ToolResult {
  readonly isError?: boolean;
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}

function contentObject(result: ToolResult): Record<string, unknown> {
  const text = result.content.find((part) => part.type === 'text')?.text;
  if (text === undefined) throw new Error('MCP Nginx fixture received a result without text');
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MCP Nginx fixture received an invalid result object');
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== 'string') throw new Error(`MCP Nginx result is missing ${field}`);
  return result;
}

let fixture: NginxMcpFixture | undefined;
const clients: HumanMcpClient[] = [];

beforeAll(async () => {
  fixture = await startNginxMcpFixture();
  console.info('MCP_NGINX_GATEWAY_MTLS_PROBE', await fixture.gatewayMetadataFromNginx());
  console.info('MCP_NGINX_E2E_SOURCE', JSON.stringify({
    owner: fixture.owner,
    networkId: fixture.networkId,
    dockerContainerIds: fixture.dockerContainerIds,
    postgresContainerId: fixture.postgresContainerId,
    nginxImage: fixture.nginxImage,
    sourceConfigSha256: fixture.sourceConfigSha256,
    runtimeConfigSha256: fixture.runtimeConfigSha256,
    testAdaptations: fixture.testAdaptations,
    tlsPublicHashes: fixture.tlsPublicHashes,
  }));
}, 240_000);

afterAll(async () => {
  const failures: unknown[] = [];
  for (const client of clients.splice(0)) {
    try { await client.close(); } catch (error) { failures.push(error); }
  }
  if (fixture) {
    for (const kind of ['primary', 'wrong-ca'] as const) {
      try {
        const logs = await fixture.nginxLogs(kind);
        console.info(`MCP_NGINX_LOGS_${kind}`, logs.slice(-4_000));
      } catch (error) { failures.push(error); }
    }
  }
  try { await fixture?.close(); } catch (error) { failures.push(error); }
  if (failures.length > 0) throw new AggregateError(failures, 'MCP Nginx mTLS test cleanup failed');
});

describe('MCP mounted through the pinned Nginx mTLS ingress', () => {
  it('routes OAuth metadata and exact MCP paths without serving the SPA', async () => {
    if (!fixture) throw new Error('MCP Nginx fixture is not ready');
    const metadata = await fixture.requestNginx(fixture.primaryOrigin, '/.well-known/oauth-protected-resource/mcp');
    expect(metadata.status).toBe(200);
    expect(metadata.headers['cache-control']).toBe('no-store');
    expect(metadata.headers['content-type']).toMatch(/application\/json/u);
    expect(metadata.body).not.toMatch(/welcome to nginx|<html/iu);
    expect(JSON.parse(metadata.body)).toMatchObject({
      resource: `${fixture.primaryOrigin}/mcp`, authorization_servers: [fixture.issuer.issuer],
    });

    for (const path of ['/mcp?unexpected=1', '/.well-known/oauth-protected-resource/mcp?unexpected=1']) {
      const response = await fixture.requestNginx(fixture.primaryOrigin, path);
      expect(response.status).toBe(404);
      expect(response.headers['content-type']).toMatch(/application\/json/u);
      expect(response.body).not.toMatch(/welcome to nginx|<html/iu);
    }
  }, 15_000);

  it('preserves the incoming Host and Origin and rejects missing or malformed bearer credentials', async () => {
    if (!fixture) throw new Error('MCP Nginx fixture is not ready');
    const missing = await fixture.requestNginx(fixture.primaryOrigin, '/mcp', { method: 'POST', body: '{' });
    expect(missing.status).toBe(401);
    expect(missing.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(missing.body)).toEqual({ error: 'unauthorized' });

    const malformed = await fixture.requestNginx(fixture.primaryOrigin, '/mcp', {
      method: 'POST', headers: { authorization: 'Bearer not-a-signed-token' }, body: '{',
    });
    expect(malformed.status).toBe(401);
    expect(JSON.parse(malformed.body)).toEqual({ error: 'unauthorized' });

    const wrongHost = await fixture.requestNginx(fixture.primaryOrigin, '/.well-known/oauth-protected-resource/mcp', {
      headers: { host: 'untrusted.invalid' },
    });
    expect(wrongHost.status).toBe(403);
    const wrongOrigin = await fixture.requestNginx(fixture.primaryOrigin, '/.well-known/oauth-protected-resource/mcp', {
      headers: { origin: 'https://untrusted.invalid' },
    });
    expect(wrongOrigin.status).toBe(403);
  }, 15_000);

  it('carries a real SDK OAuth operation through Nginx to the durable tenant row', async () => {
    if (!fixture) throw new Error('MCP Nginx fixture is not ready');
    const [account] = fixture.database.accounts;
    const token = await fixture.issuer.issue(account.subject, ['cauce.read', 'cauce.publish'],
      `${fixture.primaryOrigin}/mcp`);
    const client = await connectSdkClient(fixture.primaryOrigin, token);
    clients.push(client);
    const toolset = await client.listTools();
    expect(toolset.tools.map((tool) => tool.name).sort()).toEqual([
      'cauce_agents', 'cauce_receipt', 'cauce_status', 'cauce_submit',
    ]);
    const requestKey = randomUUID();
    const uniqueBody = `nginx mTLS publish ${randomUUID()}`;
    const submitted = await client.callTool({ name: 'cauce_submit', arguments: {
      request_key: requestKey,
      room_id: 'grp.steven',
      recipients: [{ tenant_id: 'Steven', alias: 'mcp_target_steven' }],
      body: { text: uniqueBody },
    } });
    expect(submitted.isError, JSON.stringify(submitted)).not.toBe(true);
    const receipt = contentObject(submitted);
    const messageId = stringField(receipt, 'message_id');
    expect(receipt).toMatchObject({ tenant_id: 'Steven', actor_alias: 'mcpoperator' });
    const stored = await fixture.database.pool.query<{
      tenant_id: string; room_id: string; actor_alias: string; body: Record<string, unknown>;
    }>('SELECT tenant_id,room_id,actor_alias,body FROM messages WHERE id=$1', [messageId]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({ tenant_id: 'Steven', room_id: 'grp.steven',
      actor_alias: 'mcpoperator', body: { text: uniqueBody } });
  }, 30_000);

  it('requires a client certificate upstream and rejects an untrusted gateway CA', async () => {
    if (!fixture) throw new Error('MCP Nginx fixture is not ready');
    const missingClientCertificate = await fixture.gatewayWithoutClientCertificate();
    expect(missingClientCertificate).toMatch(
      /^(?:ECONNRESET|ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED|ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE|ERR_SSL_TLSV1_ALERT_UNKNOWN_CA)$/u,
    );

    const untrustedGateway = await fixture.requestNginx(fixture.wrongCaOrigin,
      '/.well-known/oauth-protected-resource/mcp');
    expect(untrustedGateway.status).toBe(502);
    expect(await fixture.nginxLogs('wrong-ca')).toMatch(/upstream SSL certificate verify error.*self-signed certificate in certificate chain/iu);
  }, 15_000);
});
