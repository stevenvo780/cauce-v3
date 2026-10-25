import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PostgresDeviceAuthorizationStore, type DatabasePool } from '@cauce/store';
import { AuthError, AuthorizationError } from './auth.js';
import { rateLimitKey } from './client-ip.js';
import { scalarHeaderValue } from './http-auth-primitives.js';
import { LoginThrottle, PasswordAuthProvider } from './password-auth.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const USER_CODE = /^[A-HJ-NP-Z2-9]{8}$/u;
const DEVICE_CODE = /^[A-Za-z0-9_-]{43}$/u;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function userCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 32) return undefined;
  const normalized = value.trim().replaceAll('-', '').replaceAll(' ', '').toUpperCase();
  return USER_CODE.test(normalized) ? normalized : undefined;
}

function maskedAddress(address: string): string {
  const key = rateLimitKey(address);
  if (key.includes(':')) return `${key.split(':').slice(0, 3).join(':')}:…`;
  const words = key.split('.');
  return words.length === 4 ? `${words.slice(0, 3).join('.')}.*` : 'No disponible';
}

async function failure(reply: FastifyReply, error: string, status = 400, interval?: number): Promise<void> {
  await reply.code(status).send({ error, ...(interval === undefined ? {} : { interval }) });
}

class DeviceAdmission {
  private readonly create = new LoginThrottle(20);
  private readonly token = new LoginThrottle(600);
  private readonly session = new LoginThrottle(20);
  private readonly lookupAddress = new LoginThrottle(60);

  async allow(kind: 'create' | 'token' | 'session', key: string, reply: FastifyReply): Promise<boolean> {
    const throttle = this[kind];
    const now = Date.now();
    const retry = throttle.retryAfterMs(key, now);
    if (retry > 0) {
      reply.header('Retry-After', String(Math.ceil(retry / 1000)));
      await failure(reply, 'too_many_requests', 429);
      return false;
    }
    throttle.recordFailure(key, now);
    return true;
  }

  async lookup(ip: string, reply: FastifyReply): Promise<boolean> {
    const now = Date.now();
    const retry = this.lookupAddress.retryAfterMs(ip, now);
    if (retry > 0) {
      reply.header('Retry-After', String(Math.ceil(retry / 1000)));
      await failure(reply, 'too_many_requests', 429);
      return false;
    }
    this.lookupAddress.recordFailure(ip, now);
    return true;
  }
}

export function registerDeviceAuthorization(app: FastifyInstance, provider: PasswordAuthProvider,
  pool: DatabasePool, consoleOrigins?: readonly string[]): void {
  const store = new PostgresDeviceAuthorizationStore(pool);
  const admission = new DeviceAdmission();
  const verify = provider.verifyCredentialStamp.bind(provider);

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.split('?')[0]?.startsWith('/v3/auth/device')) {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    }
  });

  app.post('/v3/auth/device', { bodyLimit: 1024 }, async (request, reply) => {
    if (!await admission.allow('create', rateLimitKey(request.ip), reply)) return;
    const body = fields(request.body);
    const clientName = body.client_name ?? 'Cauce CLI';
    if (Object.keys(body).some(key => key !== 'client_name') || typeof clientName !== 'string'
        || clientName.trim().length === 0 || clientName.length > 80 || /[\p{Cc}\p{Cf}]/u.test(clientName)) {
      await failure(reply, 'invalid_request'); return;
    }
    const deviceCode = randomBytes(32).toString('base64url');
    const code = [...randomBytes(8)].map(byte => ALPHABET[byte & 31]).join('');
    const formatted = `${code.slice(0, 4)}-${code.slice(4)}`;
    const pending = await store.create({ deviceCodeHash: hash(deviceCode), userCodeHash: hash(code),
      clientName: clientName.trim(), maskedIp: maskedAddress(request.ip) });
    const ownOrigin = new URL(`${request.protocol}://${request.headers.host ?? request.hostname}`).origin;
    const requestedOrigin = scalarHeaderValue(request.headers.origin);
    const allowed = (consoleOrigins?.length ? consoleOrigins : [ownOrigin]).map(origin => new URL(origin).origin);
    const origin = requestedOrigin !== undefined && allowed.includes(requestedOrigin) ? requestedOrigin : allowed[0] ?? ownOrigin;
    const uri = `${origin}/dispositivo`;
    await reply.send({ device_code: deviceCode, user_code: formatted, verification_uri: uri,
      verification_uri_complete: `${uri}?code=${formatted}`, expires_in: 600, interval: pending.interval });
  });

  async function session(request: FastifyRequest, reply: FastifyReply) {
    const verified = await provider.verifiedConsoleSession(request);
    if (verified === undefined) throw new AuthError('Se requiere iniciar sesión en la consola.');
    if (!await admission.allow('session', verified.loginSid, reply)
        || !await admission.lookup(rateLimitKey(request.ip), reply)) return undefined;
    return verified;
  }

  app.get<{ Params: { user_code: string } }>('/v3/auth/device/:user_code', async (request, reply) => {
    if (!await session(request, reply)) return;
    const code = userCode(request.params.user_code);
    const pending = code === undefined ? undefined : await store.lookup(hash(code));
    if (pending === undefined) { await failure(reply, 'invalid_request', 404); return; }
    await reply.send({ client_name: pending.clientName, created_at: pending.createdAt, masked_ip: pending.maskedIp,
      expires_at: pending.expiresAt, status: 'pending' });
  });

  app.post('/v3/auth/device/approve', { bodyLimit: 1024 }, async (request, reply) => {
    const verified = await session(request, reply);
    if (verified === undefined) return;
    await provider.requireCsrf(request);
    const body = fields(request.body);
    const code = userCode(body.user_code);
    if (Object.keys(body).length !== 2 || code === undefined || !['approve', 'deny'].includes(String(body.decision))) {
      await failure(reply, 'invalid_request'); return;
    }
    const state = await provider.authState(request);
    if (verified.credentialStamp === undefined || state.authority === undefined || state.authority.scope === 'none') {
      throw new AuthorizationError('Renueva la sesión y elige una empresa activa antes de autorizar.');
    }
    const result = await store.decide({ userCodeHash: hash(code), decision: body.decision as 'approve' | 'deny',
      humanId: verified.humanId, tenantId: verified.tenantId, actorAlias: verified.actorAlias,
      activeCompany: state.authority.acting_company, credentialStamp: verified.credentialStamp,
      sessionExpiresAtMs: verified.expiresAtMs, verifyCredentialStamp: verify });
    if (result === 'expired_token' || result === 'invalid_request') { await failure(reply, result, 404); return; }
    await reply.send({ status: result });
  });

  app.post('/v3/auth/device/token', { bodyLimit: 1024 }, async (request, reply) => {
    if (!await admission.allow('token', rateLimitKey(request.ip), reply)) return;
    const body = fields(request.body);
    if (Object.keys(body).length !== 1 || typeof body.device_code !== 'string' || !DEVICE_CODE.test(body.device_code)) {
      await failure(reply, 'invalid_request'); return;
    }
    const result = await store.poll(hash(body.device_code), verify);
    if (result.status !== 'approved') {
      await failure(reply, result.status, 400, 'interval' in result ? result.interval : undefined); return;
    }
    try {
      await provider.completeDeviceLogin(reply, result);
    } catch (error) {
      if (!(error instanceof AuthError) && !(error instanceof AuthorizationError)) throw error;
      await failure(reply, 'access_denied');
    }
  });
}
