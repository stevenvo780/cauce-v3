import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COMPANY_ID_PATTERN, StoreError, registerCompany, type DatabasePool } from '@cauce/store';
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password.js';
import { normalizeEmail } from './console-users.js';
import { replyError } from './routes/shared.js';

export const CompanyRegistrationSchema = z.object({
  email: z.email().max(254).transform(normalizeEmail),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
  company: z.object({ name: z.string().trim().min(1).max(80), slug: z.string().regex(COMPANY_ID_PATTERN) }).strict(),
}).strict();

const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_TRACKED_IPS = 10_000;
export function registerCompanyRegistrationRoute(app: FastifyInstance, pool: DatabasePool): void {
  const attempts = new Map<string, { count: number; until: number }>();
  let hashing = 0;
  app.post('/v3/auth/register', { bodyLimit: 8192 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const now = Date.now();
    for (const [ip, entry] of attempts) if (entry.until <= now) attempts.delete(ip);
    const current = attempts.get(request.ip) ?? { count: 0, until: now + WINDOW_MS };
    if (current.count >= MAX_ATTEMPTS || hashing >= 4 || (attempts.size >= MAX_TRACKED_IPS && !attempts.has(request.ip))) {
      return reply.header('Retry-After', String(Math.max(1, Math.ceil((current.until - now) / 1_000))))
        .code(429).send({ error: 'too_many_requests', message: 'Demasiados registros. Intenta más tarde.' });
    }
    current.count += 1; attempts.set(request.ip, current);
    const input = CompanyRegistrationSchema.safeParse(request.body);
    if (!input.success) return await reply.code(400).send({ error: 'invalid_request', message: 'Revisa correo, nombre, contraseña y empresa.' });
    hashing += 1;
    try {
      const { password, ...data } = input.data;
      const passwordHash = await hashPassword(password);
      return await reply.code(201).send(await registerCompany(pool, { ...data, passwordHash }));
    } catch (error) {
      if (error instanceof StoreError) { replyError(reply, error); return; }
      return await reply.code(503).send({ error: 'registration_unavailable', message: 'No se pudo completar el registro.' });
    } finally { hashing -= 1; }
  });
}
