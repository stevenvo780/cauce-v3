import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { GenericContainer, Wait } from 'testcontainers';
import { applyMigrations, createPool } from '@cauce/store';
import { MtlsAuthProvider } from '../../services/gateway/src/auth.js';
import { FleetMtlsIdentityProvider } from '../../services/gateway/src/fleet/mtls-identities.js';
import { configureExternalGateway, externalGatewayOptions } from '../../services/gateway/src/security/route-isolation-external.fixtures.js';
import { COMANDO_POSTGRES_DE_PRUEBA, arrancarPostgresDePrueba, saludDePostgresDePrueba } from '../helpers/contenedor-de-prueba.js';
import type { TestDatabase } from '../helpers/postgres.js';
import { startRealPtyFixture, type RealPtyGatewayContext } from './real-pty-agent.fixtures.js';
import { OWNER, TerminalIsolationRuntime, type AttachRequest, type PublicTarget, type RelayRequest } from './m1-terminal-isolation-external.runtime.js';

export { OWNER } from './m1-terminal-isolation-external.runtime.js';
export const RECEIPTS = join(process.cwd(), '.delegados/v4/recibos', OWNER);
export async function receipt(name: string, value: unknown): Promise<void> {
  await mkdir(RECEIPTS, { recursive: true });
  await writeFile(join(RECEIPTS, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function ownedDatabase(): Promise<TestDatabase> {
  const password = randomUUID();
  const container = await arrancarPostgresDePrueba(() => new GenericContainer('postgres:16-alpine')
    .withName(`zz-canary-${OWNER}-pg-${randomUUID().slice(0, 8)}`).withLabels({ 'cauce.e2e.owner': OWNER })
    .withCommand([...COMANDO_POSTGRES_DE_PRUEBA])
    .withEnvironment({ POSTGRES_DB: 'cauce_test', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: password })
    .withExposedPorts(5432).withHealthCheck(saludDePostgresDePrueba('cauce_test', 'cauce_test')).withWaitStrategy(Wait.forHealthCheck()).start());
  const url = `postgresql://cauce_test:${encodeURIComponent(password)}@${container.getHost()}:${String(container.getMappedPort(5432))}/cauce_test`;
  const pool = createPool(url);
  try { await applyMigrations(pool); }
  catch (error) { await pool.end(); await container.stop(); throw error; }
  return { container, pool, url, adminPool: pool, adminUrl: url };
}

type BridgeRequest = ({ op: 'prepare'; runId: string; sides: PublicTarget[] })
  | ({ op: 'relay' } & RelayRequest) | ({ op: 'attach' } & AttachRequest) | { op: 'close'; runId: string };

async function bridge(socketPath: string, runtime: TerminalIsolationRuntime) {
  const sockets = new Set<Socket>();
  const failures: { op: string; code: string; stage: string; detail?: string }[] = [];
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '', accepted = false;
    socket.on('error', () => undefined);
    socket.on('data', (chunk: string) => {
      if (accepted) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1_048_576) { socket.destroy(); return; }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      accepted = true;
      void (async () => {
        const input = JSON.parse(buffer.slice(0, end)) as BridgeRequest;
        try {
          let value: unknown;
          if (input.op === 'prepare') value = await runtime.prepare(input.runId, input.sides);
          else if (input.op === 'relay') value = await runtime.relay(input);
          else if (input.op === 'attach') value = await runtime.attach(input);
          else { assert.equal(input.op, 'close'); value = await runtime.close(input.runId); }
          socket.end(`${JSON.stringify({ ok: true, value })}\n`);
        } catch (error) {
          failures.push({ op: input.op, code: 'M1_RUNTIME_OPERATION_FAILED', stage: runtime.stage,
            ...(input.op === 'prepare' && error instanceof Error ? { detail: error.message.slice(0, 2000) } : {}) });
          socket.end('{"ok":false,"error":"M1_RUNTIME_OPERATION_FAILED"}\n');
        }
      })().catch(() => socket.end('{"ok":false,"error":"M1_INVALID_REQUEST"}\n'));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return { failures, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => { if (error) reject(error); else resolve(); }));
  } };
}

export async function startTerminalIsolationFixture() {
  assert.match(process.env.HOME ?? '', /^\/tmp\/cauce-e2e-home-/u, 'Run this suite through scripts/e2e-lab.sh');
  let context: RealPtyGatewayContext | undefined;
  let oauthIssuer = '';
  const database = await ownedDatabase();
  const fixture = await startRealPtyFixture({ owner: OWNER, resourcePrefix: `zz-canary-${OWNER}`, database,
    skipBrowser: true, externalVerificationProxy: true, governanceRelay: true, tui: true, maxSessionsPerOperator: 10,
    gatewayOptions: async value => {
      const base = join(value.directory, 'm1-bootstrap-base.json'), fleet = join(value.directory, 'm1-bootstrap-fleet.json');
      for (const path of [base, fleet]) await writeFile(path, '{"version":1,"identities":[]}', { mode: 0o600 });
      const provider = (namespace: 'bootstrap' | 'normal') => new MtlsAuthProvider(new FleetMtlsIdentityProvider(
        base, fleet, namespace, process.getuid?.() ?? 0));
      return { ...externalGatewayOptions(value), bootstrapProviders: { bootstrap: provider('bootstrap'), normal: provider('normal') } };
    },
    configureGateway: async value => { context = value; ({ oauthIssuer } = await configureExternalGateway(value)); },
  });
  assert.ok(context);
  const runtime = new TerminalIsolationRuntime(fixture, context);
  const socketPath = join(fixture.directory, 'm1-terminal.sock');
  let server: Awaited<ReturnType<typeof bridge>>;
  try { server = await bridge(socketPath, runtime); }
  catch (error) { await fixture.close(); throw error; }
  return { fixture, runtime, oauthIssuer, socketPath,
    close: async () => {
      const failures: unknown[] = [];
      for (const cleanup of [async () => runtime.close(), async () => server.close(), async () => fixture.close()]) {
        try { await cleanup(); } catch (error) { failures.push(error); }
      }
      await receipt('cleanup', { result: failures.length ? 'FAIL' : 'PASS', failureCount: failures.length,
        bridgeFailures: server.failures, runtimeProofs: runtime.proofs });
      if (failures.length) throw new AggregateError(failures, 'owned terminal isolation cleanup failed');
    } };
}
