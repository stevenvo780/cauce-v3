import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

/**
 * The fleet monitor is the only MCP surface Cauce exposes to an agent, so it is the only
 * place a tool can honestly be declared. This suite exists because two commits once
 * declared a `get_agent_chain_status` tool — types, help text and a protocol prompt that
 * told every agent to call it — with nothing behind it, so an agent that believed the
 * prompt spent a turn and got an error back.
 *
 * The assertions therefore compare two lists that must not drift: what the server
 * advertises over `tools/list`, and what it can actually execute over `tools/call`.
 * Nothing here is stubbed; the server runs as a real process against a real database and
 * every advertised tool is invoked for real.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SERVER_ENTRY = fileURLToPath(
  new URL('../../packages/mcp-fleet-monitor/src/server.ts', import.meta.url),
);
const HARNESS_PROMPT_SOURCE = fileURLToPath(
  new URL('../../packages/adapter-sdk/src/harnesses/shared.ts', import.meta.url),
);
/**
 * A tenant id, not a room id. `CAUCE_TENANT_ID` is matched against
 * `connection_leases.tenant_id` and `deliveries.recipient_tenant`, whose values are the
 * tenants in migration 001. Pointing it at a room (`grp.steven`) makes every tool return
 * an empty fleet forever, which is what the package docs used to instruct.
 */
const TENANT = 'Steven';

interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

interface ToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

interface ToolCallResult {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly isError?: boolean;
}

/** Minimal MCP stdio client. Deliberately hand-rolled so the test asserts the real wire. */
class StdioMcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { resolve: (value: JsonRpcResponse) => void; reject: (reason: Error) => void }
  >();

  private buffer = '';
  private nextId = 1;
  readonly stderr: string[] = [];

  constructor(databaseUrl: string) {
    this.child = spawn('pnpm', ['exec', 'tsx', SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        CAUCE_TENANT_ID: TENANT,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.absorb(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => this.stderr.push(chunk));
  }

  private absorb(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as JsonRpcResponse;
      if (message.id === undefined) continue;
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      waiter.resolve(message);
    }
  }

  private request(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const settled = new Promise<JsonRpcResponse>((resolvePending, rejectPending) => {
      this.pending.set(id, { resolve: resolvePending, reject: rejectPending });
      setTimeout(() => {
        if (!this.pending.delete(id)) return;
        rejectPending(new Error(
          `MCP request '${method}' timed out. Server stderr:\n${this.stderr.join('')}`,
        ));
      }, 60_000).unref();
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return settled;
  }

  private notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize(): Promise<void> {
    const response = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'cauce-tool-surface-test', version: '1.0.0' },
    });
    expect(response.error, `initialize failed: ${JSON.stringify(response.error)}`).toBeUndefined();
    this.notify('notifications/initialized');
  }

  async listTools(): Promise<readonly ToolDescriptor[]> {
    const response = await this.request('tools/list');
    expect(response.error, `tools/list failed: ${JSON.stringify(response.error)}`).toBeUndefined();
    return (response.result?.tools ?? []) as readonly ToolDescriptor[];
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    const response = await this.request('tools/call', { name, arguments: args });
    expect(response.error, `tools/call ${name} failed: ${JSON.stringify(response.error)}`)
      .toBeUndefined();
    return response.result ?? {};
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    await once(this.child, 'exit').catch(() => undefined);
  }
}

function textOf(result: ToolCallResult): string {
  return (result.content ?? []).map((part) => part.text ?? '').join('');
}

