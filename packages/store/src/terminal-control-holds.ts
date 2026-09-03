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
 * Tenant and alias are read from the session row, never from the caller's copy of them.
 */
export async function takeControlHold(pool: DatabasePool, input: ControlHoldTake): Promise<ControlHold> {
  const windowMs = boundedWindow(input.windowMs);
  const reason = boundedReason(input.reason);
  return withTransaction(pool, async (client) => {
    await releaseExpired(client, input.tenantId, input.alias);
    const taken = await client.query<ControlHold>(
      `INSERT INTO terminal_control_holds(session_id,tenant_id,alias,operator_id,reason,expires_at)
       SELECT s.id,s.tenant_id,s.alias,$4,$5,now()+($6||' milliseconds')::interval
         FROM terminal_sessions s
        WHERE s.id=$3::uuid AND s.tenant_id=$1 AND s.alias=$2
       RETURNING ${holdColumns}`,
      [input.tenantId, input.alias, input.sessionId, input.operatorId, reason, windowMs],
    ).catch(liveHoldConflict);
    const row = taken.rows[0];
    if (row === undefined) {
      throw new StoreError('not_found', 'the terminal session of this alias does not exist');
    }
    return row;
  });
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

/**
 * Moves the window forward, clamped to the ceiling of the CHECK: the base bounds the extension,
 * not the process that asks for it. The window never shrinks and never outlives `taken_at+12h`.
 */
export async function extendControlHold(
  pool: DatabasePool, change: ControlHoldChange, windowMs: number,
): Promise<ControlHold> {
  const extended = await pool.query<ControlHold>(
    `UPDATE terminal_control_holds
        SET expires_at=LEAST(
              GREATEST(expires_at,now()+($4||' milliseconds')::interval),
              taken_at+interval '12 hours')
      WHERE id=$3::uuid AND tenant_id=$1 AND alias=$2 AND released_at IS NULL AND expires_at>now()
      RETURNING ${holdColumns}`,
    [change.tenantId, change.alias, change.holdId, boundedWindow(windowMs)],
  );
  const row = extended.rows[0];
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
