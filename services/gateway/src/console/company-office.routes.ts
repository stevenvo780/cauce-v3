import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { StoreError, readCompanyOffice, readSavableOfficeRooms, writeCompanyOffice, readCompanyPreferences, writeCompanyPreferences, type DatabasePool } from '@cauce/store';
import { AuthError, AuthorizationError, type AuthProvider } from '../auth.js';
import { consoleHumanAccess } from '../console-human-authority.js';
import { replyError } from '../routes/shared.js';

export function registerCompanyOfficeRoutes(app: FastifyInstance, provider: AuthProvider, pool: DatabasePool): void {
  for (const resource of ['office/layout', 'preferences'] as const) for (const method of ['GET', 'PUT'] as const) {
    app.route({ method, url: `/v3/console/${resource}`, bodyLimit: 262_144, handler: async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        const access = await consoleHumanAccess(provider, request, reply, 'read');
        if (!access) throw new AuthorizationError('a console session is required');
        try {
          const source = (client: import('@cauce/store').DatabaseClient) => access.companyAuthority(client);
          if (resource === 'preferences') return method === 'GET' ? await readCompanyPreferences(pool, source)
            : await writeCompanyPreferences(pool, source, request.body);
          if (method === 'PUT') return await writeCompanyOffice(pool, source, request.body);
          return { ...await readCompanyOffice(pool, source), available: await readSavableOfficeRooms(pool, source) };
        }
        finally { access.close(); }
      } catch (error) {
        if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request', message: 'invalid office layout' });
        if (error instanceof AuthError || error instanceof AuthorizationError || error instanceof StoreError) { replyError(reply, error); return; }
        throw error;
      }
    } });
  }
}
