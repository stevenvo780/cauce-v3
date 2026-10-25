import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect } from 'vitest';
import { COMPUTER_RUNTIME } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import type { FleetCliFixture } from './v4-cli-flota-dinamica.host.js';
import { InstalledCliProcess, type InstalledCliResult, type InstalledCliRunOptions } from './v4-cli-flota-dinamica.install.js';

const execute = promisify(execFile);
const root = process.cwd();
export const LEGIBLE_OWNER = 'p2-cli-salida-legible-1025';
const sourceParts = ['ops/cli', 'ops/guardias', 'ops/scripts', 'ops/container-runtime', 'ops/schemas', 'ops/pty-agent',
  'services/gateway/src', 'services/terminal-relay/src', 'packages/store/src', 'packages/protocol/src',
  'packages/adapter-sdk/src', 'packages/adapter-sdk/descriptors'];
const agentFields = new Set(['harness_id', 'primary_room_id', 'host_id', 'display_name', 'enabled', 'container_name',
  'runtime_user', 'home_directory', 'state_directory', 'max_concurrent_deliveries', 'tenant_id', 'alias', 'runtime_key',
  'runtime_mode', 'systemd_user', 'primary_account_id', 'model_id', 'reasoning_effort', 'lifecycle_state', 'placement',
  'retired_at', 'purged_at']);

export interface LegibleOperation { id: string; kind: string; status: string; error?: { code?: string; step?: string } | null }
export interface LegibleInventory {
  revision: number; agents: Record<string, unknown>[]; retired_agents: Record<string, unknown>[]; operations: LegibleOperation[];
}

export async function privateReceipt(directory: string, name: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

async function hashes(directory: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await hashes(directory, name));
    else if (entry.isFile()) result[name] = createHash('sha256').update(await readFile(join(directory, name))).digest('hex');
    else throw new Error('the private CLI candidate contains a nonregular source');
  }
  return result;
}

