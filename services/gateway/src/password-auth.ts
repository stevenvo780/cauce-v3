import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AuthError, AuthorizationError, validatePrincipal,
  type AuthProvider, type Principal, type PrincipalPermission, type PrincipalRole
} from './auth.js';
import type { ConsoleUser, ConsoleUserRole, ConsoleUserStore } from './console-users.js';
import { DECOY_PASSWORD_HASH_PROMISE, MAX_PASSWORD_LENGTH, verifyPassword } from './password.js';

/**
 * Login humano de la consola: correo + contraseña contra `console_users`, sesión en un JWT
 * firmado que viaja SÓLO en una cookie `HttpOnly; Secure; SameSite=Strict` con prefijo
 * `__Host-`. El navegador no puede leer el token: un XSS en la consola no se lleva la sesión.
 *
 * SE SUMA AL mTLS, NO LO REEMPLAZA. `fallback` recibe todo lo que llegue SIN la cookie de
 * sesión, así que los agentes siguen entrando por su certificado de cliente exactamente igual y
 * el mismo proceso atiende las dos puertas. Esa era la pregunta abierta de
 * `ops/console-login/README.md` §3.2 ("si no conviven, la consola necesita su propio listener"):
 * conviven, porque la credencial de cada puerta es distinguible en el propio request.
 *
 * QUÉ NO HACE, a propósito: ni refresh rotativo, ni MFA, ni recuperación por correo, ni
 * proveedor externo. Login, logout, sesión.
 *
 * Lo que el token NO decide: el rol y los permisos NO se leen del JWT, se releen de la fila de
 * `console_users` en cada request. Desactivar una cuenta o cambiarle la contraseña corta las
 * sesiones abiertas sin tabla de revocación — un token viejo sigue estando firmado, pero ya no
 * encuentra respaldo. Y encima de eso, `/v3/console/access` intersecta estos permisos con los
 * que la base le concede al tenant/alias: el JWT nunca puede escalar por encima de `memberships`.
 */

const JWT_HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString('base64url');
const JWT_ISSUER = 'cauce-v3-gateway';
const JWT_AUDIENCE = 'cauce-v3-console';
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const MIN_SIGNING_KEY_BYTES = 32;
/** Mensaje único para "no existe", "contraseña mala" y "cuenta apagada". Ver `login()`. */
const CREDENTIAL_FAILURE_MESSAGE = 'Correo o contraseña incorrectos.';

export interface ConsoleSessionClaims {
  iss: string;
  aud: string;
  sub: string;
  sid: string;
  csrf: string;
  iat: number;
  exp: number;
}

export type LoginMode = 'password' | 'redirect';

export interface ConsolePasswordAuthState {
  authenticated: boolean;
  login_mode: LoginMode;
  subject?: string;
  name?: string;
  roles?: readonly string[];
  permissions?: readonly string[];
  expires_at?: string;
  csrf_token?: string;
  reason?: string;
}

/** Se distingue del resto de los `AuthError` sólo para poder decirle a la persona qué pasó. */
class SessionExpiredError extends AuthError {
  constructor() {
    super('La sesión venció. Volvé a iniciar sesión.');
  }
}

/**
 * Rol de la consola -> autoridad de Cauce. Es la traducción MÍNIMA razonable y vive en el código
 * y no en la base porque es una decisión de producto, no un dato: `operator` opera (publicar,
 * cancelar, reintentar, terminales) y `reader` sólo mira. Cualquiera de las dos queda acotada
 * después por `memberships`/`role_policies`.
 */
const ROLE_AUTHORITY: Readonly<Record<ConsoleUserRole, {
  roles: readonly PrincipalRole[]; permissions: readonly PrincipalPermission[];
}>> = Object.freeze({
  operator: { roles: ['operator'], permissions: ['route', 'read', 'control', 'notify'] },
  reader: { roles: [], permissions: ['read'] }
});

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function constantTimeText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Devuelve `undefined` si la cabecera trae la cookie repetida. Dos valores con el mismo nombre
 * son la forma clásica de "cookie tossing": un subdominio comprometido escribe una segunda
 * cookie y el servidor elige la equivocada. Acá se elige ninguna.
 */
