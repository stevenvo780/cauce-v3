import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, createPool, FleetOperationsRepository, type DatabasePool } from '@cauce/store';
import { seedDevelopmentDatabase } from '../../packages/store/src/seed-dev-cli.js';
import { buildGateway } from '../../services/gateway/src/app.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { registerTerminalControlPlane } from '../../services/gateway/src/terminal/plugin.js';
import { terminalCapabilityAnnouncement, type TerminalConfig } from '../../services/gateway/src/terminal/config.js';
import { AgentRegistry } from '../../services/gateway/src/terminal/registry.js';
import { registerClientDelegationRoutes } from '../../services/gateway/src/routes/mcp-client-delegations.js';
import { arrancarPostgresDePrueba, COMANDO_POSTGRES_DE_PRUEBA, saludDePostgresDePrueba } from '../helpers/contenedor-de-prueba.js';

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface SmokeReceipt {
  recorded_at: string;
  all_passed: boolean;
  company: string;
  parameters: {
    tenant_id: string;
    alias: string;
  };
  views: {
    id: string;
    name: string;
    ok: boolean;
    latency_avg_ms: number;
    routes: {
      path: string;
      status: number;
      latency_ms: number;
      ok: boolean;
      error: string | null;
    }[];
  }[];
}

const execFileAsync = promisify(execFile);
const OWNER = 'r6-humo-produccion';
const RUN = randomUUID().slice(0, 8);
const ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT_PATH = join(ROOT, '.delegados/v4/humo-produccion.sh');
const MODULE_PATH = join(ROOT, '.delegados/v4/humo-produccion.mjs');

let tempHome = '';
let sessionFile = '';
let sessionCookie = '';
let sessionCsrfToken = '';
let gatewayUrl = '';
let database: StartedTestContainer | undefined;
let pool: DatabasePool | undefined;
let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
let closing: Promise<void> | undefined;

function runSmokeScript(args: string[]): Promise<CliResult> {
  return execFileAsync(SCRIPT_PATH, args, {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: tempHome,
      NODE_PATH: join(ROOT, 'node_modules'),
    },
    timeout: 60_000,
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: unknown) => {
      const err = error as Error & { code?: number; stdout?: string; stderr?: string };
      return {
        code: typeof err.code === 'number' ? err.code : 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? err.message,
      };
    },
  );
}

async function closeAll(): Promise<void> {
  closing ??= (async () => {
    const activeApp = app;
    app = undefined;
    const activePool = pool;
    pool = undefined;
    const activeDatabase = database;
    database = undefined;
    const activeHome = tempHome;
    tempHome = '';

    try {
      await activeApp?.close();
    } finally {
      try {
        await activePool?.end();
      } finally {
        try {
          await activeDatabase?.stop();
        } finally {
          if (activeHome) {
            await rm(activeHome, { recursive: true, force: true });
          }
        }
      }
    }
  })();
  return closing;
}