export async function installLegibleCli(receipts: string) {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.CI !== '1'
    || process.env.DOCKER_HOST !== 'unix:///var/run/docker.sock') {
    throw new Error('run the installed CLI journey through scripts/e2e-lab.sh');
  }
  const directory = await mkdtemp(join(tmpdir(), 'cauce-cli-legible-'));
  const source = join(directory, 'source');
  const home = join(directory, 'home');
  const runtime = join(home, '.local/share/cauce-v3');
  const binDirectory = join(home, '.local/bin');
  const cwd = join(directory, 'working-directory');
  const env = { HOME: home, PATH: [binDirectory, dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    XDG_STATE_HOME: join(home, '.local/state'), PYTHONDONTWRITEBYTECODE: '1',
    CAUCE_DESTINO_AVISO_INICIAL: 'zz-canary-cli-legible', LANG: 'C.UTF-8', TERM: 'xterm-256color' };
  const close = async () => { await rm(directory, { recursive: true, force: true }); };
  try {
    for (const path of [source, home, runtime, cwd]) await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    for (const part of sourceParts) await cp(join(root, part), join(source, part), { recursive: true,
      filter: path => !path.split('/').includes('__pycache__') });
    const relay = join(runtime, 'services/terminal-relay');
    await mkdir(join(relay, 'dist'), { recursive: true });
    await writeFile(join(relay, 'package.json'), '{"type":"module"}\n', { mode: 0o600 });
    const require = createRequire(join(root, 'services/terminal-relay/package.json'));
    const websocketSource = dirname(await realpath(require.resolve('ws/package.json')));
    await cp(websocketSource, join(relay, 'node_modules/ws'), { recursive: true, dereference: true });
    await build({ entryPoints: [join(source, 'services/terminal-relay/src/session-limits.ts')], bundle: true,
      platform: 'node', format: 'esm', target: 'node22', outfile: join(relay, 'dist/session-limits.js'), logLevel: 'silent',
      alias: { '@cauce/protocol': join(source, 'packages/protocol/src/index.ts') },
      nodePaths: ['node_modules', 'packages/protocol/node_modules', 'services/terminal-relay/node_modules'].map(path => join(root, path)),
      banner: { js: 'import{createRequire as __cauceRequire}from"node:module";const require=__cauceRequire(import.meta.url);' } });
    await execute('/bin/bash', [join(source, 'ops/scripts/install-cauce-cli.sh'), binDirectory], { cwd, env, timeout: 60_000 });
    const sourceHashes = await hashes(source);
    const installedHashes = await hashes(binDirectory);
    for (const name of ['cauce', 'cauce-login', 'cauce-spaces', 'context_client.py']) {
      expect(installedHashes[name]).toBe(sourceHashes[join('ops/cli', name)]);
    }
    const revision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    await privateReceipt(receipts, '00-installed-cli', { source_kind: 'working_tree_snapshot', revision,
      immutable_release: false, installed_outside_checkout: relative(root, home).startsWith('..'),
      canonical_installer: true, runtime_kind: 'bundled_real_terminal_relay_source_and_private_ws',
      source_sha256: sourceHashes, installed_sha256: installedHashes, runtime_sha256: await hashes(runtime) });
    const bin = join(binDirectory, 'cauce');
    const start = (args: string[], options: Pick<InstalledCliRunOptions, 'timeout'> = {}) =>
      new InstalledCliProcess(bin, args, cwd, env, options.timeout);
    const run = async (args: string[], options: InstalledCliRunOptions = {}): Promise<InstalledCliResult> => {
      const child = start(args, options);
      try {
        if (options.input !== undefined) {
          if (args[0] === 'login') child.child.stdin.end(options.input);
          else { await child.waitFor('Terminal conectado'); child.write(options.input); }
        }
        if (options.detachWhen !== undefined) { await child.waitFor(options.detachWhen); child.write('\x1d'); }
        return await child.result;
      } catch (error) { await child.stop().catch(() => undefined); throw error; }
    };
    return { source, home, bin, runtime, run, start, close, sessionFile: join(env.XDG_STATE_HOME, 'cauce-v3/console-session.json') };
  } catch (error) { await close(); throw error; }
}

export function jsonResult(result: InstalledCliResult): unknown {
  if (result.code !== 0) throw new Error(`installed CLI failed with exit ${String(result.code)} (${String(result.stderr.length)} diagnostic bytes withheld)`);
  return JSON.parse(result.stdout) as unknown;
}

export function assertHumanOutput(result: InstalledCliResult, fixture: FleetCliFixture, runtimeKey: string): string {
  expect(result.code, `human CLI exit ${String(result.code)}`).toBe(0);
  const output = result.stdout + result.stderr;
  for (const privateValue of [fixture.owner.password, COMPUTER_RUNTIME.home, runtimeKey, fixture.caFile,
    fixture.computer.installRoot]) expect(output.includes(privateValue)).toBe(false);
  expect(output).not.toMatch(/ssh-(?:rsa|ed25519)|ecdsa-sha2-|SHA256:|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[a-f\d]{64}\b/iu);
  expect(() => JSON.parse(result.stdout) as unknown).toThrow();
  return result.stdout;
}

export function expectedInventory(config: Record<string, unknown>, operations: unknown, tenant: string, alias: string) {
  const select = (rows: unknown) => {
    if (!Array.isArray(rows)) throw new Error('the real config did not contain its agent inventory');
    return rows.filter((row: unknown): row is Record<string, unknown> => typeof row === 'object' && row !== null
      && !Array.isArray(row) && (row as Record<string, unknown>).tenant_id === tenant
      && (row as Record<string, unknown>).alias === alias).map(row => Object.fromEntries(Object.entries(row)
        .filter(([key]) => agentFields.has(key))));
  };
  const retired = config.retired as { agents?: unknown } | undefined;
  return { state: 'observed', tenant_id: tenant, revision: config.revision, agents: select(config.agents),
    retired_agents: select(retired?.agents ?? []), operations, history_limit: 100 };
}
