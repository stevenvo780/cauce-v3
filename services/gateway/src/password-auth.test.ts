import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { buildGateway, type GatewayRepository } from './app.js';
import { AuthError, validatePrincipal, type AuthProvider, type Principal } from './auth.js';
import { MemoryConsoleUserStore, type ConsoleUser } from './console-users.js';
import { hashPassword } from './password.js';
import { LoginThrottle, PasswordAuthProvider } from './password-auth.js';

/**
 * Todo lo que se afirma acá se afirma sobre el EFECTO: la cabecera `Set-Cookie` real, el código
 * de estado real y el cuerpo real de la respuesta. Nada se da por bueno porque el tipo compile.
 */

// scrypt con el costo de producción tarda ~100 ms por verificación; en los tests el parámetro
// viaja dentro del hash, así que bajarlo NO cambia el código que se está probando.
const TEST_SCRYPT = { cost: 1_024, blockSize: 8, parallelism: 1 };
const PASSWORD = 'una-frase-de-paso-larga';

function fakePool(): DatabasePool {
  return { query: vi.fn(async () => ({ rows: [{ ssl: true }], rowCount: 1 })) } as unknown as DatabasePool;
}

function fakeRepository(): GatewayRepository {
  return {
    assertPrincipal: vi.fn(async () => undefined),
    status: vi.fn(async () => ({ online: 1 })),
    listPresence: vi.fn(async () => []),
    principalAccess: vi.fn(async () => ({ roles: ['operator'], permissions: ['route', 'read', 'control'] })),
    claimOutbox: vi.fn(async () => [])
  } as unknown as GatewayRepository;
}

async function makeUser(overrides: Partial<ConsoleUser> = {}): Promise<ConsoleUser> {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    email: 'steven@elenxos.com',
    display_name: 'Steven',
    role: 'operator',
    tenant_id: 'Steven',
    alias: 'kant',
    active: true,
    password_hash: await hashPassword(PASSWORD, TEST_SCRYPT),
    password_changed_at: 0,
    ...overrides
  };
}