function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const values = header.split(';').map((item) => item.trim()).filter((item) => item.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  try {
    return decodeURIComponent(values[0]!.slice(name.length + 1));
  } catch {
    return undefined;
  }
}

function sessionCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${
    Math.max(0, Math.floor(maxAgeSeconds))}`;
}

export function signConsoleSession(key: Buffer, claims: ConsoleSessionClaims): string {
  const payload = base64urlJson(claims);
  const signature = createHmac('sha256', key).update(`${JWT_HEADER}.${payload}`).digest('base64url');
  return `${JWT_HEADER}.${payload}.${signature}`;
}

/**
 * Verificación completa antes de mirar NADA del contenido: algoritmo fijado en el servidor (un
 * `alg` que venga en el token no se lee jamás — así es como se cuela `alg: none`), firma
 * comparada en tiempo constante, y recién entonces se decodifica el payload.
 */
export function verifyConsoleSession(key: Buffer, token: string, nowMs: number): ConsoleSessionClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new AuthError('token de sesión malformado');
  const [header, payload, signature] = parts as [string, string, string];
  if (header !== JWT_HEADER) throw new AuthError('cabecera de token no aceptada');
  const expected = createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url');
  if (!constantTimeText(signature, expected)) throw new AuthError('firma de token inválida');
  let claims: Partial<ConsoleSessionClaims>;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<ConsoleSessionClaims>;
  } catch {
    throw new AuthError('token de sesión malformado');
  }
  if (claims.iss !== JWT_ISSUER || claims.aud !== JWT_AUDIENCE) throw new AuthError('token de sesión ajeno');
  if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 128) {
    throw new AuthError('sujeto del token inválido');
  }
  if (typeof claims.sid !== 'string' || claims.sid.length < 16 || claims.sid.length > 128) {
    throw new AuthError('identificador de sesión inválido');
  }
  if (typeof claims.csrf !== 'string' || claims.csrf.length < 32 || claims.csrf.length > 128) {
    throw new AuthError('token CSRF de la sesión inválido');
  }
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) throw new AuthError('emisión del token inválida');
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) throw new AuthError('vencimiento del token inválido');
  // Sin tolerancia de reloj hacia el futuro: emisor y verificador son EL MISMO proceso.
  if (claims.exp * 1_000 <= nowMs) throw new SessionExpiredError();
  return claims as ConsoleSessionClaims;
}

/**
 * Freno de fuerza bruta, en memoria y por correo normalizado.
 *
 * En memoria a propósito: el gateway corre en un proceso y un contador en PostgreSQL agregaría
 * una escritura por intento fallido en el camino menos autenticado que existe. Si el proceso se
 * reinicia el contador se pierde — es el lado barato del error, y el costo por intento lo pone
 * scrypt igual.
 */
export class LoginThrottle {
  private readonly failures = new Map<string, { count: number; blockedUntil: number; seenAt: number }>();

  constructor(
    private readonly maxFailures = 8,
    private readonly windowMs = 15 * 60 * 1_000,
    private readonly maxTracked = 10_000
  ) {}

  /** Milisegundos que faltan para poder reintentar, o 0 si se puede intentar ahora. */
  retryAfterMs(key: string, now: number): number {
    const record = this.failures.get(key);
    if (!record) return 0;
    if (record.blockedUntil <= now) return 0;
    return record.blockedUntil - now;
  }

  recordFailure(key: string, now: number): void {
    this.prune(now);
    const record = this.failures.get(key);
    if (!record || now - record.seenAt > this.windowMs) {
      this.failures.set(key, { count: 1, blockedUntil: 0, seenAt: now });
      return;
    }
    record.count += 1;
    record.seenAt = now;
    if (record.count >= this.maxFailures) record.blockedUntil = now + this.windowMs;
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  private prune(now: number): void {
    if (this.failures.size < this.maxTracked) return;
    for (const [key, record] of this.failures) {
      if (record.blockedUntil <= now && now - record.seenAt > this.windowMs) this.failures.delete(key);
    }
    // Si aun así sigue llena, se vacía entera: preferimos perder contadores antes que crecer sin
    // techo. Un atacante puede forzarlo, pero para hacerlo tiene que pagar 10.000 verificaciones.
    if (this.failures.size >= this.maxTracked) this.failures.clear();
  }
}

export interface PasswordAuthProviderOptions {
  users: ConsoleUserStore;
  /** Clave HMAC del JWT. Sale de un archivo de secreto, nunca del repositorio ni del navegador. */
  signingKey: Uint8Array;
  /** Proveedor que atiende todo lo que NO trae cookie de sesión: hoy, el mTLS de los agentes. */
  fallback?: AuthProvider;
  sessionTtlMs?: number;
  cookieName?: string;
  now?: () => number;
  throttle?: LoginThrottle;
  /**
   * Canal del principal de MÁQUINA que además es la boca del NAVEGADOR.
   *
   * El proxy de la consola (nginx) le habla al gateway con SU propio certificado de cliente, y ese
   * certificado está provisionado en el registro mTLS como `Steven:kant`, `channel: console`,
   * rol `operator`. Sin esta puerta, un request del navegador SIN cookie de sesión cae al
   * `fallback` mTLS, presenta el certificado del proxy y el gateway lo atiende como operador: se
   * medió el 2026-08-06 y `/v3/console/*` devolvía las entregas, los mensajes, la auditoría y las
   * salas de los CINCO tenants a cualquiera que llegara al proxy. El login quedaba de cortina: la
   * SPA escondía la interfaz, pero la API seguía abierta y lo único que la tapaba era el basic
   * auth de Caddy.
   *
   * La regla: el certificado del proxy es una credencial de TRANSPORTE ("soy la consola"), no una
   * autorización para LEER LA FLOTA EN EL NAVEGADOR. Es el canal el que dice QUIÉN puede tener un
   * navegador del otro lado; es la RUTA la que dice si hace falta una persona. Ver
   * `isConsoleSurface`: sólo la superficie de consola exige sesión, y ahí ni el certificado del
   * proxy alcanza. El resto de `/v3/` es máquina a máquina y le basta el mTLS, venga por el canal
   * que venga — ése es el "no rompas el mTLS".
   */
  machineChannelRequiringSession?: string;
}

