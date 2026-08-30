import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DatabasePool } from '@cauce/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthProvider, Principal } from '../../services/gateway/src/auth.js';
import type { TerminalConfig } from '../../services/gateway/src/terminal/config.js';
import { registerTerminalControlPlane } from '../../services/gateway/src/terminal/plugin.js';
import { AgentRegistry } from '../../services/gateway/src/terminal/registry.js';

/**
 * Tests de integración del plugin `registerTerminalControlPlane` sobre `app.inject`.
 *
 * El plugin registra cuatro rutas de console, cinco rutas de relay y la ruta de directive
 * del governance probe. Los asserts aquí no reproducen la cobertura fina de los otros
 * ficheros del plano terminal: se concentran en validar que el plugin PUBLICA las rutas
 * correctas, que cada una devuelve 400 con motivo cuando la entrada es inválida, y que
 * un cuerpo bien formado pasa la validación de shape antes de tocar la base de datos.
 *
 * La base de datos es mínima: devuelve `[]` para todo. Las rutas que solo validan input
 * lanzan ANTES de cualquier `pool.query`, así que un fallo de validación cierra el camino
 * sin tocar la base.
 */

const MASTER = Buffer.from('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=', 'base64');
const RELAY_TOKEN = 'relay-token-that-is-long-enough-0123456789';
const RELAY_INSTANCE_ID = 'a'.repeat(64);

function consolePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    tenant_id: 'Steven', alias: 'kant', session_id: 'console-session', channel: 'console',
    roles: ['operator'], permissions: ['route', 'read', 'control'], ...overrides
  };
}

function authProvider(): AuthProvider {
  return {
    name: 'test-plugin', mode: 'test',
    authenticateHttp: async () => consolePrincipal(),
    authenticateHello: async () => consolePrincipal(),
  };
}

function emptyPool(): DatabasePool {
  return {
    query: async () => ({ rows: [], rowCount: 0 })
  } as unknown as DatabasePool;
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

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-plugin-'));
    grantsFile = join(directory, 'grants.json');
    await writeFile(grantsFile, JSON.stringify({ version: 1, grants: [] }));
    app = Fastify({ logger: false });
    await app.register(registerTerminalControlPlane, {
      pool: emptyPool(),
      authProvider: authProvider(),
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

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-plugin-validate-'));
    grantsFile = join(directory, 'grants.json');
    await writeFile(grantsFile, JSON.stringify({ version: 1, grants: [] }));
    app = Fastify({ logger: false });
    await app.register(registerTerminalControlPlane, {
      pool: emptyPool(),
      authProvider: authProvider(),
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
      tenant_id: 'Steven', alias: 'jarvis', mode: 'shell', reason: 'revisar el harness colgado',
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

  it('POST /v3/console/terminal/sessions: rechaza un reason más corto que 8 caracteres', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v3/console/terminal/sessions',
      payload: { ...validSessionBody(), reason: 'corto' }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_request', message: 'reason must be between 8 and 280 characters'
    });
  });

  it('POST /v3/console/terminal/sessions: rechaza un reason de más de 280 caracteres', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v3/console/terminal/sessions',
      payload: { ...validSessionBody(), reason: 'x'.repeat(281) }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_request', message: 'reason must be between 8 and 280 characters'
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

  it('POST /v3/console/terminal/sessions: rechaza un mode que no sea shell o harness', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v3/console/terminal/sessions',
      payload: { ...validSessionBody(), mode: 'root' }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_request', message: "mode must be 'shell' or 'harness'"
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
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_request', message: 'expected_owner_generation is invalid'
    });
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