/** Doble del mTLS de los agentes: no mira cookies, devuelve siempre el mismo principal. */
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
 * Doble del certificado de cliente del PROXY de la consola, tal como está provisionado en
 * producción: `Steven:kant`, `channel: console`, rol `operator`. nginx lo presenta en TODO lo que
 * proxea, así que sin la puerta del canal un navegador sin sesión entra como operador.
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
} = {}) {
  let now = Date.UTC(2026, 7, 6, 12, 0, 0);
  const user = options.user ?? await makeUser();
  const users = new MemoryConsoleUserStore([user]);
  const provider = new PasswordAuthProvider({
    users,
    signingKey: Buffer.alloc(32, 7),
    sessionTtlMs: 60 * 60 * 1_000,
    now: () => now,
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
    ...(options.throttle === undefined ? {} : { throttle: options.throttle })
  });
  const app = await buildGateway({
    pool: fakePool(),
    authProvider: provider,
    repository: fakeRepository(),
    deliveryWakeSubscriber: async () => async () => undefined
  });
  return {
    app,
    provider,
    users,
    advance(ms: number) { now += ms; },
    login(email: string, password: string) {
      return app.inject({
        method: 'POST', url: '/v3/auth/login',
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
  return selected.split(';', 1)[0]!;
}

describe('login por contraseña de la consola', () => {
  it('entrega la sesión en una cookie HttpOnly+Secure+SameSite y NUNCA en el cuerpo', async () => {
    const test = await fixture();
    try {
      const login = await test.login('Steven@Elenxos.com', PASSWORD);
      expect(login.statusCode).toBe(200);
      const rawCookie = String(login.headers['set-cookie']);
      expect(rawCookie).toContain('HttpOnly');
      expect(rawCookie).toContain('Secure');
      expect(rawCookie).toContain('SameSite=Strict');
      expect(rawCookie).toContain('Path=/');
      const cookie = cookieFrom(login.headers);
      // El token va SÓLO en la cookie: si apareciera en el cuerpo, un XSS se lo llevaría.
      expect(JSON.stringify(login.json())).not.toContain(cookie.split('=')[1]!.slice(0, 24));
      expect(login.json()).toMatchObject({
        authenticated: true, login_mode: 'password', subject: 'steven@elenxos.com', name: 'Steven'
      });

      const session = await test.app.inject({ method: 'GET', url: '/v3/auth/session', headers: { cookie } });
      expect(session.statusCode).toBe(200);
      expect(session.json()).toMatchObject({
        authenticated: true, subject: 'steven@elenxos.com', roles: ['operator']
      });

      const api = await test.app.inject({ method: 'GET', url: '/v3/status', headers: { cookie } });
      expect(api.statusCode).toBe(200);
      expect(api.json()).toMatchObject({ auth_provider: 'console-password' });
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
    const test = await fixture({ user: await makeUser({ active: false, email: 'apagada@elenxos.com' }) });
    try {
      const wrongPassword = await test.login('apagada@elenxos.com', 'no-es-la-contraseña');
      const unknownEmail = await test.login('nadie@elenxos.com', PASSWORD);
      const disabled = await test.login('apagada@elenxos.com', PASSWORD);

      for (const response of [wrongPassword, unknownEmail, disabled]) {
        expect(response.statusCode).toBe(401);
        expect(response.headers['set-cookie']).toBeUndefined();
      }
      // La igualdad literal es la garantía: si mañana alguien agrega "usuario no encontrado",
      // este test se cae. El mensaje no puede ser un directorio de quién tiene cuenta.
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
      const cookie = cookieFrom((await test.login('steven@elenxos.com', PASSWORD)).headers);
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
      const cookie = cookieFrom((await test.login('steven@elenxos.com', PASSWORD)).headers);
      expect((await test.app.inject({ method: 'GET', url: '/v3/status', headers: { cookie } })).statusCode).toBe(200);

      test.users.put(await makeUser({ active: false }));
      expect((await test.app.inject({ method: 'GET', url: '/v3/status', headers: { cookie } })).statusCode).toBe(401);

      // Y la otra mitad: cuenta viva, pero contraseña cambiada DESPUÉS de emitir el token.
      test.users.put(await makeUser({ password_changed_at: Date.UTC(2026, 7, 6, 13, 0, 0) }));
      expect((await test.app.inject({ method: 'GET', url: '/v3/status', headers: { cookie } })).statusCode).toBe(401);
    } finally {
      await test.app.close();
    }
  });

  it('las escrituras con cookie exigen CSRF y el logout borra la cookie', async () => {
    const test = await fixture();
    try {
      const login = await test.login('steven@elenxos.com', PASSWORD);
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

      // Un POST de agente NO puede quedar atrapado por el guardia CSRF de la consola: llega a
      // enrutarse (404 de ruta inexistente), no muere en 401/403 antes de tocar el router.
      const write = await test.app.inject({ method: 'POST', url: '/v3/inexistente' });
      expect(write.statusCode).toBe(404);

      // Y con cookie de consola, el mismo POST sí pasa por el guardia.
      const cookie = cookieFrom((await test.login('steven@elenxos.com', PASSWORD)).headers);
      const guarded = await test.app.inject({
        method: 'POST', url: '/v3/inexistente', headers: { cookie, origin: 'http://localhost' }
      });
      expect(guarded.statusCode).toBe(403);
    } finally {
      await test.app.close();
    }
  });

  it('el certificado del PROXY de la consola no reemplaza a una sesión: sin cookie, 401', async () => {
    // Medido en producción el 2026-08-06 con CAUCE_AUTH_PROVIDER=password ya encendido:
    // `/v3/console/*` devolvía ~850 KB —entregas, mensajes, auditoría y salas de los cinco
    // tenants— a cualquiera que llegara al proxy, porque el request sin cookie caía al mTLS y el
    // certificado de nginx está provisionado como operador. El login era una cortina de la SPA.
    const fallback = new StubConsoleProxyProvider();
    const test = await fixture({ fallback });
    try {
      const anonymous = await test.app.inject({ method: 'GET', url: '/v3/status' });
      expect(anonymous.statusCode).toBe(401);
      // Se consultó al fallback: la puerta está DESPUÉS de resolver la identidad de máquina, no
      // en una lista de rutas que haya que acordarse de actualizar.
      expect(fallback.calls).toBeGreaterThan(0);

      // Y la pantalla de login sigue siendo alcanzable, o no habría forma de entrar.
      const session = await test.app.inject({ method: 'GET', url: '/v3/auth/session' });
      expect(session.statusCode).toBe(200);
      expect(session.json()).toMatchObject({ authenticated: false, login_mode: 'password' });

      // Con sesión, el mismo endpoint contesta.
      const cookie = cookieFrom((await test.login('steven@elenxos.com', PASSWORD)).headers);
      const authenticated = await test.app.inject({ method: 'GET', url: '/v3/status', headers: { cookie } });
      expect(authenticated.statusCode).toBe(200);
    } finally {
      await test.app.close();
    }
  });

  it('cerrar la puerta de la consola NO cierra la de los agentes: el adaptador sigue entrando', async () => {
    // La otra mitad del arreglo, y la que importa no romper: el mismo request sin cookie, con un
    // principal de canal `adapter`, tiene que seguir pasando. Si esto se rompe, la flota se queda
    // muda (los adaptadores y el recolector de cuotas entran por su propio certificado).
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
      const cookie = cookieFrom((await test.login('steven@elenxos.com', PASSWORD)).headers);
      const principal = await test.provider.authenticateHttp({
        headers: { cookie, 'x-cauce-operator': 'steven' }
      } as unknown as FastifyRequest);
      expect(principal.operator_id).toBe('steven@elenxos.com');
      expect(principal.channel).toBe('console');
    } finally {
      await test.app.close();
    }
  });

  it('frena la fuerza bruta después de varios intentos fallidos', async () => {
    const test = await fixture({ throttle: new LoginThrottle(3, 60_000) });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect((await test.login('steven@elenxos.com', 'mal')).statusCode).toBe(401);
      }
      const blocked = await test.login('steven@elenxos.com', PASSWORD);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBeDefined();
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
      const cookie = cookieFrom((await test.login('steven@elenxos.com', PASSWORD)).headers);
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
