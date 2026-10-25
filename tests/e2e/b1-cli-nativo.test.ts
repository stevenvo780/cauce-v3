import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, createPool, type DatabasePool } from '@cauce/store';
import { seedSyntheticCompanyContexts } from '../../packages/store/src/seed-dev-cli.js';
import { buildGateway } from '../../services/gateway/src/app.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { arrancarPostgresDePrueba, COMANDO_POSTGRES_DE_PRUEBA, saludDePostgresDePrueba } from '../helpers/contenedor-de-prueba.js';

interface CliResult { code: number | null; stdout: string; stderr: string }
interface NativeSnapshot { version: number; files: { path: string; content: string }[] }
interface Diagnosis { items: { type: string; id: string; action?: string }[] }

const execute = promisify(execFile);
const owner = 'b1-cli-nativo';
const run = randomUUID().slice(0, 8);
const root = resolve(import.meta.dirname, '../..');
const company = 'context_alpha';
const tenant = 'ContextAlpha';
const alias = 'director';
const email = `${company}@dev.example`;
const note = 'Nota nativa del CLI instalado.';
const password = randomBytes(24).toString('base64url');
const secrets = [password];
let home = '';
let work = '';
let bin = '';
let shimDirectory = '';
let sessionFile = '';
let nativeRoot = '';
let gateway = '';
let auditId = '';
let database: StartedTestContainer | undefined;
let pool: DatabasePool | undefined;
let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
let closing: Promise<void> | undefined;

function db(): DatabasePool {
  if (!pool) throw new Error('owned CLI PostgreSQL is unavailable');
  return pool;
}
function assertPrivate(result: CliResult): void {
  const output = result.stdout + result.stderr;
  expect(secrets.some(secret => output.includes(secret))).toBe(false);
  expect(/"(?:cookie|csrf_token|password|password_hash)"\s*:/u.test(output)).toBe(false);
}
function runInstalled(args: string[], input = '', extra: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(bin, args, {
      cwd: work,
      env: {
        HOME: home,
        PATH: `${shimDirectory}:${join(home, '.local/bin')}:/usr/local/bin:/usr/bin:/bin`,
        XDG_STATE_HOME: join(home, '.local/state'),
        PYTHONDONTWRITEBYTECODE: '1',
        CAUCE_TEST_CLI_HOME: home,
        LANG: 'C.UTF-8',
        ...extra,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 60_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', () => { clearTimeout(timer); reject(new Error('installed CLI did not start')); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
    child.once('close', code => {
      clearTimeout(timer);
      if (expired) reject(new Error(`installed CLI exceeded its deadline: ${args.join(' ')}`));
      else resolveResult({ code, stdout, stderr });
    });
  });
}
function close(): Promise<void> {
  closing ??= (async () => {
    const activeApp = app; app = undefined;
    const activePool = pool; pool = undefined;
    const activeDatabase = database; database = undefined;
    const activeHome = home; home = '';
    try { await activeApp?.close(); }
    finally {
      try { await activePool?.end(); }
      finally {
        try { await activeDatabase?.stop(); }
        finally { if (activeHome) await rm(activeHome, { recursive: true, force: true }); }
      }
    }
  })();
  return closing;
}

beforeAll(async () => {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.CAUCE_TEST_DATABASE_URL || process.env.DATABASE_URL) {
    throw new Error('run the installed CLI journey through scripts/e2e-lab.sh');
  }
  home = await mkdtemp(join(tmpdir(), `zz-canary-${owner}-`));
  await chmod(home, 0o700);
  try {
    work = join(home, 'work');
    shimDirectory = join(home, 'shims');
    nativeRoot = join(home, 'native');
    sessionFile = join(home, 'operator.session');
    const binDirectory = join(home, '.local/bin');
    await mkdir(work, { recursive: true, mode: 0o700 });
    await mkdir(shimDirectory, { recursive: true, mode: 0o700 });
    await mkdir(join(nativeRoot, 'context/notes'), { recursive: true, mode: 0o700 });
    await writeFile(join(nativeRoot, 'context/notes/b1.md'), note, { mode: 0o600 });
    await writeFile(join(shimDirectory, 'getent'), `#!/bin/sh
if [ "$1" = passwd ]; then
  printf 'fixture:x:%s:%s::%s:/bin/sh\\n' "$(id -u)" "$(id -g)" "$CAUCE_TEST_CLI_HOME"
  exit 0
fi
exec /usr/bin/getent "$@"
`, { mode: 0o755 });
    await execute('/bin/bash', [join(root, 'ops/scripts/install-cauce-cli.sh'), binDirectory], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: home, CAUCE_DESTINO_AVISO_INICIAL: 'zz-canary-b1-cli' },
      timeout: 60_000,
    });
    bin = join(binDirectory, 'cauce');
    const databasePassword = randomBytes(24).toString('base64url');
    secrets.push(databasePassword);
    database = await arrancarPostgresDePrueba(() => new GenericContainer('postgres:16-alpine')
      .withName(`zz-canary-${owner}-${run}`)
      .withLabels({ 'cauce.e2e.owner': owner })
      .withCommand([...COMANDO_POSTGRES_DE_PRUEBA])
      .withEnvironment({ POSTGRES_DB: 'cauce_test', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: databasePassword })
      .withExposedPorts(5432)
      .withHealthCheck(saludDePostgresDePrueba('cauce_test', 'cauce_test'))
      .withWaitStrategy(Wait.forHealthCheck())
      .start());
    const url = `postgresql://cauce_test:${encodeURIComponent(databasePassword)}@${database.getHost()}:${String(database.getMappedPort(5432))}/cauce_test`;
    secrets.push(url);
    pool = createPool(url);
    await applyMigrations(pool);
    await seedSyntheticCompanyContexts(url);
    await pool.query('UPDATE console_users SET password_hash=$1 WHERE email_normalized=$2', [
      await hashPassword(password, { cost: 1024, blockSize: 8, parallelism: 1 }), email,
    ]);
    app = await buildGateway({
      pool, logger: false,
      authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: randomBytes(32) }),
    });
    gateway = await app.listen({ host: '127.0.0.1', port: 0 });
  } catch (error) { await close(); throw error; }
}, 180_000);
afterAll(close, 60_000);

