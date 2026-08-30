import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '../../services/gateway/src/app.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

const execute = promisify(execFile);

/**
 * Certifies the console human login (`services/gateway/src/password-auth.ts`) end-to-end: real
 * HTTP, real PostgreSQL, and the account provisioned through THE SAME path production uses
 * (`pnpm console:user` / `console-user-cli.ts`), never an in-memory double.
 *
 * THE DATABASE IS "DEV-ISOLATED" BY CONSTRUCTION: `startTestDatabase()` (`tests/helpers/postgres.ts`)
 * spins up its OWN `postgres:16-alpine` container via testcontainers — host, port, user and
 * password generated at random (`randomUUID()`) for THIS run, migrated from zero and destroyed in
 * `afterAll`. No production `DATABASE_URL` or any persistent environment is involved in this
 * file: there is no way for this suite to touch real data, because the database does not exist
 * until `beforeAll` creates it.
 *
 * The account under test has MINIMUM scope (`role: reader` → `permissions: ['read']`, no
 * `roles`). The suite certifies that every general view is genuinely navigable under that scope
 * and, in the same session, that mutations stay closed before producing durable effects.
 */

const CONSOLE_EMAIL = process.env.CAUCE_E2E_CONSOLE_EMAIL ?? 'qa-e2e-dev@cauce.test';
const CONSOLE_PASSWORD = process.env.CAUCE_E2E_CONSOLE_PASSWORD ?? randomBytes(24).toString('base64url');
const CONSOLE_TENANT = 'Steven';
const CONSOLE_ALIAS = 'kant';
const CHAIN_TRACE_ID = 'trace-reader-visible';

let database: TestDatabase;
let app: Awaited<ReturnType<typeof buildGateway>>;
let httpUrl: string;
let provisionStdout = '';

beforeAll(async () => {
  database = await startTestDatabase();

  // Account creation goes through the REAL production path: the same `console-user-cli.ts` that
  // `pnpm console:user` invokes, against the ephemeral database's DATABASE_URL. The password
  // travels ONLY via subprocess env var — never via argv (visible in `ps`), and never printed:
  // the CLI reads it from `CAUCE_CONSOLE_USER_PASSWORD` and echoes nothing sensitive.
  const cli = await execute(
    join(process.cwd(), 'node_modules/.bin/tsx'),
    [
      'services/gateway/src/console-user-cli.ts',
      '--email', CONSOLE_EMAIL,
      '--name', 'QA E2E Dev',
      '--role', 'reader',
      '--tenant', CONSOLE_TENANT,
      '--alias', CONSOLE_ALIAS
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: database.url, CAUCE_CONSOLE_USER_PASSWORD: CONSOLE_PASSWORD }
    }
  );
  provisionStdout = cli.stdout;

  await persistDevOnlyCredentialRecord();
  await seedAgentAndVisibleChain();

  const provider = new PasswordAuthProvider({
    users: new PostgresConsoleUserStore(database.pool),
    signingKey: randomBytes(32),
    sessionTtlMs: 60 * 60 * 1_000
    // No `fallback` on purpose: this suite certifies ONLY the password door, not the agent mTLS
    // (already covered by `tests/e2e/real-qa.test.ts` with `DevOnlyAuthProvider`).
  });
  await provider.ready();

  app = await buildGateway({ pool: database.pool, authProvider: provider });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  httpUrl = `http://127.0.0.1:${String(address.port)}`;
}, 120_000);

afterAll(async () => {
  await app.close();
  await database.pool.end();
  await database.container.stop();
});

