#!/usr/bin/env node
/**
 * Runs the whole test matrix to completion instead of stopping at the first failure.
 *
 * `pnpm test` used to be `test:unit && test:services && ... && test:e2e`. The `&&`
 * chain aborts on the first non-zero exit, so the state of every suite behind the
 * failure was simply unknown. That is how the e2e suite stayed broken for four days
 * behind an unrelated failure in `test:services`: nobody could see it, and deleting
 * the visible failure would have deleted the only pointer to the real one.
 *
 * Every suite now runs, the summary reports all of them, and the exit code is
 * non-zero when any suite failed.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUITES = [
  'test:unit',
  'test:terminal-pty',
  'test:services',
  'test:gateway-hardening',
  'test:store-hardening',
  'test:integration',
  'test:e2e',
];

/**
 * Suites with their own gate: each needs something the developer matrix cannot
 * assume — a built release bundle plus its evidence validator, or a live
 * container host with Docker privileges.
 */
const SEPARATELY_GATED = new Set([
  'test:fleet-release',
  'test:container-supervisor',
  'test:container-cutover',
]);


const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A suite that exists but belongs to no list is a suite nobody runs. Fail loudly
 * so adding one forces the choice between the matrix and an explicit exclusion.
 */
async function assertMatrixIsComplete() {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const declared = Object.keys(manifest.scripts ?? {}).filter((name) => name.startsWith('test:'));
  const unclaimed = declared.filter((name) => !SUITES.includes(name) && !SEPARATELY_GATED.has(name));
  if (unclaimed.length > 0) {
    throw new Error(
      `these test scripts are neither in the matrix nor explicitly excluded: ${unclaimed.join(', ')}`,
    );
  }
  const absent = SUITES.filter((name) => !declared.includes(name));
  if (absent.length > 0) throw new Error(`the matrix names missing scripts: ${absent.join(', ')}`);
}

function runSuite(name) {
  return new Promise((settle, fail) => {
    const startedAt = Date.now();
    process.stdout.write(`\n${'='.repeat(72)}\n=== ${name}\n${'='.repeat(72)}\n`);
    const child = spawn('pnpm', ['run', name], { cwd: root, stdio: 'inherit' });
    child.on('error', fail);
    child.on('close', (code, signal) => {
      const result = { name, code: code ?? 1, signal, elapsedMs: Date.now() - startedAt };
      // Verdict now, not only in the closing summary: a full matrix run takes many minutes,
      // and whoever is watching should not have to wait for the end to learn suite one fell.
      process.stdout.write(`\n=== ${name}: ${result.code === 0 ? 'PASS' : 'FAIL'} in ${seconds(result.elapsedMs)}\n`);
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

  const failed = results.filter((result) => result.code !== 0);
  const total = results.reduce((sum, result) => sum + result.elapsedMs, 0);
  const width = Math.max(...SUITES.map((name) => name.length));
  process.stdout.write(`\n${'='.repeat(72)}\n=== test matrix summary\n${'='.repeat(72)}\n`);
  for (const result of results) {
    const verdict = result.code === 0 ? 'PASS' : 'FAIL';
    const cause = result.code === 0
      ? ''
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

await main();
