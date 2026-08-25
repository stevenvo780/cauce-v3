import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { withTransaction, type DatabasePool } from '@cauce/store';

export interface HealthOptions {
  pool: DatabasePool;
  logger?: boolean;
  requirePostgresTls?: boolean;
  /** The externally-facing data listener, distinct from the loopback health server. */
  dataApp?: Pick<FastifyInstance, 'server'>;
  /** A bounded, non-mutating probe of the tables used by the delivery ACK transaction. */
  ackProbe?: () => Promise<void>;
}

async function readiness(options: HealthOptions, reply: FastifyReply): Promise<unknown> {
  try {
    await options.pool.query('SELECT 1');
  } catch {
    return reply.code(503).send({ status: 'not_ready', reason: 'postgres_unavailable' });
  }
  if (options.requirePostgresTls === true) {
    try {
      const encrypted = await options.pool.query<{ ssl: boolean }>(
        'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()'
      );
      if (encrypted.rows[0]?.ssl !== true) {
        return reply.code(503).send({ status: 'not_ready', reason: 'postgres_tls_required' });
      }
    } catch {
      return reply.code(503).send({ status: 'not_ready', reason: 'postgres_unavailable' });
    }
  }
  if (options.dataApp !== undefined && !options.dataApp.server.listening) {
    return reply.code(503).send({ status: 'not_ready', reason: 'data_listener_down' });
  }
  try {
    await options.ackProbe?.();
  } catch {
    return reply.code(503).send({ status: 'not_ready', reason: 'ack_path_unavailable' });
  }
  return { status: 'ready' };
}

/**
 * Exercises relation availability and query permissions for both sides of the ACK ledger without
 * selecting payloads or identities and without mutating a delivery.
 */
export async function probeAckPath(pool: DatabasePool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query("SET LOCAL lock_timeout='1000ms'");
    await client.query("SET LOCAL statement_timeout='2000ms'");
    await client.query(
      `SELECT 1 FROM deliveries d
       LEFT JOIN delivery_acks a ON a.delivery_id=d.id
       LIMIT 1`
    );
  });
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
