import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serverEnvironment } from './server-environment.js';
import { createFleetToolServer, FLEET_TOOLS } from './tool-server.js';

const fleetStatus = vi.fn(async () => ({ data: [], available: true }));
const deliveries = vi.fn(async () => ({ data: [], available: true }));
const chain = vi.fn(async () => ({ data: [], available: true }));
const deadLetters = vi.fn(async () => ({ data: [], available: true }));
const health = vi.fn(async () => ({ summary: 'Flota: healthy', timestamp: new Date(0).toISOString() }));
const model = { fleetStatus, deliveries, chain, deadLetters, health };
const demo = fileURLToPath(new URL('../demo-client.mjs', import.meta.url));

let client: Client;
let server: ReturnType<typeof createFleetToolServer>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOf(result: unknown): string {
  if (!isRecord(result)) throw new Error('tool result was not an object');
  const content = result.content;
  if (!Array.isArray(content)) throw new Error('tool result had no content');
  for (const part of content) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
      return part.text;
    }
  }
  throw new Error('tool result had no text content');
}

beforeEach(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'fleet-monitor-test', version: '1.0.0' });
  server = createFleetToolServer(model);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  await server.close();
  vi.clearAllMocks();
});

describe('fleet monitor MCP dispatch', () => {
  it('completes the MCP handshake and advertises exactly the implemented tools', async () => {
    await expect(client.ping()).resolves.toBeDefined();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(FLEET_TOOLS.map((tool) => tool.name));
  });

  it('dispatches every advertised tool and preserves selectors', async () => {
    await client.callTool({ name: 'fleet_status', arguments: { alias: 'kant' } });
    await client.callTool({
      name: 'deliveries', arguments: { alias: 'kant', status: 'done', limit: 7 },
    });
    await client.callTool({
      name: 'chain', arguments: { trace_id: 'trace-1', root_message_id: 'root-1' },
    });
    await client.callTool({ name: 'dead_letters', arguments: {} });
    await client.callTool({ name: 'health', arguments: {} });

    expect(fleetStatus).toHaveBeenCalledWith('kant');
    expect(deliveries).toHaveBeenCalledWith('kant', 'done', 7);
    expect(chain).toHaveBeenCalledWith('trace-1', 'root-1');
    expect(deadLetters).toHaveBeenCalledOnce();
    expect(health).toHaveBeenCalledOnce();
  });

  it('rejects an invalid delivery status before reaching the read model', async () => {
    const result = await client.callTool({
      name: 'deliveries', arguments: { status: 'invented' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid 'status' value 'invented'");
    expect(deliveries).not.toHaveBeenCalled();
  });

  it('returns explicit errors for unknown tools and read-model failures', async () => {
    const unknown = await client.callTool({ name: 'write_database', arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toBe('Unknown tool: write_database');

    health.mockRejectedValueOnce(new Error('database offline'));
    const failed = await client.callTool({ name: 'health', arguments: {} });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toBe('Error executing health: database offline');
  });
});

describe('fleet monitor smoke client', () => {
  it('passes the exact database and TLS environment allowlist to the server', () => {
    const forwarded = serverEnvironment({
      DATABASE_URL: 'postgresql://demo.invalid/fleet',
      CAUCE_TENANT_ID: 'tenant-fixture',
      NODE_ENV: 'production',
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: '/fixtures/root-ca.pem',
      NODE_OPTIONS: '--require=/tmp/untrusted.cjs',
      AWS_SECRET_ACCESS_KEY: 'must-not-leak',
      PATH: '/untrusted/bin',
    });

    expect(forwarded).toEqual({
      DATABASE_URL: 'postgresql://demo.invalid/fleet',
      CAUCE_TENANT_ID: 'tenant-fixture',
      NODE_ENV: 'production',
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: '/fixtures/root-ca.pem',
    });
  });

  it.each([
    [{}, 'CAUCE_TENANT_ID environment variable is required'],
    [{ CAUCE_TENANT_ID: 'Steven' }, 'DATABASE_URL environment variable is required'],
  ])('propagates server startup failure %# instead of reporting a false green', (extraEnv, expected) => {
    const result = spawnSync(process.execPath, [demo], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...extraEnv },
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expected);
    expect(result.stderr).toContain('MCP smoke failed');
    expect(result.stdout).not.toContain('MCP smoke passed');
  });

  it('fails closed on production TLS before opening a database connection', () => {
    const result = spawnSync(process.execPath, [demo], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        DATABASE_URL: 'postgresql://127.0.0.1:1/fleet',
        CAUCE_TENANT_ID: 'tenant-fixture',
        NODE_ENV: 'production',
        PGSSLMODE: 'verify-full',
        PGSSLROOTCERT: '/__cauce_missing__/root-ca.pem',
      },
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('production PostgreSQL root certificate is unavailable');
    expect(result.stderr).toContain('MCP smoke failed');
    expect(result.stdout).not.toContain('MCP smoke passed');
  });
});
