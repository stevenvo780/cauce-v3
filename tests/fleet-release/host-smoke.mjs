#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readAliasManifest } from './manifest-matrix.mjs';

const MAX_OUTPUT_BYTES = 256 * 1024;
const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function currentSourceDigest() {
  const { stdout } = await execFileAsync('python3', [path.join(repositoryRoot, 'ops/scripts/source-digest.py')], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  const value = stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error('source digest script returned an invalid digest');
  return value;
}

async function resolveExecutable(command, searchPath) {
  if (command.includes(path.sep)) {
    const resolved = await realpath(path.resolve(command));
    await access(resolved, constants.X_OK);
    return resolved;
  }
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through the explicit PATH without invoking a shell.
    }
  }
  throw new Error(`executable '${command}' is unavailable`);
}

async function probe(executable, argument, environment, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [argument], {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    let bytes = 0;
    let exceeded = false;
    const collect = (chunk) => {
      bytes += chunk.length;
      if (bytes <= MAX_OUTPUT_BYTES) chunks.push(Buffer.from(chunk));
      else exceeded = true;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks);
      if (signal === 'SIGKILL') return reject(new Error(`${argument} timed out`));
      if (code !== 0) return reject(new Error(`${argument} exited ${String(code)}`));
      if (exceeded) return reject(new Error(`${argument} output exceeded ${MAX_OUTPUT_BYTES} bytes`));
      if (output.length === 0) return reject(new Error(`${argument} output was empty`));
      resolve({ bytes: output.length, sha256: sha256(output) });
    });
  });
}

export async function runHostSmoke({
  host,
  manifestPaths,
  commands = {},
  outputPath,
  timeoutMs = 10_000,
  searchPath = process.env.PATH ?? '',
  evidenceClass = 'harness-authentic',
  sourceDigest,
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(host)) throw new Error('host is invalid');
  if (evidenceClass !== 'harness-authentic' && evidenceClass !== 'harness-double') {
    throw new Error('evidenceClass is invalid');
  }
  const manifests = await Promise.all(manifestPaths.map(readAliasManifest));
  const boundSourceDigest = sourceDigest ?? await currentSourceDigest();
  if (!/^sha256:[a-f0-9]{64}$/u.test(boundSourceDigest)) throw new Error('sourceDigest is invalid');
  const aliasSet = new Set(manifests.map((manifest) => manifest.alias));
  if (aliasSet.size !== manifests.length) throw new Error(`host '${host}' has duplicate manifest aliases`);
  const harnesses = [...new Set(manifests.map((manifest) => manifest.harness))].sort();
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'cauce-host-smoke-'));
  const startedAt = new Date();
  const checks = [];
  try {
    const directories = Object.fromEntries(['home', 'config', 'cache', 'data'].map((name) => [name, path.join(sandbox, name)]));
    await Promise.all(Object.values(directories).map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
    const environment = {
      PATH: searchPath,
      HOME: directories.home,
      XDG_CONFIG_HOME: directories.config,
      XDG_CACHE_HOME: directories.cache,
      XDG_DATA_HOME: directories.data,
      CI: '1',
      NO_COLOR: '1',
      TERM: 'dumb',
    };
    for (const harness of harnesses) {
      const started = performance.now();
      try {
        const executable = await resolveExecutable(commands[harness] ?? harness, searchPath);
        const binary = await readFile(executable);
        const version = await probe(executable, '--version', environment, timeoutMs);
        const help = await probe(executable, '--help', environment, timeoutMs);
        checks.push({
          harness,
          status: 'passed',
          evidenceClass,
          executable,
          binarySha256: sha256(binary),
          version,
          help,
          durationMs: Math.round(performance.now() - started),
        });
      } catch (error) {
        checks.push({
          harness,
          status: 'failed',
          evidenceClass,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Math.round(performance.now() - started),
        });
      }
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
  const failed = checks.filter((check) => check.status === 'failed').length;
  const report = {
    schemaVersion: 1,
    suite: 'cauce-v3-host-harness-smoke',
    sourceDigest: boundSourceDigest,
    host,
    scope: 'authentic --version/--help only; no prompt, model execution, inherited auth, or session access',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    manifests: manifests.map((manifest) => ({
      alias: manifest.alias,
      harness: manifest.harness,
      path: manifest.path,
      sha256: manifest.sha256,
    })).sort((left, right) => left.alias.localeCompare(right.alias)),
    summary: { checks: checks.length, passed: checks.length - failed, failed },
    checks,
  };
  if (outputPath) {
    await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    await writeFile(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
  }
  return report;
}

function values(args, flag) {
  const found = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const value = args[index + 1];
      if (!value) throw new Error(`${flag} requires a value`);
      found.push(value);
      index += 1;
    }
  }
  return found;
}

async function main() {
  const args = process.argv.slice(2);
  const host = values(args, '--host')[0];
  const outputPath = values(args, '--out')[0];
  if (!host || !outputPath) throw new Error('--host and --out are required');
  const commands = Object.fromEntries(values(args, '--command').map((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 1) throw new Error('--command requires harness=executable');
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  const report = await runHostSmoke({
    host,
    manifestPaths: values(args, '--manifest'),
    commands,
    outputPath,
  });
  process.stdout.write(`${report.summary.failed === 0 ? 'PASS' : 'FAIL'} ${host}: ${report.summary.passed}/${report.summary.checks} harness probes\n`);
  if (report.summary.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
