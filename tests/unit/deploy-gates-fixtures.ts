import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';

export const releaseGatesScript = resolve(import.meta.dirname, '../../scripts/release-gates.sh');

export interface GateUnit {
  exit: unknown;
  log_sha256: string;
  duracion: number;
  log: string;
  carril?: number;
  inicio?: string;
  interrumpido?: boolean;
}

export interface GateCommand extends GateUnit {
  cmd: string;
  trozos?: (GateUnit & { trozo: string })[];
  fusion?: GateUnit | null;
  sin_fusion?: boolean;
}

export interface CoverageRow {
  estado: string;
  base: number;
  medido: number;
}

export interface GatesReceipt {
  commit: string;
  tree: string;
  comandos: GateCommand[];
  inicio: string;
  fin: string;
  concurrencia?: number;
  carriles?: number;
  trozos?: number;
  fallo_rapido?: boolean;
  carriles_sucios?: string[];
  cobertura?: { paquetes: Record<string, CoverageRow>; lineas_fusionadas_pct: number | null } | null;
}

export interface TimelineEvent {
  event: 'start' | 'end';
  gate: string;
  unit: string;
  cwd: string;
  pid: number;
  at: number;
  paso: string;
  trozo: string | null;
  dir: string | null;
}

export function releaseGateCommands(): string[] {
  const listed = spawnSync('bash', [releaseGatesScript, '--list'], { encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`release-gates --list failed: ${listed.stderr}`);
  return listed.stdout.trim().split('\n');
}

export function greenGatesReceipt(commit: string, tree: string): GatesReceipt {
  return {
    commit,
    tree,
    comandos: releaseGateCommands().map((cmd, index) => ({
      cmd, exit: 0, log_sha256: 'a'.repeat(64), duracion: index, log: `${String(index + 1)}.log`,
    })),
    inicio: '2026-10-12T00:00:00Z',
    fin: '2026-10-12T01:00:00Z',
  };
}

/* Every gate is a fake pnpm: it logs, can pause, go red or dirty its checkout, and prints the
   ratchet table that the receipt parses for coverage:ratchet. A unit is the gate, gate#i for shard i
   or gate#fusion; MOCK_* selectors match the unit or the plain gate. It can also leave a process
   outside its group and a container labelled with its step token, as real suites do. */
const fakePnpm = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const env = process.env;
const gate = process.argv[2];
const shard = env.CAUCE_TEST_SHARD ? env.CAUCE_TEST_SHARD.split('/')[0] : null;
const unit = gate + (shard ? '#' + shard : env.CAUCE_TEST_SHARD_MERGE ? '#fusion' : '');
const selected = (names) => (names || '').split(',').some((name) => name === unit || name === gate);
const mark = (event) => env.MOCK_TIMELINE && fs.appendFileSync(env.MOCK_TIMELINE, JSON.stringify({
  event, gate, unit, cwd: process.cwd(), pid: process.pid, at: Date.now(), paso: env.CAUCE_RELEASE_GATES_PASO || '',
  trozo: env.CAUCE_TEST_SHARD || null, dir: env.CAUCE_TEST_SHARD_DIR || null,
}) + '\n');
fs.appendFileSync(env.MOCK_PNPM_LOG, unit + '\n');
mark('start');
if (selected(env.MOCK_DIRTY_GATE)) fs.writeFileSync('dirty-by-gate.txt', gate);
if (gate !== 'install') {
  fs.mkdirSync('ops/artifacts', { recursive: true });
  fs.writeFileSync('ops/artifacts/' + unit.replace(':', '-').replace('#', '-') + '.txt', gate);
}
if (selected(env.MOCK_ESCAPE_GATES)) {
  const escaped = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { detached: true, stdio: 'ignore' });
  escaped.unref();
  fs.appendFileSync(env.MOCK_ESCAPED_LOG, JSON.stringify({ unit, pid: escaped.pid }) + '\n');
}
if (selected(env.MOCK_CONTAINER_GATES)) fs.writeFileSync(env.MOCK_DOCKER_DIR + '/cid-' + env.CAUCE_RELEASE_GATES_PASO, unit);
if (gate === 'coverage:ratchet' && !shard) {
  console.log('  CIFRA FUSIONADA  lineas 97210/102869 = 94.50%   ramas 88.98%');
  console.log('\ntrinquete de cobertura (lineas por paquete, base scripts/cobertura-base.json):');
  console.log('  console/src                      SUBE    base 94.69%  medido 95.41%  +0.72');
  console.log('  services/gateway/src             SUBE    base 92.07%  medido 94.12%  +2.05');
  console.log('  VERDE: ningun paquete cae mas de 0.20 puntos');
}
console.log('ran ' + unit);
const pauses = JSON.parse(env.MOCK_GATE_PAUSE_MS || '{}');
const pause = pauses[unit] ?? (env.CAUCE_TEST_SHARD_MERGE ? 0 : pauses[gate]) ?? 0;
setTimeout(() => { mark('end'); process.exit(selected(env.MOCK_RED_GATE) ? 3 : 0); }, pause);
`;

/* A container is a file named cid-<step token>: ps answers the one whose label it is asked for, rm deletes it. */
const fakeDocker = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_DOCKER_LOG, JSON.stringify(args) + '\n');
if (args[0] === 'ps') {
  const token = (args[args.indexOf('--filter') + 1] || '').replace(/^label=io\.cauce\.gate\.paso=/, '');
  if (fs.existsSync(process.env.MOCK_DOCKER_DIR + '/cid-' + token)) console.log('cid-' + token);
}
if (args[0] === 'rm') for (const id of args.slice(2)) fs.rmSync(process.env.MOCK_DOCKER_DIR + '/' + id, { force: true });
`;