describe('MCP fleet monitor tool surface', () => {
  let database: TestDatabase;
  let client: StdioMcpClient;
  let advertised: readonly ToolDescriptor[];

  beforeAll(async () => {
    database = await startTestDatabase();
    client = new StdioMcpClient(database.url);
    await client.initialize();
    advertised = await client.listTools();
  }, 300_000);

  afterAll(async () => {
    await client?.close();
    if (database?.pool) await database.pool.end();
    if (database?.container) await database.container.stop();
  });

  it('advertises the documented read-only fleet tools', () => {
    expect([...advertised.map((tool) => tool.name)].sort()).toEqual([
      'cadena',
      'dead_letters',
      'entregas',
      'estado_flota',
      'salud',
    ]);
  });

  /**
   * The point of the suite. Every advertised tool is executed against the live server;
   * a name that reached `tools/list` without reaching the dispatcher falls into the
   * server's default branch and comes back as `Unknown tool`, which fails here.
   */
  it('executes every tool it advertises', async () => {
    const unimplemented: string[] = [];
    for (const tool of advertised) {
      const result = await client.callTool(tool.name, argumentsFor(tool.name));
      const text = textOf(result);
      if (result.isError === true || /^Unknown tool:/u.test(text)) {
        unimplemented.push(`${tool.name} -> ${text}`);
        continue;
      }
      // Answering is not the same as working. Each read model reports whether its query
      // actually ran, which is what caught `estado_flota` and `salud` querying a table
      // that does not exist while still returning a tidy empty payload.
      const payload = JSON.parse(text) as Record<string, unknown>;
      if (payload.available === false) {
        unimplemented.push(`${tool.name} -> responded but its read model could not query`);
      }
      if (tool.name === 'salud' && String(payload.summary).includes('unavailable')) {
        unimplemented.push(`${tool.name} -> ${String(payload.summary)}`);
      }
    }
    expect(unimplemented, 'advertised tools with no working implementation behind them')
      .toEqual([]);
  }, 120_000);

  /**
   * Proves the tools read live rows rather than returning a shape. A row is written
   * straight into the fleet tables and has to surface, unprompted, through the MCP call.
   */
  it('returns rows that were really written to the database', async () => {
    const empty = JSON.parse(textOf(await client.callTool('estado_flota'))) as {
      data: readonly Record<string, unknown>[];
    };
    expect(empty.data).toEqual([]);

    await database.pool.query(
      `INSERT INTO tenants(id) VALUES($1) ON CONFLICT DO NOTHING`,
      [TENANT],
    );
    await database.pool.query(
      `INSERT INTO connection_leases(tenant_id,alias,instance_id,epoch,lease_until)
       VALUES($1,$2,$3,$4,now() + interval '1 hour')`,
      [TENANT, 'kant', 'adapter-kant-1', 7],
    );

    const flota = JSON.parse(textOf(await client.callTool('estado_flota'))) as {
      available: boolean;
      data: readonly Record<string, unknown>[];
    };
    expect(flota.available).toBe(true);
    expect(flota.data).toHaveLength(1);
    expect(flota.data[0]).toMatchObject({
      alias: 'kant',
      active_instance_id: 'adapter-kant-1',
      epoch: 7,
      lease_alive: true,
    });

    // The same row has to reach the health summary, which counts it through a
    // separate query against the same table.
    const salud = JSON.parse(textOf(await client.callTool('salud'))) as { summary: string };
    expect(salud.summary).toContain('1 alias');
    expect(salud.summary).toContain('1 vivos');
    expect(salud.summary).not.toContain('unavailable');

    // Filtering is applied by the query, not by the caller.
    const filtered = JSON.parse(
      textOf(await client.callTool('estado_flota', { alias: 'no-such-alias' })),
    ) as { data: readonly unknown[] };
    expect(filtered.data).toEqual([]);
  }, 120_000);

  /**
   * An advertised input schema is part of the contract too. `entregas` used to offer
   * estado values of claimed/acked/dead, and only `dead` is a real delivery status, so an
   * agent filtering by the documented values got an empty list and no explanation.
   */
  it('advertises delivery statuses the database actually allows', async () => {
    const entregas = advertised.find((tool) => tool.name === 'entregas');
    const properties = (entregas?.inputSchema?.properties ?? {}) as Record<
      string,
      { enum?: readonly string[] }
    >;
    const offered = [...(properties.estado?.enum ?? [])].sort();

    const constraint = await database.pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       WHERE c.conrelid = 'deliveries'::regclass AND c.contype = 'c'
         AND pg_get_constraintdef(c.oid) LIKE '%status%'`,
    );
    const definition = constraint.rows[0]?.definition;
    expect(definition, 'deliveries.status CHECK constraint not found').toBeTypeOf('string');
    const allowed = [
      ...new Set(
        [...(definition ?? '').matchAll(/'([a-z_]+)'/gu)].map((match) => match[1] as string),
      ),
    ].sort();

    expect(offered).toEqual(allowed);

    // And the filter really reaches the query.
    const filtered = JSON.parse(
      textOf(await client.callTool('entregas', { estado: 'dead', limit: 5 })),
    ) as { available: boolean; data: readonly unknown[] };
    expect(filtered.available).toBe(true);
    expect(filtered.data).toEqual([]);
  }, 120_000);

  it('rejects a tool it does not implement', async () => {
    const result = await client.callTool('get_agent_chain_status', { trace_id: 'x' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Unknown tool/u);
  });

  /**
   * Closes the loop between the two surfaces. The adapter's protocol prompt is the other
   * place an agent learns what it may call, and the adapter cannot execute a tool at all:
   * it reaches the store only through the gateway socket. So the prompt must advertise
   * nothing. If a tool affordance is ever reintroduced there, it has to be backed by a
   * tool this server really implements, and this assertion is what forces that.
   */
  it('is the only surface that advertises tools to agents', async () => {
    const promptSource = await readFile(HARNESS_PROMPT_SOURCE, 'utf8');
    const implemented = new Set(advertised.map((tool) => tool.name));

    expect(promptSource).not.toMatch(/get_agent_chain_status/u);

    const advertisedInPrompt = [...promptSource.matchAll(/"name"\s*:\s*"([a-z_]+)"/gu)]
      .map((match) => match[1] as string)
      .filter((name) => !implemented.has(name));
    expect(advertisedInPrompt, 'harness prompt names a tool the MCP server does not implement')
      .toEqual([]);
  });
});

function argumentsFor(tool: string): Record<string, unknown> {
  if (tool === 'cadena') return { trace_id: 'trace-probe' };
  if (tool === 'entregas') return { limit: 1 };
  return {};
}
