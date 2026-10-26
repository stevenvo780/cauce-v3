import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { buildPublishReceipt, type Permission } from '@cauce/protocol';
import { buildGateway, type GatewayRepository } from './app.js';
import { StoreError } from '@cauce/store';
import { AuthError, validatePrincipal, type AuthProvider, type Principal } from './auth.js';
import type { ConsoleCompanyAuthority } from './console-user-authority.js';
import type { ConsoleUser } from './console-users.js';
import { MemoryConsoleUserStore } from './test-support/console-users.js';
import { hashPassword } from './password.js';
import {
  LoginThrottle, PasswordAuthProvider, PasswordWorkGate, PasswordWorkSaturated, isConsoleSurface, signConsoleSession,
} from './password-auth.js';
import { verifyConsoleCredentialStamp } from './console-credential-stamp.js';
import { fakePool, fakeRepository, noDeliveryWakes } from './test-support/gateway-doubles.js';
import type { ConsoleSessionRevocations } from './console-session-revocations.js';
import { MemoryConsoleSessionRevocations } from './test-support/console-session-revocations.js';

/**
 * Everything asserted here is asserted on the EFFECT: the real `Set-Cookie` header, the real
 * status code and the real response body. Nothing is taken as good just because the type compiles.
 */

// scrypt at production cost takes ~100 ms per verification; in tests the parameter travels
// inside the hash, so lowering it does NOT change the code being tested.
const TEST_SCRYPT = { cost: 1_024, blockSize: 8, parallelism: 1 };
const PASSWORD = 'una-frase-de-paso-larga';
const EMAIL = 'operator@example.test';

function repositoryDouble(): {
  repository: GatewayRepository;
  publish: ReturnType<typeof vi.fn>;
  enqueueJob: ReturnType<typeof vi.fn>;
  applyConfigurationChange: ReturnType<typeof vi.fn>;
  rollbackConfiguration: ReturnType<typeof vi.fn>;
  replayDelivery: ReturnType<typeof vi.fn>;
  cancelDelivery: ReturnType<typeof vi.fn>;
} {
  const publish = vi.fn(async (input: Parameters<GatewayRepository['publish']>[0]) => {
    return buildPublishReceipt(input, {
      message_id: '11111111-2222-4333-8444-555555555556',
      delivery_ids: ['21111111-2222-4333-8444-555555555556'],
      duplicate: false,
      request_id: input.request_id,
      trace_id: input.trace_id,
    });
  });
  const enqueueJob = vi.fn(async () => 'job-no-debe-crearse');
  const applyConfigurationChange = vi.fn(async () => ({ applied: true }));
  const rollbackConfiguration = vi.fn(async () => ({ applied: true }));
  const replayDelivery = vi.fn(async () => ({ replayed: true }));
  const cancelDelivery = vi.fn(async () => ({ cancelled: true }));
  return {
    publish,
    enqueueJob,
    applyConfigurationChange,
    rollbackConfiguration,
    replayDelivery,
    cancelDelivery,
    repository: fakeRepository({
      status: vi.fn(async () => ({ online: 1 })),
      principalAccess: vi.fn(async () => ({
        roles: ['operator'], permissions: ['route', 'read', 'control'] as Permission[],
      })),
      topology: vi.fn(async () => ({ tenants: [], acl_edges: [] })),
      listMessages: vi.fn(async () => ({ items: [], next_cursor: null })),
      queueSnapshot: vi.fn(async () => ({ pending: 0, retrying: 0, dead: 0, items: [] })),
      listJobs: vi.fn(async () => ({ items: [] })),
      enqueueJob,
      listAdapters: vi.fn(async () => ({ items: [] })),
      fleetActivity: vi.fn(async () => ({ observed_at: new Date().toISOString(), agents: [] })),
      listAgents: vi.fn(async () => ({ items: [] })),
      getAgent: vi.fn(async (alias: string) => ({ tenant_id: 'Steven', alias })),
      getAgentByIdentity: vi.fn(async (tenantId: string, alias: string) => ({ tenant_id: tenantId, alias })),
      listOriginRelays: vi.fn(async () => ({ items: [] })),
      listAudit: vi.fn(async () => ({ items: [], next_cursor: null })),
      agentChain: vi.fn(async (traceId: string) => ({
        trace_id: traceId, nodes: [], edges: [], origin_relays: [], redacted_endpoints: 0,
      })),
      getConfiguration: vi.fn(async () => ({ revision: 0, tenants: [], rooms: [], memberships: [] })),
      applyConfigurationChange,
      rollbackConfiguration,
      replayDelivery,
      cancelDelivery,
      publish,
      verifyPublishReceipt: vi.fn(async () => true),
    }),
  };
}

async function makeUser(overrides: Partial<ConsoleUser> = {}): Promise<ConsoleUser> {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    email: EMAIL,
    display_name: 'Operator',
    role: 'operator',
    tenant_id: 'Steven',
    alias: 'kant',
    active: true,
    password_hash: await hashPassword(PASSWORD, TEST_SCRYPT),
    password_changed_at: 0,
    ...overrides
  };
}

/** Double of the agents' mTLS: it ignores cookies and always returns the same principal. */
class StubAgentProvider implements AuthProvider {
  readonly name = 'stub-mtls';
  readonly mode = 'production' as const;
  calls = 0;

  private principal(): Principal {
    this.calls += 1;
    return validatePrincipal({
      tenant_id: 'Steven',
      alias: 'jarvis',
      session_id: 'mtls:jarvis',
      channel: 'adapter',
      roles: ['agent'],
      permissions: ['route', 'read']
    });
  }

  async authenticateHttp(): Promise<Principal> { return this.principal(); }
  async authenticateHello(): Promise<Principal> { return this.principal(); }
}

/**
 * Double of the console PROXY client certificate, as provisioned in production: `Steven:kant`,
 * `channel: console`, `operator` role. nginx presents it on EVERYTHING it proxies, so without
 * the channel gate a browser without a session enters as operator.
 */
class StubConsoleProxyProvider implements AuthProvider {
  readonly name = 'stub-console-proxy';
  readonly mode = 'production' as const;
  calls = 0;

  private principal(): Principal {
    this.calls += 1;
    return validatePrincipal({
      tenant_id: 'Steven',
      alias: 'kant',
      session_id: 'mtls:console-client',
      channel: 'console',
      roles: ['operator'],
      permissions: ['route', 'read', 'control']
    });
  }

