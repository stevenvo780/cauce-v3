import { randomUUID } from 'node:crypto';
import { isLiteralTrue } from '@cauce/protocol';
import { withTransaction, type DatabaseClient, type DatabasePool } from '@cauce/store';
import { ProviderAuthError } from './provider-auth.contracts.js';

export interface ProviderAuthReservation {
  session_id: string; actor_subject: string; cohort: string; expires_at: string;
  state: 'reserved' | 'releasing' | 'released'; release_id?: string; release_until?: string;
}
export async function recordProviderAuthReservation(client: DatabaseClient, operationId: string,
  name: 'step_started' | 'step_completed', reservation: ProviderAuthReservation, advance = true): Promise<void> {
  const next = (await client.query<{ version: string }>(advance
    ? 'UPDATE fleet_operations SET version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING version'
    : 'SELECT version FROM fleet_operations WHERE id=$1', [operationId])).rows[0];
  if (!next) throw new ProviderAuthError('SESSION_CONFLICT');
  await client.query('INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,$2,$3,$4::jsonb)',
    [operationId, next.version, name, JSON.stringify({ step: 'authenticate', provider_auth: reservation })]);
}
export async function latestProviderAuthReservation(client: DatabaseClient, operationId: string): Promise<ProviderAuthReservation | undefined> {
  return (await client.query<{ reservation: ProviderAuthReservation }>(`SELECT metadata->'provider_auth' AS reservation FROM fleet_operation_events
    WHERE operation_id=$1 AND metadata ? 'provider_auth' ORDER BY id DESC LIMIT 1`, [operationId])).rows[0]?.reservation;
}
export async function lockProviderAuthReservation(client: DatabaseClient, operationId: string, cohort: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,783003005))', [cohort]);
  await client.query('SELECT id FROM fleet_operations WHERE id=$1 FOR UPDATE', [operationId]);
}
export async function releaseProviderAuthReservation(pool: DatabasePool, operationId: string, cohort: string, sessionId: string,
  cleanup: () => Promise<{ stopped: boolean }>,
  recordResult?: (client: DatabaseClient, failure: Error | undefined) => Promise<void>): Promise<boolean> {
  const claimed = await withTransaction(pool, async client => {
    await lockProviderAuthReservation(client, operationId, cohort);
    const current = await latestProviderAuthReservation(client, operationId);
    if (current?.session_id !== sessionId) throw new ProviderAuthError('SESSION_CONFLICT');
    if (current.state === 'released') return undefined;
    if (current.state === 'releasing' && Date.parse(current.release_until ?? '') > Date.now()) throw new ProviderAuthError('SESSION_CONFLICT');
    const reservation: ProviderAuthReservation = { ...current, state: 'releasing', release_id: randomUUID(),
      // The broker's remote command times out after 330 seconds.
      release_until: new Date(Date.now() + 360_000).toISOString() };
    await recordProviderAuthReservation(client, operationId, 'step_started', reservation, false);
    return reservation;
  });
  if (!claimed) return false;
  let failure: Error | undefined;
  try { if (!isLiteralTrue((await cleanup()).stopped)) throw new ProviderAuthError('STOP_UNCONFIRMED'); }
  catch (error) { failure = error instanceof Error ? error : new ProviderAuthError('STOP_UNCONFIRMED'); }
  await withTransaction(pool, async client => {
    await lockProviderAuthReservation(client, operationId, cohort);
    const current = await latestProviderAuthReservation(client, operationId);
    if (current?.session_id !== sessionId || current.state !== 'releasing' || current.release_id !== claimed.release_id) {
      throw new ProviderAuthError('SESSION_CONFLICT');
    }
    const { release_id: _id, release_until: _until, ...reservation } = current;
    await recordProviderAuthReservation(client, operationId, 'step_completed',
      { ...reservation, state: failure === undefined ? 'released' : 'reserved' }, failure === undefined);
    await recordResult?.(client, failure);
  });
  if (failure !== undefined) throw failure;
  return true;
}