describe.sequential('CLI instalado: contexto nativo y diagnose contra gateway y PostgreSQL reales', () => {
  it('sincroniza un archivo nativo explícito y lo deja en el historial', async () => {
    const login = await runInstalled(['login', '--gateway', gateway, '--email', email, '--password-stdin', '--session-file', sessionFile], `${password}\n`);
    assertPrivate(login);
    expect(login.code, login.stderr).toBe(0);
    expect((await stat(sessionFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(sessionFile, 'utf8')).not.toContain(password);
    const session = JSON.parse(await readFile(sessionFile, 'utf8')) as { cookie?: string; csrf_token?: string };
    if (session.cookie) secrets.push(session.cookie);
    if (session.csrf_token) secrets.push(session.csrf_token);
    const status = await runInstalled(['login', '--status', '--session-file', sessionFile]);
    assertPrivate(status);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ authenticated: true, home_tenant: tenant });

    const connection = ['--gateway', gateway, '--origin', gateway, '--session-file', sessionFile, '--tenant', tenant, '--alias', alias];
    const missing = await runInstalled(['context-native', ...connection, '--root', nativeRoot, '--expected-version', '0']);
    assertPrivate(missing);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('Indica los archivos nativos que quieres sincronizar');
    expect(missing.stderr).not.toMatch(/explicit native context|Traceback/u);

    const synced = await runInstalled(['context-native', ...connection, '--root', nativeRoot, '--expected-version', '0', 'context/notes/b1.md']);
    assertPrivate(synced);
    expect(synced.code, synced.stderr).toBe(0);
    const snapshot = JSON.parse(synced.stdout) as NativeSnapshot;
    expect(snapshot.version).toBeGreaterThan(0);
    expect(snapshot.files).toEqual(expect.arrayContaining([{ path: 'context/notes/b1.md', content: note }]));
    const stored = await db().query<{ version: number; source: string }>(
      `SELECT version::int AS version, source FROM agent_context_versions WHERE tenant_id=$1 AND alias=$2 ORDER BY version`,
      [tenant, alias],
    );
    expect(stored.rows.at(-1)).toMatchObject({ version: snapshot.version, source: 'native' });
    const audit = await db().query<{ id: string }>(
      `SELECT id::text AS id FROM audit_events
        WHERE action='context.version' AND metadata->>'target_alias'=$1 AND metadata->>'version'=$2
        ORDER BY id DESC LIMIT 1`,
      [alias, String(snapshot.version)],
    );
    const id = audit.rows[0]?.id;
    if (!id) throw new Error('native context version has no audit row');
    auditId = id;
  });

  it('lee esa versión con cauce diagnose instalado y rechaza un identificador ausente en español', async () => {
    if (!auditId) throw new Error('native audit id is unavailable');
    const found = await runInstalled(['diagnose', auditId, '--gateway', gateway, '--origin', gateway, '--session-file', sessionFile]);
    assertPrivate(found);
    expect(found.code, found.stderr).toBe(0);
    expect(found.stderr).toBe('');
    const diagnosis = JSON.parse(found.stdout) as Diagnosis;
    expect(diagnosis.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'audit', id: auditId, action: 'context.version' }),
    ]));
    const absent = await runInstalled(['diagnose', 'zz-canary-b1-ausente', '--gateway', gateway, '--origin', gateway, '--session-file', sessionFile]);
    assertPrivate(absent);
    expect(absent.code).toBe(1);
    expect(absent.stdout).toBe('');
    expect(absent.stderr).toContain('La consola rechazó el diagnóstico (HTTP 404)');
    expect(absent.stderr).not.toMatch(/diagnostic request rejected|Traceback/u);
  });

  it('cuotas y coutas entregan los argumentos al lector sin abrir el host remoto', async () => {
    const marker = join(home, 'quota-side-effect');
    const hostFile = join(home, 'ssh-host');
    const commandFile = join(home, 'ssh-command');
    await writeFile(join(shimDirectory, 'ssh'), `#!/bin/sh
host=
command=
previous=
for argument in "$@"; do
  if [ "$previous" = "-o" ]; then previous=; continue; fi
  case "$argument" in
    -t|-o) previous=$argument; continue ;;
    -*) continue ;;
  esac
  if [ -z "$host" ]; then host=$argument; else command=$argument; fi
done
printf '%s\\n' "$host" > "$CAUCE_TEST_SSH_HOST"
printf '%s\\n' "$command" > "$CAUCE_TEST_SSH_CMD"
printf 'cuotas: laboratorio, sin lectura remota\\n'
exit 0
`, { mode: 0o755 });
    const injection = `gpt; touch ${marker}`;
    const extra = { CUOTAS_HOST: 'zz-canary-cuotas', CAUCE_TEST_SSH_HOST: hostFile, CAUCE_TEST_SSH_CMD: commandFile };
    for (const command of ['cuotas', 'coutas'] as const) {
      const result = await runInstalled([command, '--model', injection], '', extra);
      assertPrivate(result);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('cuotas: laboratorio, sin lectura remota');
      expect(await readFile(hostFile, 'utf8')).toBe('zz-canary-cuotas\n');
      const remote = await readFile(commandFile, 'utf8');
      expect(remote.startsWith('$HOME/.local/bin/cuotas ')).toBe(true);
      expect(remote).toContain('--model');
      expect(remote).toContain('gpt');
      expect(remote).not.toContain('server2');
      await expect(stat(marker)).rejects.toThrow();
    }
  });
});
