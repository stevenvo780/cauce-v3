import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const publicValues = {
  CAUCE_MCP_PUBLIC_ORIGIN: 'https://mcp.example.test',
  CAUCE_MCP_OAUTH_ISSUER: 'https://issuer.example.test',
  CAUCE_MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/keys.json',
};
const publicConfiguration = Object.entries(publicValues).map(([name, value]) => `${name}=${value}\n`).join('');
const baseEnvironment = `COMPOSE_PROJECT_NAME=overlay-fixture
POSTGRES_USER=fixture
POSTGRES_DB=fixture
CAUCE_RUNTIME_IMAGE=fixture/runtime:previous
CAUCE_CONSOLE_IMAGE=fixture/console:previous
CAUCE_TERMINAL_ENABLED=0
`;
const temporaryDirectories: string[] = [];

interface Command {
  command: string;
  args: string[];
  mcp: Record<string, string>;
  rendered?: { gateway: Record<string, string>; secrets: Record<string, { file: string }> };
}

const mock = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const log = process.env.MOCK_COMMAND_LOG;
const previous = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
let mcp = {};
if (command === 'docker' && args[0] === 'compose') {
  if (args.includes(process.env.MOCK_OVERLAY)) {
    const text = fs.readFileSync(args[args.indexOf('--env-file') + 1], 'utf8');
    for (const name of ['CAUCE_MCP_PUBLIC_ORIGIN', 'CAUCE_MCP_OAUTH_ISSUER', 'CAUCE_MCP_OAUTH_JWKS_URI']) {
      const line = text.split('\n').find(line => line.startsWith(name + '='));
      mcp[name] = process.env[name] ?? (line || '').slice(name.length + 1).replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}
fs.appendFileSync(log, JSON.stringify({ command, args, mcp }) + '\n');
if (command === 'id') { console.log('0'); process.exit(0); }
if (command === 'date') { console.log('20261004T000000Z'); process.exit(0); }
if (command === 'git') {
  if (args[0] === 'rev-parse') console.log(args.includes('--short') ? 'feade86' : 'feade86f7efa4408409c7b4285c576f4e2e38bcf');
  else if (!['status', 'fetch'].includes(args[0])) process.exit(91);
  process.exit(0);
}
if (['backup-monitor', 'refresh-observability.sh', 'smoke.sh'].includes(command)) {
  process.exit(process.env.MOCK_FAILURE === command ? 17 : 0);
}
if (command !== 'docker') process.exit(92);
if (args[0] === 'compose') {
  const operation = args.find(arg => ['config', 'run', 'up'].includes(arg));
  if (!operation) process.exit(93);
  const probe = args.includes('-');
  if (operation === 'config' && (probe || process.env.MOCK_REAL_COMPOSE === '1')) {
    const rendered = require('node:child_process').spawnSync('docker',
      probe ? args : [...args, '--format', 'json', '--no-env-resolution', '--no-path-resolution'], {
        encoding: 'utf8', input: probe ? fs.readFileSync(0, 'utf8') : undefined,
        env: { ...process.env, PATH: process.env.MOCK_REAL_PATH }, timeout: 15000,
      });
    if (rendered.error) throw rendered.error;
    if (!rendered.status && !probe) {
      const model = JSON.parse(rendered.stdout);
      const entries = [...previous, { command, args, mcp, rendered: { gateway: model.services.gateway.environment, secrets: model.secrets } }];
      fs.writeFileSync(log, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    }
    process.stdout.write(rendered.stdout);
    process.stderr.write(rendered.stderr);
    if (rendered.status || probe) process.exit(rendered.status ?? 96);
  }
  if (operation === 'config' && !probe && !process.env.CAUCE_TERMINAL_RELAY_INSTANCE_ID) {
    process.stderr.write('relay instance id required\n'); process.exit(21);
  }
  if (operation === 'config' && Object.values(mcp).some(value => !value.trim())) process.exit(18);
  if (process.env.MOCK_FAILURE === operation) process.exit(19);
  if (process.env.MOCK_FAILURE === 'pinned-config' && operation === 'config' && previous.some(entry => entry.args[0] === 'build')) process.exit(20);
  process.exit(0);
}
if (['build', 'push', 'ps'].includes(args[0]) || (args[0] === 'volume' && args[1] === 'ls')) process.exit(0);
if (args[0] === 'inspect') {
  if (args.length === 2) process.exit(1);
  if (args[2].includes('instance-id')) console.log('0'.repeat(64));
  else if (args[2].includes('RepoDigests')) console.log('fixture/' + (args.at(-1).includes('runtime') ? 'runtime' : 'console') + '@sha256:' + '1'.repeat(64));
  else process.exit(94);
  process.exit(0);
}
process.exit(95);
`;

function execute(configuration: string, options: {
  environment?: Record<string, string>;
  failure?: string;
  missingOverlay?: boolean;
  realCompose?: boolean;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cauce deploy mcp '));
  temporaryDirectories.push(directory);
  const repository = join(directory, 'repo with spaces');
  const binaries = join(directory, 'bin');
  const deployment = join(repository, 'deploy');
  const migrations = join(repository, 'packages/store/migrations');
  mkdirSync(deployment, { recursive: true });
  mkdirSync(migrations, { recursive: true });
  mkdirSync(binaries);
  copyFileSync(join(root, 'deploy/deploy.sh'), join(deployment, 'deploy.sh'));
  for (const name of ['compose.yaml', 'compose.postgres.yaml', 'compose.mcp-human.yaml']) {
    if (name === 'compose.mcp-human.yaml' && options.missingOverlay) continue;
    copyFileSync(join(root, 'deploy', name), join(deployment, name));
  }
  writeFileSync(join(migrations, '001_fixture.sql'), '');
  for (const name of ['docker', 'git', 'id', 'date', 'backup-monitor']) {
    writeFileSync(join(binaries, name), mock, { mode: 0o700 });
  }
  for (const name of ['refresh-observability.sh', 'smoke.sh']) {
    writeFileSync(join(deployment, name), mock, { mode: 0o700 });
  }
  const environmentFile = join(directory, 'instance with spaces.env');
  const history = join(directory, 'history.md');
  const log = join(directory, 'commands.jsonl');
  const dockerConfig = join(directory, 'docker-config');
  mkdirSync(dockerConfig);
  const initialEnvironment = baseEnvironment + configuration;
  writeFileSync(environmentFile, initialEnvironment);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !name.startsWith('CAUCE_') && !name.startsWith('MOCK_') && !name.startsWith('COMPOSE_')));
  const environment = {
    ...inherited,
    PATH: `${binaries}:${process.env.PATH ?? ''}`,
    CAUCE_ENV_FILE: environmentFile,
    CAUCE_FASE3_CON_DUENO: 'si',
    CAUCE_DEPLOY_CONFIRMADO: 'si',
    CAUCE_DEPLOY_HISTORY_FILE: history,
    CAUCE_DEPLOY_BACKUP_STATUS_FILE: join(directory, 'backup-status.json'),
    CAUCE_DEPLOY_BACKUP_MONITOR: join(binaries, 'backup-monitor'),
    MOCK_COMMAND_LOG: log,
    MOCK_OVERLAY: join(deployment, 'compose.mcp-human.yaml'),
    MOCK_FAILURE: options.failure ?? '',
    MOCK_REAL_COMPOSE: options.realCompose ? '1' : '0',
    MOCK_REAL_PATH: process.env.PATH ?? '',
    DOCKER_CONFIG: dockerConfig,
    ...(options.realCompose ? {
      CAUCE_AUTH_PROVIDER: 'password',
      CAUCE_CONSOLE_GATEWAY_CLIENT_CERT_PATH: '/fixture/console-client.crt',
      CAUCE_CONSOLE_GATEWAY_CLIENT_KEY_PATH: '/fixture/console-client.key',
      CAUCE_CONSOLE_ORIGINS: 'https://console.example.test',
      CAUCE_CONSOLE_TLS_CA_PATH: '/fixture/console-ca.crt',
      CAUCE_CONSOLE_TLS_CERT_PATH: '/fixture/console.crt',
      CAUCE_CONSOLE_TLS_KEY_PATH: '/fixture/console.key',
      CAUCE_DATABASE_URL_SECRET_PATH: '/fixture/database-url',
      CAUCE_GATEWAY_IDENTITY_DIR: '/fixture/identities',
      CAUCE_GATEWAY_TLS_CA_PATH: '/fixture/gateway-ca.crt',
      CAUCE_GATEWAY_TLS_CERT_PATH: '/fixture/gateway.crt',
      CAUCE_GATEWAY_TLS_KEY_PATH: '/fixture/gateway.key',
      CAUCE_MEDIA_RUNTIME_DIR: '/fixture/media',
      CAUCE_OTEL_IMAGE: 'fixture/otel:previous',
      CAUCE_POSTGRES_CA_PATH: '/fixture/postgres-ca.crt',
      CAUCE_POSTGRES_PASSWORD_PATH: '/fixture/postgres-password',
      CAUCE_POSTGRES_SERVER_CERT_PATH: '/fixture/postgres.crt',
      CAUCE_POSTGRES_SERVER_KEY_PATH: '/fixture/postgres.key',
      CAUCE_POSTGRES_IMAGE: 'fixture/postgres@sha256:' + '1'.repeat(64),
      CAUCE_PROMETHEUS_IMAGE: 'fixture/prometheus:previous',
      CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE: '/fixture/writer-snapshot.json',
    } : {}),
    ...options.environment,
  };
  const result = spawnSync('bash', [join(deployment, 'deploy.sh')], {
    cwd: directory, encoding: 'utf8', env: environment, timeout: 30_000,
  });
  const commands = () => existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Command)
    : [];
  return {
    ...result, repository, environmentFile, initialEnvironment, history, commands,
    currentEnvironment: () => readFileSync(environmentFile, 'utf8'),
    snapshots: () => readdirSync(directory).filter(name => name.includes('.pre-deploy-'))
      .map(name => readFileSync(join(directory, name), 'utf8')),
    recover: (instructions: string, overrides: Record<string, string> = {}) => spawnSync('bash', ['-euc', instructions], {
      cwd: directory, encoding: 'utf8', env: { ...environment, ...overrides, MOCK_FAILURE: '' }, timeout: 30_000,
    }),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function composeCommands(commands: Command[]) {
  return commands.filter(command => command.command === 'docker' && command.args[0] === 'compose' && !command.args.includes('-'));
}

function renderPublicConfiguration(configuration: string) {
  const directory = mkdtempSync(join(tmpdir(), 'cauce-mcp-dotenv-'));
  temporaryDirectories.push(directory);
  const environmentFile = join(directory, 'fixture.env');
  const dockerConfig = join(directory, 'docker-config');
  mkdirSync(dockerConfig);
  writeFileSync(environmentFile, configuration);
  const result = spawnSync('docker', ['compose', '--env-file', environmentFile,
    '--project-name', 'dotenv-fixture', '--project-directory', directory, '-f', '-', 'config', '--format', 'json'], {
    encoding: 'utf8', timeout: 15_000,
    env: { PATH: process.env.PATH, DOCKER_CONFIG: dockerConfig },
    input: `services:\n  probe:\n    image: scratch\n    environment:\n`
      + ['CAUCE_MCP_HUMAN_ENABLED', ...Object.keys(publicValues)]
        .map(name => `      ${name}: \${${name}-${name === 'CAUCE_MCP_HUMAN_ENABLED' ? '0' : ''}}\n`).join(''),
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const model = JSON.parse(result.stdout) as { services: { probe: { environment: Record<string, string> } } };
  return model.services.probe.environment;
}

function expectUnchanged(result: ReturnType<typeof execute>) {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).not.toBe(0);
  expect(result.currentEnvironment()).toBe(result.initialEnvironment);
  expect(result.snapshots()).toEqual([]);
  expect(existsSync(result.history)).toBe(false);
  expect(result.commands().every(command => command.command === 'id'
    || (command.command === 'docker' && command.args.includes('config')))).toBe(true);
}

describe('deploy human MCP overlay selection', () => {
  it.each(['', 'CAUCE_MCP_HUMAN_ENABLED=0\n'])('keeps default/off deployment canonical with public values present (%j)', flag => {
    const result = execute(flag + publicConfiguration, { environment: publicValues });
    expect(result.status, result.stderr).toBe(0);
    const commands = composeCommands(result.commands());
    expect(commands.map(command => command.args.find(arg => ['config', 'run', 'up'].includes(arg))))
      .toEqual(['config', 'run', 'up']);
    for (const command of commands) {
      expect(command.args.filter(arg => arg.endsWith('.yaml'))).toEqual([
        join(result.repository, 'deploy/compose.yaml'), join(result.repository, 'deploy/compose.postgres.yaml'),
      ]);
      expect(command.mcp).toEqual({});
    }
    expect(readFileSync(result.history, 'utf8')).toContain('smoke OK');
  });

  it.each(['', 'CAUCE_MCP_HUMAN_ENABLED=0\n'])('ignores partial public values while MCP is default/off (%j)', flag => {
    const result = execute(flag + 'CAUCE_MCP_PUBLIC_ORIGIN=https://mcp.example.test\n');
    expect(result.status, result.stderr).toBe(0);
    expect(composeCommands(result.commands()).every(command => Object.keys(command.mcp).length === 0)).toBe(true);
  });

  it('uses the exact overlay and instance paths for preflight, pinned config, migrator and recreation', () => {
    const result = execute('CAUCE_MCP_HUMAN_ENABLED=1\n' + publicConfiguration);
    expect(result.status, result.stderr).toBe(0);
    const commands = composeCommands(result.commands());
    expect(commands.map(command => command.args.find(arg => ['config', 'run', 'up'].includes(arg))))
      .toEqual(['config', 'config', 'run', 'up']);
    for (const command of commands) {
      expect(command.args.filter(arg => arg.endsWith('.yaml'))).toEqual([
        join(result.repository, 'deploy/compose.yaml'), join(result.repository, 'deploy/compose.postgres.yaml'),
        join(result.repository, 'deploy/compose.mcp-human.yaml'),
      ]);
      expect(command.args[command.args.indexOf('--env-file') + 1]).toBe(result.environmentFile);
      expect(command.args[command.args.indexOf('--project-directory') + 1]).toBe(join(result.repository, 'deploy'));
      expect(command.mcp).toEqual(publicValues);
    }
    const up = commands.at(-1);
    expect(up?.args.slice(-6)).toEqual(['up', '-d', '--wait', '--wait-timeout', '300', '--remove-orphans']);
    expect(result.snapshots()).toEqual([result.initialEnvironment]);
    expect(result.currentEnvironment()).toContain('CAUCE_MCP_HUMAN_ENABLED=1\n' + publicConfiguration);
    expect(result.currentEnvironment()).toContain('CAUCE_RUNTIME_IMAGE=fixture/runtime@sha256:');
  });

  it.each(['', 'true', 'yes', '2', ' 1', '"1"', '1 # comment'])('rejects a nonliteral flag %j before changes', flag => {
    const result = execute(`CAUCE_MCP_HUMAN_ENABLED=${flag}\n` + publicConfiguration);
    expectUnchanged(result);
    expect(result.stderr).toContain('CAUCE_MCP_HUMAN_ENABLED debe ser 0 o 1');
  });

  it.each(['CAUCE_MCP_HUMAN_ENABLED=1', 'export CAUCE_MCP_HUMAN_ENABLED=1', ' CAUCE_MCP_HUMAN_ENABLED =1'])('rejects a duplicate flag before changes (%s)', duplicate => {
    const result = execute(`CAUCE_MCP_HUMAN_ENABLED=0\n${duplicate}\n` + publicConfiguration);
    expectUnchanged(result);
    expect(result.stderr).toContain('CAUCE_MCP_HUMAN_ENABLED esta duplicado');
  });

  it.each(Object.keys(publicValues))('rejects missing, empty or duplicated %s before changes', name => {
    const others = publicConfiguration.split('\n').filter(line => !line.startsWith(`${name}=`)).join('\n') + '\n';
    for (const declaration of ['', `${name}=\n`, `${name}=   \n`, `${name}=x\n${name}=y\n`, `${name}=x\nexport ${name}=y\n`, `${name}=x\n ${name} =y\n`, `${name}=""\n`]) {
      const result = execute('CAUCE_MCP_HUMAN_ENABLED=1\n' + others + declaration);
      expectUnchanged(result);
      expect(result.stderr).toContain(name);
    }
  });

  it.each(['', 'CAUCE_MCP_HUMAN_ENABLED=0\n', 'CAUCE_MCP_HUMAN_ENABLED=1\n'])('rejects a shell flag contradicting the instance (%j)', flag => {
    const result = execute(flag + publicConfiguration, {
      environment: { CAUCE_MCP_HUMAN_ENABLED: flag.endsWith('=1\n') ? '0' : '1' },
    });
    expectUnchanged(result);
    expect(result.stderr).toContain('CAUCE_MCP_HUMAN_ENABLED del entorno contradice');
  });

  it.each(Object.keys(publicValues))('rejects shell override of enabled %s without logging its value', name => {
    const result = execute('CAUCE_MCP_HUMAN_ENABLED=1\n' + publicConfiguration, {
      environment: { [name]: 'private-fixture-value' },
    });
    expectUnchanged(result);
    expect(result.stderr).toContain(`${name} del entorno contradice`);
    expect(result.stderr + result.stdout).not.toContain('private-fixture-value');
  });

  it('accepts matching shell settings and reads public values from the instance', () => {
    const result = execute('CAUCE_MCP_HUMAN_ENABLED=1\n' + publicConfiguration, {
      environment: { CAUCE_MCP_HUMAN_ENABLED: '1', ...publicValues },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(composeCommands(result.commands()).every(command => JSON.stringify(command.mcp) === JSON.stringify(publicValues))).toBe(true);
  });

  it('rejects an unreadable overlay before changes', () => {
    const result = execute('CAUCE_MCP_HUMAN_ENABLED=1\n' + publicConfiguration, { missingOverlay: true });
    expectUnchanged(result);
    expect(result.stderr).toContain('no puedo leer deploy/compose.mcp-human.yaml');
  });

  it('rejects failed MCP rendering before build, fetch or pin changes', () => {
    const result = execute('CAUCE_MCP_HUMAN_ENABLED=1\n' + publicConfiguration, { failure: 'config' });
    expectUnchanged(result);
    expect(result.stderr).toContain('el compose MCP no renderiza');
  });

  it.each(['pinned-config', 'run', 'up', 'refresh-observability.sh', 'smoke.sh'])('preserves manual rollback with the exact overlay after %s fails', failure => {
    const result = execute('CAUCE_MCP_HUMAN_ENABLED=1\n' + publicConfiguration, { failure });
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.snapshots()).toEqual([result.initialEnvironment]);
    expect(result.currentEnvironment()).not.toBe(result.initialEnvironment);
    expect(existsSync(result.history)).toBe(false);
    expect(result.stderr).toContain('solo despues de verificar/restaurar esquema, BD y volumen');
    const recoveryCommands = result.stderr.split('\n').filter(line => line.startsWith('cp -a ') || line.startsWith('env -u '));
    expect(recoveryCommands).toHaveLength(3);
    const beforeRecovery = result.commands();
    expect(beforeRecovery.some(command => command.args.includes('down') || command.args.includes('stop'))).toBe(false);
    const recovery = result.recover(recoveryCommands.join('\n'), { CAUCE_MCP_PUBLIC_ORIGIN: 'https://unrelated-shell.example.test' });
    expect(recovery.status, recovery.stderr).toBe(0);
    expect(result.currentEnvironment()).toBe(result.initialEnvironment);
    const recoveredCompose = composeCommands(result.commands().slice(beforeRecovery.length));
    expect(recoveredCompose.map(command => command.args.find(arg => ['config', 'up'].includes(arg)))).toEqual(['config', 'up']);
    for (const command of recoveredCompose) {
      expect(command.args).toContain(join(result.repository, 'deploy/compose.mcp-human.yaml'));
      expect(command.mcp).toEqual(publicValues);
    }
  });

  it.each(['', 'CAUCE_MCP_HUMAN_ENABLED=0\n'])('keeps default/off manual recovery and snapshots unchanged (%j)', flag => {
    const result = execute(flag + publicConfiguration, { failure: 'up' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('up fallo; no levantes el gateway anterior');
    expect(result.stderr).not.toContain('Rollback MCP manual');
    expect(result.snapshots()).toEqual([result.initialEnvironment]);
    expect(composeCommands(result.commands()).every(command => !command.args.some(arg => arg.endsWith('compose.mcp-human.yaml')))).toBe(true);
  });

  it.each(['CAUCE_MCP_HUMAN_ENABLED=1\nCAUCE_MCP_HUMAN_ENABLED:0\n',
    'CAUCE_MCP_HUMAN_ENABLED:1\n', 'CAUCE_MCP_HUMAN_ENABLED=1\nexport CAUCE_MCP_HUMAN_ENABLED:0\n'])(
    'rejects ambiguous colon flag declarations before changes (%j)', configuration => {
    expect(renderPublicConfiguration(configuration).CAUCE_MCP_HUMAN_ENABLED)
      .toBe(configuration === 'CAUCE_MCP_HUMAN_ENABLED:1\n' ? '1' : '0');
    const result = execute(configuration + publicConfiguration);
    expectUnchanged(result);
    expect(result.stderr).toContain('CAUCE_MCP_HUMAN_ENABLED');
  });

  it.each(Object.keys(publicValues))('rejects a colon override of %s before changes', name => {
    const configuration = 'CAUCE_MCP_HUMAN_ENABLED=1\n' + publicConfiguration + `${name}:https://overridden.example.test\n`;
    expect(renderPublicConfiguration(configuration)[name]).toBe('https://overridden.example.test');
    const result = execute(configuration);
    expectUnchanged(result);
    expect(result.stderr).toContain(name);
  });

  it.each(["'", '"'])('rejects a flag hidden inside a multiline %s value without leaking it', quote => {
    const configuration = `UNRELATED=${quote}private-fixture-line\nCAUCE_MCP_HUMAN_ENABLED=1\n${quote}\n` + publicConfiguration;
    expect(renderPublicConfiguration(configuration).CAUCE_MCP_HUMAN_ENABLED).toBe('0');
    const result = execute(configuration);
    expectUnchanged(result);
    expect(result.stderr).toContain('CAUCE_MCP_HUMAN_ENABLED debe ser literal y coincidir con Compose');
    expect(result.stdout + result.stderr).not.toContain('private-fixture-line');
    expect(composeCommands(result.commands())).toEqual([]);
  });

  it.each(['CAUCE_MCP_PUBLIC_ORIGIN=${UNRELATED}\nUNRELATED=https://expanded.example.test\n',
    'CAUCE_MCP_PUBLIC_ORIGIN="https://mcp.example.test"\n'])(
    'rejects nonliteral public interpolation before changes (%j)', origin => {
    const configuration = publicConfiguration.split('\n').filter(line => !line.startsWith('CAUCE_MCP_PUBLIC_ORIGIN=')).join('\n');
    const result = execute('CAUCE_MCP_HUMAN_ENABLED=1\n' + configuration + '\n' + origin);
    expectUnchanged(result);
    expect(result.stderr).toContain('CAUCE_MCP_PUBLIC_ORIGIN debe ser literal y coincidir con Compose');
  });

  it.each(['', 'CAUCE_TERMINAL_RELAY_INSTANCE_ID=invalid\n'])('renders real Compose with terminal disabled and normalized relay identity (%j)', relay => {
    const result = execute('CAUCE_MCP_HUMAN_ENABLED=1\n' + publicConfiguration + relay, { realCompose: true });
    expect(result.status, result.stderr).toBe(0);
    const rendered = composeCommands(result.commands()).filter(command => command.rendered);
    expect(rendered).toHaveLength(2);
    for (const command of rendered) {
      expect(command.rendered?.gateway.CAUCE_TERMINAL_RELAY_INSTANCE_ID).toBe('0'.repeat(64));
      expect(command.rendered?.secrets.gateway_relay_client_cert?.file).toBe('/dev/null');
      expect(command.rendered?.secrets.gateway_relay_client_key?.file).toBe('/dev/null');
    }
  });

  it('preserves real effective Compose configuration in manual recovery under hostile shell overrides', () => {
    const result = execute('CAUCE_MCP_HUMAN_ENABLED=1\n' + publicConfiguration, { realCompose: true, failure: 'up' });
    expect(result.status, result.stderr).not.toBe(0);
    const initial = composeCommands(result.commands()).find(command => command.rendered)?.rendered;
    expect(initial).toBeDefined();
    const recoveryCommands = result.stderr.split('\n').filter(line => line.startsWith('cp -a ') || line.startsWith('env -u '));
    const beforeRecovery = result.commands().length;
    const recovery = result.recover(recoveryCommands.join('\n'), {
      CAUCE_MCP_PUBLIC_ORIGIN: 'https://shell.example.test', CAUCE_BLOB_API_ENABLED: '1',
      CAUCE_TERMINAL_RELAY_INSTANCE_ID: '9'.repeat(64),
      CAUCE_GATEWAY_RELAY_CLIENT_CERT_PATH: '/hostile/cert', CAUCE_GATEWAY_RELAY_CLIENT_KEY_PATH: '/hostile/key',
    });
    expect(recovery.status, recovery.stderr).toBe(0);
    const recovered = composeCommands(result.commands().slice(beforeRecovery)).find(command => command.rendered)?.rendered;
    expect(recovered).toEqual(initial);
    expect(recovered?.gateway.CAUCE_BLOB_API_ENABLED).toBe('0');
    expect(result.currentEnvironment()).toBe(result.initialEnvironment);
  });
});
