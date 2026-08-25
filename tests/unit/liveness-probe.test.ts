import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const probePath = join(repositoryRoot, 'deploy/liveness-probe.mjs');

interface ProbeResult { code: number | null; stderr: string }

let stateDirectory: string;
let server: Server | undefined;
/** Lo que el /health/ready simulado devuelve en la próxima consulta. */
let document: Record<string, unknown> = { status: 'ready', ticks: 0 };
let statusCode = 200;

async function startHealthServer(): Promise<string> {
  server = createServer((_request, response) => {
    response.writeHead(statusCode, { 'content-type': 'application/json' });
    response.end(JSON.stringify(document));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `http://127.0.0.1:${address.port}/health/ready`;
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
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'cauce-liveness-test-'));
  document = { status: 'ready', ticks: 0 };
  statusCode = 200;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  await rm(stateDirectory, { recursive: true, force: true });
});

describe('liveness probe: verdict is progress, not response', () => {
  it('fails once the counter has been frozen longer than the stall window', async () => {
    const url = await startHealthServer();
    // El bucle "gira": el contador sube y la sonda pasa.
    document = { status: 'ready', ticks: 10 };
    expect((await runProbe(url, 'ticks', 150)).code).toBe(0);
    document = { status: 'ready', ticks: 11 };
    expect((await runProbe(url, 'ticks', 150)).code).toBe(0);

    // El bucle MUERE. El proceso sigue contestando 200 y `status: ready` — igual que hoy
    // contestan los nueve contenedores. La sonda de readiness diría "healthy" para siempre.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await runProbe(url, 'ticks', 150)).code).toBe(0); // todavía dentro de la ventana
    await new Promise((resolve) => setTimeout(resolve, 200));

    const stalled = await runProbe(url, 'ticks', 150);
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
    expect((await runProbe(url, 'ticks', 10_000)).code).toBe(0);
    expect((await runProbe(url, 'ticks', 10_000)).code).toBe(0);
    expect((await runProbe(url, 'ticks', 10_000)).code).toBe(0);
  });

  it('treats a counter that went backwards as a restart and restarts the window', async () => {
    const url = await startHealthServer();
    document = { status: 'ready', ticks: 900 };
    expect((await runProbe(url, 'ticks', 100)).code).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    // El contenedor reinició: el contador vuelve a cero. Un bucle recién arrancado no está parado.
    document = { status: 'ready', ticks: 0 };
    expect((await runProbe(url, 'ticks', 100)).code).toBe(0);
    expect((await runProbe(url, 'ticks', 100)).code).toBe(0);
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

    await new Promise<void>((resolve) => server!.close(() => resolve()));
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
      child.once('close', (code) => resolve({ code, stderr }));
    });
    expect(noField.code).toBe(1);
    expect(noField.stderr).toContain('usage:');
  });
});
