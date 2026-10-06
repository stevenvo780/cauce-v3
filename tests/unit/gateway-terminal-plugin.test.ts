import { schemaBarrierReply } from '../helpers/schema-barrier.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DatabasePool } from '@cauce/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import { createConsoleCredentialStamp } from '../../services/gateway/src/console-credential-stamp.js';
import type { ConsoleUser } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider, signConsoleSession } from '../../services/gateway/src/password-auth.js';
import { MemoryConsoleUserStore } from '../../services/gateway/src/test-support/console-users.js';
import type { TerminalConfig } from '../../services/gateway/src/terminal/config.js';
import { registerTerminalControlPlane } from '../../services/gateway/src/terminal/plugin.js';
import { AgentRegistry } from '../../services/gateway/src/terminal/registry.js';

/**
 * Tests de integración del plugin `registerTerminalControlPlane` sobre `app.inject`.
 *
 * El plugin registra cuatro rutas de console, cinco rutas de relay y la ruta de directive
 * del governance probe. Los asserts aquí no reproducen la cobertura fina de los otros
 * ficheros del plano terminal: se concentran en validar que el plugin PUBLICA las rutas
 * correctas, que cada una devuelve 400 cuando la entrada es inválida, y que
 * un cuerpo bien formado pasa la validación de shape antes de tocar la base de datos.
 *
 * La base de datos es mínima: devuelve `[]` para todo. Las rutas que solo validan input
 * lanzan ANTES de cualquier `pool.query`, así que un fallo de validación cierra el camino
 * sin tocar la base.
 */

const MASTER = Buffer.from('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=', 'base64');
const RELAY_TOKEN = 'relay-token-that-is-long-enough-0123456789';
const RELAY_INSTANCE_ID = 'a'.repeat(64);

const HUMAN_ID = '11111111-1111-4111-8111-111111111111';
const PASSWORD_KEY = Buffer.alloc(32, 19);
const PASSWORD_HASH = 'unit-test-password-hash';
const PASSWORD_CHANGED_US = '0';

function authFixture() {
  const user: ConsoleUser = {
    id: HUMAN_ID, email: 'operator@example.test', display_name: 'Operator', role: 'operator',
    tenant_id: 'Steven', alias: 'kant', active: true, password_hash: PASSWORD_HASH,
    password_changed_at: 0, password_changed_at_us: PASSWORD_CHANGED_US,
  };
  const users = new MemoryConsoleUserStore([user]);
  const provider = new PasswordAuthProvider({ users, signingKey: PASSWORD_KEY });
  const issuedAt = Math.floor(Date.now() / 1_000);
  const credentialStamp = createConsoleCredentialStamp(PASSWORD_KEY, {
    userId: user.id, passwordHash: user.password_hash, passwordChangedAtUs: PASSWORD_CHANGED_US,
  });
  const token = signConsoleSession(PASSWORD_KEY, {
    iss: 'cauce-v3-gateway', aud: 'cauce-v3-console', sub: user.id,
    sid: `unit-session-${randomUUID()}`, csrf: randomUUID() + randomUUID(),
    iat: issuedAt, exp: issuedAt + 3_600, credential_stamp: credentialStamp,
  });
  return { provider, cookie: `${provider.cookieName}=${token}` };
}

type TrackedPool = DatabasePool & { query: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> };

