import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { expect } from 'vitest';
import { applyMigrations, createPool, type DatabasePool } from '@cauce/store';
import { seedSyntheticCompanyContexts } from '../../packages/store/src/seed-dev-cli.js';
import { buildGateway } from '../../services/gateway/src/app.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { arrancarPostgresDePrueba, COMANDO_POSTGRES_DE_PRUEBA, saludDePostgresDePrueba } from '../helpers/contenedor-de-prueba.js';
import { publishCliDatabase } from './cli-database-loopback.js';
import type { CliResult } from './v4-rupturas-terminal-cli.fixtures.js';

export const owner = 'b3p-admin';
export const prefix = `zz-canary-${owner}`;
const root = resolve(import.meta.dirname, '../..');
const receipts = join(root, '.delegados/v4/recibos', owner, 'platform-admin');

export async function startPlatformAdminFixture() {
  if (process.env.CAUCE_TEST_DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') {
    throw new Error('platform CLI E2E requires owned PostgreSQL and real routes');
  }
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-platform-`));
  await chmod(directory, 0o700);
  const password = randomBytes(24).toString('base64url');
  const secrets = [password];
  let database: StartedTestContainer | undefined;
  let pool: DatabasePool | undefined;
  let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let releaseCliDatabase: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    try { await app?.close(); }
    finally {
      try { await pool?.end(); }
      finally {
        try { await releaseCliDatabase?.(); }
        finally {
          try { await database?.stop(); }
          finally { await rm(directory, { recursive: true, force: true }); }
        }
      }
    }
  })();
  const privateFile = async (name: string, value: unknown): Promise<string> => {
    const path = join(directory, name);
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
    return path;
  };
  const raw = async (args: string[], environment: NodeJS.ProcessEnv = {}, input = ''): Promise<CliResult> => {
    const result = await new Promise<CliResult>((resolveResult, reject) => {
      const child = spawn('bash', [join(root, 'ops/cli/cauce'), ...args], {
        cwd: root, env: { PATH: process.env.PATH, HOME: directory, CAUCE_PROJECT_ROOT: root, NODE_ENV: 'test', ...environment },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = ''; let expired = false;
      const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 150_000);
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', () => { clearTimeout(timer); reject(new Error('platform CLI did not start')); });
      child.once('close', code => {
        clearTimeout(timer);
        if (expired) reject(new Error('platform CLI exceeded its deadline'));
        else resolveResult({ code, stdout, stderr });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    });
    const output = result.stdout + result.stderr;
    expect(secrets.some(secret => output.includes(secret)), 'CLI exposed private fixture material').toBe(false);
    expect(/"(?:cookie|csrf_token|password|password_hash)"\s*:/u.test(output)).toBe(false);
    return result;
  };
  try {
    const databasePassword = randomBytes(24).toString('base64url'); secrets.push(databasePassword);
    database = await arrancarPostgresDePrueba(() => new GenericContainer('postgres:16-alpine')
      .withName(`${prefix}-platform-${randomUUID().slice(0, 8)}`).withLabels({ 'cauce.e2e.owner': owner })
      .withCommand([...COMANDO_POSTGRES_DE_PRUEBA])
      .withEnvironment({ POSTGRES_DB: 'cauce_test', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: databasePassword })
      .withExposedPorts(5432).withHealthCheck(saludDePostgresDePrueba('cauce_test', 'cauce_test'))
      .withWaitStrategy(Wait.forHealthCheck()).start());
    const published = await publishCliDatabase('cauce_test', databasePassword, database.getHost(), database.getMappedPort(5432), 'cauce_test');
    releaseCliDatabase = () => published.close();
    const url = published.directUrl;
    secrets.push(url, published.cliUrl); pool = createPool(url); await applyMigrations(pool); await seedSyntheticCompanyContexts(url);
    await pool.query('UPDATE console_users SET password_hash=$1', [await hashPassword(password, { cost: 1024, blockSize: 8, parallelism: 1 })]);
    const actor = (await pool.query<{ id: string }>('SELECT id::text FROM console_users WHERE email=$1', ['context_alpha@dev.example'])).rows[0]?.id;
    const foreignActor = (await pool.query<{ id: string }>('SELECT id::text FROM console_users WHERE email=$1', ['context_beta@dev.example'])).rows[0]?.id;
    if (!actor || !foreignActor) throw new Error('synthetic operators are unavailable');
    const databaseFile = await privateFile('database-url', published.cliUrl);
    const environment = { DATABASE_URL_FILE: databaseFile, CAUCE_PLATFORM_ADMIN_ID: actor, CAUCE_SPACE_BACKUP_DIRECTORY: join(directory, 'backups') };
    app = await buildGateway({ pool, logger: false,
      authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: randomBytes(32) }),
    });
    const gateway = await app.listen({ host: '127.0.0.1', port: 0 });
    const sessionFile = join(directory, 'operator.session');
    const login = await raw(['login', '--gateway', gateway, '--email', 'context_alpha@dev.example', '--password-stdin', '--session-file', sessionFile], {}, `${password}\n`);
    expect(login.code, login.stderr).toBe(0);
    const session = JSON.parse(await readFile(sessionFile, 'utf8')) as { cookie: string; csrf_token: string };
    secrets.push(session.cookie, session.csrf_token);
    const platform = (args: string[], extra: NodeJS.ProcessEnv = {}) => raw(['platform', ...args], { ...environment, ...extra });
    const confirmed = async (args: string[]): Promise<string> => {
      const result = await platform(args); expect(result.code, result.stderr || result.stdout).toBe(0); return result.stdout;
    };
    const api = async <T>(path: string): Promise<T> => {
      const response = await fetch(gateway + path, { headers: { Cookie: session.cookie } });
      expect(response.ok, `gateway returned HTTP ${String(response.status)}`).toBe(true);
      return await response.json() as T;
    };
    const receipt = async (name: string, evidence: Record<string, boolean | number | string>): Promise<void> => {
      await mkdir(receipts, { recursive: true, mode: 0o700 });
      await writeFile(join(receipts, `${name}.json`), JSON.stringify({ owner, ...evidence }, null, 2) + '\n', { mode: 0o600 });
    };
    return { directory, password, databaseFile, actor, foreignActor, pool, database, privateFile, platform, confirmed, api, receipt, close };
  } catch (error) { await close(); throw error; }
}