  async authenticateHttp(): Promise<Principal> { return this.principal(); }
  async authenticateHello(): Promise<Principal> { return this.principal(); }
}

async function fixture(options: {
  user?: ConsoleUser;
  fallback?: AuthProvider;
  throttle?: LoginThrottle;
  addressThrottle?: LoginThrottle;
  companyAuthority?: ConsoleCompanyAuthority;
  sessionMaxMs?: number;
  revocations?: boolean;
  sessionRevocations?: ConsoleSessionRevocations;
} = {}) {
  let now = Date.UTC(2026, 7, 6, 12, 0, 0);
  const user = options.user ?? await makeUser();
  const users = new MemoryConsoleUserStore([user]);
  const provider = new PasswordAuthProvider({
    users,
    signingKey: Buffer.alloc(32, 7),
    sessionTtlMs: 60 * 60 * 1_000,
    ...(options.sessionMaxMs === undefined ? {} : { sessionMaxMs: options.sessionMaxMs }),
    ...(options.sessionRevocations === undefined ? {} : { sessionRevocations: options.sessionRevocations }),
    ...(options.revocations === true ? { sessionRevocations: new MemoryConsoleSessionRevocations() } : {}),
    companyAuthority: options.companyAuthority ?? {
      resolve: async () => ({ role: 'tenant_operator', scope: 'tenant', home_company: 'humanizar',
        acting_company: 'humanizar', platform_override: false }),
      switchCompany: async () => { throw new Error('company switching is outside these fixtures'); },
    },
    now: () => now,
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
    ...(options.throttle === undefined ? {} : { throttle: options.throttle }),
    ...(options.addressThrottle === undefined ? {} : { addressThrottle: options.addressThrottle })
  });
  const fake = repositoryDouble();
  const app = await buildGateway({
    pool: fakePool({ ssl: true }),
    authProvider: provider,
    repository: fake.repository,
    deliveryWakeSubscriber: noDeliveryWakes
  });
  return {
    app,
    provider,
    ...fake,
    users,
    advance(ms: number) { now += ms; },
    login(email: string, password: string, remoteAddress = '127.0.0.1') {
      return app.inject({
        method: 'POST', url: '/v3/auth/login', remoteAddress,
        headers: { origin: 'http://localhost' },
        payload: { email, password }
      });
    }
  };
}

function cookieFrom(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const values = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
  const selected = values.find((value) => value.startsWith('__Host-cauce_session='));
  if (!selected) throw new Error('la respuesta no trae la cookie de sesión');
  const [cookie] = selected.split(';', 1);
  if (cookie === undefined) throw new Error('la respuesta no trae la cookie de sesión');
  return cookie;
}

