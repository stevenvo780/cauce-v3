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
 * Certifica el login humano de la consola (`services/gateway/src/password-auth.ts`) de punta a
 * punta: HTTP real, PostgreSQL real y la cuenta provista por el MISMO camino que produción usa
 * (`pnpm console:user` / `console-user-cli.ts`), nunca un doble en memoria.
 *
 * LA BASE ES "DEV AISLADA" POR CONSTRUCCIÓN: `startTestDatabase()` (`tests/helpers/postgres.ts`)
 * levanta un contenedor `postgres:16-alpine` PROPIO con `testcontainers` -- host, puerto, usuario
 * y contraseña generados al azar (`randomUUID()`) para ESTA corrida, migrado desde cero y
 * destruido en `afterAll`. No hay ningún `DATABASE_URL` de producción ni de ningún ambiente
 * persistente involucrado en este archivo: no existe forma de que esta suite le pegue a un dato
 * real, porque la base ni existe hasta que `beforeAll` la crea.
 *
 * La cuenta que se prueba es de alcance MÍNIMO (`role: reader` -> `permissions: ['read']`, sin
 * `roles`). Certifica que todas las vistas generales son realmente navegables con ese alcance y,
 * en la misma sesión, que las mutaciones siguen cerradas antes de producir efectos durables.
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

  // Alta de la cuenta por el camino REAL de producción: el mismo `console-user-cli.ts` que
  // `pnpm console:user` invoca, contra el DATABASE_URL de la base efímera. La contraseña viaja
  // SÓLO por variable de entorno del subproceso -- nunca por argv (se ve en `ps`) y nunca se
  // imprime: el CLI la lee de `CAUCE_CONSOLE_USER_PASSWORD` y no hace eco de nada sensible.
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
  await seedVisibleChain();

  const provider = new PasswordAuthProvider({
    users: new PostgresConsoleUserStore(database.pool),
    signingKey: randomBytes(32),
    sessionTtlMs: 60 * 60 * 1_000
    // Sin `fallback` a propósito: esta suite certifica SOLO la puerta de contraseña, no el mTLS
    // de los agentes (eso ya lo cubre `tests/e2e/real-qa.test.ts` con `DevOnlyAuthProvider`).
  });
  await provider.ready();

  app = await buildGateway({ pool: database.pool, authProvider: provider });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  httpUrl = `http://127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  if (database?.pool) await database.pool.end();
  if (database?.container) await database.container.stop();
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
    expect(cookie).toContain('__Host-cauce_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      authenticated: true, login_mode: 'password', subject: CONSOLE_EMAIL,
      roles: [], permissions: ['read']
    });
    // El token nunca viaja en el cuerpo: si apareciera acá, un XSS se lo llevaría.
    expect(JSON.stringify(body)).not.toContain(cookieToken(cookie!).slice(0, 24));
  });

  it('FLUJOS PRINCIPALES: con sesión, la consola navega sus vistas de lectura', async () => {
    const { cookie } = await authenticatedSession();
    const reads: Array<[string, number]> = [
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
      // Superficies operativas deliberadamente excluidas de reader.
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
    const mutations: Array<{ method: 'POST' | 'PUT'; path: string; body: unknown }> = [
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

    // El token es autocontenido (documentado en `password-auth.ts::logout`): el logout NO lo
    // revoca en el servidor, sólo le dice al navegador que borre la cookie. Reenviar la cookie
    // VIEJA a mano sigue autenticando hasta que venza sola, o hasta que la cuenta se desactive o
    // le cambien la contraseña -- es la mitad documentada de la revocación, no un bug de esta
    // suite. Se mide para que quede escrito, no asumido.
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
  const cookie = rawCookie.split(';', 1)[0]!;
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

async function seedVisibleChain(): Promise<void> {
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
 * Deja constancia auditable de QUÉ cuenta se usó para certificar el login, sin depender de que
 * nadie recuerde mirar la salida de este archivo. Vive en `.test-state/` (gitignored, 700) y el
 * archivo queda en 600: sólo el dueño del proceso lo lee. La contraseña vale ÚNICAMENTE contra el
 * contenedor Postgres efímero de ESTA corrida -- se destruye en `afterAll`, así que reusar este
 * archivo después no abre nada; es evidencia de qué se certificó, no una credencial viva.
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