describe('login E2E de la consola contra PostgreSQL real (base dev aislada y efímera)', () => {
  it('la cuenta se creó por el camino de producción y sin imprimir la contraseña', () => {
    expect(provisionStdout).toContain('cuenta creada');
    expect(provisionStdout).not.toContain(CONSOLE_PASSWORD);
  });

  it('sin cookie no hay sesión ni acceso: la puerta cierra por defecto', async () => {
    const anonymous = await fetch(`${httpUrl}/v3/status`, { headers: { accept: 'application/json' } });
    expect(anonymous.status).toBe(401);
    const session = await fetch(`${httpUrl}/v3/auth/session`);
    expect(await session.json()).toEqual({ authenticated: false, login_mode: 'password' });
  });

  it('una contraseña equivocada no entrega cookie', async () => {
    const wrong = await login(CONSOLE_EMAIL, 'esta-no-es-la-contraseña-correcta');
    expect(wrong.status).toBe(401);
    expect(wrong.headers.getSetCookie()).toEqual([]);
  });

  it('LOGIN: la contraseña SOLO-DEV entra, entrega cookie HttpOnly+Secure+SameSite y CSRF', async () => {
    const response = await login(CONSOLE_EMAIL, CONSOLE_PASSWORD);
    expect(response.status).toBe(200);
    const [cookie] = response.headers.getSetCookie();
    expect(cookie).toBeDefined();
    if (!cookie) throw new Error('expected cookie');
    expect(cookie).toContain('__Host-cauce_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      authenticated: true, login_mode: 'password', subject: CONSOLE_EMAIL,
      roles: [], permissions: ['read']
    });
    // The token never travels in the body: if it appeared here, an XSS would steal it.
    expect(JSON.stringify(body)).not.toContain(cookieToken(cookie).slice(0, 24));
  });

  it('FLUJOS PRINCIPALES: con sesión, la consola navega sus vistas de lectura', async () => {
    const { cookie } = await authenticatedSession();
    const reads: [string, number][] = [
      ['/v3/auth/session', 200],
      ['/v3/status', 200],
      ['/v3/console/access', 200],
      ['/v3/console/topology', 200],
      ['/v3/console/messages', 200],
      ['/v3/console/queues', 200],
      ['/v3/console/adapters', 200],
      ['/v3/console/jobs', 200],
      ['/v3/console/activity', 200],
      ['/v3/console/quotas', 200],
      ['/v3/console/agents', 200],
      ['/v3/console/agents/kant', 200],
      ['/v3/console/tenants/Steven/agents/kant', 200],
      ['/v3/console/role-assignments/Steven/kant/history', 200],
      ['/v3/console/audit', 200],
      [`/v3/console/chains/${CHAIN_TRACE_ID}`, 200],
      ['/v3/console/chain-gates', 200],
      ['/v3/console/config', 200],
      ['/v3/console/observability', 200],
      ['/v3/console/tenants/Steven/agents/kant/perfil', 200],
      ['/v3/console/tenants/Steven/agents/kant/documents', 200],
      // Operational surfaces deliberately excluded from reader.
      ['/v3/console/dlq', 403],
      ['/v3/console/terminal/capability', 403]
    ];
    for (const [path, expected] of reads) {
      const response = await fetch(`${httpUrl}${path}`, {
        headers: { cookie, accept: 'application/json' }
      });
      expect(response.status, path).toBe(expected);
    }
  });

  it('RBAC: POST y PUT del reader responden 403 y dejan cero efectos durables', async () => {
    const { cookie, csrf } = await authenticatedSession();
    const before = await durableMutationCounts();
    const headers = {
      cookie,
      origin: httpUrl,
      'x-csrf-token': csrf,
      'content-type': 'application/json',
    };
    const mutations: { method: 'POST' | 'PUT'; path: string; body: unknown }[] = [
      {
        method: 'POST', path: '/v3/console/messages',
        body: {
          room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }],
          body: { text: 'reader no publica' }, idempotency_key: 'reader-e2e-no-publish',
        },
      },
      {
        method: 'POST', path: '/v3/console/jobs',
        body: { lane: 'batch', priority: 0, kind: 'system.database.probe', payload: {} },
      },
      {
        method: 'POST', path: '/v3/console/config/changes',
        body: {
          dry_run: false, expected_revision: 0,
          mutation: { resource: 'tenant', action: 'update', id: 'Steven', value: { enabled: true } },
        },
      },
      {
        method: 'POST', path: '/v3/console/config/revisions/1/rollback',
        body: { dry_run: false, expected_revision: 0 },
      },
      {
        method: 'POST', path: '/v3/console/chain-gates/11111111-1111-4111-8111-111111111111/answer',
        body: { answer: 'reader no responde' },
      },
      {
        method: 'POST', path: '/v3/console/deliveries/22222222-2222-4222-8222-222222222222/cancel',
        body: { reason: 'reader no cancela' },
      },
      {
        method: 'PUT', path: '/v3/console/tenants/Steven/agents/kant/perfil',
        body: { expected_revision: null, profile: {} },
      },
      {
        method: 'PUT', path: '/v3/console/tenants/Steven/agents/kant/documents/directive/content',
        body: { content: 'reader no escribe', create_if_absent: true },
      },
    ];

    for (const mutation of mutations) {
      const response = await fetch(`${httpUrl}${mutation.path}`, {
        method: mutation.method,
        headers,
        body: JSON.stringify(mutation.body),
      });
      expect(response.status, `${mutation.method} ${mutation.path}`).toBe(403);
    }
    expect(await durableMutationCounts()).toEqual(before);
  });

  it('LOGOUT: exige CSRF, contesta 204 y le dice al navegador que borre la cookie', async () => {
    const { cookie, csrf } = await authenticatedSession();
    const withoutCsrf = await fetch(`${httpUrl}/v3/auth/logout`, {
      method: 'POST', headers: { cookie, origin: httpUrl }
    });
    expect(withoutCsrf.status).toBe(403);

    const logout = await fetch(`${httpUrl}/v3/auth/logout`, {
      method: 'POST', headers: { cookie, origin: httpUrl, 'x-csrf-token': csrf }
    });
    expect(logout.status).toBe(204);
    const [cleared] = logout.headers.getSetCookie();
    expect(cleared).toContain('Max-Age=0');

    // The token is self-contained (documented in `password-auth.ts::logout`): logout does NOT
    // revoke it on the server, only tells the browser to drop the cookie. Replaying the OLD
    // cookie by hand keeps authenticating until it expires on its own, or until the account is
    // deactivated or the password is rotated — that is the documented half of revocation, not a
    // bug in this suite. Measured so it stays written, not assumed.
    const staleCookieStillWorks = await fetch(`${httpUrl}/v3/auth/session`, { headers: { cookie } });
    expect((await staleCookieStillWorks.json())).toMatchObject({ authenticated: true });
  });
});