describe('login por contraseña de la consola', () => {
  it('reader navega lecturas generales y no puede ejecutar ninguna mutación de consola', async () => {
    const test = await fixture({ user: await makeUser({ role: 'reader' }) });
    try {
      const login = await test.login(EMAIL, PASSWORD);
      expect(login.statusCode).toBe(200);
      expect(login.json()).toMatchObject({ roles: [], permissions: ['read'] });
      const cookie = cookieFrom(login.headers);
      const csrf = login.json<{ csrf_token: string }>().csrf_token;

      const reads = [
        '/v3/console/access',
        '/v3/console/topology',
        '/v3/console/messages',
        '/v3/console/queues',
        '/v3/console/jobs',
        '/v3/console/adapters',
        '/v3/console/activity',
        '/v3/console/agents',
        '/v3/console/agents/kant',
        '/v3/console/tenants/Steven/agents/kant',
        '/v3/console/audit',
        '/v3/console/chains/trace-reader',
        '/v3/console/config',
        '/v3/console/observability',
      ];
      for (const url of reads) {
        const response = await test.app.inject({ method: 'GET', url, headers: { cookie } });
        expect(response.statusCode, url).toBe(200);
      }

      const mutationHeaders = {
        cookie,
        origin: 'http://localhost',
        'x-csrf-token': csrf,
      };
      const mutations: {
        method: 'POST' | 'PUT'; url: string; payload: Record<string, unknown>;
      }[] = [
        {
          method: 'POST', url: '/v3/console/messages',
          payload: {
            room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }],
            body: { text: 'no debe publicarse' }, idempotency_key: 'reader-no-publish',
          },
        },
        {
          method: 'POST', url: '/v3/console/jobs',
          payload: { lane: 'batch', priority: 0, kind: 'system.database.probe', payload: {} },
        },
        {
          method: 'POST', url: '/v3/console/config/changes',
          payload: {
            dry_run: false, expected_revision: 0,
            mutation: { resource: 'tenant', action: 'update', id: 'Steven', value: { enabled: true } },
          },
        },
        {
          method: 'POST', url: '/v3/console/config/revisions/1/rollback',
          payload: { dry_run: false, expected_revision: 0 },
        },
        {
          method: 'POST', url: '/v3/console/deliveries/20000000-0000-4000-8000-000000000001/replay',
          payload: {},
        },
        {
          method: 'POST', url: '/v3/console/deliveries/20000000-0000-4000-8000-000000000001/cancel',
          payload: { reason: 'reader no cancela' },
        },
        {
          method: 'PUT', url: '/v3/console/tenants/Steven/agents/kant/perfil',
          payload: { expected_revision: null, profile: {} },
        },
        {
          method: 'PUT', url: '/v3/console/tenants/Steven/agents/kant/documents/directive/content',
          payload: { content: 'no escribir', create_if_absent: true },
        },
      ];
      for (const mutation of mutations) {
        const response = await test.app.inject({ ...mutation, headers: mutationHeaders });
        expect(response.statusCode, `${mutation.method} ${mutation.url}`).toBe(403);
      }

      expect(test.publish).not.toHaveBeenCalled();
      expect(test.enqueueJob).not.toHaveBeenCalled();
      expect(test.applyConfigurationChange).not.toHaveBeenCalled();
      expect(test.rollbackConfiguration).not.toHaveBeenCalled();
      expect(test.replayDelivery).not.toHaveBeenCalled();
      expect(test.cancelDelivery).not.toHaveBeenCalled();
    } finally {
      await test.app.close();
    }
  });

  it('una persona con nombre y permiso control pasa la puerta de atribución del PUT de documentos', async () => {
    const test = await fixture();
    try {
      const login = await test.login(EMAIL, PASSWORD);
      const response = await test.app.inject({
        method: 'PUT', url: '/v3/console/tenants/Steven/agents/kant/documents/directive/content',
        headers: {
          cookie: cookieFrom(login.headers),
          origin: 'http://localhost',
          'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token,
        },
        payload: { content: 'escrito con nombre', create_if_absent: true, reason: 'prueba del cableado del operador' },
      });
      // Past the person gate the degraded probe answers: the write is refused for lack of facts, not of a name.
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: string }>().error).toBe('no_medido');
    } finally {
      await test.app.close();
    }
  });

  it('publica sin fabricar un origin_relay hacia un adapter console inexistente', async () => {
    const test = await fixture();
    try {
      const login = await test.login(EMAIL, PASSWORD);
      const cookie = cookieFrom(login.headers);
      const csrf = login.json<{ csrf_token: string }>().csrf_token;
      const response = await test.app.inject({
        method: 'POST',
        url: '/v3/console/messages',
        headers: { cookie, origin: 'http://localhost', 'x-csrf-token': csrf },
        payload: {
          room_id: 'ops',
          recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }],
          body: { type: 'operator.message', text: 'contenido de prueba' },
          idempotency_key: 'console-no-fake-origin',
        },
      });

      expect(response.statusCode).toBe(202);
      expect(test.publish).toHaveBeenCalledTimes(1);
      const command = test.publish.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(command.authenticated_context).toMatchObject({ channel: 'console' });
      expect(command.authenticated_context).not.toHaveProperty('origin');
    } finally {
      await test.app.close();
    }
  });

  it('entrega la sesión en una cookie HttpOnly+Secure+SameSite y NUNCA en el cuerpo', async () => {
    const test = await fixture();
    try {
      const login = await test.login('Operator@Example.Test', PASSWORD);
      expect(login.statusCode).toBe(200);
      const rawCookie = String(login.headers['set-cookie']);
      expect(rawCookie).toContain('HttpOnly');
      expect(rawCookie).toContain('Secure');
      expect(rawCookie).toContain('SameSite=Strict');
      expect(rawCookie).toContain('Path=/');
      const cookie = cookieFrom(login.headers);
      // The token goes ONLY in the cookie: if it appeared in the body, an XSS would carry it away.
      const token = cookie.split('=')[1];
      if (token === undefined) throw new Error('la cookie de sesión no contiene un token');
      expect(JSON.stringify(login.json())).not.toContain(token.slice(0, 24));
      expect(login.json()).toMatchObject({
        authenticated: true, login_mode: 'password', subject: EMAIL, name: 'Operator'
      });

      const session = await test.app.inject({ method: 'GET', url: '/v3/auth/session', headers: { cookie } });
      expect(session.statusCode).toBe(200);
      expect(session.json()).toMatchObject({
        authenticated: true, subject: EMAIL, roles: ['operator']
      });

      const api = await test.app.inject({ method: 'GET', url: '/v3/status', headers: { cookie } });
      expect(api.statusCode).toBe(200);
      expect(api.json()).toMatchObject({ auth_provider: 'console-password' });
    } finally {
      await test.app.close();
    }
  });

  it('sella la contraseña exacta que se verificó aunque el registro cambie antes de emitir la cookie', async () => {
    const original = await makeUser();
    const test = await fixture({ user: original });
    const replacement = await makeUser({
      password_hash: await hashPassword('otra-frase-de-paso-larga', TEST_SCRYPT),
      password_changed_at: original.password_changed_at
    });
    const findByEmail = test.users.findByEmail.bind(test.users);
    vi.spyOn(test.users, 'findByEmail').mockImplementation(async (email) => {
      const verifiedCandidate = await findByEmail(email);
      queueMicrotask(() => { test.users.put(replacement); });
      return verifiedCandidate;
    });

    try {
      const login = await test.login(original.email, PASSWORD);
      expect(login.statusCode).toBe(200);
      const token = cookieFrom(login.headers).split('=', 2)[1]?.split(';', 1)[0];
      expect(token).toBeDefined();
      const encodedPayload = token?.split('.')[1];
      if (encodedPayload === undefined) throw new Error('la cookie de sesión no incluye un payload');
      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as {
        credential_stamp?: string;
      };
      expect(payload.credential_stamp).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const stamp = payload.credential_stamp;
      if (stamp === undefined) throw new Error('la sesión no incluye sello de credenciales');
      const key = Buffer.alloc(32, 7);
      const snapshot = (user: ConsoleUser) => ({ userId: user.id, passwordHash: user.password_hash,
        passwordChangedAtUs: user.password_changed_at_us ?? String(user.password_changed_at * 1_000) });
      expect(verifyConsoleCredentialStamp(key, stamp, snapshot(original))).toBe(true);
      expect(verifyConsoleCredentialStamp(key, stamp, snapshot(replacement))).toBe(false);
      expect(login.body).not.toContain(original.password_hash);
      expect(login.body).not.toContain(replacement.password_hash);
      const current = await test.users.findById(original.id);
      expect(current?.password_hash).toBe(replacement.password_hash);
      const stale = await test.app.inject({ method: 'GET', url: '/v3/auth/session', headers: {
        cookie: cookieFrom(login.headers)
      } });
      expect(stale.json()).toMatchObject({ authenticated: false, login_mode: 'password' });
    } finally {
      await test.app.close();
    }
  });

  it('mantiene la lectura de cookies antiguas pero rechaza su uso para una publicación durable', async () => {
    const test = await fixture();
    const prepare = vi.spyOn(test.repository, 'prepareConsolePublishIntent');
    const csrf = Buffer.alloc(32, 9).toString('base64url');
    const token = signConsoleSession(Buffer.alloc(32, 7), {
      iss: 'cauce-v3-gateway', aud: 'cauce-v3-console', sub: '11111111-2222-4333-8444-555555555555',
      sid: 'legacy-session-identifier', csrf, iat: 1_786_017_600, exp: 1_786_021_200
    });
    const cookie = `__Host-cauce_session=${token}`;
    try {
      const session = await test.app.inject({ method: 'GET', url: '/v3/auth/session', headers: { cookie } });
      expect(session.json()).toMatchObject({ authenticated: true, login_mode: 'password' });

      const durable = await test.app.inject({ method: 'POST', url: '/v3/console/publish-intents',
        headers: { cookie, origin: 'http://localhost', 'x-csrf-token': csrf }, payload: {} });
      expect(durable.statusCode).toBe(403);
      expect(durable.json()).toMatchObject({ error: 'forbidden' });
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      await test.app.close();
    }
  });

  it('sin cookie no hay sesión ni acceso a la API', async () => {
    const test = await fixture();
    try {
      const session = await test.app.inject({ method: 'GET', url: '/v3/auth/session' });
      expect(session.statusCode).toBe(200);
      expect(session.json()).toEqual({ authenticated: false, login_mode: 'password' });
      expect((await test.app.inject({ method: 'GET', url: '/v3/status' })).statusCode).toBe(401);
    } finally {
      await test.app.close();
    }
  });

  it('contraseña mala, correo inexistente y cuenta apagada contestan EXACTAMENTE lo mismo', async () => {
    const test = await fixture({ user: await makeUser({ active: false, email: 'apagada@example.test' }) });
    try {
      const wrongPassword = await test.login('apagada@example.test', 'no-es-la-contraseña');
      const unknownEmail = await test.login('nadie@example.test', PASSWORD);
      const disabled = await test.login('apagada@example.test', PASSWORD);

      for (const response of [wrongPassword, unknownEmail, disabled]) {
        expect(response.statusCode).toBe(401);
        expect(response.headers['set-cookie']).toBeUndefined();
      }
      // Literal equality is the guarantee: if someone tomorrow adds "user not found", this test
      // breaks. The message cannot be a directory of who has an account.
      expect(unknownEmail.body).toBe(wrongPassword.body);
      expect(disabled.body).toBe(wrongPassword.body);
      expect(wrongPassword.json()).toEqual({
        error: 'unauthorized', message: 'Correo o contraseña incorrectos.'
      });
    } finally {
      await test.app.close();
    }
  });

  it('el token vence de verdad y la sesión vencida lo dice', async () => {
    const test = await fixture();
    try {
      const cookie = cookieFrom((await test.login(EMAIL, PASSWORD)).headers);
      expect((await test.app.inject({ method: 'GET', url: '/v3/status', headers: { cookie } })).statusCode).toBe(200);

      test.advance(61 * 60 * 1_000);
      expect((await test.app.inject({ method: 'GET', url: '/v3/status', headers: { cookie } })).statusCode).toBe(401);
      const session = await test.app.inject({ method: 'GET', url: '/v3/auth/session', headers: { cookie } });
      const state = session.json<{ authenticated: boolean; reason?: string }>();
      expect(state.authenticated).toBe(false);
      expect(state.reason).toMatch(/venció/);
    } finally {
      await test.app.close();
    }
  });

  it('desactivar la cuenta o cambiar la contraseña corta las sesiones ya abiertas', async () => {
    const test = await fixture();
    try {
      const cookie = cookieFrom((await test.login(EMAIL, PASSWORD)).headers);
      expect((await test.app.inject({ method: 'GET', url: '/v3/status', headers: { cookie } })).statusCode).toBe(200);

      test.users.put(await makeUser({ active: false }));
      expect((await test.app.inject({ method: 'GET', url: '/v3/status', headers: { cookie } })).statusCode).toBe(401);

      // And the other half: active account, but password changed AFTER issuing the token.
      test.users.put(await makeUser({ password_changed_at: Date.UTC(2026, 7, 6, 13, 0, 0) }));
      expect((await test.app.inject({ method: 'GET', url: '/v3/status', headers: { cookie } })).statusCode).toBe(401);
    } finally {
      await test.app.close();
    }
  });

  it('una autoridad de empresa irresoluble no tumba la sesión, pero una identidad cambiada sí', async () => {
    const resolve = vi.fn<ConsoleCompanyAuthority['resolve']>()
      .mockRejectedValueOnce(Object.assign(new Error('permission denied for function cauce_company_authority'), { code: '42501' }))
      .mockRejectedValueOnce(new StoreError('forbidden', 'company authority is unavailable'));
    const test = await fixture({ companyAuthority: { resolve, switchCompany: vi.fn() } });
    try {
      const cookie = cookieFrom((await test.login(EMAIL, PASSWORD)).headers);
      const state = async () => (await test.app.inject({ method: 'GET', url: '/v3/auth/session', headers: { cookie } }))
        .json<Record<string, unknown>>();
      const degraded = await state();
      expect(degraded).toMatchObject({ authenticated: true, subject: EMAIL });
      expect(degraded).not.toHaveProperty('authority');
      expect(await state()).toEqual({ authenticated: false, login_mode: 'password' });
      expect((await test.app.inject({ method: 'GET', url: '/v3/status', headers: { cookie } })).statusCode).toBe(200);
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      await test.app.close();
    }
  });

  it('las escrituras con cookie exigen CSRF y el logout borra la cookie', async () => {
    const test = await fixture();
    try {
      const login = await test.login(EMAIL, PASSWORD);
      const cookie = cookieFrom(login.headers);
      const csrf = login.json<{ csrf_token: string }>().csrf_token;

      const withoutToken = await test.app.inject({
        method: 'POST', url: '/v3/auth/logout', headers: { cookie, origin: 'http://localhost' }
      });
      expect(withoutToken.statusCode).toBe(403);

      const logout = await test.app.inject({
        method: 'POST', url: '/v3/auth/logout',
        headers: { cookie, origin: 'http://localhost', 'x-csrf-token': csrf }
      });
      expect(logout.statusCode).toBe(204);
      expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');
    } finally {
      await test.app.close();
    }
  });

  it('el mTLS de los agentes sigue entrando: sin cookie no hay CSRF ni cookie que pedir', async () => {
    const fallback = new StubAgentProvider();
    const test = await fixture({ fallback });
    try {
      const api = await test.app.inject({ method: 'GET', url: '/v3/status' });
      expect(api.statusCode).toBe(200);
      expect(fallback.calls).toBeGreaterThan(0);

      // An agent POST must NOT be trapped by the console's CSRF guard: it reaches routing
      // (404 for unknown route), not dying in 401/403 before touching the router.
      const write = await test.app.inject({ method: 'POST', url: '/v3/inexistente' });
      expect(write.statusCode).toBe(404);

      // And with a console cookie, the same POST does pass through the guard.
      const cookie = cookieFrom((await test.login(EMAIL, PASSWORD)).headers);
      const guarded = await test.app.inject({
        method: 'POST', url: '/v3/inexistente', headers: { cookie, origin: 'http://localhost' }
      });
      expect(guarded.statusCode).toBe(403);
    } finally {
      await test.app.close();
    }
  });

  it('el certificado del PROXY de la consola no reemplaza a una sesión: sin cookie, 401', async () => {
    // Console routes require an authenticated user session with a cookie,
    // rejecting anonymous accesses even when they come from the TLS proxy.
    const fallback = new StubConsoleProxyProvider();
    const test = await fixture({ fallback });
    try {
      const anonymous = await test.app.inject({ method: 'GET', url: '/v3/status' });
      expect(anonymous.statusCode).toBe(401);
      // The fallback was consulted: the gate sits AFTER resolving the machine identity.
      expect(fallback.calls).toBeGreaterThan(0);

      // And across the whole console surface, not only on the front page. `/v3/console/activity`
      // is the endpoint where the hole was measured.
      for (const url of ['/v3/console/activity', '/v3/console/audit', '/v3/console/queues']) {
        const leak = await test.app.inject({ method: 'GET', url });
        expect(leak.statusCode, url).toBe(401);
      }

      // And the login screen must remain reachable, otherwise there is no way to log in.
      const session = await test.app.inject({ method: 'GET', url: '/v3/auth/session' });
      expect(session.statusCode).toBe(200);
      expect(session.json()).toMatchObject({ authenticated: false, login_mode: 'password' });

      // With a session, the same endpoint answers.
      const cookie = cookieFrom((await test.login(EMAIL, PASSWORD)).headers);
      const authenticated = await test.app.inject({ method: 'GET', url: '/v3/status', headers: { cookie } });
      expect(authenticated.statusCode).toBe(200);
    } finally {
      await test.app.close();
    }
  });

  it('el mismo certificado del proxy SÍ entra al bus: la puerta es la ruta, no el canal', async () => {
    // Session-based auth applies to console routes, not to bus operations.
    const fallback = new StubConsoleProxyProvider();
    const test = await fixture({ fallback });
    try {
      // The bus surface does not die at authentication: the request REACHES the router. A 404
      // for an unknown route proves it passed the gate; a 401 would prove it did not.
      const bus = await test.app.inject({ method: 'POST', url: '/v3/inexistente' });
      expect(bus.statusCode).toBe(404);

      // And the principal coming out of the fallback is the machine one, with its `control` intact.
      const machine = await test.provider.authenticateHttp({
        url: '/v3/messages', headers: {}
      } as unknown as FastifyRequest);
      expect(machine.channel).toBe('console');
      expect(machine.permissions).toContain('control');
      expect(machine.permissions).toContain('route');

      // The other half, in the same test and with the SAME principal: the console stays closed.
      await expect(test.provider.authenticateHttp({
        url: '/v3/console/activity', headers: {}
      } as unknown as FastifyRequest)).rejects.toThrow(AuthError);
    } finally {
      await test.app.close();
    }
  });

  it('cerrar la puerta de la consola NO cierra la de los agentes: el adaptador sigue entrando', async () => {
    // The other half of the fix, and the one we must not break: the same request without a
    // cookie, with an `adapter` channel principal, must keep passing. If this breaks, the fleet
    // goes mute (adapters and the quota collector enter with their own certificate).
    const fallback = new StubAgentProvider();
    const test = await fixture({ fallback });
    try {
      const api = await test.app.inject({ method: 'GET', url: '/v3/status' });
      expect(api.statusCode).toBe(200);
    } finally {
      await test.app.close();
    }
  });

  it('la identidad del operador sale del usuario, no de la cabecera que inyecta el proxy', async () => {
    const test = await fixture();
    try {
      const cookie = cookieFrom((await test.login(EMAIL, PASSWORD)).headers);
      const principal = await test.provider.authenticateHttp({
        headers: { cookie, 'x-cauce-operator': 'steven' }
      } as unknown as FastifyRequest);
      expect(principal.operator_id).toBe(EMAIL);
      const account = await test.users.findByEmail(EMAIL);
      expect(principal.operator_profile).toEqual({ id: `console:${account?.id ?? ''}`, display_name: 'Operator' });
      expect(principal.channel).toBe('console');
    } finally {
      await test.app.close();
    }
  });

  it('frena la fuerza bruta después de varios intentos fallidos', async () => {
    const test = await fixture({ throttle: new LoginThrottle(3, 60_000) });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect((await test.login(EMAIL, 'mal')).statusCode).toBe(401);
      }
      const blocked = await test.login(EMAIL, PASSWORD);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBeDefined();
    } finally {
      await test.app.close();
    }
  });

  it('frena por dirección real a quien prueba muchos correos distintos desde la misma IP', async () => {
    const test = await fixture({ addressThrottle: new LoginThrottle(3, 60_000) });
    try {
      for (const email of ['uno@example.test', 'dos@example.test', 'tres@example.test']) {
        expect((await test.login(email, 'mal', '203.0.113.7')).statusCode).toBe(401);
      }
      const blocked = await test.login(EMAIL, PASSWORD, '203.0.113.7');
      expect([blocked.statusCode, Number(blocked.headers['retry-after']) > 0]).toEqual([429, true]);
      expect((await test.login('cuatro@example.test', 'mal', '203.0.113.8')).statusCode).toBe(401);
      expect((await test.login(EMAIL, PASSWORD, '203.0.113.9')).statusCode).toBe(200);
    } finally {
      await test.app.close();
    }
  });

  it('un login correcto no limpia el cupo de la dirección', async () => {
    const test = await fixture({ addressThrottle: new LoginThrottle(2, 60_000) });
    try {
      expect((await test.login('uno@example.test', 'mal', '203.0.113.7')).statusCode).toBe(401);
      expect((await test.login(EMAIL, PASSWORD, '203.0.113.7')).statusCode).toBe(200);
      expect((await test.login('dos@example.test', 'mal', '203.0.113.7')).statusCode).toBe(401);
      expect((await test.login(EMAIL, PASSWORD, '203.0.113.7')).statusCode).toBe(429);
    } finally {
      await test.app.close();
    }
  });

  it('rechaza una clave de firma corta en vez de arrancar con una sesión falsificable', async () => {
    expect(() => new PasswordAuthProvider({
      users: new MemoryConsoleUserStore(), signingKey: Buffer.alloc(16)
    })).toThrow(/32 bytes/);
  });

  it('un token firmado con otra clave no vale', async () => {
    const test = await fixture();
    try {
      const cookie = cookieFrom((await test.login(EMAIL, PASSWORD)).headers);
      const forged = new PasswordAuthProvider({
        users: test.users, signingKey: Buffer.alloc(32, 9)
      });
      await expect(forged.authenticateHttp({ headers: { cookie } } as unknown as FastifyRequest))
        .rejects.toBeInstanceOf(AuthError);
    } finally {
      await test.app.close();
    }
  });
});

