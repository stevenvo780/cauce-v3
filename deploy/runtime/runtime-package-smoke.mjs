#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimePackages = [
  ['protocol', '../packages/protocol/package.json'],
  ['store', '../packages/store/package.json'],
  ['adapter-sdk', '../packages/adapter-sdk/package.json'],
  ['gateway', '../services/gateway/package.json'],
  ['dispatcher', '../services/dispatcher/package.json'],
  ['telegram-bridge', '../services/telegram-bridge/package.json'],
  ['terminal-relay', '../services/terminal-relay/package.json'],
];

const runtimeModules = [
  ['protocol', '../packages/protocol/dist/index.js'],
  ['store', '../packages/store/dist/index.js'],
  ['adapter-sdk', '../packages/adapter-sdk/dist/src/index.js'],
  ['adapter CLI runtime', '../packages/adapter-sdk/dist/src/bin/shared.js'],
  ['emission MCP server', '../packages/adapter-sdk/dist/src/sdk/mcp-emission/server.js', 'createEmissionMcpServer'],
  ['gateway', '../services/gateway/dist/app.js'],
  ['fleet host', '../services/gateway/dist/fleet/main.js', 'runFleetHost'],
  ['fleet authentication host', '../services/gateway/dist/fleet/auth-main.js', 'runFleetAuthHost'],
  ['native administration', '../services/gateway/dist/console/native-admin/service.js', 'createNativeAdminService'],
  ['dispatcher', '../services/dispatcher/dist/index.js'],
  ['telegram-bridge', '../services/telegram-bridge/dist/index.js'],
  ['outbox metrics', './outbox-metrics.mjs', 'startOutboxMetrics'],
];

/**
 * Entrypoints that must be PRESENT in the image but must never be imported by this smoke test:
 * they are processes, not libraries. `terminal-relay/dist/main.js` binds two TLS listeners and
 * exits 78 under a root euid the moment it is evaluated, so importing it here would either hang
 * the release gate or fail it for reasons that have nothing to do with packaging.
 */
const runtimeEntrypoints = [
  ['terminal-relay', '../services/terminal-relay/dist/main.js'],
];

const adapterBins = [
  'cauce-mcp',
  'claude',
  'codex',
  'fake',
  'fake-harness',
  'grok',
  'hermes',
  'muse',
  'openclaw',
  'opencode',
];

const bridgePrompt = 'cauce runtime package bridge fixture';
const bridgeReplies = {
  hermes: 'hermes runtime package bridge passed',
  openclaw: 'openclaw runtime package bridge passed',
};
const harnessStartStderr = '<<cauce:harness-started>>\n';

const hermesFixture = `def run_oneshot(prompt):
    if prompt != ${JSON.stringify(bridgePrompt)}:
        raise ValueError("unexpected fixture prompt")
    return {"reply": ${JSON.stringify(bridgeReplies.hermes)}}
`;

const openClawAgentFixture = `export async function agentCliCommand(options, runtime) {
  if (options.message !== ${JSON.stringify(bridgePrompt)} || options.json !== true || options.deliver !== false) {
    throw new Error('unexpected fixture invocation');
  }
  if (runtime?.fixture !== true || process.argv.includes(options.message)) {
    throw new Error('invalid fixture runtime or prompt transport');
  }
  return { reply: ${JSON.stringify(bridgeReplies.openclaw)} };
}
`;

const openClawRuntimeFixture = 'export const defaultRuntime = { fixture: true };\n';

export function dependencyIsInstalled(require, dependency) {
  const entrypoint = dependency === '@modelcontextprotocol/sdk' ? `${dependency}/server/index.js` : dependency;
  try {
    require.resolve(entrypoint);
    return true;
  } catch (error) {
    // An import-only package can be installed and valid for ESM while exposing no
    // CommonJS resolution target. Its package boundary was still found.
    if (error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return entrypoint === dependency;
    if (error?.code === 'MODULE_NOT_FOUND') return false;
    throw error;
  }
}

async function assertRuntimeBridge(name, path) {
  try {
    await access(path, constants.R_OK | constants.X_OK);
  } catch (error) {
    throw new Error(`${name} runtime bridge is missing or not executable`, { cause: error });
  }

  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${name} runtime bridge is not a file`);
  const mode = metadata.mode & 0o777;
  if (mode !== 0o555) {
    throw new Error(`${name} runtime bridge must have mode 0555; got ${mode.toString(8).padStart(4, '0')}`);
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new Error(`${name} runtime bridge is not owned by the runtime user`);
  }
}

async function writeBridgeFixtures(directory) {
  const hermesDirectory = join(directory, 'hermes', 'hermes_cli');
  const openClawDirectory = join(directory, 'openclaw');
  await Promise.all([
    mkdir(hermesDirectory, { recursive: true }),
    mkdir(openClawDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(hermesDirectory, '__init__.py'), ''),
    writeFile(join(hermesDirectory, 'oneshot.py'), hermesFixture),
    writeFile(join(openClawDirectory, 'package.json'), '{"type":"module"}\n'),
    writeFile(join(openClawDirectory, 'agent-via-gateway-fixture.js'), openClawAgentFixture),
    writeFile(join(openClawDirectory, 'runtime-fixture.js'), openClawRuntimeFixture),
  ]);
  return {
    hermesPythonPath: join(directory, 'hermes'),
    openClawDistDirectory: openClawDirectory,
  };
}

function runBridgeFixture(name, command, expectedReply, env) {
  const result = spawnSync(command, ['--'], {
    input: bridgePrompt,
    encoding: 'utf8',
    env,
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw new Error(`${name} runtime bridge could not launch`, { cause: result.error });
  if (result.status !== 0) throw new Error(`${name} runtime bridge fixture exited with status ${String(result.status)}`);
  if (result.stderr !== harnessStartStderr) {
    throw new Error(`${name} runtime bridge fixture did not emit exactly one harness-start marker`);
  }

  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${name} runtime bridge fixture returned invalid JSON`, { cause: error });
  }
  if (envelope?.result?.reply !== expectedReply) {
    throw new Error(`${name} runtime bridge fixture returned an unexpected envelope`);
  }
}

