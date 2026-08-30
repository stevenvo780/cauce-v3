import { readFileSync } from 'node:fs'; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import { isAbsolute } from 'node:path';
import pg from 'pg';
import {
  ensureMigrationIntegrityTables,
  inspectMigrationIntegrity,
  migrationIntegrityVersions,
  migrationSourcesForApply,
  recordLegacy024Verification,
} from './migration-integrity.js';

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
  const migrations = await migrationSourcesForApply();
  await withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(783_003_003)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await ensureMigrationIntegrityTables(client);
    // Recompute the observed legacy fingerprint on every attempt. A prior verification row is
    // evidence, never permission to trust later drift.
    await inspectMigrationIntegrity(client);
    for (const migration of migrations) {
      const applied = await client.query<{ exists: boolean; source_sha256: string | null }>(
        `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1) AS exists,
                (SELECT source_sha256 FROM schema_migration_ledger WHERE version=$1) AS source_sha256`,
        [migration.version],
      );
      if (applied.rows[0]?.exists) {
        if (migration.version === migrationIntegrityVersions.legacyStructural
            && applied.rows[0].source_sha256 === null) {
          await recordLegacy024Verification(client, migration.sourceSha256);
        }
        continue;
      }
      await client.query(migration.source);
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [migration.version]);
      await client.query(
        `INSERT INTO schema_migration_ledger(version,source_sha256,source_origin)
         VALUES ($1,$2,'applied-atomically')`,
        [migration.version, migration.sourceSha256],
      );
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

function abortFailure(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    signal.reason === undefined ? 'database operation aborted' : String(signal.reason),
  );
  error.name = 'AbortError';
  return error;
}

/** node-postgres does not expose hard socket cancellation on PoolClient's public type. */
function destroyClientSocket(client: DatabaseClient): void {
  const internal = client as unknown as {
    connection?: { stream?: { destroy: () => void } };
  };
  try {
    internal.connection?.stream?.destroy();
  } catch {
    // release(true) below remains the fallback when pg changes its internal transport shape.
  }
}

function clientBackendPid(client: DatabaseClient): number | undefined {
  const internal = client as unknown as { processID?: unknown };
  return typeof internal.processID === 'number' && Number.isSafeInteger(internal.processID)
    && internal.processID > 0 ? internal.processID : undefined;
}

async function terminateBackend(pool: DatabasePool, backendPid: number | undefined): Promise<void> {
  if (backendPid === undefined) return;
  try {
    // Closing a TCP socket does not necessarily wake a backend blocked inside every PostgreSQL
    // wait primitive immediately. Signal our own abandoned backend through a fresh pool checkout
    // and wait for that command before reporting the cancellation complete.
    await pool.query('SELECT pg_terminate_backend($1)', [backendPid]);
  } catch {
    // A DB restart or concurrent reap is already an equivalent terminal outcome. Callers still
    // observe the original abort and readiness independently observes a broader outage.
  }
}

async function connectAbortably(pool: DatabasePool, signal: AbortSignal): Promise<DatabaseClient> {
  if (signal.aborted) throw abortFailure(signal);
  return new Promise<DatabaseClient>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(abortFailure(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void pool.connect().then(
      (client) => {
        signal.removeEventListener('abort', onAbort);
        if (settled || signal.aborted) {
          // The pool wait cannot itself be cancelled.  If a slot arrives after abort, destroy it
          // instead of returning an unobserved checkout to the pool or letting late work start.
          try {
            client.release(true);
          } catch {
            // A concurrently closing pool may already have disposed of the checkout.
          }
          if (!settled) reject(abortFailure(signal));
          return;
        }
        settled = true;
        resolve(client);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * A transaction whose PostgreSQL backend is actually torn down when the caller aborts.
 *
 * Racing an await against a timer only abandons the JavaScript promise: the checked-out pg
 * client and its server-side query keep running and later block pool.end().  This helper owns a
 * dedicated checkout for the whole transaction and calls release(true) from the AbortSignal
 * listener.  pg closes the socket, PostgreSQL reaps the backend and every pending query rejects;
 * no continuation can reach COMMIT after abort.
 */
export async function withAbortableTransaction<T>(
  pool: DatabasePool,
  signal: AbortSignal,
  work: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = await connectAbortably(pool, signal);
  let broken = false;
  let released = false;
  let abortCleanup: Promise<void> = Promise.resolve();
  const onClientError = (): void => {
    broken = true;
  };
  const release = (destroy: boolean): void => {
    if (released) return;
    released = true;
    if (!destroy) client.off('error', onClientError);
    try {
      client.release(destroy);
    } catch {
      // Release must never mask the transaction result or create a secondary rejection.
    }
  };
  const onAbort = (): void => {
    broken = true;
    // Keep the error listener attached while pg tears the socket down: a backend loss can emit
    // more than once and an unhandled EventEmitter error would crash the process during shutdown.
    // PoolClient.release(true) removes the checkout but node-postgres may let an active query keep
    // its socket/backend alive. Destroy the transport first so the pending query actually rejects.
    const backendPid = clientBackendPid(client);
    destroyClientSocket(client);
    release(true);
    abortCleanup = terminateBackend(pool, backendPid);
  };

  client.on('error', onClientError);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) throw abortFailure(signal);
    await client.query('BEGIN');
    if (signal.aborted) throw abortFailure(signal); // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- AbortSignal can change while BEGIN is awaited.
    const result = await work(client);
    if (signal.aborted) throw abortFailure(signal); // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- User work may asynchronously abort the transaction.
    await client.query('COMMIT');
    // Once COMMIT has succeeded, report success even if abort raced immediately afterwards.
    // Returning AbortError here would falsely describe a durable commit as cancelled.
    return result;
  } catch (error) {
    broken ||= connectionFailure(error);
    if (!released && !signal.aborted) { // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- The abort listener can release the client while awaited work rejects.
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
    }
    if (signal.aborted) throw abortFailure(signal);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    release(broken || signal.aborted);
    if (signal.aborted) await abortCleanup;
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
    retryTimer.unref();
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
          onError: (): void => {
            lost(connectedClient);
          },
          onEnd: (): void => {
            lost(connectedClient);
          }
        };
        connectionHandlers.set(connectedClient, handlers);
        connectedClient.on('notification', onNotification);
        connectedClient.on('error', handlers.onError);
        connectedClient.on('end', handlers.onEnd);
        await connectedClient.query('LISTEN cauce_delivery_wake');
        if (stopped) { // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- Shutdown can race the awaited LISTEN query.
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
