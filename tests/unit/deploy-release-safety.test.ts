import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { greenGatesReceipt, releaseGateCommands, releaseGatesScript, type GatesReceipt } from './deploy-gates-fixtures.js';

const root = resolve(import.meta.dirname, '../..');
const commit = '0123456789abcdef0123456789abcdef01234567';
const tree = 'fedcba9876543210fedcba9876543210fedcba98';
const previousPin = 'registry.test/runtime@sha256:' + '1'.repeat(64);
const newPin = '@sha256:' + '2'.repeat(64);
const stamp = '20261012T000000Z';
const temporaryDirectories: string[] = [];

interface Command {
  command: string;
  args: string[];
  envFile?: string;
  instance?: string;
  maxAge?: string;
}

const mock = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const env = process.env;
const entry = { command, args, instance: fs.readFileSync(env.CAUCE_ENV_FILE, 'utf8') };
if (command === 'docker' && args[0] === 'compose') entry.envFile = args[args.indexOf('--env-file') + 1];
if (command === 'backup-monitor') entry.maxAge = env.MAX_AGE_HOURS;
fs.appendFileSync(env.MOCK_LOG, JSON.stringify(entry) + '\n');
if (command === 'id') { console.log('0'); process.exit(0); }
if (command === 'date') { console.log(env.MOCK_STAMP); process.exit(0); }
if (command === 'systemctl') process.exit(0);
if (command === 'git') {
  if (args[0] === 'rev-parse') {
    console.log(args.includes('--short') ? env.MOCK_COMMIT.slice(0, 8) : args.includes('HEAD^{tree}') ? env.MOCK_TREE : env.MOCK_COMMIT);
  }
  process.exit(['rev-parse', 'status', 'fetch'].includes(args[0]) ? 0 : 91);
}
if (command === 'backup-monitor') process.exit(Number(env.MOCK_BACKUP_AGE_HOURS) <= Number(env.MAX_AGE_HOURS) ? 0 : 1);
if (command !== 'docker') process.exit(env.MOCK_FAILURE === command ? 17 : 0);
if (args[0] === 'compose') {
  const operation = args.find(arg => ['config', 'run', 'up'].includes(arg));
  if (operation === 'config' && args.includes('--format')) {
    if (env.MOCK_REAL_COMPOSE !== '1') { process.stdout.write(env.MOCK_COMPOSE_MODEL || '{"services":{}}'); process.exit(0); }
    const rendered = spawnSync('docker', args, { encoding: 'utf8', env: { ...env, PATH: env.MOCK_REAL_PATH }, timeout: 15000 });
    fs.writeSync(1, rendered.stdout || '');
    fs.writeSync(2, rendered.stderr || '');
    process.exit(rendered.status ?? 96);
  }
  process.exit(env.MOCK_FAILURE === operation ? 19 : 0);
}
if (args[0] === 'ps') { if (env.MOCK_APPLIED !== undefined) console.log(env.MOCK_PG_CONTAINER); process.exit(0); }
if (args[0] === 'volume') process.exit(0);
if (args[0] === 'exec') { console.log(env.MOCK_APPLIED.split(',').join('\n')); process.exit(0); }
if (args[0] === 'inspect') {
  if (args[1] === '-f') console.log('true');
  else if (args[2].includes('instance-id')) console.log('0'.repeat(64));
  else console.log('registry.test/' + (args.at(-1).includes('runtime') ? 'runtime' : 'console') + env.MOCK_NEW_PIN);
  process.exit(0);
}
process.exit(['build', 'push'].includes(args[0]) ? 0 : 95);
`;

interface Options {
  receipt?: GatesReceipt | null;
  environment?: Record<string, string>;
  instance?: string;
  migrations?: string[];
  applied?: string[];
  backupAgeHours?: number;
  failure?: string;
  composeModel?: object;
  realCompose?: boolean;
}

function temporaryDirectory(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function deploy(options: Options = {}) {
  const directory = temporaryDirectory('cauce-deploy-safety-');
  const repository = join(directory, 'repo');
  const binaries = join(directory, 'bin');
  const migrations = join(repository, 'packages/store/migrations');
  for (const path of ['deploy/postgres', 'ops/scripts', 'scripts']) mkdirSync(join(repository, path), { recursive: true });
  mkdirSync(migrations, { recursive: true });
  mkdirSync(binaries);
  copyFileSync(join(root, 'deploy/deploy.sh'), join(repository, 'deploy/deploy.sh'));
  copyFileSync(releaseGatesScript, join(repository, 'scripts/release-gates.sh'));
  for (const name of ['source-digest.py', 'digest_lib.py']) copyFileSync(join(root, 'ops/scripts', name), join(repository, 'ops/scripts', name));
  for (const name of ['compose.yaml', 'compose.postgres.yaml', 'compose.fleet.yaml']) {
    copyFileSync(join(root, 'deploy', name), join(repository, 'deploy', name));
  }
  writeFileSync(join(repository, 'deploy/postgres/postgres-tls-entrypoint.sh'), '');
  for (const name of options.migrations ?? ['001_fixture.sql']) writeFileSync(join(migrations, name), '');
  for (const name of ['docker', 'git', 'id', 'date', 'systemctl', 'backup-monitor']) writeFileSync(join(binaries, name), mock, { mode: 0o700 });
  for (const name of ['refresh-observability.sh', 'smoke.sh']) writeFileSync(join(repository, 'deploy', name), mock, { mode: 0o700 });
  const instanceFile = join(directory, 'prod.env');
  const initialInstance = `COMPOSE_PROJECT_NAME=release-fixture
