import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
export type DatabasePool = pg.Pool;
export type DatabaseClient = pg.PoolClient;

export interface DeliveryWakeNotice {
  tenant_id: string;
  alias: string;
}

export interface DeliveryWakeSubscriptionOptions {
  minBackoffMs?: number;
  maxBackoffMs?: number;
  onStateChange?: (state: 'connected' | 'disconnected' | 'reconnecting') => void;
}

export interface DatabasePoolOptions {
  max?: number;
  /** Bounds both new connections and waits for a checked-out pool slot. */
  connectionTimeoutMillis?: number;
  applicationName?: string;
}

const defaultConnectionTimeoutMillis = 5_000;

function productionSsl(connectionString: string): { ca: string; rejectUnauthorized: true } | undefined {
  if (process.env.NODE_ENV !== 'production') return undefined;
  let mode: string | null;
  try {
    mode = new URL(connectionString).searchParams.get('sslmode') ?? process.env.PGSSLMODE ?? null;
  } catch {
    throw new Error('production DATABASE_URL is invalid');
  }
  if (mode !== 'verify-full') {
    throw new Error('production PostgreSQL requires sslmode=verify-full');
  }
  const rootCertificate = process.env.PGSSLROOTCERT;
  if (!rootCertificate || !isAbsolute(rootCertificate)) {
    throw new Error('production PostgreSQL requires an absolute PGSSLROOTCERT path');
  }
  try {
    return { ca: readFileSync(rootCertificate, 'utf8'), rejectUnauthorized: true };
  } catch (error) {
    throw new Error('production PostgreSQL root certificate is unavailable', { cause: error });
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function connectionFailure(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return code.startsWith('08') || ['57P01', '57P02', '57P03', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(code);
}

export function createPool(connectionString: string, options: DatabasePoolOptions = {}): DatabasePool {
  const ssl = productionSsl(connectionString);
  const pool = new Pool({
    connectionString,
    max: positiveInteger(options.max ?? 20, 'pool max'),
    connectionTimeoutMillis: positiveInteger(
      options.connectionTimeoutMillis ?? defaultConnectionTimeoutMillis,
      'connectionTimeoutMillis'
    ),
    application_name: options.applicationName ?? 'cauce-v3',
    ...(ssl === undefined ? {} : { ssl })
  });
  // pg emits idle-client failures (for example during a DB restart) on the pool.
  // Readiness and callers still observe query failures; this listener prevents process crashes.
  pool.on('error', () => undefined);
  return pool;
}

export async function applyMigrations(pool: DatabasePool): Promise<void> {
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  await withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(783_003_003)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const file of files) {
      const applied = await client.query<{ exists: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = $1) AS exists', [file]
      );
      if (!applied.rows[0]?.exists) {
        await client.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
      }
    }
  });
}

export async function withTransaction<T>(pool: DatabasePool, work: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  const onClientError = (): void => {
    broken = true;
  };
  // Pool-level error handlers only cover idle clients. A checked-out client needs its own
  // listener or a backend termination can become an uncaught EventEmitter error.
  client.on('error', onClientError);
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    broken ||= connectionFailure(error);
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    if (!broken) client.off('error', onClientError);
    try {
      // Destroy failed sockets instead of returning them to the pool. Keep the terminal
      // listener attached until pg tears a broken client down; some failures emit twice.
      client.release(broken);
    } catch {
      // Release must never mask the transaction result or create a secondary rejection.
    }
  }
}

/** Best-effort low-latency wake path; adapter_outbox remains the durable fallback. */
export async function subscribeDeliveryWakes(
  pool: DatabasePool,
  listener: (notice: DeliveryWakeNotice) => void,
  options: DeliveryWakeSubscriptionOptions = {}
): Promise<() => Promise<void>> {
  const minBackoffMs = Math.max(1, options.minBackoffMs ?? 100);
  const maxBackoffMs = Math.max(minBackoffMs, options.maxBackoffMs ?? 5_000);
  let stopped = false;
  let current: DatabaseClient | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let reconnectAttempt = 0;
  let connecting: Promise<void> | undefined;
  const connectionHandlers = new WeakMap<DatabaseClient, { onError: () => void; onEnd: () => void }>();

  const onNotification = (notification: pg.Notification): void => {
    if (notification.channel !== 'cauce_delivery_wake' || !notification.payload) return;
    try {
      const decoded: unknown = JSON.parse(notification.payload);
      if (decoded && typeof decoded === 'object') {
        const record = decoded as Record<string, unknown>;
        const tenantId = record.tenant_id;
        const alias = record.alias;
        if (typeof tenantId === 'string' && typeof alias === 'string') {
          listener({ tenant_id: tenantId, alias });
        }
      }
    } catch {
      // Ignore malformed notifications: the outbox poller still guarantees wake delivery.
    }
  };

  const detach = (client: DatabaseClient): void => {
    client.off('notification', onNotification);
    const handlers = connectionHandlers.get(client);
    if (handlers) {
      client.off('error', handlers.onError);
      client.off('end', handlers.onEnd);
      connectionHandlers.delete(client);
    }
  };

  const destroy = (client: DatabaseClient): void => {
    detach(client);
    // A PostgreSQL restart can emit a second socket/client error after the first loss event.
    // Keep a terminal listener until pg destroys the client so EventEmitter never escalates it.
    client.on('error', () => undefined);
    try {
      client.release(true);
    } catch {
      // A concurrently closed socket may already have released itself.
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || retryTimer) return;
    options.onStateChange?.('reconnecting');
    const delay = Math.min(maxBackoffMs, minBackoffMs * (2 ** reconnectAttempt));
    reconnectAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void connect(false);
    }, delay);
    retryTimer.unref?.();
  };

  const lost = (client: DatabaseClient): void => {
    if (client !== current) return;
    current = undefined;
    destroy(client);
    options.onStateChange?.('disconnected');
    scheduleReconnect();
  };

  const connect = (initial: boolean): Promise<void> => {
    if (connecting) return connecting;
    connecting = (async () => {
      let client: DatabaseClient | undefined;
      try {
        client = await pool.connect();
        if (stopped) {
          try {
            client.release();
          } catch {
            // The pool may have closed while the connection attempt was in flight.
          }
          return;
        }
        const connectedClient = client;
        const handlers = {
          onError: (): void => lost(connectedClient),
          onEnd: (): void => lost(connectedClient)
        };
        connectionHandlers.set(connectedClient, handlers);
        connectedClient.on('notification', onNotification);
        connectedClient.on('error', handlers.onError);
        connectedClient.on('end', handlers.onEnd);
        await connectedClient.query('LISTEN cauce_delivery_wake');
        if (stopped) {
          detach(connectedClient);
          try {
            connectedClient.release();
          } catch {
            // The listener connection may have died concurrently with shutdown.
          }
          return;
        }
        current = connectedClient;
        reconnectAttempt = 0;
        options.onStateChange?.('connected');
      } catch (error) {
        if (client) {
          destroy(client);
        }
        if (initial) throw error;
        scheduleReconnect();
      } finally {
        connecting = undefined;
      }
    })();
    return connecting;
  };

  await connect(true);
  return async () => {
    if (stopped) return;
    stopped = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    await connecting?.catch(() => undefined);
    const client = current;
    current = undefined;
    if (!client) return;
    try {
      await client.query('UNLISTEN cauce_delivery_wake');
    } catch {
      destroy(client);
      return;
    } finally {
      detach(client);
    }
    try {
      client.release();
    } catch {
      // Shutdown is best effort after UNLISTEN has completed.
    }
  };
}