/** Mensaje único de la puerta de sesión: no distingue "no hay cookie" de "cookie no vale acá". */
const SESSION_REQUIRED_MESSAGE = 'se requiere la cookie de sesión de la consola';

/**
 * Superficie de CONSOLA: las rutas que le devuelven datos de la flota a un NAVEGADOR. Son las
 * únicas que exigen una sesión humana; todo lo demás bajo `/v3/` es superficie de BUS (máquina a
 * máquina) y se autoriza con el mTLS del que llama.
 *
 * POR QUÉ POR RUTA Y NO POR CANAL. El 2026-08-06 la puerta se puso sobre el canal: cualquier
 * principal del canal `console` quedaba rechazado en CUALQUIER endpoint. Como `console-client` es
 * el único principal mTLS con permiso `control` y el único que usan el guardia médico y las
 * herramientas de operación para publicar, `POST /v3/messages` empezó a devolver 401 y la flota se
 * quedó sin plano de control: ningún cambio de configuración era posible, ni por un humano ni por
 * un agente. Un canal dice de dónde PUEDE venir un navegador; no dice qué está pidiendo. Lo que
 * hay que proteger es la superficie que un navegador puede leer, y eso es una lista de rutas.
 *
 * Un mismo principal entra por las dos puertas según qué pida: `console-client` publica en
 * `/v3/messages` con su certificado, y en `/v3/console/activity` necesita que además haya una
 * persona con sesión iniciada.
 *
 * `/v3/status` está adentro porque devuelve presencia y contadores de la flota y la SPA lo pinta en
 * la portada; era parte del mismo agujero. Las rutas del relay de terminal (`/v3/terminal/relay/*`)
 * no aparecen porque se autorizan con su token y ni pasan por este proveedor.
 *
 * El prefijo es EXACTAMENTE el mismo que mira `createConsoleSecurityHook`: si un día se agrega una
 * ruta de consola, queda cubierta por las dos puertas sin tocar ninguna lista.
 */