describe('sesión deslizante de la consola', () => {
  const HOUR = 60 * 60 * 1_000;
  const renewedCookie = (headers: Record<string, unknown>): string | undefined => {
    const raw = headers['set-cookie'];
    const values = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
    return values.find((value) => value.startsWith('__Host-cauce_session='))?.split(';', 1)[0];
  };
  const expiryOf = (cookie: string): number => {
    const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
    return (JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp: number }).exp * 1_000;
  };
  const use = (test: Awaited<ReturnType<typeof fixture>>, cookie: string) =>
    test.app.inject({ method: 'GET', url: '/v3/status', headers: { cookie } });

  it('una sesión en uso extiende su vencimiento y conserva sid, CSRF y empresa', async () => {
    const test = await fixture();
    try {
      const login = await test.login(EMAIL, PASSWORD);
      const first = cookieFrom(login.headers);
      expect(renewedCookie((await use(test, first)).headers)).toBeUndefined();

      test.advance(40 * 60 * 1_000);
      const slid = await use(test, first);
      expect(slid.statusCode).toBe(200);
      const second = renewedCookie(slid.headers);
      expect(second).toBeDefined();
      expect(String(slid.headers['set-cookie'])).toMatch(/HttpOnly; Secure; SameSite=Strict; Max-Age=3600/);
      expect(expiryOf(second as string)).toBe(expiryOf(first) + 40 * 60 * 1_000);
      const claims = (cookie: string) => JSON.parse(Buffer.from(decodeURIComponent(cookie.split('=')[1] as string).split('.')[1] as string, 'base64url')
        .toString('utf8')) as Record<string, unknown>;
      expect({ ...claims(second as string), exp: 0 }).toEqual({ ...claims(first), exp: 0 });

      test.advance(40 * 60 * 1_000);
      expect((await use(test, first)).statusCode).toBe(401);
      expect((await use(test, second as string)).statusCode).toBe(200);
    } finally {
      await test.app.close();
    }
  });

  it('el estado de sesión que consulta la consola renueva en segundo plano', async () => {
    const test = await fixture();
    try {
      let cookie = cookieFrom((await test.login(EMAIL, PASSWORD)).headers);
      for (let minute = 0; minute < 5 * 60; minute += 1) {
        test.advance(60 * 1_000);
        const poll = await test.app.inject({ method: 'GET', url: '/v3/auth/session', headers: { cookie } });
        expect(poll.json<{ authenticated: boolean }>().authenticated).toBe(true);
        cookie = renewedCookie(poll.headers) ?? cookie;
      }
    } finally {
      await test.app.close();
    }
  });

  it('el tope absoluto desde el login no se extiende con actividad y luego exige login', async () => {
    const test = await fixture({ sessionMaxMs: 3 * HOUR });
    try {
      const loginAt = Date.UTC(2026, 7, 6, 12, 0, 0);
      let cookie = cookieFrom((await test.login(EMAIL, PASSWORD)).headers);
      for (let step = 0; step < 4; step += 1) {
        test.advance(40 * 60 * 1_000);
        const response = await use(test, cookie);
        expect(response.statusCode).toBe(200);
        cookie = renewedCookie(response.headers) ?? cookie;
        expect(expiryOf(cookie)).toBeLessThanOrEqual(loginAt + 3 * HOUR);
      }
      test.advance(40 * 60 * 1_000);
      expect(expiryOf(cookie)).toBe(loginAt + 3 * HOUR);
      test.advance(25 * 60 * 1_000);
      const capped = await use(test, cookie);
      expect(capped.statusCode).toBe(401);
      expect(renewedCookie(capped.headers)).toBeUndefined();
      const state = await test.app.inject({ method: 'GET', url: '/v3/auth/session', headers: { cookie } });
      const body = state.json<{ authenticated: boolean; reason?: string }>();
      expect(body.authenticated).toBe(false);
      expect(body.reason).toMatch(/venció/);
    } finally {
      await test.app.close();
    }
  });

  it('una sesión caducada nunca se revive: ni responde ni emite cookie, ni siquiera tras usarla', async () => {
    const test = await fixture();
    try {
      const cookie = cookieFrom((await test.login(EMAIL, PASSWORD)).headers);
      test.advance(61 * 60 * 1_000);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await use(test, cookie);
        expect(response.statusCode).toBe(401);
        expect(renewedCookie(response.headers)).toBeUndefined();
        test.advance(5 * 60 * 1_000);
      }
    } finally {
      await test.app.close();
    }
  });

  it('una respuesta fallida o una cuenta retirada no renuevan nada', async () => {
    const test = await fixture();
    try {
      const login = await test.login(EMAIL, PASSWORD);
      const cookie = cookieFrom(login.headers);
      test.advance(40 * 60 * 1_000);
      const forbidden = await test.app.inject({
        method: 'POST', url: '/v3/auth/session/company', headers: { cookie, origin: 'http://localhost' }, payload: {},
      });
      expect(forbidden.statusCode).toBe(403);
      expect(renewedCookie(forbidden.headers)).toBeUndefined();

      test.users.put(await makeUser({ active: false }));
      const retired = await use(test, cookie);
      expect(retired.statusCode).toBe(401);
      expect(renewedCookie(retired.headers)).toBeUndefined();
    } finally {
      await test.app.close();
    }
  });

  it('el logout revoca la sesión: ni la cookie original ni una renovada vuelven a valer', async () => {
    const test = await fixture({ revocations: true });
    try {
      const login = await test.login(EMAIL, PASSWORD);
      const first = cookieFrom(login.headers);
      const csrf = login.json<{ csrf_token: string }>().csrf_token;
      test.advance(40 * 60 * 1_000);
      const second = renewedCookie((await use(test, first)).headers) as string;
      expect((await use(test, second)).statusCode).toBe(200);

      const logout = await test.app.inject({
        method: 'POST', url: '/v3/auth/logout', headers: { cookie: second, origin: 'http://localhost', 'x-csrf-token': csrf },
      });
      expect(logout.statusCode).toBe(204);
      expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');
      for (const cookie of [first, second]) {
        const response = await use(test, cookie);
        expect(response.statusCode).toBe(401);
        expect(renewedCookie(response.headers)).toBeUndefined();
      }
      const again = await test.login(EMAIL, PASSWORD);
      expect((await use(test, cookieFrom(again.headers))).statusCode).toBe(200);
    } finally {
      await test.app.close();
    }
  });

  it('rechaza un tope absoluto menor que la ventana de inactividad', () => {
    expect(() => new PasswordAuthProvider({
      users: new MemoryConsoleUserStore(), signingKey: Buffer.alloc(32, 7), sessionTtlMs: 2 * HOUR, sessionMaxMs: HOUR,
    })).toThrow(/tope absoluto/);
  });
});

