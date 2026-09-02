#!/usr/bin/env node
/** Runs the whole test matrix to completion; non-zero exit if any suite fails or times out. */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SUITES = [
  'test:unit',
  'test:terminal-pty',
  'test:pty',
  'test:ops',
  'test:services',
  'test:gateway-hardening',
  'test:store-hardening',
  'test:integration',
  'test:e2e',
];

/* Kept out of the matrix, each for a reason no automated check can see from the script alone. */
export const SEPARATELY_GATED = new Map([
  ['test:container-supervisor', 'covered by test:ops discovery (ops/tests/run-all.mjs); direct entry point only'],
  ['test:container-cutover', 'covered by test:ops discovery (ops/tests/run-all.mjs); direct entry point only'],
  ['test:coverage', 're-runs this whole matrix under instrumentation, so the matrix cannot contain it'],
  ['qa:real', 'the live fleet: talks to the real bus and real agent adapters'],
  ['qa:contract', 'the live fleet: exercises the harness against the fleet topology, mocked responses only'],
  ['qa:opencode-cli', 'the live fleet: probes whatever opencode CLI binary the host actually has installed'],
  ['qa:testcontainers', 'Docker: provisions real containers via testcontainers'],
  ['qa:runtime-packaging', 'root/packaging: builds and boots the release Docker image, needs a normal-user identity'],
  ['qa:layout', 'Playwright/Chromium: renders the console in a real browser at fixed viewports'],
  ['qa:layout:update', 'Playwright/Chromium: same renderer as qa:layout, writing the baseline instead of checking it'],
]);

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const TIEMPOS = new Map([
  ['test:e2e', 40 * 60_000],
  ['test:integration', 40 * 60_000],
  ['test:store-hardening', 40 * 60_000],
]);
const GRACE_KILL_MS = 10_000;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A suite that exists but belongs to no list is a suite nobody runs. Fail loudly
 * so adding one forces the choice between the matrix and an explicit exclusion.
 */
async function assertMatrixIsComplete() {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const scripts = Object.keys(manifest.scripts ?? {});
  const declared = scripts.filter((name) => name.startsWith('test:') || name.startsWith('qa:'));
  const unclaimed = declared.filter((name) => !SUITES.includes(name) && !SEPARATELY_GATED.has(name));
  if (unclaimed.length > 0) {
    throw new Error(
      `these test/qa scripts are neither in the matrix nor explicitly excluded: ${unclaimed.join(', ')}`,
    );
  }
  const absent = SUITES.filter((name) => !scripts.includes(name));
  if (absent.length > 0) throw new Error(`the matrix names missing scripts: ${absent.join(', ')}`);

  const { execSync } = await import('node:child_process');
  const paquetes = execSync('git ls-files "*/package.json"', { encoding: 'utf8' }).split('\n')
    .filter((f) => f && !f.includes('node_modules'));
  const invocaciones = Object.entries(manifest.scripts ?? {})
    .filter(([name]) => name.startsWith('test:')).map(([, cmd]) => cmd).join(' ');
  const sinRunner = [];
  for (const ruta of paquetes) {
    const pkg = JSON.parse(await readFile(resolve(root, ruta), 'utf8'));
    if (!pkg.scripts?.test || !pkg.name) continue;
    if (!invocaciones.includes(pkg.name) && !invocaciones.includes(dirname(ruta))) sinRunner.push(pkg.name);
  }
  if (sinRunner.length > 0) {
    throw new Error(`workspace packages declare a test script that no root test:* ever invokes: ${sinRunner.join(', ')}`);
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function verdictFor(result) {
  if (result.timedOut) return 'TIMEOUT';
  return result.code === 0 ? 'PASS' : 'FAIL';
}

function runSuite(name) {
  return new Promise((settle, fail) => {
    const startedAt = Date.now();
    const timeoutMs = TIEMPOS.get(name) ?? DEFAULT_TIMEOUT_MS;
    process.stdout.write(`\n${'='.repeat(72)}\n=== ${name}\n${'='.repeat(72)}\n`);
    // Own process group so a wedged suite dies with its grandchildren, not just its pnpm wrapper.
    const child = spawn('pnpm', ['run', name], { cwd: root, stdio: 'inherit', detached: true });
    let timedOut = false;
    let killTimer = null;
    const deadline = setTimeout(() => {
      timedOut = true;
      process.stdout.write(`\n=== ${name}: exceeded ${(timeoutMs / 60_000).toFixed(0)} min, sending SIGTERM\n`);
      signalGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), GRACE_KILL_MS);
    }, timeoutMs);
    child.on('error', fail);
    child.on('close', (code, signal) => {
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      const result = { name, code: code ?? 1, signal, elapsedMs: Date.now() - startedAt, timedOut, timeoutMs };
      // Verdict now, not only in the closing summary: a full matrix run takes many minutes,
      // and whoever is watching should not have to wait for the end to learn suite one fell.
      process.stdout.write(`\n=== ${name}: ${verdictFor(result)} in ${seconds(result.elapsedMs)}\n`);
      settle(result);
    });
  });
}

function seconds(ms) {
  return `${(ms / 1_000).toFixed(1)}s`;
}

async function main() {
  await assertMatrixIsComplete();
  const results = [];
  for (const name of SUITES) results.push(await runSuite(name));

  const failed = results.filter((result) => result.timedOut || result.code !== 0);
  const total = results.reduce((sum, result) => sum + result.elapsedMs, 0);
  const width = Math.max(...SUITES.map((name) => name.length));
  process.stdout.write(`\n${'='.repeat(72)}\n=== test matrix summary\n${'='.repeat(72)}\n`);
  for (const result of results) {
    const verdict = verdictFor(result);
    const cause = verdict === 'PASS'
      ? ''
      : verdict === 'TIMEOUT'
        ? `  (killed after ${(result.timeoutMs / 60_000).toFixed(0)} min)`
        : `  (${result.signal === null || result.signal === undefined ? `exit ${result.code}` : `signal ${result.signal}`})`;
    process.stdout.write(`${verdict}  ${result.name.padEnd(width)}  ${seconds(result.elapsedMs).padStart(8)}${cause}\n`);
  }
  process.stdout.write(
    `\n${results.length - failed.length} passed, ${failed.length} failed of ${results.length} suites in ${seconds(total)}\n`,
  );
  if (failed.length > 0) {
    process.stdout.write(`failed suites: ${failed.map((result) => result.name).join(' ')}\n`);
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) await main();
