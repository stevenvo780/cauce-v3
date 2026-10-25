import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { expect } from 'vitest';
import { applyMigrations, createPool, type DatabasePool } from '@cauce/store';
import { seedSyntheticCompanyContexts } from '../../packages/store/src/seed-dev-cli.js';
import { buildGateway } from '../../services/gateway/src/app.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { arrancarPostgresDePrueba, COMANDO_POSTGRES_DE_PRUEBA, saludDePostgresDePrueba } from '../helpers/contenedor-de-prueba.js';

export const owner = 'e2e-a9-sigue-1025';
const root = resolve(import.meta.dirname, '../..');
const execute = promisify(execFile);
interface CliResult { readonly code: number | null; readonly stdout: string; readonly stderr: string }
interface Session { readonly cookie: string; readonly csrf_token: string }

export async function git(directory: string, args: string[]): Promise<string> {
  return (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], {
    env: { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    timeout: 20_000, maxBuffer: 2_097_152,
  })).stdout.trim();
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('canary TCP port unavailable');
  await new Promise<void>((done, reject) => server.close(error => { if (error) reject(error); else done(); }));
  return address.port;
}

async function listening(port: number): Promise<boolean> {
  return new Promise(done => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    const finish = (ready: boolean) => { socket.destroy(); done(ready); };
    socket.once('connect', () => { finish(true); });
    socket.once('error', () => { finish(false); });
    socket.once('timeout', () => { finish(false); });
  });
}

