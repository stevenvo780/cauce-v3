import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { DatabasePool } from '@cauce/store';

export interface HealthOptions {
  pool: DatabasePool;
  logger?: boolean;
  requirePostgresTls?: boolean;
}

async function readiness(options: HealthOptions, reply: FastifyReply): Promise<unknown> {
  try {
    await options.pool.query('SELECT 1');
    if (options.requirePostgresTls === true) {
      const encrypted = await options.pool.query<{ ssl: boolean }>(
        'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()'
      );
      if (encrypted.rows[0]?.ssl !== true) throw new Error('postgres TLS is required');
    }
    return { status: 'ready' };
  } catch {
    return reply.code(503).send({ status: 'not_ready' });
  }
}

export function registerHealthRoutes(app: FastifyInstance, options: HealthOptions): void {
  app.get('/health/live', async () => ({ status: 'live' }));
  app.get('/health/ready', async (_request, reply) => readiness(options, reply));
}

/** Health-only app intended to bind to 127.0.0.1; it contains no data routes. */
export async function buildLoopbackHealthProbe(options: HealthOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  registerHealthRoutes(app, options);
  return app;
}
