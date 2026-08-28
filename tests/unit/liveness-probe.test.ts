import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const probePath = join(repositoryRoot, 'deploy/liveness-probe.mjs');
const TEST_STALL_WINDOW_MS = 5 * 60_000;

interface ProbeResult { code: number | null; stderr: string }
interface ProbeState { path: string; since: number; value: number }

let stateDirectory: string;
let server: Server | undefined;
/** What the simulated /health/ready returns on the next query. */
let document: Record<string, unknown> = { status: 'ready', ticks: 0 };
let statusCode = 200;

async function startHealthServer(): Promise<string> {
  const currentServer = createServer((_request, response) => {
    response.writeHead(statusCode, { 'content-type': 'application/json' });
    response.end(JSON.stringify(document));
  });
  server = currentServer;
  await new Promise<void>((resolve) => { currentServer.listen(0, '127.0.0.1', () => { resolve(); }); });
  const address = currentServer.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `http://127.0.0.1:${String(address.port)}/health/ready`;
}

function runProbe(url: string, field: string, stallMs: number): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probePath, url, field, String(stallMs)], {
      cwd: repositoryRoot,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        NODE_ENV: 'production',
        HEALTH_TIMEOUT_MS: '3000',
        CAUCE_LIVENESS_STATE_DIR: stateDirectory,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => { resolve({ code, stderr }); });
  });
}

async function readProbeState(): Promise<ProbeState> {
  const entries = await readdir(stateDirectory);
  if (entries.length !== 1 || entries[0] === undefined) throw new Error('expected one probe state file');
  const path = join(stateDirectory, entries[0]);
  const decoded = JSON.parse(await readFile(path, 'utf8')) as { since?: unknown; value?: unknown };
  if (typeof decoded.since !== 'number' || typeof decoded.value !== 'number') {
    throw new Error('invalid probe state');
  }
  return { path, since: decoded.since, value: decoded.value };
}

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'cauce-liveness-test-'));
  document = { status: 'ready', ticks: 0 };
  statusCode = 200;
});

afterEach(async () => {
  if (server) {
    const s = server;
    await new Promise<void>((resolve) => { s.close(() => { resolve(); }); });
  }
  server = undefined;
  await rm(stateDirectory, { recursive: true, force: true });
});

describe('liveness probe: verdict is progress, not response', () => {
  it('fails once the counter has been frozen longer than the stall window', async () => {
    const url = await startHealthServer();
    // The loop "turns": the counter goes up and the probe passes.
    document = { status: 'ready', ticks: 10 };
    expect((await runProbe(url, 'ticks', TEST_STALL_WINDOW_MS)).code).toBe(0);
    document = { status: 'ready', ticks: 11 };
    expect((await runProbe(url, 'ticks', TEST_STALL_WINDOW_MS)).code).toBe(0);

    // The loop DIES. The process keeps answering 200 and `status: ready` — just as the nine
    // containers do today. The readiness probe would say "healthy" forever.
    expect((await runProbe(url, 'ticks', TEST_STALL_WINDOW_MS)).code).toBe(0);
    const fresh = await readProbeState();
    await writeFile(fresh.path, JSON.stringify({
      value: fresh.value,
      since: Date.now() - TEST_STALL_WINDOW_MS - 1_000,
    }));

    const stalled = await runProbe(url, 'ticks', TEST_STALL_WINDOW_MS);
    expect(stalled.code).toBe(1);
    expect(stalled.stderr).toContain('progress stalled');
    expect(stalled.stderr).toContain('frozen at 11');
  });

  it('never fails while the counter keeps advancing, however slowly', async () => {
    const url = await startHealthServer();
    for (let tick = 1; tick <= 6; tick += 1) {
      document = { status: 'ready', ticks: tick };
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect((await runProbe(url, 'ticks', 60)).code).toBe(0);
    }
  });

  it('does not flap: a frozen counter inside the window still passes', async () => {
    const url = await startHealthServer();
    document = { status: 'ready', ticks: 42 };
    expect((await runProbe(url, 'ticks', TEST_STALL_WINDOW_MS)).code).toBe(0);
    expect((await runProbe(url, 'ticks', TEST_STALL_WINDOW_MS)).code).toBe(0);
    expect((await runProbe(url, 'ticks', TEST_STALL_WINDOW_MS)).code).toBe(0);
  });

  it('treats a counter that went backwards as a restart and restarts the window', async () => {
    const url = await startHealthServer();
    document = { status: 'ready', ticks: 900 };
    expect((await runProbe(url, 'ticks', TEST_STALL_WINDOW_MS)).code).toBe(0);
    const beforeRestart = await readProbeState();
    const staleSince = Date.now() - TEST_STALL_WINDOW_MS - 1_000;
    await writeFile(beforeRestart.path, JSON.stringify({ value: beforeRestart.value, since: staleSince }));
    expect((await runProbe(url, 'ticks', TEST_STALL_WINDOW_MS)).code).toBe(1);
    // The container restarted: the counter goes back to zero. A freshly started loop is not stuck.
    document = { status: 'ready', ticks: 0 };
    expect((await runProbe(url, 'ticks', TEST_STALL_WINDOW_MS)).code).toBe(0);
    const restarted = await readProbeState();
    expect(restarted.value).toBe(0);
    expect(restarted.since).toBeGreaterThan(staleSince);
  });

  it('reads nested progress fields without inheriting from the prototype', async () => {
    const url = await startHealthServer();
    document = { status: 'ready', progress: { cycles: 5 } };
    expect((await runProbe(url, 'progress.cycles', 100)).code).toBe(0);
    const missing = await runProbe(url, 'progress.__proto__', 100);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('missing or not a counter');
  });

  it('fails when the endpoint is unreachable, non-2xx, or has no counter', async () => {
    const url = await startHealthServer();
    statusCode = 503;
    expect((await runProbe(url, 'ticks', 100)).code).toBe(1);

    statusCode = 200;
    document = { status: 'ready' };
    const noField = await runProbe(url, 'ticks', 100);
    expect(noField.code).toBe(1);
    expect(noField.stderr).toContain('missing or not a counter');

    document = { status: 'ready', ticks: 'many' };
    expect((await runProbe(url, 'ticks', 100)).code).toBe(1);

    if (server) {
      const s = server;
      await new Promise<void>((resolve) => { s.close(() => { resolve(); }); });
    }
    server = undefined;
    expect((await runProbe(url, 'ticks', 100)).code).toBe(1);
  });

  it('rejects a malformed invocation instead of passing by default', async () => {
    const url = await startHealthServer();
    const noField = await new Promise<ProbeResult>((resolve, reject) => {
      const child = spawn(process.execPath, [probePath, url], {
        cwd: repositoryRoot,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', CAUCE_LIVENESS_STATE_DIR: stateDirectory },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code) => { resolve({ code, stderr }); });
    });
    expect(noField.code).toBe(1);
    expect(noField.stderr).toContain('usage:');
  });
});