POSTGRES_USER=fixture
POSTGRES_DB=fixture
CAUCE_RUNTIME_IMAGE=${previousPin}
CAUCE_CONSOLE_IMAGE=${previousPin.replace('runtime', 'console')}
CAUCE_TERMINAL_ENABLED=0
${options.instance ?? ''}`;
  writeFileSync(instanceFile, initialInstance);
  const receiptFile = join(directory, 'recibo.json');
  const receipt = options.receipt === undefined ? greenGatesReceipt(commit, tree) : options.receipt;
  if (receipt) writeFileSync(receiptFile, JSON.stringify(receipt));
  const history = join(directory, 'HISTORIAL.md');
  const log = join(directory, 'commands.jsonl');
  const dockerConfig = join(directory, 'docker-config');
  mkdirSync(dockerConfig);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !name.startsWith('CAUCE_') && !name.startsWith('MOCK_') && !name.startsWith('COMPOSE_')));
  const result = spawnSync('bash', [join(repository, 'deploy/deploy.sh')], {
    cwd: directory, encoding: 'utf8', input: 'no\n', timeout: 30_000,
    env: {
      ...inherited,
      PATH: `${binaries}:${process.env.PATH ?? ''}`,
      DOCKER_CONFIG: dockerConfig,
      CAUCE_ENV_FILE: instanceFile,
      CAUCE_FASE3_CON_DUENO: 'si',
      CAUCE_DEPLOY_CONFIRMADO: 'si',
      CAUCE_DEPLOY_HISTORY_FILE: history,
      CAUCE_DEPLOY_BACKUP_STATUS_FILE: join(directory, 'backup-status.json'),
      CAUCE_DEPLOY_BACKUP_MONITOR: join(binaries, 'backup-monitor'),
      ...(receipt ? { CAUCE_DEPLOY_GATES_RECEIPT: receiptFile } : {}),
      MOCK_LOG: log,
      MOCK_STAMP: stamp,
      MOCK_COMMIT: commit,
      MOCK_TREE: tree,
      MOCK_NEW_PIN: newPin,
      MOCK_PG_CONTAINER: 'release-fixture-postgres-1',
      MOCK_BACKUP_AGE_HOURS: String(options.backupAgeHours ?? 1),
      MOCK_FAILURE: options.failure ?? '',
      MOCK_REAL_COMPOSE: options.realCompose ? '1' : '0',
      MOCK_REAL_PATH: process.env.PATH ?? '',
      ...(options.applied ? { MOCK_APPLIED: options.applied.join(',') } : {}),
      ...(options.composeModel ? { MOCK_COMPOSE_MODEL: JSON.stringify(options.composeModel) } : {}),
      ...options.environment,
    },
  });
  const commands = (): Command[] => existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Command)
    : [];
  return {
    ...result, directory, receiptFile, history, initialInstance, commands,
    instance: () => readFileSync(instanceFile, 'utf8'),
    leftovers: () => readdirSync(directory).filter(name => name.startsWith('prod.env.')),
    built: () => commands().some(entry => entry.command === 'docker' && entry.args[0] === 'build'),
    composeRuns: (operation: string) => commands().filter(entry =>
      entry.command === 'docker' && entry.args[0] === 'compose' && entry.args.includes(operation)),
  };
}

function single<T>(items: T[]): T {
  const [first, ...rest] = items;
  if (first === undefined || rest.length > 0) throw new Error(`expected exactly one item, got ${String(items.length)}`);
  return first;
}

function gate(receipt: GatesReceipt, index: number): GatesReceipt['comandos'][number] {
  const command = receipt.comandos[index];
  if (!command) throw new Error(`missing gate ${String(index)}`);
  return command;
}

function expectStoppedBeforeBuild(result: ReturnType<typeof deploy>, reason: string) {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain(reason);
  expect(result.built()).toBe(false);
  expect(result.instance()).toBe(result.initialInstance);
  expect(result.leftovers()).toEqual([]);
  expect(existsSync(result.history)).toBe(false);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('deploy gates receipt', () => {
  it('refuses to build without a gates receipt', () => {
    expectStoppedBeforeBuild(deploy({ receipt: null }), 'falta el recibo de gates');
  });

  it('refuses a receipt of another commit', () => {
    const result = deploy({ receipt: greenGatesReceipt('f'.repeat(40), tree) });
    expectStoppedBeforeBuild(result, `no acredita un gate verde de ${commit}`);
    expect(result.stderr).toContain(`commit del recibo ${'f'.repeat(40)} != HEAD ${commit}`);
  });

  it.each([
    ['a red gate', (receipt: GatesReceipt) => { gate(receipt, 1).exit = 1; }, 'pnpm lint: exit 1'],
    ['a boolean exit', (receipt: GatesReceipt) => { gate(receipt, 0).exit = false; }, 'exit False'],
    ['a missing gate', (receipt: GatesReceipt) => { receipt.comandos.pop(); }, 'no son los de scripts/release-gates.sh --list'],
    ['another tree', (receipt: GatesReceipt) => { receipt.tree = '0'.repeat(40); }, 'tree del recibo'],
    ['an invalid log hash', (receipt: GatesReceipt) => { gate(receipt, 2).log_sha256 = 'x'; }, 'log_sha256 invalido'],
  ])('refuses a receipt with %s', (_case, mutate, reason) => {
    const receipt = greenGatesReceipt(commit, tree);
    mutate(receipt);
    const result = deploy({ receipt });
    expectStoppedBeforeBuild(result, 'no acredita un gate verde');
    expect(result.stderr).toContain(reason);
  });

  it('accepts a green receipt of HEAD and records its sha256 in the history', () => {
    const result = deploy();
    expect(result.status, result.stderr).toBe(0);
    const digest = createHash('sha256').update(readFileSync(result.receiptFile)).digest('hex');
    expect(readFileSync(result.history, 'utf8')).toContain(`smoke OK; recibo de gates sha256:${digest} |`);
  });

  it('records the audited escape in the history', () => {
    const result = deploy({ receipt: null, environment: { CAUCE_DEPLOY_SIN_RECIBO: 'hotfix de humo con gates en curso' } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('SIN recibo de gates');
    expect(readFileSync(result.history, 'utf8')).toContain('smoke OK; SIN RECIBO DE GATES: hotfix de humo con gates en curso |');
  });

  it.each(['rompe | la tabla', 'dos\nlineas', '   '])('refuses an escape reason that the history cannot hold (%j)', reason => {
    expectStoppedBeforeBuild(deploy({ receipt: null, environment: { CAUCE_DEPLOY_SIN_RECIBO: reason } }),
      'CAUCE_DEPLOY_SIN_RECIBO debe ser un motivo');
  });

  it('refuses an escape next to a receipt', () => {
    expectStoppedBeforeBuild(deploy({ environment: { CAUCE_DEPLOY_SIN_RECIBO: 'motivo cualquiera' } }), 'son excluyentes');
  });
});

describe('deploy bind sources', () => {
  it('stops before the build when a bind or secret source is missing', () => {
    const present = temporaryDirectory('cauce-bind-present-');
    const result = deploy({
      composeModel: {
        services: {
          gateway: {
            volumes: [
              { type: 'bind', source: present, target: '/present' },
              { type: 'bind', source: '/nonexistent/context-broker/repository', target: '/contexts', bind: { create_host_path: false } },
              { type: 'volume', source: 'blobs_data', target: '/blobs' },
            ],
          },
        },
        secrets: { database_url: { file: '/nonexistent/database-url' }, unused: { file: present } },
      },
    });
    expectStoppedBeforeBuild(result, 'faltan fuentes de bind mounts del compose');
    expect(result.stderr).toContain('gateway: /nonexistent/context-broker/repository');
    expect(result.stderr).toContain('secrets.database_url: /nonexistent/database-url');
    expect(result.stderr).not.toContain(present);
  });

  function realComposeEnvironment(contexts: string) {
    const fixture = temporaryDirectory('cauce-bind-real-');
    const file = (name: string) => { writeFileSync(join(fixture, name), ''); return join(fixture, name); };
    mkdirSync(join(fixture, 'identities'));
    writeFileSync(join(fixture, 'writer-snapshot.json.state.json'), '');
    return {
      CAUCE_AUTH_PROVIDER: 'password',
      CAUCE_CONSOLE_ORIGINS: 'https://console.example.test',
      CAUCE_CONSOLE_GATEWAY_CLIENT_CERT_PATH: file('console-client.crt'),
      CAUCE_CONSOLE_GATEWAY_CLIENT_KEY_PATH: file('console-client.key'),
      CAUCE_CONSOLE_TLS_CA_PATH: file('console-ca.crt'),
      CAUCE_CONSOLE_TLS_CERT_PATH: file('console.crt'),
      CAUCE_CONSOLE_TLS_KEY_PATH: file('console.key'),
      CAUCE_DATABASE_URL_SECRET_PATH: file('database-url'),
      CAUCE_GATEWAY_IDENTITY_DIR: join(fixture, 'identities'),
      CAUCE_GATEWAY_TLS_CA_PATH: file('gateway-ca.crt'),
      CAUCE_GATEWAY_TLS_CERT_PATH: file('gateway.crt'),
      CAUCE_GATEWAY_TLS_KEY_PATH: file('gateway.key'),
      CAUCE_POSTGRES_CA_PATH: file('postgres-ca.crt'),
      CAUCE_POSTGRES_PASSWORD_PATH: file('postgres-password'),
      CAUCE_POSTGRES_SERVER_CERT_PATH: file('postgres.crt'),
      CAUCE_POSTGRES_SERVER_KEY_PATH: file('postgres.key'),
      CAUCE_POSTGRES_IMAGE: 'registry.test/postgres@sha256:' + '1'.repeat(64),
      CAUCE_OTEL_IMAGE: 'registry.test/otel:fixture',
      CAUCE_PROMETHEUS_IMAGE: 'registry.test/prometheus:fixture',
      CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE: join(fixture, 'writer-snapshot.json'),
      CAUCE_CONTEXT_REPOSITORY_DIRECTORY: join(contexts, 'repository'),
      CAUCE_CONTEXT_GIT_KEY_DIRECTORY: join(contexts, 'ssh'),
    };
  }

  it('finds the missing context broker and fleet overlay sources in the real compose', () => {
    const contexts = temporaryDirectory('cauce-contexts-');
    const result = deploy({
      realCompose: true, instance: 'CAUCE_DEPLOY_FLEET_OVERLAY=1\n', environment: realComposeEnvironment(contexts),
    });
    expectStoppedBeforeBuild(result, 'faltan fuentes de bind mounts del compose');
    expect(result.stderr).toContain(`gateway: ${join(contexts, 'repository')}`);
    expect(result.stderr).toContain(`gateway: ${join(contexts, 'ssh')}`);
    for (const source of ['/etc/cauce-v3/fleet-v35/gateway', '/etc/cauce-v3/fleet-v35/registry-fleet', '/run/cauce-fleet-v35/auth']) {
      expect(result.stderr.includes(`gateway: ${source}\n`)).toBe(!existsSync(source));
    }
  });

  it('accepts the real compose when every bind source exists', () => {
    const contexts = temporaryDirectory('cauce-contexts-');
    mkdirSync(join(contexts, 'repository'));
    mkdirSync(join(contexts, 'ssh'));
    const result = deploy({ realCompose: true, environment: realComposeEnvironment(contexts) });
    expect(result.status, result.stderr).toBe(0);
    expect(result.built()).toBe(true);
  });
});

describe('deploy pins and migrator', () => {
  it('leaves prod.env untouched when the migrator fails', () => {
    const result = deploy({ failure: 'run' });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('migracion fallida');
    expect(result.stderr).toContain('no hay pins que restaurar');
    expect(result.instance()).toBe(result.initialInstance);
    expect(result.leftovers()).toEqual([]);
    expect(result.composeRuns('up')).toEqual([]);
    const migrator = single(result.composeRuns('run'));
    expect(migrator.envFile).toBe(join(result.directory, `prod.env.candidate-${stamp}`));
    expect(migrator.instance).toBe(result.initialInstance);
    expect(existsSync(result.history)).toBe(false);
  });

  it('writes the new pins only after the migrator succeeds and keeps the rollback snapshot', () => {
    const result = deploy({ failure: 'up' });
    expect(result.status, result.stderr).toBe(1);
    expect(single(result.composeRuns('run')).instance).toBe(result.initialInstance);
    const up = single(result.composeRuns('up'));
    expect(up.envFile).toBe(join(result.directory, 'prod.env'));
    expect(up.instance).toContain(`CAUCE_RUNTIME_IMAGE=registry.test/runtime${newPin}\n`);
    expect(up.instance).toContain(`CAUCE_CONSOLE_IMAGE=registry.test/console${newPin}\n`);
    expect(result.leftovers()).toEqual([`prod.env.pre-deploy-${stamp}`]);
    expect(readFileSync(join(result.directory, `prod.env.pre-deploy-${stamp}`), 'utf8')).toBe(result.initialInstance);
  });

  it('refuses ambient pins that would override the instance file', () => {
    expectStoppedBeforeBuild(deploy({ environment: { CAUCE_RUNTIME_IMAGE: previousPin } }), 'CAUCE_RUNTIME_IMAGE del entorno anularia el pin');
  });
});

describe('deploy backup window for pending migrations', () => {
  const migrations = ['001_fixture.sql', '002_fixture.sql'];

  it('aborts with pending migrations and a 3 h old backup even when confirmed', () => {
    const result = deploy({ migrations, applied: ['001_fixture.sql'], backupAgeHours: 3 });
    expectStoppedBeforeBuild(result, 'hay 1 migraciones pendientes');
    expect(result.stdout).toContain('se exige backup verificado de 2 h o menos');
    expect(result.commands().filter(entry => entry.command === 'backup-monitor').map(entry => entry.maxAge)).toEqual(['2']);
  });

  it('deploys pending migrations with a 1 h old backup checked again before migrating', () => {
    const result = deploy({ migrations, applied: ['001_fixture.sql'], backupAgeHours: 1 });
    expect(result.status, result.stderr).toBe(0);
    const monitor = result.commands().filter(entry => entry.command === 'backup-monitor');
    expect(monitor.map(entry => entry.maxAge)).toEqual(['2', '2']);
    const order = result.commands().map(entry => entry.command === 'backup-monitor' ? 'monitor' : entry.args[0] === 'build' ? 'build'
      : entry.args.includes('run') ? 'migrator' : '');
    expect(order.filter(Boolean)).toEqual(['monitor', 'build', 'build', 'monitor', 'migrator']);
  });

  it('keeps the configured window when every bundled migration is applied', () => {
    const result = deploy({ migrations, applied: migrations, backupAgeHours: 3 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands().filter(entry => entry.command === 'backup-monitor').map(entry => entry.maxAge)).toEqual(['24']);
  });
});

describe('release gates receipt', () => {
  const pnpm = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const gate = process.argv[2];
fs.appendFileSync(process.env.MOCK_PNPM_LOG, gate + '\n');
console.log('ran ' + gate);
process.exit(gate === process.env.MOCK_RED_GATE ? 3 : 0);
`;

  function repositoryWithGates() {
    const directory = temporaryDirectory('cauce-release-gates-');
    const repository = join(directory, 'repo');
    const binaries = join(directory, 'bin');
    mkdirSync(join(repository, 'scripts'), { recursive: true });
    mkdirSync(binaries);
    copyFileSync(releaseGatesScript, join(repository, 'scripts/release-gates.sh'));
    for (const name of ['pnpm', 'shellcheck', 'ruff']) writeFileSync(join(binaries, name), pnpm, { mode: 0o700 });
    const environment = {
      ...process.env,
      PATH: `${binaries}:${process.env.PATH ?? ''}`,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      CAUCE_RELEASE_GATES_DIR: join(directory, 'receipts'),
      MOCK_PNPM_LOG: join(directory, 'pnpm.log'),
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
    const run = (extra: Record<string, string> = {}) => spawnSync('bash', [join(repository, 'scripts/release-gates.sh')], {
      cwd: repository, encoding: 'utf8', env: { ...environment, ...extra }, timeout: 30_000,
    });
    const receipts = () => existsSync(join(directory, 'receipts')) ? readdirSync(join(directory, 'receipts')) : [];
    return { directory, repository, git, run, receipts, pnpmLog: () => readFileSync(environment.MOCK_PNPM_LOG, 'utf8') };
  }

  it('lists only gates that exist in package.json, in order', () => {
    const scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    const commands = releaseGateCommands();
    expect(commands[0]).toBe('pnpm typecheck');
    for (const command of commands) expect(scripts[command.replace(/^pnpm /, '')], command).toBeDefined();
  });

  it('writes a green receipt bound to HEAD that deploy accepts', () => {
    const gates = repositoryWithGates();
    const result = gates.run();
    expect(result.status, result.stderr).toBe(0);
    const run = single(gates.receipts());
    const head = gates.git('rev-parse', 'HEAD');
    expect(run.startsWith(`${head}-`)).toBe(true);
    const receipt = JSON.parse(readFileSync(join(gates.directory, 'receipts', run, 'recibo.json'), 'utf8')) as GatesReceipt;
    expect(receipt.commit).toBe(head);
    expect(receipt.tree).toBe(gates.git('rev-parse', 'HEAD^{tree}'));
    expect(receipt.comandos.map(command => command.cmd)).toEqual(releaseGateCommands());
    for (const command of receipt.comandos) {
      expect(command.exit).toBe(0);
      const log = readFileSync(join(gates.directory, 'receipts', run, command.log));
      expect(command.log_sha256).toBe(createHash('sha256').update(log).digest('hex'));
    }
    expect(receipt.inicio <= receipt.fin).toBe(true);
    const accepted = deploy({ receipt, environment: { MOCK_COMMIT: receipt.commit, MOCK_TREE: receipt.tree } });
    expect(accepted.status, accepted.stderr).toBe(0);
  });

  it('stops at the first red gate and writes a red receipt that deploy refuses', () => {
    const gates = repositoryWithGates();
    const result = gates.run({ MOCK_RED_GATE: 'lint' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ROJO en pnpm lint');
    expect(gates.pnpmLog()).toBe('typecheck\nlint\n');
    const run = single(gates.receipts());
    const receipt = JSON.parse(readFileSync(join(gates.directory, 'receipts', run, 'recibo.json'), 'utf8')) as GatesReceipt;
    expect(receipt.comandos.map(command => [command.cmd, command.exit])).toEqual([['pnpm typecheck', 0], ['pnpm lint', 3]]);
    const refused = deploy({ receipt, environment: { MOCK_COMMIT: receipt.commit, MOCK_TREE: receipt.tree } });
    expectStoppedBeforeBuild(refused, 'pnpm lint: exit 3');
  });

  it('refuses a dirty tree without running any gate', () => {
    const gates = repositoryWithGates();
    writeFileSync(join(gates.repository, 'untracked.txt'), 'dirty\n');
    const result = gates.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('el arbol no esta limpio');
    expect(gates.receipts()).toEqual([]);
    expect(existsSync(join(gates.directory, 'pnpm.log'))).toBe(false);
  });
});