export function isConsoleSurface(url: string): boolean {
  const path = url.split('?', 1)[0] ?? '';
  return path.startsWith('/v3/console/') || path === '/v3/status';
}

interface LoadedSession {
  claims: ConsoleSessionClaims;
  user: ConsoleUser;
  principal: Principal;
}

export class PasswordAuthProvider implements AuthProvider {
  readonly name = 'console-password';
  readonly mode = 'production' as const;
  readonly cookieName: string;
  readonly fallback: AuthProvider | undefined;
  private readonly users: ConsoleUserStore;
  private readonly signingKey: Buffer;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;
  private readonly throttle: LoginThrottle;
  private readonly machineChannelRequiringSession: string;
  private readonly requestCache = new WeakMap<FastifyRequest, LoadedSession>();

  constructor(options: PasswordAuthProviderOptions) {
    if (options.signingKey.byteLength < MIN_SIGNING_KEY_BYTES) {
      throw new Error(`la clave de firma de la consola necesita al menos ${MIN_SIGNING_KEY_BYTES} bytes`);
    }
    this.users = options.users;
    this.signingKey = Buffer.from(options.signingKey);
    this.fallback = options.fallback;
    this.cookieName = options.cookieName ?? '__Host-cauce_session';
    if (!/^__Host-[A-Za-z0-9_-]+$/.test(this.cookieName)) {
      throw new Error('la cookie de sesión debe usar el prefijo __Host-');
    }
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    if (!Number.isFinite(this.sessionTtlMs) || this.sessionTtlMs <= 0) {
      throw new Error('la vida de la sesión de consola debe ser positiva');
    }
    this.now = options.now ?? Date.now;
    this.throttle = options.throttle ?? new LoginThrottle();
    this.machineChannelRequiringSession = options.machineChannelRequiringSession ?? 'console';
  }

  /**
   * Todo lo que no trae cookie pasa por acá, y sale con la identidad de MÁQUINA del `fallback`.
   *
   * La única excepción es la superficie de CONSOLA pedida por el principal que tiene un navegador
   * del otro lado (el certificado del proxy, canal `console`): ahí hace falta una persona con
   * sesión y el certificado no la sustituye. Fuera de esa intersección el mTLS manda, así que el
   * bus (`/v3/messages`, `/v3/query`, `/v3/quotas/samples`, `/v3/egress/notifications`, `/v3/ws`…)
   * sigue abierto a TODOS los principales de máquina, incluido el del proxy.
   */
  private async viaFallback(
    request: FastifyRequest,
    resolve: (provider: AuthProvider) => Promise<Principal>
  ): Promise<Principal> {
    if (!this.fallback) throw new AuthError(SESSION_REQUIRED_MESSAGE);
    const machine = await resolve(this.fallback);
    if (machine.channel === this.machineChannelRequiringSession && isConsoleSurface(request.url)) {
      throw new AuthError(SESSION_REQUIRED_MESSAGE);
    }
    return machine;
  }

  async ready(): Promise<void> {
    await this.users.ready();
  }

  private token(request: FastifyRequest): string | undefined {
    return cookieValue(headerValue(request.headers.cookie), this.cookieName);
  }

  private principalFor(user: ConsoleUser, claims: ConsoleSessionClaims): Principal {
    const authority = ROLE_AUTHORITY[user.role];
    return validatePrincipal({
      tenant_id: user.tenant_id,
      alias: user.alias,
      session_id: `console:${claims.sid}`,
      channel: 'console',
      roles: authority.roles,
      permissions: authority.permissions,
      // La pieza que arregla la auditoría: de acá sale el operador, no de una cabecera que hoy
      // pone el proxy con el valor `steven` fijo para todo el mundo.
      operator_id: user.email,
      /*
       * Una sesión web NO es un transporte de retorno. La consola relee el mensaje y sus
       * entregas desde PostgreSQL; no existe (ni debe existir) un bridge `adapter=console` que
       * reciba una respuesta. Fabricar ese origin hacía que cada respuesta terminal dejara un
       * `origin_relay` durable que ningún worker podía reclamar. La identidad humana ya queda
       * trazada por operator_id y session_id, sin convertirla en una ruta de entrega.
       */
    });
  }