beforeAll(async () => {
  tempHome = await mkdtemp(join(tmpdir(), `zz-canary-${OWNER}-`));
  await chmod(tempHome, 0o700);

  try {
    const dbPassword = randomBytes(24).toString('base64url');
    database = await arrancarPostgresDePrueba(() => new GenericContainer('postgres:16-alpine')
      .withName(`zz-canary-${OWNER}-${RUN}`)
      .withLabels({ 'cauce.e2e.owner': OWNER })
      .withCommand([...COMANDO_POSTGRES_DE_PRUEBA])
      .withEnvironment({ POSTGRES_DB: 'cauce_test', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: dbPassword })
      .withExposedPorts(5432)
      .withHealthCheck(saludDePostgresDePrueba('cauce_test', 'cauce_test'))
      .withWaitStrategy(Wait.forHealthCheck())
      .start());

    const dbUrl = `postgresql://cauce_test:${encodeURIComponent(dbPassword)}@${database.getHost()}:${String(database.getMappedPort(5432))}/cauce_test`;
    pool = createPool(dbUrl);

    await applyMigrations(pool);
    await seedDevelopmentDatabase(dbUrl, () => undefined);

    const email = 'owner@dev.example';
    const password = 'TestOwnerPassword123!';
    await pool.query('UPDATE console_users SET password_hash=$1 WHERE email_normalized=$2', [
      await hashPassword(password, { cost: 1024, blockSize: 8, parallelism: 1 }), email,
    ]);
    await pool.query("UPDATE human_tenant_memberships SET permissions=ARRAY['route','read','control','notify']");

    const ownerUser = (await pool.query<{ id: string }>('SELECT id FROM console_users WHERE email_normalized=$1', [email])).rows[0];
    if (!ownerUser) throw new Error('owner user was not seeded');

    await pool.query("INSERT INTO company_links(company_a,company_b,created_by) VALUES('humanizar','praxis',$1) ON CONFLICT DO NOTHING", [ownerUser.id]);
    await pool.query("INSERT INTO acl_edges(from_tenant,to_tenant,enabled,allow_route,allow_read,allow_control) VALUES('Steven','Hospital',true,true,true,true) ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO acl_edges(from_tenant,to_tenant,enabled,allow_route,allow_read,allow_control) VALUES('Hospital','Steven',true,true,true,true) ON CONFLICT DO NOTHING");

    // Seed MCP OAuth grant with NO human delegation (binding_id: null, label: null)
    const extIdentityId = randomUUID();
    await pool.query(
      "INSERT INTO human_external_identities(id, human_id, provider, namespace, subject) VALUES($1, $2, 'oauth', 'http://127.0.0.1', 'canary-oauth-sub') ON CONFLICT DO NOTHING",
      [extIdentityId, ownerUser.id],
    );
    const oauthGrantId = randomUUID();
    await pool.query(
      `INSERT INTO cauce_oauth_grants(id, human_id, issuer, resource, client_id, redirect_uri, scopes,
         binding_id, binding_revision, membership_revision, tenant_id, actor_alias, credential_stamp, expires_at)
       VALUES($1, $2, 'http://127.0.0.1', 'http://127.0.0.1/mcp', 'canary-client', 'http://127.0.0.1/callback',
         ARRAY['cauce.read'], $3, 1, 1, 'Steven', 'zeus', repeat('a', 43), clock_timestamp() + interval '1 day')
       ON CONFLICT DO NOTHING`,
      [oauthGrantId, ownerUser.id, extIdentityId],
    );

    // Seed real DLQ entry in dead_letters
    await pool.query("INSERT INTO rooms(id, tenant_id) VALUES('grp.steven', 'Steven') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO memberships(tenant_id, room_id, alias, role) VALUES('Steven', 'grp.steven', 'zeus', 'operator') ON CONFLICT DO NOTHING");
    const dlqMessageId = randomUUID();
    await pool.query(
      `INSERT INTO messages(id, request_id, trace_id, tenant_id, room_id, actor_alias, body, lane, priority)
       VALUES($1, gen_random_uuid(), 'trace-dlq', 'Steven', 'grp.steven', 'zeus', '{"text":"test dlq msg"}'::jsonb, 'interactive', 0)
       ON CONFLICT DO NOTHING`,
      [dlqMessageId],
    );
    const dlqDeliveryId = randomUUID();
    await pool.query(
      `INSERT INTO deliveries(id, message_id, recipient_tenant, recipient_alias, status)
       VALUES($1, $2, 'Steven', 'zeus', 'failed')
       ON CONFLICT DO NOTHING`,
      [dlqDeliveryId, dlqMessageId],
    );
    await pool.query(
      `INSERT INTO dead_letters(id, delivery_id, tenant_id, reason, payload, attempts, disposition, disposition_at, evidence_sha256)
       VALUES(gen_random_uuid(), $1, 'Steven', 'simulated dead letter', '{"error":"simulated"}'::jsonb, 1, 'ambiguous', clock_timestamp(), repeat('a', 64))
       ON CONFLICT DO NOTHING`,
      [dlqDeliveryId],
    );

    const grantsFile = join(tempHome, 'grants.json');
    await writeFile(grantsFile, '[]\n', { mode: 0o600 });

    const terminalConfig: TerminalConfig = {
      wsPath: '/v3/console/terminal/ws',
      ticketKey: randomBytes(32),
      relayToken: randomBytes(32).toString('hex'),
      relayInstanceIds: new Set(['lab-relay']),
      grantsFile,
      ticketTtlSeconds: 60,
      sessionTtlSeconds: 300,
      sessionMaxTotalSeconds: 600,
      claimLeaseSeconds: 150,
      maxSessionsPerOperator: 4,
      operatorHeader: 'x-terminal-operator',
      operators: new Set(['kant', email]),
    };

    const authProvider = new PasswordAuthProvider({
      users: new PostgresConsoleUserStore(pool),
      signingKey: randomBytes(32),
    });

    const backupDir = join(tempHome, 'backups');
    await mkdir(backupDir, { recursive: true, mode: 0o700 });

    app = await buildGateway({
      pool,
      logger: false,
      authProvider,
      terminalCapability: terminalCapabilityAnnouncement(terminalConfig),
      operatorResolution: { operatorHeader: terminalConfig.operatorHeader, operators: terminalConfig.operators },
      fleetOperationsRepository: new FleetOperationsRepository(pool),
      spaceBackups: { directory: backupDir, projectRoot: ROOT, python: '/usr/bin/python3' },
    });

    const registry = new AgentRegistry();
    await app.register(registerTerminalControlPlane, {
      pool,
      authProvider,
      config: terminalConfig,
      registry,
      governanceRelay: {
        readFile: async (_tenantId: string, _alias: string, path: string) => ({
          path,
          bytes: 21,
          truncated: false,
          modified_at: new Date().toISOString(),
          sha: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          content: 'CANARY_DIRECTIVE_BODY',
        }),
      },
    });

    registerClientDelegationRoutes(app, pool, authProvider, {
      issuer: 'http://127.0.0.1',
      resource: 'http://127.0.0.1/mcp',
      verifyCredentialStamp: authProvider.verifyCredentialStamp.bind(authProvider),
    });

    gatewayUrl = await app.listen({ host: '127.0.0.1', port: 0 });

    const loginRes = await fetch(`${gatewayUrl}/v3/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: gatewayUrl },
      body: JSON.stringify({ email, password }),
    });
    if (!loginRes.ok) {
      throw new Error(`login failed with HTTP ${String(loginRes.status)}`);
    }

    const setCookie = loginRes.headers.get('set-cookie');
    const cookie = setCookie ? setCookie.split(';')[0] ?? '' : '';
    const loginBody = (await loginRes.json()) as { csrf_token: string };
    const csrfToken = loginBody.csrf_token;
    sessionCookie = cookie;
    sessionCsrfToken = csrfToken;

    sessionFile = join(tempHome, 'console-session.json');
    await writeFile(
      sessionFile,
      JSON.stringify(
        {
          gateway: gatewayUrl,
          origin: gatewayUrl,
          cookie,
          csrf_token: csrfToken,
          version: 1,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
  } catch (error) {
    await closeAll();
    throw error;
  }
}, 180_000);

afterAll(closeAll, 60_000);

describe.sequential('humo-produccion.sh: pasada de humo de solo lectura para producción', () => {
  it('ejecuta la pasada completa en verde contra todas las vistas de la consola', async () => {
    const result = await runSmokeScript(['--session-file', sessionFile, '--gateway', gatewayUrl]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('PASADA DE HUMO DE PRODUCCIÓN - VISTAS DE CONSOLA (SOLO LECTURA)');
    expect(result.stdout).toContain('Total vistas: 10 | Pasadas: 10 | Fallidas: 0');
    expect(result.stdout).toContain('Veredicto final: VERDE (PASÓ)');
    expect(result.stdout).not.toContain('ROJO');
  });

  it('guarda un recibo JSON con permisos 0600 y sin secretos ni cuerpos', async () => {
    const receiptPath = join(tempHome, 'recibo-humo.json');
    const result = await runSmokeScript([
      '--session-file',
      sessionFile,
      '--gateway',
      gatewayUrl,
      '--json',
      receiptPath,
    ]);
    expect(result.code).toBe(0);

    const fileStat = await stat(receiptPath);
    expect(fileStat.mode & 0o777).toBe(0o600);

    const rawContent = await readFile(receiptPath, 'utf8');
    expect(rawContent).not.toContain('Cookie');
    expect(rawContent).not.toContain('password');
    expect(rawContent).not.toContain('csrf_token');

    const receipt = JSON.parse(rawContent) as SmokeReceipt;
    expect(receipt.all_passed).toBe(true);
    expect(receipt.company).toBe('humanizar');
    expect(receipt.views).toHaveLength(10);
    expect(receipt.views.every(view => view.ok)).toBe(true);
  });

  it('marca en rojo y sale con código 1 si una ruta está rota a propósito', async () => {
    const result = await runSmokeScript([
      '--session-file',
      sessionFile,
      '--gateway',
      gatewayUrl,
      '--romper-ruta',
      '/v3/console/topology',
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('ROJO');
    expect(result.stdout).toContain('Veredicto final: ROJO (FALLÓ)');
  });

  it('rechaza cualquier intento de POST sin salir a la red', async () => {
    const result = await runSmokeScript([
      '--session-file',
      sessionFile,
      '--gateway',
      gatewayUrl,
      '--probar-post',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Intento de POST rechazado correctamente antes de salir a la red');

    const moduleImports = (await import(MODULE_PATH)) as {
      createHttpClient: (
        session: { gateway: string; origin: string; cookie: string; csrf_token: string },
        options?: { gateway?: string },
      ) => (method: string, path: string) => Promise<unknown>;
    };

    const client = moduleImports.createHttpClient({
      gateway: 'http://127.0.0.1:1',
      origin: 'http://127.0.0.1:1',
      cookie: 'test-cookie',
      csrf_token: 'test-csrf',
    });

    await expect(client('POST', '/v3/console/messages')).rejects.toThrow('METHOD_PROHIBITED');
    await expect(client('PUT', '/v3/console/config')).rejects.toThrow('METHOD_PROHIBITED');
    await expect(client('DELETE', '/v3/console/people')).rejects.toThrow('METHOD_PROHIBITED');
    await expect(client('GET', '/v3/console/ruta-fuera-de-inventario')).rejects.toThrow('ROUTE_NOT_IN_INVENTORY');
  });

  it('valida delegación MCP con binding_id null y DLQ real sin delivery_id', async () => {
    const moduleImports = (await import(MODULE_PATH)) as {
      createHttpClient: (
        session: { gateway: string; origin: string; cookie: string; csrf_token: string },
        options?: { gateway?: string },
      ) => (method: string, path: string) => Promise<{ ok: boolean; status: number; body: unknown; error: string | null }>;
    };
    const schemasModule = (await import(join(ROOT, '.delegados/v4/humo-schemas.mjs'))) as {
      ClientConnectionsPageSchema: { safeParse: (data: unknown) => { success: boolean; data?: { items: { binding_id: string | null }[] } } };
      DlqPageSchema: { safeParse: (data: unknown) => { success: boolean; data?: { items?: Record<string, unknown>[] | null } } };
    };

    const client = moduleImports.createHttpClient({
      gateway: gatewayUrl,
      origin: gatewayUrl,
      cookie: sessionCookie,
      csrf_token: sessionCsrfToken,
    });

    const delegationsRes = await client('GET', '/v3/console/mcp/client-delegations');
    expect(delegationsRes.ok).toBe(true);
    const parsedDelegations = schemasModule.ClientConnectionsPageSchema.safeParse(delegationsRes.body);
    expect(parsedDelegations.success).toBe(true);
    expect(parsedDelegations.data?.items.some((item) => item.binding_id === null)).toBe(true);

    const dlqRes = await client('GET', '/v3/console/dlq?limit=200');
    expect(dlqRes.ok).toBe(true);
    const parsedDlq = schemasModule.DlqPageSchema.safeParse(dlqRes.body);
    expect(parsedDlq.success).toBe(true);
    expect(parsedDlq.data?.items).toBeDefined();
    expect(parsedDlq.data?.items?.length).toBeGreaterThan(0);
    for (const item of parsedDlq.data?.items ?? []) {
      expect(item).not.toHaveProperty('delivery_id');
      expect(item.id).toBeDefined();
    }
  });

  it('con --empresa aborta si la empresa activa no coincide para evitar rotar la sesión por POST', async () => {
    // Coincide con la empresa activa de la sesión (humanizar): verde
    const matchResult = await runSmokeScript([
      '--session-file',
      sessionFile,
      '--gateway',
      gatewayUrl,
      '--empresa',
      'humanizar',
    ]);
    expect(matchResult.code).toBe(0);
    expect(matchResult.stdout).toContain('Empresa: humanizar');
    expect(matchResult.stdout).toContain('Total vistas: 10 | Pasadas: 10 | Fallidas: 0');
    expect(matchResult.stdout).toContain('Veredicto final: VERDE (PASÓ)');

    // No coincide con la empresa activa de la sesión (praxis): aborta sin hacer POST
    const mismatchResult = await runSmokeScript([
      '--session-file',
      sessionFile,
      '--gateway',
      gatewayUrl,
      '--empresa',
      'praxis',
    ]);
    expect(mismatchResult.code).toBe(1);
    expect(mismatchResult.stderr).toContain('ABORT_COMPANY_MISMATCH');
    expect(mismatchResult.stderr).toContain('no coincide con la solicitada en --empresa ("praxis")');
    expect(mismatchResult.stderr).toContain('sin realizar peticiones POST');
  });
});