const fakePython = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const pytest = args[0] === '-m' && args[1] === 'pytest'
  && args.includes('ops/tests/test_fleet_orphan_sweep.py')
  && args.includes('ops/tests/test_fleet_executor_container.py');
if (pytest) {
  fs.appendFileSync(process.env.MOCK_PNPM_LOG, 'orphan\n');
  process.exit(process.env.MOCK_RED_GATE === 'orphan' ? 3 : 0);
}
const result = spawnSync('/usr/bin/python3', args, { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
`;

/** A committed fixture repository whose gates are fakes, plus the receipts and lanes it produces. */
export function gatesRepository(directory: string) {
  const repository = join(directory, 'repo');
  const binaries = join(directory, 'bin');
  const lanes = join(directory, 'lanes');
  mkdirSync(join(repository, 'scripts'), { recursive: true });
  mkdirSync(binaries);
  copyFileSync(releaseGatesScript, join(repository, 'scripts/release-gates.sh'));
  writeFileSync(join(repository, '.gitignore'), 'ops/artifacts/\n');
  for (const name of ['pnpm', 'shellcheck', 'ruff']) writeFileSync(join(binaries, name), fakePnpm, { mode: 0o700 });
  writeFileSync(join(binaries, 'python3'), fakePython, { mode: 0o700 });
  writeFileSync(join(binaries, 'docker'), fakeDocker, { mode: 0o700 });
  mkdirSync(join(directory, 'docker'));
  // The release gate that runs this suite exports its own knobs; the scripted gate under test must not inherit them.
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !name.startsWith('CAUCE_RELEASE_GATES_') && !name.startsWith('CAUCE_CARRIL_EXCLUSIVO_')
      && !name.startsWith('CAUCE_ARRANQUES_POSTGRES_')));
  const environment = {
    ...inherited,
    PATH: `${binaries}:${process.env.PATH ?? ''}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    CAUCE_RELEASE_GATES_DIR: join(directory, 'receipts'),
    CAUCE_RELEASE_GATES_LANES_DIR: lanes,
    MOCK_PNPM_LOG: join(directory, 'pnpm.log'),
    MOCK_TIMELINE: join(directory, 'timeline.jsonl'),
    MOCK_ESCAPED_LOG: join(directory, 'escaped.jsonl'),
    MOCK_DOCKER_LOG: join(directory, 'docker.jsonl'),
    MOCK_DOCKER_DIR: join(directory, 'docker'),
  };
  const git = (...args: string[]) => {
    const output = spawnSync('git', ['-c', 'user.email=gates@example.test', '-c', 'user.name=gates', ...args], {
      cwd: repository, encoding: 'utf8', env: environment,
    });
    expect(output.status, output.stderr).toBe(0);
    return output.stdout.trim();
  };
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const script = join(repository, 'scripts/release-gates.sh');
  const run = (extra: Record<string, string> = {}, args: string[] = []) => spawnSync('bash', [script, ...args], {
    cwd: repository, encoding: 'utf8', env: { ...environment, ...extra }, timeout: 30_000,
  });
  const start = (extra: Record<string, string> = {}) => spawn('bash', [script], {
    cwd: repository, env: { ...environment, ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const receipts = () => existsSync(environment.CAUCE_RELEASE_GATES_DIR) ? readdirSync(environment.CAUCE_RELEASE_GATES_DIR) : [];
  const receipt = (run: string) => JSON.parse(
    readFileSync(join(environment.CAUCE_RELEASE_GATES_DIR, run, 'recibo.json'), 'utf8')) as GatesReceipt;
  const timeline = () => existsSync(environment.MOCK_TIMELINE)
    ? readFileSync(environment.MOCK_TIMELINE, 'utf8').trim().split('\n').map(line => JSON.parse(line) as TimelineEvent)
    : [];
  const pnpmLog = () => readFileSync(environment.MOCK_PNPM_LOG, 'utf8');
  const lines = (file: string) => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
  const escaped = () => lines(environment.MOCK_ESCAPED_LOG).map(line => JSON.parse(line) as { unit: string; pid: number });
  const dockerCalls = () => lines(environment.MOCK_DOCKER_LOG).map(line => JSON.parse(line) as string[]);
  const containers = () => readdirSync(environment.MOCK_DOCKER_DIR);
  return { directory, repository, lanes, git, run, start, receipts, receipt, timeline, pnpmLog, escaped, dockerCalls, containers };
}