describe('sesión deslizante: carreras, dispositivo y estados', () => {
  const HOUR = 60 * 60 * 1_000;
  const T0 = Date.UTC(2026, 7, 6, 12, 0, 0);
  const setCookies = (headers: Record<string, unknown>): string[] => {
    const raw = headers['set-cookie'];
    return Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
  };
  const claimsOf = (cookie: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)).split('.')[1] ?? '', 'base64url')
      .toString('utf8')) as Record<string, unknown>;
  const fakeReply = () => {
    const headers: string[] = [];
    const reply = {
      statusCode: 200,
      hasHeader: () => false,
      header(name: string, value: string) { if (name.toLowerCase() === 'set-cookie') headers.push(value); return reply; },
      code() { return reply; },
      send() { return Promise.resolve(reply); },
    };
    return { reply: reply as unknown as FastifyReply, headers };
  };
  const switching = (): ConsoleCompanyAuthority => ({
    resolve: async (_user, requested) => ({ role: 'platform_admin', scope: 'platform', home_company: 'humanizar',
      acting_company: requested ?? 'humanizar', platform_override: requested !== undefined && requested !== 'humanizar' }),
    switchCompany: async (_user, company) => ({ role: 'platform_admin', scope: 'platform', home_company: 'humanizar',
      acting_company: company ?? 'humanizar', platform_override: company !== null && company !== 'humanizar' }),
  });

  it('una respuesta tardía lanzada antes de cambiar de empresa no pisa la cookie de la empresa nueva', async () => {
    const test = await fixture({ companyAuthority: switching() });
    try {
      const login = await test.login(EMAIL, PASSWORD);
      const csrf = login.json<{ csrf_token: string }>().csrf_token;
      const switchTo = (cookie: string, company: string) => test.app.inject({
        method: 'POST', url: '/v3/auth/session/company', payload: { company_id: company },
        headers: { cookie, origin: 'http://localhost', 'x-csrf-token': csrf },
      });
      const first = await switchTo(cookieFrom(login.headers), 'praxis');
      expect(first.statusCode).toBe(200);
      const cookieA = cookieFrom(first.headers);
      expect(claimsOf(cookieA).cmp).toBe('praxis');

      test.advance(10 * 60 * 1_000);
      const stale = { headers: { cookie: cookieA }, url: '/v3/console/agents' } as unknown as FastifyRequest;
      await test.provider.authenticateHttp(stale);

      const second = await switchTo(cookieA, 'otra');
      expect(second.statusCode).toBe(200);
      const cookieB = cookieFrom(second.headers);
      expect(claimsOf(cookieB).cmp).toBe('otra');
      expect(claimsOf(cookieB).exp as number).toBeGreaterThan(claimsOf(cookieA).exp as number);

      const late = fakeReply();
      test.provider.slideSession(stale, late.reply);
      expect(late.headers).toEqual([]);

      const current = { headers: { cookie: cookieB }, url: '/v3/console/agents' } as unknown as FastifyRequest;
      test.advance(10 * 60 * 1_000);
      await test.provider.authenticateHttp(current);
      const fresh = fakeReply();
      test.provider.slideSession(current, fresh.reply);
      expect(fresh.headers).toHaveLength(1);
      expect(claimsOf(cookieFromHeader(fresh.headers[0] as string)).cmp).toBe('otra');
    } finally {
      await test.app.close();
    }
  });

  it('volver a la empresa de origen tampoco deja que una cookie anterior la deshaga', async () => {
    const test = await fixture({ companyAuthority: switching() });
    try {
      const login = await test.login(EMAIL, PASSWORD);
      const csrf = login.json<{ csrf_token: string }>().csrf_token;
      const switchTo = (cookie: string, company: string | null) => test.app.inject({
        method: 'POST', url: '/v3/auth/session/company', payload: { company_id: company },
        headers: { cookie, origin: 'http://localhost', 'x-csrf-token': csrf },
      });
      const cookieA = cookieFrom((await switchTo(cookieFrom(login.headers), 'praxis')).headers);
      test.advance(10 * 60 * 1_000);
      const stale = { headers: { cookie: cookieA }, url: '/v3/console/agents' } as unknown as FastifyRequest;
      await test.provider.authenticateHttp(stale);
      const home = await switchTo(cookieA, null);
      expect(claimsOf(cookieFrom(home.headers)).cmp).toBeUndefined();
      const late = fakeReply();
      test.provider.slideSession(stale, late.reply);
      expect(late.headers).toEqual([]);
    } finally {
      await test.app.close();
    }
  });

  it('aprobar un dispositivo no da un tope nuevo: la sesión emitida hereda el login de la que aprobó', async () => {
    const test = await fixture({ sessionMaxMs: 3 * HOUR });
    try {
      const login = await test.login(EMAIL, PASSWORD);
      let original = cookieFrom(login.headers);
      const stamp = claimsOf(original).credential_stamp as string;
      const user = (await test.users.findByEmail(EMAIL)) as ConsoleUser;
      for (let step = 0; step < 2; step += 1) {
        test.advance(55 * 60 * 1_000);
        original = cookieFromHeader(setCookies((await test.app.inject({ method: 'GET', url: '/v3/status', headers: { cookie: original } })).headers)[0] ?? original);
      }
      const grant = { humanId: user.id, tenantId: user.tenant_id, actorAlias: user.alias, activeCompany: 'humanizar', credentialStamp: stamp };

      const approver = await test.provider.verifiedConsoleSession({ headers: { cookie: original } } as unknown as FastifyRequest);
      expect(approver?.authTimeMs).toBe(T0);
      const issued = fakeReply();
      await test.provider.completeDeviceLogin(issued.reply, { ...grant, sessionAuthAtMs: approver?.authTimeMs as number });
      const device = cookieFromHeader(issued.headers[0] as string);
      expect(claimsOf(device).auth_time).toBe(T0 / 1_000);
      expect(claimsOf(device).exp).toBe((T0 + 170 * 60 * 1_000) / 1_000);

      const chained = await test.provider.verifiedConsoleSession({ headers: { cookie: device } } as unknown as FastifyRequest);
      expect(chained?.authTimeMs).toBe(T0);
      const second = fakeReply();
      await test.provider.completeDeviceLogin(second.reply, { ...grant, sessionAuthAtMs: chained?.authTimeMs as number });
      expect(claimsOf(cookieFromHeader(second.headers[0] as string)).auth_time).toBe(T0 / 1_000);

      test.advance(71 * 60 * 1_000);
      expect((await test.app.inject({ method: 'GET', url: '/v3/status', headers: { cookie: device } })).statusCode).toBe(401);
      const refused = fakeReply();
      await expect(test.provider.completeDeviceLogin(refused.reply, { ...grant, sessionAuthAtMs: T0 })).rejects.toThrow('access_denied');
      expect(refused.headers).toEqual([]);
    } finally {
      await test.app.close();
    }
  });

  it('el estado de sesión informa el vencimiento ya renovado', async () => {
    const test = await fixture();
    try {
      const cookie = cookieFrom((await test.login(EMAIL, PASSWORD)).headers);
      test.advance(40 * 60 * 1_000);
      const state = await test.app.inject({ method: 'GET', url: '/v3/auth/session', headers: { cookie } });
      const renewed = cookieFromHeader(setCookies(state.headers)[0] as string);
      expect(state.json<{ expires_at: string }>().expires_at).toBe(new Date((claimsOf(renewed).exp as number) * 1_000).toISOString());
      expect(claimsOf(renewed).exp as number).toBeGreaterThan(claimsOf(cookie).exp as number);
    } finally {
      await test.app.close();
    }
  });

  it('si la autoridad de la sesión ya no vale, el estado dice no autenticado y no renueva la cookie', async () => {
    let revoked = false;
    const test = await fixture({ companyAuthority: {
      resolve: async () => {
        if (revoked) throw new AuthError('la empresa ya no vale');
        return { role: 'tenant_operator', scope: 'tenant', home_company: 'humanizar', acting_company: 'humanizar', platform_override: false };
      },
      switchCompany: async () => { throw new Error('unused'); },
    } });
    try {
      const cookie = cookieFrom((await test.login(EMAIL, PASSWORD)).headers);
      test.advance(40 * 60 * 1_000);
      revoked = true;
      const state = await test.app.inject({ method: 'GET', url: '/v3/auth/session', headers: { cookie } });
      expect(state.json<{ authenticated: boolean }>().authenticated).toBe(false);
      expect(setCookies(state.headers)).toEqual([]);
    } finally {
      await test.app.close();
    }
  });

  it('el logout borra la cookie aunque falle la revocación y el proceso sigue rechazando esa sesión', async () => {
    const failing: ConsoleSessionRevocations = {
      revoke: () => Promise.reject(new Error('database unavailable')),
      isRevoked: () => Promise.resolve(false),
    };
    const test = await fixture({ sessionRevocations: failing });
    try {
      const login = await test.login(EMAIL, PASSWORD);
      const cookie = cookieFrom(login.headers);
      const csrf = login.json<{ csrf_token: string }>().csrf_token;
      const logout = await test.app.inject({
        method: 'POST', url: '/v3/auth/logout', headers: { cookie, origin: 'http://localhost', 'x-csrf-token': csrf },
      });
      expect(logout.statusCode).toBe(204);
      expect(setCookies(logout.headers).join()).toContain('Max-Age=0');
      expect((await test.app.inject({ method: 'GET', url: '/v3/status', headers: { cookie } })).statusCode).toBe(401);
    } finally {
      await test.app.close();
    }
  });
});