function emptyPool(): TrackedPool {
  const query = vi.fn(async (text: string, values: readonly unknown[] = []) => {
    const schema = schemaBarrierReply(text, values);
    if (schema) return schema;
    if (text.includes('FROM console_users WHERE id=$1 FOR SHARE')) return { rows: [{
      id: HUMAN_ID, active: true, role: 'operator', tenant_id: 'Steven', alias: 'kant',
      password_changed_at: new Date(0), password_hash: PASSWORD_HASH,
      password_changed_at_us: PASSWORD_CHANGED_US,
    }], rowCount: 1 };
    if (text.includes('FROM human_tenant_memberships')) return { rows: [{
      tenant_id: 'Steven', actor_alias: 'kant', role: 'operator', permissions: ['control'],
      enabled: true, revision: '1', revoked_at: null,
    }], rowCount: 1 };
    if (text.includes('AS database_now')) return { rows: [{ database_now: new Date() }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const client = {
    query,
    release: () => undefined,
    on: () => undefined,
    off: () => undefined,
  };
  return {
    query,
    connect: vi.fn(async () => client),
  } as unknown as TrackedPool;
}

function pluginConfig(grantsFile: string): TerminalConfig {
  return {
    wsPath: '/v3/console/terminal/ws',
    ticketKey: MASTER,
    relayToken: RELAY_TOKEN,
    relayInstanceIds: new Set([RELAY_INSTANCE_ID]),
    grantsFile,
    ticketTtlSeconds: 30,
    sessionTtlSeconds: 900,
    sessionMaxTotalSeconds: 3_600,
    controlHoldSeconds: 900,
    writableTuiEnabled: true,
    claimLeaseSeconds: 150,
    maxSessionsPerOperator: 2,
    operatorHeader: 'x-cauce-operator',
    operators: new Set<string>(),
  };
}

/**
 * Determina si una ruta fue registrada: la inyectamos con un payload mínimo y comparamos
 * la respuesta contra el 404 que Fastify genera cuando una ruta NO está registrada. Una ruta
 * registrada puede responder 404 con cuerpo propio (p.ej. "agent not found"), así que la
 * distinción está en el cuerpo y el campo `error`.
 */
async function routeIsRegistered(app: FastifyInstance, method: 'GET' | 'POST' | 'DELETE' | 'HEAD' | 'PATCH' | 'PUT' | 'OPTIONS', url: string): Promise<boolean> {
  const response = await app.inject({ method, url, payload: {} });
  if (response.statusCode !== 404) return true;
  const raw: unknown = response.json();
  if (typeof raw !== 'object' || raw === null) return false;
  const body = raw as { error?: unknown };
  return typeof body.error === 'string' && body.error !== 'Not Found';
}

describe('registerTerminalControlPlane: rutas registradas', () => {
  let directory: string;
  let grantsFile: string;
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-plugin-'));
    grantsFile = join(directory, 'grants.json');
    await writeFile(grantsFile, JSON.stringify({ version: 1, grants: [] }));
    const auth = authFixture();
    cookie = auth.cookie;
    app = Fastify({ logger: false });
    app.addHook('onRequest', async (request) => {
      request.headers.cookie ??= cookie;
    });
    await app.register(registerTerminalControlPlane, {
      pool: emptyPool(),
      authProvider: auth.provider,
      config: pluginConfig(grantsFile),
      registry: new AgentRegistry(),
      repository: {
        assertPermission: async () => undefined,
        authorizeAgentTarget: async () => undefined,
      },
      governanceRelay: {
        readFile: async () => ({ error: 'unavailable' as const, reason: 'stub' })
      },
      relayPeerInstanceId: () => RELAY_INSTANCE_ID,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('publica las rutas de console esperadas', async () => {
    expect(await routeIsRegistered(app, 'POST', '/v3/console/terminal/sessions')).toBe(true);
    expect(await routeIsRegistered(app, 'GET', '/v3/console/terminal/sessions')).toBe(true);
    expect(await routeIsRegistered(app, 'POST',
      '/v3/console/terminal/sessions/11111111-1111-4111-8111-111111111111/owner')).toBe(true);
    expect(await routeIsRegistered(app, 'DELETE',
      '/v3/console/terminal/sessions/11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(await routeIsRegistered(app, 'GET', '/v3/console/terminal/targets')).toBe(true);
    expect(await routeIsRegistered(app, 'POST',
      '/v3/console/terminal/sessions/11111111-1111-4111-8111-111111111111/control')).toBe(true);
    expect(await routeIsRegistered(app, 'POST',
      '/v3/console/terminal/sessions/11111111-1111-4111-8111-111111111111/extend')).toBe(true);
  });

  it('publica las cinco rutas de relay esperadas', async () => {
    expect(await routeIsRegistered(app, 'POST', '/v3/terminal/relay/agents')).toBe(true);
    expect(await routeIsRegistered(app, 'POST',
      '/v3/terminal/relay/sessions/11111111-1111-4111-8111-111111111111/consume')).toBe(true);
    expect(await routeIsRegistered(app, 'POST',
      '/v3/terminal/relay/sessions/11111111-1111-4111-8111-111111111111/resume')).toBe(true);
    expect(await routeIsRegistered(app, 'POST',
      '/v3/terminal/relay/sessions/11111111-1111-4111-8111-111111111111/authz')).toBe(true);
    expect(await routeIsRegistered(app, 'POST',
      '/v3/terminal/relay/sessions/11111111-1111-4111-8111-111111111111/close')).toBe(true);
  });

  it('publica la ruta del directive de governance', async () => {
    expect(await routeIsRegistered(app, 'GET',
      '/v3/console/agents/Steven/jarvis/directive')).toBe(true);
  });
});

describe('registerTerminalControlPlane: validación de body', () => {
  let directory: string;
  let grantsFile: string;
  let app: FastifyInstance;
  let cookie: string;
  let pool: TrackedPool;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-plugin-validate-'));
    grantsFile = join(directory, 'grants.json');
    await writeFile(grantsFile, JSON.stringify({ version: 1, grants: [] }));
    const auth = authFixture();
    cookie = auth.cookie;
    app = Fastify({ logger: false });
    app.addHook('onRequest', async (request) => {
      request.headers.cookie ??= cookie;
    });
    pool = emptyPool();
    await app.register(registerTerminalControlPlane, {
      pool,
      authProvider: auth.provider,
      config: pluginConfig(grantsFile),
      registry: new AgentRegistry(),
      repository: {
        assertPermission: async () => undefined,
        authorizeAgentTarget: async () => undefined,
      },
      governanceRelay: {
        readFile: async () => ({ error: 'unavailable' as const, reason: 'stub' })
      },
      relayPeerInstanceId: () => RELAY_INSTANCE_ID,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  function validSessionBody(): Record<string, unknown> {
    return {
      tenant_id: 'Steven', alias: 'jarvis', mode: 'shell',
      cols: 120, rows: 40, request_id: randomUUID(), owner_token: randomUUID(),
    };
  }

  it('POST /v3/console/terminal/sessions: rechaza un body que es JSON pero no objeto', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v3/console/terminal/sessions', payload: [1, 2, 3]
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_request', message: 'session request must be an object'
    });
  });

  it('POST /v3/console/terminal/sessions: rechaza un body con campos inesperados (shape estricto)', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v3/console/terminal/sessions',
      payload: { ...validSessionBody(), unexpected: true }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_request', message: 'session request has unexpected or missing fields'
    });
  });

  it('POST /v3/console/terminal/sessions: rechaza un reason legado con menos de 8 caracteres', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v3/console/terminal/sessions',
      payload: { ...validSessionBody(), reason: 'corto' }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_request', message: 'session request has unexpected or missing fields'
    });
  });

  it('POST /v3/console/terminal/sessions: rechaza un reason legado con más de 280 caracteres', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v3/console/terminal/sessions',
      payload: { ...validSessionBody(), reason: 'x'.repeat(281) }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_request', message: 'session request has unexpected or missing fields'
    });
  });

  it('POST /v3/console/terminal/sessions: rechaza cols fuera del rango [20,500]', async () => {
    const low = await app.inject({
      method: 'POST', url: '/v3/console/terminal/sessions',
      payload: { ...validSessionBody(), cols: 19 }
    });
    expect(low.statusCode).toBe(400);
    expect(low.json()).toEqual({
      error: 'invalid_request', message: 'cols must be an integer between 20 and 500'
    });
    const high = await app.inject({
      method: 'POST', url: '/v3/console/terminal/sessions',
      payload: { ...validSessionBody(), cols: 501 }
    });
    expect(high.statusCode).toBe(400);
    expect(high.json()).toEqual({
      error: 'invalid_request', message: 'cols must be an integer between 20 and 500'
    });
  });

  it('POST /v3/console/terminal/sessions: rechaza rows fuera del rango [5,200]', async () => {
    const low = await app.inject({
      method: 'POST', url: '/v3/console/terminal/sessions',
      payload: { ...validSessionBody(), rows: 4 }
    });
    expect(low.statusCode).toBe(400);
    expect(low.json()).toEqual({
      error: 'invalid_request', message: 'rows must be an integer between 5 and 200'
    });
    const high = await app.inject({
      method: 'POST', url: '/v3/console/terminal/sessions',
      payload: { ...validSessionBody(), rows: 201 }
    });
    expect(high.statusCode).toBe(400);
    expect(high.json()).toEqual({
      error: 'invalid_request', message: 'rows must be an integer between 5 and 200'
    });
  });

  it('POST /v3/console/terminal/sessions: rechaza un mode desconocido y admite harness_rw', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v3/console/terminal/sessions',
      payload: { ...validSessionBody(), mode: 'root' }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_request', message: "mode must be 'shell', 'harness' or 'harness_rw'"
    });
    const writable = await app.inject({
      method: 'POST', url: '/v3/console/terminal/sessions',
      payload: { ...validSessionBody(), mode: 'harness_rw' }
    });
    expect(writable.statusCode).not.toBe(400);
  });

  it('POST /v3/console/terminal/sessions: initiator auto sólo abre un visor de sólo lectura', async () => {
    const readOnly = await app.inject({
      method: 'POST', url: '/v3/console/terminal/sessions',
      payload: { ...validSessionBody(), mode: 'harness', initiator: 'auto' }
    });
    expect(readOnly.statusCode).not.toBe(400);
    for (const mode of ['shell', 'harness_rw']) {
      const response = await app.inject({
        method: 'POST', url: '/v3/console/terminal/sessions',
        payload: { ...validSessionBody(), mode, initiator: 'auto' }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'invalid_request',
        message: 'a writable mode is never opened by an automatic viewer'
      });
    }
    const unknown = await app.inject({
      method: 'POST', url: '/v3/console/terminal/sessions',
      payload: { ...validSessionBody(), initiator: 'cron' }
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({
      error: 'invalid_request', message: "initiator must be 'operator' or 'auto'"
    });
  });

  it('POST /v3/console/terminal/sessions/:sid/control: valida acción, campos estrictos y proof antes de SQL', async () => {
    const url = '/v3/console/terminal/sessions/11111111-1111-4111-8111-111111111111/control';
    const fence = {
      request_id: randomUUID(), owner_generation: '1', owner_token: randomUUID(), authority_proof: 'ac2.invalid',
    };
    const noAction = await app.inject({ method: 'POST', url, payload: { ...fence, action: 'grab' } });
    expect(noAction.statusCode).toBe(400);
    expect(noAction.json()).toEqual({
      error: 'invalid_request', message: "action must be 'take' or 'release'"
    });
    const noReason = await app.inject({ method: 'POST', url, payload: { ...fence, action: 'take' } });
    expect(noReason.statusCode).toBe(403);
    expect(noReason.json()).toMatchObject({ error: 'forbidden' });
    const legacyReason = await app.inject({
      method: 'POST', url, payload: { ...fence, action: 'take', reason: 'una razón larga' },
    });
    expect(legacyReason.statusCode).toBe(400);
    expect(legacyReason.json()).toEqual({
      error: 'invalid_request', message: 'terminal control request has unexpected or missing fields'
    });
    const extra = await app.inject({
      method: 'POST', url, payload: { ...fence, action: 'release', unexpected: true },
    });
    expect(extra.statusCode).toBe(400);
    expect(extra.json()).toEqual({
      error: 'invalid_request', message: 'terminal control request has unexpected or missing fields'
    });
    expect(pool.query.mock.calls).toHaveLength(0);
    expect(pool.connect.mock.calls).toHaveLength(0);
  });

  it('POST /v3/terminal/relay/sessions/:sid/close: acepta las medidas de la grabación', async () => {
    const url = '/v3/terminal/relay/sessions/11111111-1111-4111-8111-111111111111/close';
    const report = {
      reason: 'operator_closed', exit_code: 0, bytes_in: 1_024, bytes_out: 65_536,
      relay_boot_id: randomUUID(), relay_instance_id: RELAY_INSTANCE_ID,
    };
    const recording = {
      input_batches: 7, recording_sha256: 'a'.repeat(64), recording_capped: false,
    };
    const headers = { authorization: `Bearer ${RELAY_TOKEN}` };
    const accepted = await app.inject({
      method: 'POST', url, headers, payload: { ...report, ...recording },
    });
    expect(accepted.statusCode).toBe(401);
    const withClaim = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { ...report, ...recording, claim_token: randomUUID(), claim_epoch: '1' },
    });
    expect(withClaim.statusCode).toBe(401);
    const unexpected = await app.inject({
      method: 'POST', url, headers, payload: { ...report, ...recording, unexpected: true },
    });
    expect(unexpected.statusCode).toBe(400);
    expect(unexpected.json()).toEqual({
      error: 'invalid_request', message: 'terminal close report has unexpected or missing fields'
    });
    const badDigest = await app.inject({
      method: 'POST', url, headers, payload: { ...report, ...recording, recording_sha256: 'nope' },
    });
    expect(badDigest.statusCode).toBe(400);
    expect(badDigest.json()).toEqual({
      error: 'invalid_request',
      message: 'recording_sha256 must be 64 lowercase hexadecimal characters'
    });
    const badCap = await app.inject({
      method: 'POST', url, headers, payload: { ...report, ...recording, recording_capped: 'yes' },
    });
    expect(badCap.statusCode).toBe(400);
    expect(badCap.json()).toEqual({
      error: 'invalid_request', message: 'recording_capped must be a boolean'
    });
  });

  it('POST /v3/console/terminal/sessions/:sid/extend: exige el vallado del propietario', async () => {
    const url = '/v3/console/terminal/sessions/11111111-1111-4111-8111-111111111111/extend';
    const missing = await app.inject({ method: 'POST', url, payload: { request_id: randomUUID() } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({
      error: 'invalid_request', message: 'invalid extension fields'
    });
    const badGeneration = await app.inject({
      method: 'POST',
      url,
      payload: { request_id: randomUUID(), owner_generation: '0', owner_token: randomUUID(), authority_proof: 'ac2.invalid' },
    });
    expect(badGeneration.statusCode).toBe(400);
    expect(badGeneration.json()).toEqual({
      error: 'invalid_request', message: 'owner_generation is invalid'
    });
  });

  it('POST /v3/console/terminal/sessions/:sid/owner: rechaza un body con campos faltantes', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v3/console/terminal/sessions/11111111-1111-4111-8111-111111111111/owner',
      payload: { owner_token: randomUUID() }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_request', message: 'owner rotation request has unexpected or missing fields'
    });
  });

  it('POST /v3/console/terminal/sessions/:sid/owner: rechaza un expected_owner_generation no entero positivo', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v3/console/terminal/sessions/11111111-1111-4111-8111-111111111111/owner',
      payload: {
        expected_owner_generation: 'not-a-number',
        owner_token: randomUUID(),
        request_id: randomUUID(),
        authority_proof: 'ac2.invalid',
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_request', message: 'expected_owner_generation is invalid'
    });
  });

  it.each([
    {
      route: 'control', url: '/v3/console/terminal/sessions/11111111-1111-4111-8111-111111111111/control',
      payload: { action: 'take', request_id: randomUUID(), owner_generation: '1', owner_token: randomUUID() },
    },
    {
      route: 'extend', url: '/v3/console/terminal/sessions/11111111-1111-4111-8111-111111111111/extend',
      payload: { request_id: randomUUID(), owner_generation: '1', owner_token: randomUUID() },
    },
    {
      route: 'owner', url: '/v3/console/terminal/sessions/11111111-1111-4111-8111-111111111111/owner',
      payload: { request_id: randomUUID(), expected_owner_generation: '1', owner_token: randomUUID() },
    },
  ])('rechaza proof ausente o inválido en $route antes de SQL', async ({ url, payload }) => {
    const missing = await app.inject({ method: 'POST', url, payload });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: 'invalid_request' });
    const invalid = await app.inject({ method: 'POST', url, payload: { ...payload, authority_proof: 'ac2.invalid' } });
    expect(invalid.statusCode).toBe(403);
    expect(invalid.json()).toMatchObject({ error: 'forbidden' });
    expect(pool.query.mock.calls).toHaveLength(0);
    expect(pool.connect.mock.calls).toHaveLength(0);
  });

  it('DELETE /v3/console/terminal/sessions/:sid: rechaza un body con campos faltantes', async () => {
    const response = await app.inject({
      method: 'DELETE', url: '/v3/console/terminal/sessions/11111111-1111-4111-8111-111111111111',
      payload: { owner_token: randomUUID() }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_request', message: 'terminal session release has unexpected or missing fields'
    });
  });

  it('DELETE /v3/console/terminal/sessions/:sid: rechaza un owner_generation no entero positivo', async () => {
    const response = await app.inject({
      method: 'DELETE', url: '/v3/console/terminal/sessions/11111111-1111-4111-8111-111111111111',
      payload: {
        owner_generation: '0',
        owner_token: randomUUID(),
        request_id: randomUUID(),
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_request', message: 'owner_generation is invalid'
    });
  });

  it('GET /v3/console/terminal/sessions: devuelve 200 con lista vacía cuando la base no tiene sesiones', async () => {
    const response = await app.inject({ method: 'GET', url: '/v3/console/terminal/sessions' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: unknown[] }>()).toEqual({ items: [] });
  });
});

