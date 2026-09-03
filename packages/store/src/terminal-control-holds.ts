import { withTransaction, type DatabaseClient, type DatabasePool } from './db.js';
import { StoreError } from './repository/errors.js';

/**
 * Take, release, extend and read the control hold of a TUI (migration 040). While a hold is live
 * `claimOne` does not select the deliveries of its alias: they stay `pending` and resume in order.
 */

/** The window ceiling migration 040 enforces; the extension path may never exceed it. */
export const CONTROL_HOLD_MAX_WINDOW_MS = 12 * 60 * 60 * 1_000;

const holdColumns =
  'id,session_id,tenant_id,alias,operator_id,reason,taken_at,expires_at,released_at,released_reason';

export interface ControlHold {
  id: string;
  session_id: string;
  tenant_id: string;
  alias: string;
  operator_id: string;
  reason: string;
  taken_at: Date;
  expires_at: Date;
  released_at: Date | null;
  released_reason: string | null;
}

export interface ControlHoldTake {
  tenantId: string;
  alias: string;
  sessionId: string;
  operatorId: string;
  reason: string;
  windowMs: number;
  sessionTtlSeconds: number;
  sessionMaxTotalSeconds: number | null;
}

export interface ControlHoldChange {
  tenantId: string;
  alias: string;
  holdId: string;
}

function boundedWindow(windowMs: number): string {
  if (!Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > CONTROL_HOLD_MAX_WINDOW_MS) {
    throw new StoreError('invalid_input', 'terminal control hold window is out of range');
  }
  return String(windowMs);
}

function boundedSeconds(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    throw new StoreError('invalid_input', 'terminal session window is out of range');
  }
  return seconds;
}

/**
 * The session window of migration 040 as SQL, over the columns of `terminal_sessions`: the TTL
 * from `consumed_at`, pushed by `window_extended_to` and clamped by the total ceiling. The gateway
 * derives its own copy from this builder, so the hold and `/authz` cannot drift apart.
 */
export function terminalSessionWindowExpression(
  ttlParameter: number, maxTotalParameter?: number,
): string {
  const extended = `GREATEST(consumed_at + make_interval(secs => $${String(ttlParameter)}), COALESCE(window_extended_to, 'epoch'::timestamptz))`;
  if (maxTotalParameter === undefined) return extended;
  return `LEAST(${extended}, consumed_at + make_interval(secs => $${String(maxTotalParameter)}))`;
}

function boundedReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === '') throw new StoreError('invalid_input', 'terminal control hold requires a reason');
  return trimmed;
}

function liveHoldConflict(error: unknown): never {
  const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === '23505') {
    throw new StoreError('conflict', 'the terminal control of this alias is already held');
  }
  throw error;
}

/** A browser that dies without releasing frees its slot here, on the next take of its alias. */
async function releaseExpired(client: DatabaseClient, tenantId: string, alias: string): Promise<void> {
  await client.query(
    `UPDATE terminal_control_holds SET released_at=now(),released_reason='expired'
      WHERE tenant_id=$1 AND alias=$2 AND released_at IS NULL AND expires_at<=now()`,
    [tenantId, alias],
  );
}

/**
 * Takes the control of an alias in ONE transaction: expired holds of that alias are released as
 * `expired` first, so a dead browser never blocks a re-take, and a hold still live is a conflict.
 * Tenant, alias and the end of the window are read from the session row under `FOR UPDATE`, never
 * from the caller's copy of them: a session already closed, revoked, unconsumed or out of window
 * matches nothing, and the hold can never outlive the session it belongs to.
 */
export async function takeControlHold(pool: DatabasePool, input: ControlHoldTake): Promise<ControlHold> {
  const windowMs = boundedWindow(input.windowMs);
  const reason = boundedReason(input.reason);
  const ttlSeconds = boundedSeconds(input.sessionTtlSeconds);
  const maxTotalSeconds = input.sessionMaxTotalSeconds === null
    ? null : boundedSeconds(input.sessionMaxTotalSeconds);
  const sessionWindow = terminalSessionWindowExpression(7, 8);
  return withTransaction(pool, async (client) => {
    await releaseExpired(client, input.tenantId, input.alias);
    const taken = await client.query<ControlHold>(
      `WITH live AS (
         SELECT s.id,s.tenant_id,s.alias,
                LEAST(${sessionWindow}, now()+($6||' milliseconds')::interval) AS window_ends_at
           FROM terminal_sessions s
          WHERE s.id=$3::uuid AND s.tenant_id=$1 AND s.alias=$2
            AND consumed_at IS NOT NULL AND revoked_at IS NULL AND closed_at IS NULL
            AND ${sessionWindow}>now()
          FOR UPDATE
       )
       INSERT INTO terminal_control_holds(session_id,tenant_id,alias,operator_id,reason,expires_at)
       SELECT live.id,live.tenant_id,live.alias,$4,$5,live.window_ends_at FROM live
       RETURNING ${holdColumns}`,
      [input.tenantId, input.alias, input.sessionId, input.operatorId, reason, windowMs,
        ttlSeconds, maxTotalSeconds],
    ).catch(liveHoldConflict);
    const row = taken.rows[0];
    if (row === undefined) {
      throw new StoreError('not_found', 'there is no live terminal session for this alias');
    }
    return row;
  });
}

/**
 * Teardown release, inside the transaction that closes or revokes the session: every live hold of
 * that session goes back with its audit reason and the deliveries of the alias resume. A hold
 * already released matches nothing, so a retried teardown is a no-op instead of a failure.
 */
export async function releaseSessionControlHolds(
  client: DatabaseClient, sessionId: string, reason: string,
): Promise<ControlHold[]> {
  const released = await client.query<ControlHold>(
    `UPDATE terminal_control_holds SET released_at=now(),released_reason=$2
      WHERE session_id=$1::uuid AND released_at IS NULL
      RETURNING ${holdColumns}`,
    [sessionId, boundedReason(reason)],
  );
  return released.rows;
}

/** Releases a live hold with its audit reason; the deliveries of the alias resume in order. */
export async function releaseControlHold(
  pool: DatabasePool, change: ControlHoldChange, reason: string,
): Promise<ControlHold> {
  const released = await pool.query<ControlHold>(
    `UPDATE terminal_control_holds SET released_at=now(),released_reason=$4
      WHERE id=$3::uuid AND tenant_id=$1 AND alias=$2 AND released_at IS NULL
      RETURNING ${holdColumns}`,
    [change.tenantId, change.alias, change.holdId, boundedReason(reason)],
  );
  const row = released.rows[0];
  if (row === undefined) throw new StoreError('not_found', 'there is no live terminal control hold');
  return row;
}

/** The live hold of an alias, or `undefined`: an expired one no longer gates anything. */
export async function currentControlHold(
  pool: DatabasePool, tenantId: string, alias: string,
): Promise<ControlHold | undefined> {
  const current = await pool.query<ControlHold>(
    `SELECT ${holdColumns} FROM terminal_control_holds
      WHERE tenant_id=$1 AND alias=$2 AND released_at IS NULL AND expires_at>now()`,
    [tenantId, alias],
  );
  return current.rows[0];
}