  private async load(request: FastifyRequest): Promise<LoadedSession> {
    const cached = this.requestCache.get(request);
    if (cached) return cached;
    const token = this.token(request);
    if (token === undefined) throw new AuthError(SESSION_REQUIRED_MESSAGE);
    const claims = verifyConsoleSession(this.signingKey, token, this.now());
    const user = await this.users.findById(claims.sub);
    // Se relee SIEMPRE. Un token firmado no es autoridad sobre el estado actual de la cuenta.
    if (!user || !user.active) throw new AuthError('la cuenta de consola no está habilitada');
    // Cambiar la contraseña invalida lo emitido antes: es la revocación sin tabla de revocación.
    if (claims.iat * 1_000 < user.password_changed_at - 1_000) throw new SessionExpiredError();
    const loaded = { claims, user, principal: this.principalFor(user, claims) };
    this.requestCache.set(request, loaded);
    return loaded;
  }

  /** `true` cuando el request trae cookie de consola; el resto es del `fallback` (mTLS). */
  handles(request: FastifyRequest): boolean {
    return this.token(request) !== undefined;
  }

  async authenticateHttp(request: FastifyRequest): Promise<Principal> {
    if (!this.handles(request)) {
      return this.viaFallback(request, (provider) => provider.authenticateHttp(request));
    }
    return (await this.load(request)).principal;
  }

  async authenticateHello(request: FastifyRequest, hello: Parameters<AuthProvider['authenticateHello']>[1]): Promise<Principal> {
    if (!this.handles(request)) {
      return this.viaFallback(request, (provider) => provider.authenticateHello(request, hello));
    }
    return (await this.load(request)).principal;
  }

  async requireCsrf(request: FastifyRequest): Promise<void> {
    const { claims } = await this.load(request);
    const presented = headerValue(request.headers['x-csrf-token']);
    if (!presented || !constantTimeText(presented, claims.csrf)) {
      throw new AuthorizationError('se requiere un token CSRF válido');
    }
  }

