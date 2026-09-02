#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUITES } from '../../scripts/test-all.mjs';

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testsDirectory, '../..');
const DISCOVERY_SUITE = 'test:ops';
const opsTestFileInCommand = /(?:^|\s)ops\/tests\/(\S+)/u;
const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const GRACE_KILL_MS = 10_000;
const TIMEOUT_MS = Number(process.env.CAUCE_OPS_TEST_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
const releaseValidation = process.env.CAUCE_RELEASE_VALIDATION === '1';
const declarationPattern = /^\s*(?:#|\/\/)\s*cauce:requiere\s+(\S+)\s*$/u;
const declarationHeaderLines = 20;
const defaultRequirement = 'none';
const knownRequirements = new Set(['root', 'non-root', 'docker', defaultRequirement]);
const requirementDeclaredOutsideTheFile = new Map([
  ['test_container_runtime_reaping.py', 'non-root'],
]);

async function discover() {
  const entries = await readdir(testsDirectory, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => name.endsWith('.test.mjs') || /^test[-_].*\.(?:py|sh)$/u.test(name))
    .sort();
}

async function filesRunByTheirOwnMatrixSuite() {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
  const byFile = new Map();
  for (const suite of SUITES) {
    if (suite === DISCOVERY_SUITE) continue;
    const file = opsTestFileInCommand.exec(manifest.scripts?.[suite] ?? '')?.[1];
    if (file !== undefined) byFile.set(file, suite);
  }
  return byFile;
}

async function requirementFor(name) {
  const header = (await readFile(join(testsDirectory, name), 'utf8')).split('\n', declarationHeaderLines);
  const declared = new Set(
    header.map(line => declarationPattern.exec(line)?.[1]).filter(value => value !== undefined),
  );
  if (declared.size === 0) return requirementDeclaredOutsideTheFile.get(name) ?? defaultRequirement;
  if (declared.size > 1) return `conflicting declarations: ${[...declared].sort().join(', ')}`;
  return [...declared][0];
}

let dockerDaemonReachable;

function dockerDaemonAvailable() {
  dockerDaemonReachable ??= spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 30_000 }).status === 0;
  return dockerDaemonReachable;
}

function gateFor(requirement) {
  if (requirement === 'root' && process.getuid?.() !== 0) {
    return { allowed: false, reason: 'requires root: the runner is not uid 0' };
  }
  if (requirement === 'docker' && !dockerDaemonAvailable()) {
    return { allowed: false, reason: 'requires docker: no daemon answers' };
  }
  return { allowed: true, reason: '' };
}

function interpreterFor(name) {
  if (name.endsWith('.test.mjs')) return process.execPath;
  if (name.endsWith('.sh')) return 'bash';
  return 'python3';
}

function commandFor(name, requirement) {
  const path = join(testsDirectory, name);
  const interpreter = interpreterFor(name);
  if (requirement === 'non-root' && process.getuid?.() === 0) {
    return {
      executable: 'setpriv',
      arguments: [
        '--reuid=65534',
        '--regid=65534',
        '--clear-groups',
        'env',
        'HOME=/tmp',
        'PYTHONDONTWRITEBYTECODE=1',
        interpreter,
        path,
      ],
    };
  }
  return { executable: interpreter, arguments: [path] };
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function execute(name, requirement) {
  return new Promise(resolveResult => {
    const startedAt = Date.now();
    const command = commandFor(name, requirement);
    process.stdout.write(`\n=== ops/${name}\n`);
    const child = spawn(command.executable, command.arguments, {
      cwd: repositoryRoot,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: 'inherit',
      detached: true,
    });
    let timedOut = false;
    let killTimer = null;
    const deadline = setTimeout(() => {
      timedOut = true;
      process.stdout.write(`\n=== ops/${name}: exceeded ${duration(TIMEOUT_MS)}, SIGTERM to the process group\n`);
      signalGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), GRACE_KILL_MS);
    }, TIMEOUT_MS);
    const settle = (code, signal, error) => {
      clearTimeout(deadline);
      if (killTimer !== null) clearTimeout(killTimer);
      resolveResult({
        name,
        verdict: timedOut ? 'TIMEOUT' : code === 0 ? 'PASS' : 'FAIL',
        detail: timedOut
          ? `killed after ${duration(TIMEOUT_MS)}`
          : code === 0
            ? ''
            : (error?.message ?? (signal ? `signal ${signal}` : `exit ${code}`)),
        elapsedMs: Date.now() - startedAt,
      });
    };
    child.once('error', error => settle(1, null, error));
    child.once('close', (code, signal) => settle(code ?? 1, signal, null));
  });
}

function duration(milliseconds) {
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

async function verdictFor(name, ownSuite) {
  const suite = ownSuite.get(name);
  if (suite !== undefined) {
    return { name, verdict: 'SKIP', detail: `run by the matrix suite: pnpm run ${suite}`, elapsedMs: 0 };
  }
  const requirement = await requirementFor(name);
  if (!knownRequirements.has(requirement)) {
    return { name, verdict: 'FAIL', detail: `cauce:requiere ${requirement}`, elapsedMs: 0 };
  }
  const gate = gateFor(requirement);
  if (gate.allowed) return execute(name, requirement);
  if (releaseValidation) {
    return { name, verdict: 'FAIL', detail: `${gate.reason} (CAUCE_RELEASE_VALIDATION=1 forbids skipping)`, elapsedMs: 0 };
  }
  return { name, verdict: 'SKIP', detail: gate.reason, elapsedMs: 0 };
}

async function main() {
  const tests = await discover();
  if (tests.length === 0) throw new Error('no ops tests discovered');
  if (process.argv.includes('--list')) {
    process.stdout.write(`${tests.map(name => relative(repositoryRoot, join(testsDirectory, name))).join('\n')}\n`);
    return;
  }

  const ownSuite = await filesRunByTheirOwnMatrixSuite();
  const results = [];
  for (const test of tests) results.push(await verdictFor(test, ownSuite));

  const counts = { PASS: 0, FAIL: 0, SKIP: 0, TIMEOUT: 0 };
  process.stdout.write('\n=== ops test summary\n');
  for (const result of results) {
    counts[result.verdict] += 1;
    process.stdout.write(
      `${result.verdict}  ${result.name}  ${duration(result.elapsedMs)}${result.detail ? `  ${result.detail}` : ''}\n`,
    );
  }
  process.stdout.write(
    `${counts.PASS} passed, ${counts.FAIL} failed, ${counts.TIMEOUT} timed out, ${counts.SKIP} skipped of ${results.length}\n`,
  );
  if (counts.FAIL + counts.TIMEOUT > 0) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`ops test runner: ${error.message}\n`);
  process.exitCode = 1;
});
