import { withTransaction, type DatabaseClient, type DatabasePool } from './db.js';
import { StoreError } from './repository/errors.js';

/**
 * Take, release, extend and read the control hold of a TUI (migration 040). While a hold is live
 * `claimOne` does not select the deliveries of its alias: they stay `pending` and resume in order.
 */

/** The window ceiling migration 040 enforces; the extension path may never exceed it. */
export const CONTROL_HOLD_MAX_WINDOW_MS = 12 * 60 * 60 * 1_000;

const holdColumns =
  'id,session_id,tenant_id,alias,operator_id,taken_at,expires_at,released_at,released_reason';

export interface ControlHold {
  id: string;
  session_id: string;
  tenant_id: string;
  alias: string;
  operator_id: string;
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
  windowMs: number;
  sessionTtlSeconds: number;
  sessionMaxTotalSeconds: number | null;
  allowBusy?: boolean;
}

export class TerminalAgentBusyError extends StoreError {
  constructor() {
    super('conflict', 'agent_busy');
  }
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
    `UPDATE terminal_control_holds SET released_at=clock_timestamp(),released_reason='expired'
      WHERE tenant_id=$1 AND alias=$2 AND released_at IS NULL AND expires_at<=clock_timestamp()`,
    [tenantId, alias],
  );
}

// Callers lock authority first, then this lease before terminal row fences, in the same transaction.
export async function lockTerminalControlLease(
  client: DatabaseClient, identity: Pick<ControlHoldTake, 'tenantId' | 'alias'>,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `connection-lease:${identity.tenantId}:${identity.alias}`,
  ]);
  await client.query(
    'SELECT alias FROM connection_leases WHERE tenant_id=$1 AND alias=$2 FOR UPDATE',
    [identity.tenantId, identity.alias],
  );
}

export async function takeControlHold(pool: DatabasePool, input: ControlHoldTake): Promise<ControlHold> {
  return withTransaction(pool, (client) => takeControlHoldWithinTransaction(client, input));
}

// This operation preserves caller locks; it does not authenticate authority by itself.
export async function takeControlHoldWithinTransaction(
  client: DatabaseClient, input: ControlHoldTake, authorityExpiresAt?: Date,
): Promise<ControlHold> {
  const windowMs = boundedWindow(input.windowMs);
  const ttlSeconds = boundedSeconds(input.sessionTtlSeconds);
  const maxTotalSeconds = input.sessionMaxTotalSeconds === null
    ? null : boundedSeconds(input.sessionMaxTotalSeconds);
  if (authorityExpiresAt !== undefined
      && (!(authorityExpiresAt instanceof Date) || !Number.isFinite(authorityExpiresAt.getTime()))) {
    throw new StoreError('invalid_input', 'terminal control authority deadline is invalid');
  }
  const authorityDeadline = authorityExpiresAt?.toISOString() ?? null;
  const sessionWindow = terminalSessionWindowExpression(6, 7);
  await lockTerminalControlLease(client, input);
  if (input.allowBusy !== true) {
    const active = await client.query(
      `SELECT id FROM deliveries WHERE recipient_tenant=$1 AND recipient_alias=$2
        AND status IN ('leased','accepted','started') LIMIT 1`,
      [input.tenantId, input.alias],
    );
    if (active.rows.length > 0) throw new TerminalAgentBusyError();
  }
  const session = await client.query(
    'SELECT id FROM terminal_sessions WHERE id=$3::uuid AND tenant_id=$1 AND alias=$2 FOR UPDATE',
    [input.tenantId, input.alias, input.sessionId],
  );
  if (session.rows.length === 0) throw new StoreError('not_found', 'there is no live terminal session for this alias');
  await client.query(
    `SELECT id FROM terminal_control_holds
      WHERE tenant_id=$1 AND alias=$2 AND released_at IS NULL ORDER BY id FOR UPDATE`,
    [input.tenantId, input.alias],
  );
  await releaseExpired(client, input.tenantId, input.alias);
  const clock = await client.query<{ taken_at: string; authority_live: boolean }>(
    `WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS taken_at)
     SELECT taken_at::text, ($1::timestamptz IS NULL OR $1::timestamptz>taken_at) AS authority_live FROM clock`,
    [authorityDeadline],
  );
  const instant = clock.rows[0];
  if (instant === undefined) throw new Error('terminal control clock is unavailable');
  if (!instant.authority_live) throw new StoreError('forbidden', 'terminal control authority expired');
  const taken = await client.query<ControlHold>(
    `INSERT INTO terminal_control_holds(session_id,tenant_id,alias,operator_id,reason,taken_at,expires_at)
     SELECT id,tenant_id,alias,$4,'',$8::timestamptz,
            LEAST(${sessionWindow}, $8::timestamptz+($5||' milliseconds')::interval, $9::timestamptz)
       FROM terminal_sessions
      WHERE id=$3::uuid AND tenant_id=$1 AND alias=$2
        AND consumed_at IS NOT NULL AND revoked_at IS NULL AND closed_at IS NULL
        AND ${sessionWindow}>clock_timestamp()
        AND ($9::timestamptz IS NULL OR $9::timestamptz>clock_timestamp())
     RETURNING ${holdColumns}`,
    [input.tenantId, input.alias, input.sessionId, input.operatorId, windowMs,
      ttlSeconds, maxTotalSeconds, instant.taken_at, authorityDeadline],
  ).catch(liveHoldConflict);
  const row = taken.rows[0];
  if (row === undefined) throw new StoreError('not_found', 'there is no live terminal session for this alias');
  return row;
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
    `UPDATE terminal_control_holds SET released_at=clock_timestamp(),released_reason=$2
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
    `UPDATE terminal_control_holds SET released_at=clock_timestamp(),released_reason=$4
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