export async function startContextPublishFixture() {
  if (process.env.CAUCE_TEST_DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') throw new Error('owned PostgreSQL and real context routes are required');
  const run = randomUUID().slice(0, 8);
  const directory = await mkdtemp(join(tmpdir(), `zz-canary-${owner}-${run}-`));
  await chmod(directory, 0o700);
  const receipts = join(root, '.delegados/v4/recibos', owner, 'context-publish', run);
  const broker = join(directory, 'broker'); const remote = join(directory, 'origin.git');
  const natives = join(directory, 'natives');
  const password = randomBytes(24).toString('base64url');
  const databasePassword = randomBytes(24).toString('base64url');
  const secrets = [password, databasePassword];
  let database: StartedTestContainer | undefined; let pool: DatabasePool | undefined;
  let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let daemon: ChildProcess | undefined; let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    try { await app?.close(); }
    finally {
      try { await pool?.end(); }
      finally {
        let databaseStopped = false;
        try { await database?.stop(); databaseStopped = true; }
        finally {
          if (daemon?.exitCode === null && daemon.signalCode === null) {
            const stopped = new Promise<void>(done => { daemon?.once('exit', () => { done(); }); });
            daemon.kill('SIGTERM'); await stopped;
          }
          await rm(directory, { recursive: true, force: true });
          await writeFile(join(receipts, 'cleanup.json'), JSON.stringify({ run, database_stopped: databaseStopped,
            git_daemon_stopped: daemon?.exitCode !== null || daemon.signalCode !== null, temporary_directory_removed: true }) + '\n', { mode: 0o600 });
        }
      }
    }
  })();
  const assertPrivate = (output: string): void => {
    expect(secrets.some(secret => output.includes(secret)), 'private fixture material was exposed').toBe(false);
    expect(/"(?:cookie|csrf_token|password|password_hash)"\s*:/u.test(output)).toBe(false);
  };
  const cli = async (args: string[], environment: NodeJS.ProcessEnv = {}, input = ''): Promise<CliResult> => {
    const result = await new Promise<CliResult>((done, reject) => {
      const child = spawn('bash', [join(root, 'ops/cli/cauce'), ...args], {
        cwd: root, env: { PATH: process.env.PATH, HOME: directory, CAUCE_PROJECT_ROOT: root, NODE_ENV: 'test', ...environment },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = ''; let expired = false;
      const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 150_000);
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', () => { clearTimeout(timer); reject(new Error('context CLI did not start')); });
      child.once('close', code => {
        clearTimeout(timer);
        if (expired) reject(new Error('context CLI exceeded its deadline'));
        else done({ code, stdout, stderr });
      });
      child.stdin.on('error', () => undefined); child.stdin.end(input);
    });
    assertPrivate(result.stdout + result.stderr); return result;
  };
  try {
    await Promise.all([mkdir(broker, { mode: 0o700 }), mkdir(natives), mkdir(receipts, { recursive: true, mode: 0o700 })]);
    await git(directory, ['init', '--bare', '--initial-branch=main', remote]);
    await git(broker, ['init', '--initial-branch=main']);
    const port = await unusedPort();
    await git(broker, ['remote', 'add', 'origin', `git://127.0.0.1:${String(port)}/origin.git`]);
    database = await arrancarPostgresDePrueba(() => new GenericContainer('postgres:16-alpine')
      .withName(`zz-canary-${owner}-context-${run}`).withLabels({ 'cauce.e2e.owner': owner })
      .withCommand([...COMANDO_POSTGRES_DE_PRUEBA])
      .withEnvironment({ POSTGRES_DB: 'cauce_test', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: databasePassword })
      .withExposedPorts(5432).withHealthCheck(saludDePostgresDePrueba('cauce_test', 'cauce_test'))
      .withWaitStrategy(Wait.forHealthCheck()).start());
    const url = `postgresql://cauce_test:${encodeURIComponent(databasePassword)}@${database.getHost()}:${String(database.getMappedPort(5432))}/cauce_test`;
    secrets.push(url); pool = createPool(url); await applyMigrations(pool); await seedSyntheticCompanyContexts(url);
    await pool.query('UPDATE console_users SET password_hash=$1', [await hashPassword(password, { cost: 1024, blockSize: 8, parallelism: 1 })]);
    const databaseFile = join(directory, 'database-url'); await writeFile(databaseFile, url, { mode: 0o600 });
    app = await buildGateway({ pool, logger: false, contextVersion: { repositoryRoot: broker },
      authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: randomBytes(32) }) });
    const gateway = await app.listen({ host: '127.0.0.1', port: 0 });
    const sessionFile = join(directory, 'operator.session');
    const login = await cli(['login', '--gateway', gateway, '--email', 'context_alpha@dev.example', '--password-stdin', '--session-file', sessionFile], {}, `${password}\n`);
    expect(login.code, login.stderr).toBe(0);
    const session = JSON.parse(await readFile(sessionFile, 'utf8')) as Session;
    secrets.push(session.cookie, session.csrf_token);
    const platform = (args: string[]) => cli(['platform', ...args], { DATABASE_URL_FILE: databaseFile });
    const api = (path: string, method = 'GET') => fetch(gateway + path, { method,
      headers: { Cookie: session.cookie, Origin: gateway, 'x-csrf-token': session.csrf_token } });
    const startRemote = async (): Promise<void> => {
      daemon = spawn('git', ['daemon', '--reuseaddr', '--export-all', '--enable=receive-pack', `--base-path=${directory}`,
        '--listen=127.0.0.1', `--port=${String(port)}`], { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: directory } });
      await expect.poll(() => listening(port), { timeout: 10_000 }).toBe(true);
    };
    const receipt = async (name: string, value: unknown): Promise<void> => {
      const content = JSON.stringify({ owner, run, transport: 'git-daemon-loopback', github: 'not-exercised', value }, null, 2) + '\n';
      assertPrivate(content); await writeFile(join(receipts, `${name}.json`), content, { mode: 0o600 });
    };
    await receipt('resources', { postgres: database.getId(), real_cli: 'ops/cli/cauce platform contexto sembrar', broker: 'private-owned-repository', remote: 'owned-bare-repository' });
    return { run, directory, broker, remote, natives, pool, platform, api, startRemote, secrets, assertPrivate, receipt, close };
  } catch (error) { await close(); throw error; }
}