export async function validateRuntimeBridges({
  hermesBridge = fileURLToPath(new URL('../packages/adapter-sdk/dist/bridge/hermes-stdin-bridge.py', import.meta.url)),
  openClawBridge = fileURLToPath(new URL('../packages/adapter-sdk/dist/bridge/openclaw-stdin-bridge.mjs', import.meta.url)),
} = {}) {
  await Promise.all([
    assertRuntimeBridge('Hermes', hermesBridge),
    assertRuntimeBridge('OpenClaw', openClawBridge),
  ]);

  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'cauce-runtime-bridge-smoke-'));
  try {
    const fixtures = await writeBridgeFixtures(fixtureDirectory);
    const path = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
    runBridgeFixture('Hermes', hermesBridge, bridgeReplies.hermes, {
      PATH: path,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPATH: fixtures.hermesPythonPath,
    });
    runBridgeFixture('OpenClaw', openClawBridge, bridgeReplies.openclaw, {
      PATH: path,
      CAUCE_OPENCLAW_DIST_DIR: fixtures.openClawDistDirectory,
    });
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

function runtimeCommand(command, args, input) {
  const result = spawnSync(command, args, {
    input, encoding: 'utf8', timeout: 20_000, maxBuffer: 2_097_152,
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      PYTHONDONTWRITEBYTECODE: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`runtime resource command failed: ${command} (exit ${String(result.status)})`, { cause: result.error });
  }
  return result.stdout.trim();
}

export async function validateRuntimeHarnessDescriptors({
  descriptorModule = new URL('../packages/adapter-sdk/dist/src/context/harness-descriptor.js', import.meta.url),
} = {}) {
  const { packagedHarnessDescriptor } = await import(descriptorModule);
  for (const harness of ['claude', 'codex', 'hermes', 'opencode', 'openclaw', 'grok', 'muse', 'fake']) {
    const descriptor = await packagedHarnessDescriptor(harness);
    if (descriptor.harness !== harness || descriptor.operations.execute !== 'native-execution') {
      throw new Error(`runtime harness descriptor differs: ${harness}`);
    }
  }
  console.log('runtime harness descriptors passed: 8/8');
}

export async function validateRuntimeContextBroker({
  brokerModule = new URL('../packages/store/dist/context-git.js', import.meta.url),
} = {}) {
  runtimeCommand('git', ['--version']);
  runtimeCommand('ssh', ['-V']);
  const { ContextGitBroker } = await import(brokerModule);
  const directory = await mkdtemp(join(tmpdir(), 'cauce-runtime-context-smoke-'));
  try {
    const repository = join(directory, 'repository'); const remote = join(directory, 'remote.git');
    await mkdir(repository, { mode: 0o700 });
    runtimeCommand('git', ['init', '--initial-branch=main', repository]);
    runtimeCommand('git', ['init', '--bare', '--initial-branch=main', remote]);
    runtimeCommand('git', ['-C', repository, 'remote', 'add', 'origin', remote]);
    const files = [{ path: 'context/AGENTS.md', content: 'Runtime context fixture.\n' }];
    const version = { company_id: 'runtime_fixture', tenant_id: 'Runtime', alias: 'fixture', version: 1, files,
      digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'), source: 'cli', restored_from: null,
      actor_human_id: null, actor_alias: 'fixture', created_at: '2000-01-01T00:00:00.000Z' };
    const broker = new ContextGitBroker(repository);
    const commit = await broker.commit(version);
    if (!/^[a-f0-9]{40,64}$/u.test(commit) || await broker.commit(version) !== commit) {
      throw new Error('runtime context broker commit is not idempotent');
    }
    await broker.push(commit);
    const observed = runtimeCommand('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main']);
    const content = runtimeCommand('git', ['--git-dir', remote, 'show',
      `${commit}:companies/runtime_fixture/tenants/Runtime/agents/fixture/context/AGENTS.md`]);
    if (observed !== commit || content !== files[0].content.trim()) throw new Error('runtime context push readback differs');
    console.log('runtime context broker passed: commit, idempotency, local push and readback');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function validateRuntimeSpaceBackups({
  helperDirectory = fileURLToPath(new URL('../ops/cli/', import.meta.url)),
  python = process.env.CAUCE_SPACE_BACKUP_PYTHON ?? 'python3',
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-runtime-backup-smoke-'));
  try {
    const source = join(directory, 'source'); const restored = join(directory, 'restored');
    const archive = join(directory, 'space.zip'); const content = 'Runtime backup fixture.\n';
    await mkdir(join(source, 'context'), { recursive: true, mode: 0o700 });
    await writeFile(join(source, 'context', 'AGENTS.md'), content, { mode: 0o600 });
    const identity = { company_id: 'runtime_fixture', tenant_id: 'Runtime', alias: 'fixture', runtime_key: 'runtime-fixture' };
    const identityArgs = Object.entries(identity).flatMap(([key, value]) => [`--${key.replaceAll('_', '-')}`, value]);
    const helper = join(helperDirectory, 'space_archive.py');
    const receipt = JSON.parse(runtimeCommand(python, [helper, 'backup', '--archive', archive, '--directory', source, ...identityArgs]));
    if (receipt.state !== 'backed_up' || receipt.files !== 1 || !/^[a-f0-9]{64}$/u.test(receipt.manifest_sha256)) {
      throw new Error('runtime space backup receipt differs');
    }
    const verified = JSON.parse(runtimeCommand(python, [join(helperDirectory, 'space_backup_validate.py')],
      JSON.stringify({ archive, identity, manifest_sha256: receipt.manifest_sha256 })));
    if (verified.verified !== true) throw new Error('runtime space backup manifest was not verified');
    const restore = JSON.parse(runtimeCommand(python, [helper, 'restore', '--archive', archive, '--directory', restored, ...identityArgs]));
    if (restore.state !== 'restored' || restore.manifest_sha256 !== receipt.manifest_sha256
      || await readFile(join(restored, 'context', 'AGENTS.md'), 'utf8') !== content) {
      throw new Error('runtime space restore readback differs');
    }
    console.log('runtime space backup passed: ZIP, manifest verification, restore and readback');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function validateRuntimePackage() {
  for (const [name, relativeManifest] of runtimePackages) {
    const manifestUrl = new URL(relativeManifest, import.meta.url);
    const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
    const require = createRequire(manifestUrl);

    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!dependencyIsInstalled(require, dependency)) {
        throw new Error(`${name} production dependency is unresolved: ${dependency}`);
      }
    }

    for (const dependency of Object.keys(manifest.devDependencies ?? {})) {
      if (dependencyIsInstalled(require, dependency)) {
        throw new Error(`${name} development dependency leaked into runtime: ${dependency}`);
      }
    }
  }

  for (const [name, relativeModule, requiredExport] of runtimeModules) {
    try {
      const runtimeModule = await import(new URL(relativeModule, import.meta.url));
      if (requiredExport && typeof runtimeModule[requiredExport] !== 'function') {
        throw new Error(`${name} runtime module does not export ${requiredExport}`);
      }
    } catch (error) {
      throw new Error(`${name} runtime module failed validation`, { cause: error });
    }
  }

  for (const [name, relativeEntrypoint] of runtimeEntrypoints) {
    const entrypoint = new URL(relativeEntrypoint, import.meta.url);
    try {
      await access(entrypoint, constants.R_OK);
      const metadata = await stat(entrypoint);
      if (!metadata.isFile() || metadata.size === 0) throw new Error('entrypoint is not a non-empty file');
    } catch (error) {
      throw new Error(`${name} runtime entrypoint failed validation`, { cause: error });
    }
  }

  for (const name of adapterBins) {
    const bin = new URL(`../packages/adapter-sdk/dist/src/bin/${name}.js`, import.meta.url);
    await access(bin, constants.R_OK | constants.X_OK);
    const metadata = await stat(bin);
    if (!metadata.isFile()) throw new Error(`adapter executable is not a file: ${name}`);
  }

  await validateRuntimeBridges();
  await validateRuntimeHarnessDescriptors();
  await validateRuntimeContextBroker();
  await validateRuntimeSpaceBackups();
  console.log('runtime package smoke passed');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await validateRuntimePackage();
}