function login(email: string, password: string): Promise<Response> {
  return fetch(`${httpUrl}/v3/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: httpUrl },
    body: JSON.stringify({ email, password })
  });
}

function cookieToken(setCookie: string): string {
  const value = setCookie.split(';', 1)[0] ?? '';
  return decodeURIComponent(value.split('=').slice(1).join('='));
}

async function authenticatedSession(): Promise<{ cookie: string; csrf: string }> {
  const response = await login(CONSOLE_EMAIL, CONSOLE_PASSWORD);
  const [rawCookie] = response.headers.getSetCookie();
  if (!rawCookie) throw new Error('login no entregó cookie de sesión');
  const cookie = rawCookie.split(';', 1)[0] ?? '';
  const { csrf_token: csrf } = (await response.json()) as { csrf_token: string };
  return { cookie, csrf };
}

async function durableMutationCounts(): Promise<Record<string, number>> {
  const result = await database.pool.query<Record<string, string>>(`
    SELECT
      (SELECT count(*)::text FROM messages) AS messages,
      (SELECT count(*)::text FROM jobs) AS jobs,
      (SELECT count(*)::text FROM config_revisions) AS config_revisions,
      (SELECT count(*)::text FROM audit_events) AS audit_events,
      (SELECT count(*)::text FROM agent_chain_gates) AS chain_gates
  `);
  return Object.fromEntries(
    Object.entries(result.rows[0] ?? {}).map(([name, value]) => [name, Number(value)]),
  );
}

async function seedAgentAndVisibleChain(): Promise<void> {
  await database.pool.query(
    `INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,
                        home_directory,state_directory)
     VALUES($1,$2,'claude',true,'ws-e2e','dev','/home/dev','/home/dev/.cauce/test')
     ON CONFLICT (tenant_id,alias) DO NOTHING`,
    [CONSOLE_TENANT, CONSOLE_ALIAS],
  );
  await database.pool.query(
    `WITH inserted_message AS (
       INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
       VALUES(gen_random_uuid(),$1,$2,'grp.steven',$3,'{}'::jsonb,'interactive')
       RETURNING id,request_id
     )
     INSERT INTO adapter_outbox(
       tenant_id,adapter,kind,idempotency_key,request_id,message_id,trace_id,payload
     )
     SELECT $2,'telegram','origin_relay','e2e-reader-visible-chain',request_id,id,$1,
            '{"relay_kind":"final","terminal":true}'::jsonb
     FROM inserted_message`,
    [CHAIN_TRACE_ID, CONSOLE_TENANT, CONSOLE_ALIAS],
  );
}

/**
 * Leaves an auditable record of WHICH account was used to certify login, so it does not depend
 * on anyone remembering to look at this file's output. Lives in `.test-state/` (gitignored, 700)
 * and the file ends up 600: only the process owner can read it. The password is valid ONLY
 * against THIS run's ephemeral Postgres container — it is destroyed in `afterAll`, so reusing
 * this file later opens nothing; it is evidence of what was certified, not a live credential.
 */
async function persistDevOnlyCredentialRecord(): Promise<void> {
  const directory = join(process.cwd(), '.test-state', 'e2e-console-login');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'credentials.txt');
  const content = `# Credencial SOLO-DEV -- login E2E de la consola
# Generada: ${new Date().toISOString()}
# Alcance: PostgreSQL efímero de testcontainers, destruido al terminar esta corrida.
#          NO es una cuenta de producción; no existe fuera del contenedor de este test.
email:    ${CONSOLE_EMAIL}
password: ${CONSOLE_PASSWORD}
role:     reader (permissions: ['read'], sin rol operator -- mínimo para login + navegación)
tenant:   ${CONSOLE_TENANT}
alias:    ${CONSOLE_ALIAS}
`;
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}
