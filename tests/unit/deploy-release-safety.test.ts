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
if (command === 'stat') {
  const target = args.at(-1) ?? '';
  if (target === (env.CAUCE_DEPLOY_FLEET_GATEWAY_DIR || '/etc/cauce-v3/fleet-v35/gateway')) { console.log(env.MOCK_GATEWAY_STAT || '0 755'); process.exit(0); }
  if (target === (env.CAUCE_DEPLOY_FLEET_ENCLAVE_DIR || '/run/cauce-fleet-signed-authority')) { console.log(env.MOCK_ENCLAVE_STAT || '0 0 755'); process.exit(0); }
  console.log(env.MOCK_FILE_STAT || '0 644');
  process.exit(0);
}
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
    if (env.MOCK_REAL_COMPOSE !== '1') {
      const volumes = args.some(arg => arg.endsWith('compose.fleet.yaml')) ? [
        { type: 'bind', source: env.CAUCE_DEPLOY_FLEET_GATEWAY_DIR || '/etc/cauce-v3/fleet-v35/gateway', target: '/run/cauce-fleet/config' },
        { type: 'bind', source: env.CAUCE_DEPLOY_FLEET_ENCLAVE_DIR || '/run/cauce-fleet-signed-authority', target: '/run/cauce-fleet-signed-authority' },
      ] : [];
      process.stdout.write(env.MOCK_COMPOSE_MODEL || JSON.stringify({ services: { gateway: { volumes } } }));
      process.exit(0);
    }
    const rendered = spawnSync('docker', args, { encoding: 'utf8', env: { ...env, PATH: env.MOCK_REAL_PATH }, timeout: 15000 });
    fs.writeSync(1, rendered.stdout || '');
    fs.writeSync(2, rendered.stderr || '');
    process.exit(rendered.status ?? 96);
  }
  if (operation === 'run') fs.writeFileSync(env.MOCK_LOG + '.migrator', '');
  process.exit(env.MOCK_FAILURE === operation ? 19 : 0);
}
if (args[0] === 'ps') { if (env.MOCK_APPLIED !== undefined) console.log(env.MOCK_PG_CONTAINER); process.exit(0); }
if (args[0] === 'volume') process.exit(0);
if (args[0] === 'exec') {
  const sql = args.join(' ');
  if (sql.includes('pg_terminate_backend')) process.exit(0);
  if (sql.includes('pg_stat_activity')) { if (env.MOCK_SESSIONS) console.log(env.MOCK_SESSIONS); process.exit(0); }
  const applied = fs.existsSync(env.MOCK_LOG + '.migrator') && env.MOCK_APPLIED_AFTER !== undefined ? env.MOCK_APPLIED_AFTER : env.MOCK_APPLIED;
  console.log(applied.split(',').join('\n')); process.exit(0);
}
if (['stop', 'start'].includes(args[0])) process.exit(env.MOCK_FAILURE === args[0] ? 18 : 0);
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
  appliedAfter?: string[];
  backupAgeHours?: number;
  failure?: string;
  countFailure?: 'comm' | 'grep';
  composeModel?: object;
  realCompose?: boolean;
  sessions?: string;
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
  for (const name of ['docker', 'git', 'id', 'date', 'systemctl', 'backup-monitor', 'stat']) writeFileSync(join(binaries, name), mock, { mode: 0o700 });
  const countFunctions = join(directory, 'count-functions.sh');
  writeFileSync(countFunctions, String.raw`
comm() { if [ -f "$MOCK_LOG.migrator" ] && [ "$MOCK_COUNT_FAILURE" = comm ]; then echo 'simulated comm failure' >&2; return 2; fi; command comm "$@"; }
grep() { if [ -f "$MOCK_LOG.migrator" ] && [ "$MOCK_COUNT_FAILURE" = grep ]; then echo 'simulated grep failure' >&2; return 2; fi; command grep "$@"; }
`);
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
      BASH_ENV: countFunctions,
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
      MOCK_COUNT_FAILURE: options.countFailure ?? '',
      MOCK_REAL_COMPOSE: options.realCompose ? '1' : '0',
      MOCK_REAL_PATH: process.env.PATH ?? '',
      ...(options.applied ? { MOCK_APPLIED: options.applied.join(',') } : {}),
      ...(options.appliedAfter ? { MOCK_APPLIED_AFTER: options.appliedAfter.join(',') } : {}),
      ...(options.sessions ? { MOCK_SESSIONS: options.sessions } : {}),
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

  it('prints the compose recipe without a receipt because it deploys nothing', () => {
    const result = deploy({ receipt: null, environment: { CAUCE_DEPLOY_PRINT_COMPOSE: '1' } });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const repository = join(result.directory, 'repo');
    expect(result.stdout.trim()).toBe(`env CAUCE_TERMINAL_RELAY_INSTANCE_ID=${'0'.repeat(64)} CAUCE_BLOB_API_ENABLED=0 `
      + 'CAUCE_GATEWAY_RELAY_CLIENT_CERT_PATH=/dev/null CAUCE_GATEWAY_RELAY_CLIENT_KEY_PATH=/dev/null '
      + `docker compose --env-file ${join(result.directory, 'prod.env')} -f ${join(repository, 'deploy/compose.yaml')} `
      + `-f ${join(repository, 'deploy/compose.postgres.yaml')} --project-directory ${join(repository, 'deploy')}`);
    expect(result.stderr).not.toContain('recibo de gates');
    expect(result.commands().filter(entry => ['docker', 'git', 'backup-monitor'].includes(entry.command))).toEqual([]);
    expect(result.instance()).toBe(result.initialInstance);
    expect(result.leftovers()).toEqual([]);
    expect(existsSync(result.history)).toBe(false);
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
    for (const source of ['/etc/cauce-v3/fleet-v35/gateway', '/etc/cauce-v3/fleet-v35/registry-fleet',
      '/run/cauce-fleet-v35/auth', '/run/cauce-fleet-signed-authority']) {
      expect(result.stderr.includes(`gateway: ${source}\n`)).toBe(!existsSync(source));
    }
  });

  function fleetOverlayEnvironment() {
    const fixture = temporaryDirectory('cauce-fleet-modes-');
    const gateway = join(fixture, 'gateway');
    const enclave = join(fixture, 'enclave');
    mkdirSync(gateway);
    mkdirSync(enclave);
    for (const name of ['api.v1.json', 'capability.v1.json', 'api.v1.json.pre-upgrade-fixture']) {
      writeFileSync(join(gateway, name), '{}', { mode: 0o644 });
    }
    return {
      CAUCE_DEPLOY_FLEET_GATEWAY_DIR: gateway,
      CAUCE_DEPLOY_FLEET_ENCLAVE_DIR: enclave,
      MOCK_GATEWAY_STAT: '1000 700', MOCK_ENCLAVE_STAT: '0 1000 750', MOCK_FILE_STAT: '1000 600',
    };
  }

  function fleetComposeModel(gateway: string, enclave: string) {
    return { services: { gateway: { volumes: [
      { type: 'bind', source: gateway, target: '/run/cauce-fleet/config' },
      { type: 'bind', source: enclave, target: '/run/cauce-fleet-signed-authority' },
    ] } } };
  }

  it('checks the default fleet directories mounted by compose', () => {
    const gateway = '/etc/cauce-v3/fleet-v35/gateway';
    const enclave = '/run/cauce-fleet-signed-authority';
    const result = deploy({
      instance: 'CAUCE_DEPLOY_FLEET_OVERLAY=1\n',
      composeModel: { ...fleetComposeModel(gateway, enclave), configs: { probe: { file: '/nonexistent/fleet-default-path-probe' } } },
    });
    expectStoppedBeforeBuild(result, 'faltan fuentes de bind mounts del compose');
    expect(result.stdout).toContain(`flota: compruebo gateway ${gateway} (compose: ${gateway})`);
    expect(result.stdout).toContain(`flota: compruebo enclave ${enclave} (compose: ${enclave})`);
  });

  it.each(['gateway', 'enclave'] as const)('rejects a fleet %s override that differs from the compose mount', kind => {
    const mounted = fleetOverlayEnvironment();
    const environment = { ...mounted };
    const name = kind === 'gateway' ? 'CAUCE_DEPLOY_FLEET_GATEWAY_DIR' : 'CAUCE_DEPLOY_FLEET_ENCLAVE_DIR';
    const override = fleetOverlayEnvironment()[name];
    environment[name] = override;
    const result = deploy({
      instance: 'CAUCE_DEPLOY_FLEET_OVERLAY=1\n', environment,
      composeModel: fleetComposeModel(mounted.CAUCE_DEPLOY_FLEET_GATEWAY_DIR, mounted.CAUCE_DEPLOY_FLEET_ENCLAVE_DIR),
    });
    expectStoppedBeforeBuild(result, `${name}=${override} difiere del montaje de compose ${mounted[name]}`);
    expect(result.stdout).toContain(`flota: compruebo ${kind} ${override} (compose: ${mounted[name]})`);
    expect(result.commands().some(entry => entry.command === 'stat')).toBe(false);
  });

  it('accepts fleet path overrides matching the rendered compose mounts', () => {
    const environment = fleetOverlayEnvironment();
    const result = deploy({
      instance: 'CAUCE_DEPLOY_FLEET_OVERLAY=1\n', environment,
      composeModel: fleetComposeModel(environment.CAUCE_DEPLOY_FLEET_GATEWAY_DIR, environment.CAUCE_DEPLOY_FLEET_ENCLAVE_DIR),
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ['MOCK_GATEWAY_STAT', '0 755', 'debe ser uid 1000 y modo 0700'],
    ['MOCK_FILE_STAT', '0 644', 'debe ser uid 1000 y modo 0600'],
    ['MOCK_ENCLAVE_STAT', '0 0 755', 'debe ser root:1000 y modo 0750'],
  ])('aborts the overlay before the build with incorrect %s', (name, mode, reason) => {
    const result = deploy({
      instance: 'CAUCE_DEPLOY_FLEET_OVERLAY=1\n',
      environment: { ...fleetOverlayEnvironment(), [name]: mode },
    });
    expectStoppedBeforeBuild(result, reason);
  });

  it('accepts correct overlay modes and ignores upgrade backups', () => {
    const environment = fleetOverlayEnvironment();
    const result = deploy({ instance: 'CAUCE_DEPLOY_FLEET_OVERLAY=1\n', environment });
    expect(result.status, result.stderr).toBe(0);
    const inspected = result.commands().filter(entry => entry.command === 'stat').map(entry => entry.args.at(-1));
    expect(inspected).toEqual([
      environment.CAUCE_DEPLOY_FLEET_GATEWAY_DIR,
      join(environment.CAUCE_DEPLOY_FLEET_GATEWAY_DIR, 'api.v1.json'),
      join(environment.CAUCE_DEPLOY_FLEET_GATEWAY_DIR, 'capability.v1.json'),
      environment.CAUCE_DEPLOY_FLEET_ENCLAVE_DIR,
    ]);
  });

  it('refuses an overlay with a missing active configuration', () => {
    const environment = fleetOverlayEnvironment();
    const missing = join(environment.CAUCE_DEPLOY_FLEET_GATEWAY_DIR, 'capability.v1.json');
    rmSync(missing);
    expectStoppedBeforeBuild(deploy({ instance: 'CAUCE_DEPLOY_FLEET_OVERLAY=1\n', environment }),
      `falta ${missing} antes de construir`);
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
  it.each(['comm', 'grep'] as const)('preserves the failure context and previous pins when %s fails after the migrator', countFailure => {
    const result = deploy({ failure: 'run', countFailure, migrations: ['001_fixture.sql', '002_fixture.sql'],
      applied: ['001_fixture.sql'], appliedAfter: ['001_fixture.sql', '002_fixture.sql'] });
    expect(result.status, result.stderr).toBe(1);
    expect(result.composeRuns('run')).toHaveLength(1);
    expect(result.stderr).toContain('migracion fallida');
    expect(result.stderr).toContain('sigue con los pins anteriores');
    expect(result.stderr).toContain('indeterminado');
    expect(result.stderr).toContain('no pude contar migraciones pendientes tras el fallo');
    expect(result.instance()).toBe(result.initialInstance);
    expect(result.composeRuns('up')).toEqual([]);
    expect(result.leftovers()).toEqual([]);
    expect(existsSync(result.history)).toBe(false);
  });

  it('leaves prod.env untouched when the migrator fails', () => {
    const result = deploy({ failure: 'run' });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('migracion fallida');
    expect(result.stderr).toContain('no pude leer schema_migrations');
    expect(result.stderr).toContain('sigue con los pins anteriores');
    expect(result.instance()).toBe(result.initialInstance);
    expect(result.leftovers()).toEqual([]);
    expect(result.composeRuns('up')).toEqual([]);
    const migrator = single(result.composeRuns('run'));
    expect(migrator.envFile).toBe(join(result.directory, `prod.env.candidate-${stamp}`));
    expect(migrator.instance).toBe(result.initialInstance);
    expect(existsSync(result.history)).toBe(false);
  });

  it('reports all applied when the migrator fails after the last pending migration was applied', () => {
    const result = deploy({ failure: 'run', migrations: ['001_fixture.sql', '002_fixture.sql'],
      applied: ['001_fixture.sql'], appliedAfter: ['001_fixture.sql', '002_fixture.sql'] });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('todas aplicadas; repite deploy.sh para fijar pins');
    expect(result.instance()).toBe(result.initialInstance);
  });

  it('does not count historical rows as progress after a rolled back migration', () => {
    const result = deploy({ failure: 'run', migrations: ['001_fixture.sql', '002_fixture.sql'],
      applied: ['001_fixture.sql', '000_historical.sql'] });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('nada aplicado');
    expect(result.stderr).not.toContain('parcial:');
    expect(result.instance()).toBe(result.initialInstance);
  });

  it('reports only progress from this attempt after a partial migration failure', () => {
    const result = deploy({ failure: 'run', migrations: ['001_fixture.sql', '002_fixture.sql', '003_fixture.sql'],
      applied: ['001_fixture.sql', '000_historical.sql'], appliedAfter: ['002_fixture.sql', '000_historical.sql', '001_fixture.sql'] });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('parcial: aplicadas 1 de 2');
    expect(result.instance()).toBe(result.initialInstance);
  });

  it('reports nothing applied when schema_migrations is empty after a migrator failure', () => {
    const result = deploy({ failure: 'run', migrations: ['001_fixture.sql'], applied: [''] });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('nada aplicado');
    expect(result.instance()).toBe(result.initialInstance);
  });

  it.each([
    { appliedAfter: [], state: 'nada aplicado' },
    { appliedAfter: ['001_fixture.sql'], state: 'parcial: aplicadas 1 de 2' },
  ])('reports progress without a preexisting PostgreSQL container ($state)', ({ appliedAfter, state }) => {
    const result = deploy({ failure: 'run', migrations: ['001_fixture.sql', '002_fixture.sql'], appliedAfter });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(state);
    expect(result.stderr).not.toContain('aplicadas -');
    expect(result.instance()).toBe(result.initialInstance);
    expect(result.composeRuns('up')).toEqual([]);
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

describe('deploy migrator under live traffic', () => {
  const migrations = ['001_fixture.sql', '002_fixture.sql'];
  const steps = (result: ReturnType<typeof deploy>) => result.commands().flatMap((entry) => {
    if (entry.command !== 'docker') return [];
    const sql = entry.args.join(' ');
    if (entry.args[0] === 'stop' || entry.args[0] === 'start') return [`${entry.args[0]} ${entry.args.at(-1) ?? ''}`];
    if (entry.args[0] === 'exec' && sql.includes('pg_terminate_backend')) return ['terminate'];
    if (entry.args[0] === 'exec' && sql.includes('pg_stat_activity')) return ['sessions'];
    return entry.args[0] === 'compose' && entry.args.includes('run') ? ['migrator'] : [];
  });

  it('stops the dispatcher and checks open transactions only while pending migrations run', () => {
    const result = deploy({ migrations, applied: ['001_fixture.sql'] });
    expect(result.status, result.stderr).toBe(0);
    expect(steps(result)).toEqual(['stop release-fixture-dispatcher-1', 'sessions', 'migrator', 'start release-fixture-dispatcher-1']);
    const settled = deploy({ migrations, applied: migrations });
    expect(settled.status, settled.stderr).toBe(0);
    expect(steps(settled)).toEqual(['migrator']);
  });

  it('refuses to migrate behind an idle transaction, lists it without data and restarts the dispatcher', () => {
    const session = 'pid=4242 aplicacion=cauce-v3 estado=idle in transaction transaccion=31s';
    const result = deploy({ migrations, applied: ['001_fixture.sql'], sessions: session });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('no se migro nada');
    expect(result.stderr).toContain(session);
    expect(steps(result)).toEqual(['stop release-fixture-dispatcher-1', 'sessions', 'start release-fixture-dispatcher-1']);
    expect(result.instance()).toBe(result.initialInstance);
    expect(result.leftovers()).toEqual([]);
  });

  it('terminates the migrator backend when the run fails and restarts the dispatcher', () => {
    const result = deploy({ migrations, applied: ['001_fixture.sql'], failure: 'run' });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('migracion fallida');
    expect(steps(result)).toEqual(['stop release-fixture-dispatcher-1', 'sessions', 'migrator', 'terminate',
      'start release-fixture-dispatcher-1']);
    expect(result.instance()).toBe(result.initialInstance);
  });

  it('passes the migration lock timeout to the migrator and rejects a malformed one before building', () => {
    const result = deploy({ migrations, applied: ['001_fixture.sql'], environment: { CAUCE_MIGRATION_LOCK_TIMEOUT_MS: '8000' } });
    expect(result.status, result.stderr).toBe(0);
    expect(single(result.composeRuns('run')).args).toContain('CAUCE_MIGRATION_LOCK_TIMEOUT_MS=8000');
    expectStoppedBeforeBuild(deploy({ environment: { CAUCE_MIGRATION_LOCK_TIMEOUT_MS: '5s' } }), 'CAUCE_MIGRATION_LOCK_TIMEOUT_MS');
    expectStoppedBeforeBuild(deploy({ environment: { CAUCE_DEPLOY_MAX_XACT_SECONDS: '0' } }), 'CAUCE_DEPLOY_MAX_XACT_SECONDS');
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