describe('registerTerminalControlPlane: DevOnly no es autoridad de continuidad', () => {
  let directory: string;
  let app: FastifyInstance;
  let pool: TrackedPool;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-plugin-devonly-'));
    const grantsFile = join(directory, 'grants.json');
    await writeFile(grantsFile, JSON.stringify({ version: 1, grants: [] }));
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const connect = vi.fn(async () => ({ query, release: () => undefined, on: () => undefined, off: () => undefined }));
    pool = { query, connect } as unknown as TrackedPool;
    app = Fastify({ logger: false });
    await app.register(registerTerminalControlPlane, {
      pool,
      authProvider: DevOnlyAuthProvider.forTests(),
      config: pluginConfig(grantsFile),
      registry: new AgentRegistry(),
      repository: {
        assertPermission: async () => undefined,
        authorizeAgentTarget: async () => undefined,
      },
      governanceRelay: { readFile: async () => ({ error: 'unavailable' as const, reason: 'stub' }) },
      relayPeerInstanceId: () => RELAY_INSTANCE_ID,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('rechaza una sesión DevOnly antes de consultar SQL', async () => {
    const response = await app.inject({
      method: 'GET', url: '/v3/console/terminal/sessions',
      headers: { 'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'kant' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'forbidden' });
    expect(pool.query.mock.calls).toHaveLength(0);
    expect(pool.connect.mock.calls).toHaveLength(0);
  });
});

describe('POST /v3/terminal/relay/sessions/:sid/close: fila agregada de entrada', () => {
  let directory: string;
  let app: FastifyInstance;
  let audits: { action: string; metadata: Record<string, unknown> }[];

  const SESSION_ID = '11111111-1111-4111-8111-111111111111';
  const RELAY_BOOT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  function sessionRow(mode: string): Record<string, unknown> {
    return {
      id: SESSION_ID, request_id: randomUUID(), operator_id: 'steven-kant', attributed: true,
      console_subject: 'Steven:kant', tenant_id: 'Steven', alias: 'jarvis', container: 'claw',
      generation: 'gen-1', image_id: 'sha256:abc', runtime_user: 'claw', mode,
      reason: 'revisar el harness colgado', cols: 120, rows: 40, trace_id: null,
      issued_at: new Date(), expires_at: new Date(Date.now() + 30_000),
      consumed_at: new Date(Date.now() - 1_000), relay_claim_epoch: '0', relay_claim_sha256: null,
      relay_claimed_at: null, relay_claim_expires_at: null, relay_instance_id: RELAY_INSTANCE_ID,
      relay_boot_id: null, revoked_at: null, closed_at: null, close_reason: null,
      bytes_in: 0, bytes_out: 0,
    };
  }

  function closePool(mode: string): DatabasePool {
    const row = sessionRow(mode);
    const handle = async (text: string, values: unknown[] = []) => {
      const schema = schemaBarrierReply(text, values);
      if (schema) return schema;
      if (text.includes('INSERT INTO audit_events')) {
        audits.push({
          action: String(values[2]),
          metadata: JSON.parse(String(values[5])) as Record<string, unknown>,
        });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('SET closed_at=now()')) {
        return {
          rows: [{ ...row, closed_at: new Date(), bytes_in: values[2], bytes_out: values[3] }],
          rowCount: 1,
        };
      }
      if (text.includes('SELECT * FROM terminal_sessions')) return { rows: [row], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    return {
      query: handle,
      connect: async () => ({
        query: async (text: string, values: unknown[] = []) =>
          text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK'
            ? { rows: [], rowCount: 0 }
            : handle(text, values),
        release: () => undefined,
        on: () => undefined,
        off: () => undefined,
      }),
    } as unknown as DatabasePool;
  }

  async function build(mode: string): Promise<void> {
    directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-plugin-close-'));
    const grantsFile = join(directory, 'grants.json');
    await writeFile(grantsFile, JSON.stringify({ version: 1, grants: [] }));
    const registry = new AgentRegistry();
    registry.observe({ relay_instance_id: RELAY_INSTANCE_ID, relay_boot_id: RELAY_BOOT_ID }, [{
      tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: 'gen-1',
      image_id: 'sha256:abc', runtime_user: 'claw', runtime_uid: 1_000, harness: 'claude',
      modes: ['shell', 'harness', 'harness_rw'], connected_since: new Date().toISOString(),
    }]);
    app = Fastify({ logger: false });
    await app.register(registerTerminalControlPlane, {
      pool: closePool(mode),
      authProvider: authFixture().provider,
      config: pluginConfig(grantsFile),
      registry,
      repository: {
        assertPermission: async () => undefined,
        authorizeAgentTarget: async () => undefined,
      },
      governanceRelay: { readFile: async () => ({ error: 'unavailable' as const, reason: 'stub' }) },
      relayPeerInstanceId: () => RELAY_INSTANCE_ID,
    });
    await app.ready();
  }

  beforeEach(() => { audits = []; });

  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function close(mode: string, extra: Record<string, unknown>) {
    await build(mode);
    return app.inject({
      method: 'POST',
      url: `/v3/terminal/relay/sessions/${SESSION_ID}/close`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: {
        reason: 'operator_closed', exit_code: 0, bytes_in: 4_096, bytes_out: 65_536,
        relay_boot_id: RELAY_BOOT_ID, relay_instance_id: RELAY_INSTANCE_ID, ...extra,
      },
    });
  }

  it('escribe UNA fila terminal.session.input con cuentas y digest, nunca contenido', async () => {
    const response = await close('harness_rw', {
      input_batches: 7, recording_sha256: 'b'.repeat(64), recording_capped: true,
    });
    expect(response.statusCode).toBe(200);
    const input = audits.filter((row) => row.action === 'terminal.session.input');
    expect(input).toHaveLength(1);
    expect(input[0]?.metadata).toMatchObject({
      session_id: SESSION_ID,
      bytes_in: 4_096,
      input_batches: 7,
      recording_sha256: 'b'.repeat(64),
      recording_capped: true,
    });
    expect(audits.filter((row) => row.action === 'terminal.session.close')).toHaveLength(1);
  });

  it('no escribe fila de entrada cuando el informe no trae medidas de grabación', async () => {
    const response = await close('harness_rw', {});
    expect(response.statusCode).toBe(200);
    expect(audits.some((row) => row.action === 'terminal.session.input')).toBe(false);
  });

  it('no escribe fila de entrada para un modo de sólo lectura', async () => {
    const response = await close('harness', {
      input_batches: 3, recording_sha256: 'c'.repeat(64), recording_capped: false,
    });
    expect(response.statusCode).toBe(200);
    expect(audits.some((row) => row.action === 'terminal.session.input')).toBe(false);
  });
});
