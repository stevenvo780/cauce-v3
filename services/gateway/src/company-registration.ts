import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { errorLabel } from '@cauce/protocol';
import { StoreError, registerCompany, type DatabasePool } from '@cauce/store';
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password.js';
import { normalizeEmail } from './console-users.js';
import { rateLimitKey } from './client-ip.js';
import { COMPANY_SLUG_PATTERN, configuredReservedCompanySlugs } from './company-slug.js';
import { PasswordWorkSaturated, passwordWork } from './password-auth.js';

export const CompanyRegistrationSchema = z.object({
  email: z.email().max(254).transform(normalizeEmail),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
  company: z.object({ name: z.string().trim().min(1).max(80), slug: z.string().regex(COMPANY_SLUG_PATTERN) }).strict(),
}).strict();
export type CompanyRegistrationInput = z.infer<typeof CompanyRegistrationSchema>;

export const INVALID_REGISTRATION = { error: 'invalid_request', message: 'Revisa correo, nombre, contraseña (12 caracteres o más) '
  + 'e identificador de empresa (de 2 a 63 minúsculas, números o guiones, empezando por una letra).' };
/** One body for a taken email and a taken or reserved slug: the reply must not say which of them exists. */
export const REGISTRATION_IN_USE = { error: 'conflict', message: 'No se pudo completar el registro: el correo o el identificador de empresa ya están en uso.' };
const TOO_MANY = { error: 'too_many_requests', message: 'Demasiados registros. Intenta más tarde.' };

const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_TRACKED_IPS = 10_000;
const HOUR_MS = 60 * 60_000;

/** Registrations per hour across every client address; 0 closes public registration. */
export function configuredHourlyRegistrations(value = process.env.CAUCE_REGISTRATION_HOURLY_LIMIT ?? '20'): number {
  if (!/^(?:0|[1-9][0-9]{0,5})$/u.test(value.trim())) {
    throw new Error('CAUCE_REGISTRATION_HOURLY_LIMIT must be an integer between 0 and 999999');
  }
  return Number(value.trim());
}

function limited(reply: FastifyReply, retryAfterMs: number): FastifyReply {
  return reply.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1_000)))).code(429).send(TOO_MANY);
}

/** Creates company, hub and owner account and answers; a taken email and a taken slug reach the same derivation and reply. */
export async function registerCompanyWithOwner(pool: DatabasePool, input: CompanyRegistrationInput, reply: FastifyReply): Promise<boolean> {
  const { password, ...data } = input;
  try {
    const passwordHash = await passwordWork.run(() => hashPassword(password));
    await reply.code(201).send(await registerCompany(pool, { ...data, passwordHash }));
    return true;
  } catch (error) {
    if (error instanceof PasswordWorkSaturated) await limited(reply, 5_000);
    else if (error instanceof StoreError && error.code === 'conflict') await reply.code(409).send(REGISTRATION_IN_USE);
    else if (error instanceof StoreError && error.code === 'invalid_input') await reply.code(400).send(INVALID_REGISTRATION);
    else {
      reply.log.warn({ event: 'company_registration_failed', reason: errorLabel(error) }, 'company registration failed');
      await reply.code(503).send({ error: 'registration_unavailable', message: 'No se pudo completar el registro. Intenta más tarde.' });
    }
    return false;
  }
}

export function registerCompanyRegistrationRoute(app: FastifyInstance, pool: DatabasePool,
  hourlyRegistrations = configuredHourlyRegistrations(), reserved = configuredReservedCompanySlugs()): void {
  const attempts = new Map<string, { count: number; until: number }>();
  let hour = { count: 0, until: 0 };
  app.post('/v3/auth/register', { bodyLimit: 8192 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const now = Date.now();
    const key = rateLimitKey(request.ip);
    for (const [ip, entry] of attempts) if (entry.until <= now) attempts.delete(ip);
    const current = attempts.get(key) ?? { count: 0, until: now + WINDOW_MS };
    if (current.count >= MAX_ATTEMPTS || (attempts.size >= MAX_TRACKED_IPS && !attempts.has(key))) return limited(reply, current.until - now);
    current.count += 1; attempts.set(key, current);
    const input = CompanyRegistrationSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send(INVALID_REGISTRATION);
    if (reserved.has(input.data.company.slug)) return reply.code(409).send(REGISTRATION_IN_USE);
    if (hour.until <= now) hour = { count: 0, until: now + HOUR_MS };
    if (hour.count >= hourlyRegistrations) return limited(reply, hour.until - now);
    hour.count += 1;
    await registerCompanyWithOwner(pool, input.data, reply);
  });
}