  async authState(request: FastifyRequest): Promise<ConsolePasswordAuthState> {
    if (!this.handles(request)) return { authenticated: false, login_mode: 'password' };
    try {
      const { claims, user } = await this.load(request);
      const authority = ROLE_AUTHORITY[user.role];
      return {
        authenticated: true,
        login_mode: 'password',
        subject: user.email,
        name: user.display_name,
        roles: authority.roles,
        permissions: authority.permissions,
        expires_at: new Date(claims.exp * 1_000).toISOString(),
        csrf_token: claims.csrf
      };
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        return { authenticated: false, login_mode: 'password', reason: error.message };
      }
      if (error instanceof AuthError) return { authenticated: false, login_mode: 'password' };
      throw error;
    }
  }

  private issue(user: ConsoleUser): { token: string; claims: ConsoleSessionClaims } {
    const issuedAtMs = this.now();
    const claims: ConsoleSessionClaims = {
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      sub: user.id,
      sid: randomUUID(),
      csrf: randomBytes(32).toString('base64url'),
      iat: Math.floor(issuedAtMs / 1_000),
      exp: Math.floor((issuedAtMs + this.sessionTtlMs) / 1_000)
    };
    return { token: signConsoleSession(this.signingKey, claims), claims };
  }

  /**
   * UN SOLO MENSAJE para las tres formas de fallar (correo desconocido, contraseña equivocada,
   * cuenta desactivada) y el MISMO trabajo criptográfico en todos los casos: si el correo no
   * existe se verifica igual contra un hash señuelo. Un mensaje distinto —o una respuesta más
   * rápida— convierte al login en un directorio de quién tiene cuenta.
   */
  async login(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body: unknown = request.body;
    const fields = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {};
    const email = fields.email;
    const password = fields.password;
    if (typeof email !== 'string' || email.length === 0 || email.length > 254 ||
        typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
      await reply.code(400).send({ error: 'invalid_request', message: 'Hacen falta correo y contraseña.' });
      return;
    }
    const now = this.now();
    const throttleKey = email.trim().toLowerCase();
    const retryAfterMs = this.throttle.retryAfterMs(throttleKey, now);
    if (retryAfterMs > 0) {
      await reply
        .header('Retry-After', String(Math.ceil(retryAfterMs / 1_000)))
        .code(429)
        .send({ error: 'too_many_requests', message: 'Demasiados intentos fallidos. Probá de nuevo más tarde.' });
      return;
    }
    const user = await this.users.findByEmail(email);
    const hash = user?.password_hash ?? await DECOY_PASSWORD_HASH_PROMISE;
    const verified = await verifyPassword(hash, password);
    if (!user || !verified || !user.active) {
      this.throttle.recordFailure(throttleKey, now);
      await reply
        .header('Cache-Control', 'no-store')
        .code(401)
        .send({ error: 'unauthorized', message: CREDENTIAL_FAILURE_MESSAGE });
      return;
    }
    this.throttle.recordSuccess(throttleKey);
    const { token, claims } = this.issue(user);
    try {
      await this.users.recordLogin(user.id, new Date(now));
    } catch {
      // La marca de último ingreso es informativa: perderla no puede costar el login.
    }
    const authority = ROLE_AUTHORITY[user.role];
    await reply
      .header('Cache-Control', 'no-store')
      .header('Set-Cookie', sessionCookie(this.cookieName, token, this.sessionTtlMs / 1_000))
      .code(200)
      .send({
        authenticated: true,
        login_mode: 'password',
        subject: user.email,
        name: user.display_name,
        roles: authority.roles,
        permissions: authority.permissions,
        expires_at: new Date(claims.exp * 1_000).toISOString(),
        csrf_token: claims.csrf
      } satisfies ConsolePasswordAuthState);
  }

  /**
   * Cerrar sesión es borrar la cookie, y es lo único que puede ser: el token es autocontenido.
   * Por eso la vida de la sesión es corta y por eso `active=false` y el cambio de contraseña
   * cortan de verdad — un token robado ANTES del logout vence solo, o se mata desactivando la
   * cuenta. Contesta 204 aunque no hubiera sesión: cerrar algo que ya está cerrado no es un error.
   */
  async logout(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await reply
      .header('Cache-Control', 'no-store')
      .header('Set-Cookie', sessionCookie(this.cookieName, '', 0))
      .code(204)
      .send();
  }
}

function isUnsafe(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method);
}

export function registerPasswordAuth(app: FastifyInstance, provider: PasswordAuthProvider): void {
  app.addHook('onRequest', async (request, reply) => {
    // El CSRF se exige SÓLO a lo que viaja con cookie: es la credencial ambiental que un sitio
    // ajeno puede hacer que el navegador mande solo. Un agente por mTLS no tiene cómo obtener un
    // token CSRF ni lo necesita, y exigírselo lo dejaría sin poder publicar nada.
    if (!request.url.startsWith('/v3/') || !isUnsafe(request.method)) return;
    if (request.url.split('?', 1)[0] === '/v3/auth/login') return;
    if (!provider.handles(request)) return;
    try {
      await provider.requireCsrf(request);
    } catch (error) {
      const status = error instanceof AuthorizationError ? 403 : 401;
      const message = error instanceof Error ? error.message : 'falló la autenticación del request';
      await reply.code(status).send({ error: status === 403 ? 'forbidden' : 'unauthorized', message });
    }
  });

  app.post('/v3/auth/login', async (request, reply) => {
    await provider.login(request, reply);
  });
  app.get('/v3/auth/session', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return provider.authState(request);
  });
  app.post('/v3/auth/logout', async (request, reply) => {
    await provider.logout(request, reply);
  });
}
