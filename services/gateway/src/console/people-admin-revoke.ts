import type { DatabaseClient } from '@cauce/store';
import { decodeTerminalSubject } from '../terminal/authority-continuity.js';
import type { PeopleAdminPerson } from './people-admin-schema.js';

export function ownsPeopleTerminalSession(person: Pick<PeopleAdminPerson, 'id' | 'email'>, row: { console_subject: string; attributed: boolean; operator_id: string }): boolean {
  try { const subject = decodeTerminalSubject(row.console_subject); return subject.kind === 'human' && subject.humanId === person.id; }
  catch { return !row.console_subject.startsWith('m2.') && row.attributed && row.operator_id === person.email; }
}
export async function revokePeopleAccess(client: DatabaseClient, person: PeopleAdminPerson): Promise<void> {
  await client.query(`INSERT INTO cauce_oauth_grant_revocations(grant_id)
    SELECT id FROM cauce_oauth_grants WHERE human_id=$1 ON CONFLICT(grant_id) DO NOTHING`, [person.id]);
  await client.query(`UPDATE cauce_oauth_tokens SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL
    AND grant_id IN (SELECT id FROM cauce_oauth_grants WHERE human_id=$1)`, [person.id]);
  await client.query('UPDATE human_oauth_client_delegations SET revoked_at=clock_timestamp() WHERE human_id=$1 AND revoked_at IS NULL', [person.id]);
  const candidates = await client.query<{ id: string; operator_id: string; console_subject: string; attributed: boolean }>(
    `SELECT id,operator_id,console_subject,attributed FROM terminal_sessions
     WHERE revoked_at IS NULL AND closed_at IS NULL AND (console_subject LIKE 'h2.%' OR operator_id=$1)
     ORDER BY id FOR UPDATE`, [person.email]);
  const ids = candidates.rows.filter(row => ownsPeopleTerminalSession(person, row)).map(row => row.id);
  if (ids.length) {
    await client.query('UPDATE terminal_sessions SET revoked_at=clock_timestamp() WHERE id=ANY($1::uuid[]) AND revoked_at IS NULL', [ids]);
    await client.query(`UPDATE terminal_control_holds SET released_at=clock_timestamp(),released_reason='human_access_revoked'
      WHERE session_id=ANY($1::uuid[]) AND released_at IS NULL`, [ids]);
  }
}
