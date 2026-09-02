#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testsDirectory, '../..');
const unprivilegedPython = new Set([
  'test_container_runtime_reaping.py',
]);

async function discover() {
  const entries = await readdir(testsDirectory, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => name.endsWith('.test.mjs') || /^test[-_].*\.(?:py|sh)$/u.test(name))
    .sort();
}

function commandFor(name) {
  const path = join(testsDirectory, name);
  if (name.endsWith('.test.mjs')) return { executable: process.execPath, arguments: [path] };
  if (name.endsWith('.sh')) return { executable: 'bash', arguments: [path] };
  if (process.getuid?.() === 0 && unprivilegedPython.has(name)) {
    return {
      executable: 'setpriv',
      arguments: [
        '--reuid=65534',
        '--regid=65534',
        '--clear-groups',
        'env',
        'HOME=/tmp',
        'PYTHONDONTWRITEBYTECODE=1',
        'python3',
        path,
      ],
    };
  }
  return { executable: 'python3', arguments: [path] };
}

function execute(name) {
  return new Promise(resolveResult => {
    const startedAt = Date.now();
    const command = commandFor(name);
    process.stdout.write(`\n=== ops/${name}\n`);
    const child = spawn(command.executable, command.arguments, {
      cwd: repositoryRoot,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: 'inherit',
    });
    child.once('error', error => resolveResult({
      name,
      code: 1,
      signal: null,
      error,
      elapsedMs: Date.now() - startedAt,
    }));
    child.once('close', (code, signal) => resolveResult({
      name,
      code: code ?? 1,
      signal,
      error: null,
      elapsedMs: Date.now() - startedAt,
    }));
  });
}

function duration(milliseconds) {
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

async function main() {
  const tests = await discover();
  if (tests.length === 0) throw new Error('no ops tests discovered');
  if (process.argv.includes('--list')) {
    process.stdout.write(`${tests.map(name => relative(repositoryRoot, join(testsDirectory, name))).join('\n')}\n`);
    return;
  }

  const results = [];
  for (const test of tests) results.push(await execute(test));
  const failures = results.filter(result => result.code !== 0);
  process.stdout.write('\n=== ops test summary\n');
  for (const result of results) {
    const verdict = result.code === 0 ? 'PASS' : 'FAIL';
    const detail = result.error?.message
      ?? (result.signal ? `signal ${result.signal}` : `exit ${result.code}`);
    process.stdout.write(
      `${verdict}  ${result.name}  ${duration(result.elapsedMs)}${result.code === 0 ? '' : `  ${detail}`}\n`,
    );
  }
  process.stdout.write(`${results.length - failures.length} passed, ${failures.length} failed of ${results.length}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`ops test runner: ${error.message}\n`);
  process.exitCode = 1;
});