function cookieFromHeader(header: string): string {
  return header.split(';', 1)[0] as string;
}

describe('isConsoleSurface clasifica la ruta como la resuelve el router, nunca por el texto crudo', () => {
  it.each([
    ['/v3/console/audit', true],
    ['/v3/console/audit?desde=1', true],
    ['/v3/%63onsole/audit', true],
    ['/%76%33/%63%6f%6e%73%6f%6c%65/topology', true],
    ['https://console.example.test/v3/console/audit', true],
    ['/v3/status', true],
    ['/v3/agents/zeus/messages', false],
    ['/v3/consolefalsa/x', false],
  ])('%s → %s', (url, esperado) => {
    expect(isConsoleSurface(url)).toBe(esperado);
  });
});


it('exposes the original verified login SID and ignores forged terminal identity in the body', async () => {
  const test = await fixture();
  try {
    const first = await test.login(EMAIL, PASSWORD);
    const cookie = cookieFrom(first.headers);
    const token = cookie.split('=')[1];
    if (token === undefined) throw new Error('missing session token');
    const payload = token.split('.')[1];
    if (payload === undefined) throw new Error('missing session claims');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sid: string };
    const verified = await test.provider.verifiedConsoleSession({
      headers: { cookie }, body: { loginSid: 'forged-session', humanId: 'forged-human', actorAlias: 'jarvis' },
    } as unknown as FastifyRequest);
    expect(verified).toMatchObject({ loginSid: claims.sid,
      humanId: '11111111-2222-4333-8444-555555555555', tenantId: 'Steven', actorAlias: 'kant' });
    expect(JSON.stringify(verified)).not.toContain(PASSWORD);
    const second = await test.login(EMAIL, PASSWORD);
    const next = await test.provider.verifiedConsoleSession({ headers: { cookie: cookieFrom(second.headers) } } as unknown as FastifyRequest);
    expect(next?.loginSid).not.toBe(verified?.loginSid);
    await expect(test.provider.verifiedConsoleSession({ headers: { cookie: '__Host-cauce_session=invalid' },
      body: { loginSid: claims.sid } } as unknown as FastifyRequest)).rejects.toThrow(AuthError);
  } finally { await test.app.close(); }
});

describe('PasswordWorkGate', () => {
  it('runs at most its concurrency, queues in order and refuses work beyond the queue', async () => {
    const gate = new PasswordWorkGate(1, 1); const started: string[] = []; let release: () => void = () => undefined;
    const first = gate.run(async () => { started.push('first'); await new Promise<void>(resolve => { release = resolve; }); return 'first'; });
    const second = gate.run(async () => { started.push('second'); return 'second'; });
    await expect(gate.run(async () => 'third')).rejects.toBeInstanceOf(PasswordWorkSaturated);
    expect(started).toEqual(['first']); release();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    await expect(gate.run(async () => 'again')).resolves.toBe('again');
  });

  it('frees the slot when the work fails', async () => {
    const gate = new PasswordWorkGate(1, 0);
    await expect(gate.run(async () => { throw new Error('scrypt failed'); })).rejects.toThrow('scrypt failed');
    await expect(gate.run(async () => 'next')).resolves.toBe('next');
  });
});
