#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const confirmation = 'metadata-only';
const inheritedEnvironment = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE'];
const maxOutputBytes = 128 * 1024;
const commandTimeoutMs = 8_000;

function cleanText(value) {
  return String(value)
    .split(String.fromCharCode(27)).join('')
    .replace(/\b(?:authorization|cookie|password|secret|token)\b\s*[:=]\s*\S+/giu, '[redacted]')
    .trim();
}

async function executableCandidates() {
  const candidates = [];
  const seen = new Set();
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (directory.length === 0 || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, 'opencode');
    try {
      await access(candidate, fsConstants.X_OK);
      const resolved = await realpath(candidate);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        candidates.push({ candidate, resolved });
      }
    } catch {
      continue;
    }
  }
  return candidates;
}

function safeEnvironment(root) {
  const inherited = Object.fromEntries(inheritedEnvironment.flatMap((key) => (
    process.env[key] === undefined ? [] : [[key, process.env[key]]]
  )));
  return {
    ...inherited,
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_RUNTIME_DIR: path.join(root, 'runtime'),
    CI: '1',
    NO_COLOR: '1',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    TERM: 'dumb',
  };
}

function runMetadataCommand(executable, args, root, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      detached: process.platform !== 'win32',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    const append = (current, chunk) => Buffer.concat([current, chunk]).subarray(0, maxOutputBytes);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid === undefined) return;
      try {
        process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') reject(error);
      }
    }, commandTimeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut,
        stdout: cleanText(stdout.toString('utf8')),
        stderr: cleanText(stderr.toString('utf8')),
      });
    });
  });
}

export async function runOpenCodeCliSmoke() {
  const candidates = await executableCandidates();
  assert.ok(candidates.length > 0, 'OpenCode CLI is not executable on PATH');
  const selected = candidates[0];
  assert.ok(selected !== undefined);
  const root = await mkdtemp(path.join(os.tmpdir(), 'cauce-opencode-cli-smoke-'));
  try {
    await Promise.all(['home', 'config', 'cache', 'data', 'state', 'runtime'].map((directory) => (
      mkdir(path.join(root, directory), { recursive: true, mode: 0o700 })
    )));
    const env = safeEnvironment(root);
    const versionResult = await runMetadataCommand(selected.resolved, ['--version'], root, env);
    assert.equal(versionResult.timedOut, false, 'OpenCode --version timed out');
    assert.equal(versionResult.code, 0, `OpenCode --version failed: ${versionResult.stderr}`);
    assert.equal(versionResult.signal, null);
    const versionText = `${versionResult.stdout}\n${versionResult.stderr}`;
    const version = /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/u.exec(versionText)?.[0];
    assert.ok(version !== undefined, 'OpenCode --version did not expose a semantic version');

    const helpResult = await runMetadataCommand(selected.resolved, ['run', '--help'], root, env);
    assert.equal(helpResult.timedOut, false, 'OpenCode run --help timed out');
    assert.equal(helpResult.code, 0, `OpenCode run --help failed: ${helpResult.stderr}`);
    assert.equal(helpResult.signal, null);
    assert.match(`${helpResult.stdout}\n${helpResult.stderr}`, /(?:Usage:|opencode run)/iu);

    return {
      evidenceClass: 'opencode-cli-metadata-smoke',
      scope: 'installation-and-command-surface-only',
      executable: selected.candidate,
      resolvedExecutable: selected.resolved,
      detectedExecutables: candidates.length,
      version,
      checks: ['--version', 'run --help'],
      isolatedHome: true,
      inheritedCredentialVariables: false,
      authenticated: false,
      modelInvocation: false,
      promptExecuted: false,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (process.env.CAUCE_OPENCODE_CLI_SMOKE !== confirmation) {
    console.error(`CAUCE_OPENCODE_CLI_SMOKE must be ${confirmation}; no CLI command was executed`);
    process.exitCode = 2;
  } else {
    try {
      const result = await runOpenCodeCliSmoke();
      console.log(`PASS ${JSON.stringify(result)}`);
    } catch (error) {
      console.error(`FAIL ${cleanText(error instanceof Error ? error.message : error)}`);
      process.exitCode = 1;
    }
  }
}
