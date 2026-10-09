import { withTransaction, type DatabaseClient, type DatabasePool } from '@cauce/store';
import { z } from 'zod';
import { hashPassword } from '../password.js';
import { normalizeEmail } from '../console-users.js';
import { consoleRoleAuthority } from '../console-user-authority.js';
import { assertPeopleAuthority, assertPeopleCompany, peopleAliasAuthority, peopleCompanyScopeSql, protectLastPeopleAdministrator } from './people-admin-authority.js';
import { ownsPeopleTerminalSession, revokePeopleAccess } from './people-admin-revoke.js';
import {
  PEOPLE_ADMIN_CAPABILITIES, PeopleAdminControlSchema, PeopleAdminCreateSchema, PeopleAdminError, PeopleAdminIdSchema,
  PeopleAdminPersonSchema, PeopleAdminUpdateSchema, type PeopleAdminActor, type PeopleAdminPerson,
} from './people-admin-schema.js';

const COLUMNS = 'id,email,display_name,role,tenant_id,alias,active,(extract(epoch FROM updated_at)*1000000)::numeric(20,0)::text AS revision';
function person(value: unknown): PeopleAdminPerson { return PeopleAdminPersonSchema.parse(value); }
async function lockPerson(client: DatabaseClient, id: string, revision: string, actorTenant: string): Promise<PeopleAdminPerson> {
  const row = (await client.query<PeopleAdminPerson>(`SELECT ${COLUMNS} FROM console_users
    WHERE id=$1 AND ${peopleCompanyScopeSql('tenant_id', '$2')} FOR UPDATE`, [id, actorTenant])).rows[0];
  if (!row) throw new PeopleAdminError('not_found');
  const foreign = await client.query(`SELECT 1 FROM human_tenant_memberships
    WHERE human_id=$1 AND enabled AND revoked_at IS NULL AND NOT (${peopleCompanyScopeSql('tenant_id', '$2')}) FOR SHARE`, [id, actorTenant]);
  if (foreign.rowCount) throw new PeopleAdminError('conflict');
  const current = person(row); if (current.revision !== revision) throw new PeopleAdminError('conflict'); return current;
}
async function syncMembership(client: DatabaseClient, value: PeopleAdminPerson): Promise<void> {
  await client.query(`UPDATE human_tenant_memberships SET enabled=false,revoked_at=COALESCE(revoked_at,clock_timestamp())
    WHERE human_id=$1 AND enabled`, [value.id]);
  await client.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions,enabled,revoked_at)
    VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6 THEN NULL ELSE clock_timestamp() END)
    ON CONFLICT(human_id,tenant_id) DO UPDATE SET actor_alias=EXCLUDED.actor_alias,role=EXCLUDED.role,permissions=EXCLUDED.permissions,
      enabled=EXCLUDED.enabled,revoked_at=EXCLUDED.revoked_at`,
  [value.id, value.tenant_id, value.alias, value.role, [...consoleRoleAuthority(value.role).permissions], value.active]);
}
async function audit(client: DatabaseClient, actor: PeopleAdminActor, action: string, value: PeopleAdminPerson, fields: string[] = []): Promise<void> {
  await client.query('INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
    [actor.tenant_id, actor.alias, `people.${action}`, 'allow', JSON.stringify({ actor_subject: actor.subject, person_id: value.id, revision: value.revision, fields })]);
}
function mapped(error: unknown): never {
  if (error instanceof PeopleAdminError) throw error;
  if (error instanceof z.ZodError) throw new PeopleAdminError('invalid_request');
  if (error && typeof error === 'object' && 'code' in error && ['23505', '23503', 'P0001'].includes(String(error.code))) throw new PeopleAdminError('conflict');
  throw new PeopleAdminError('unverified');
}
function identifier(value: string): string { return `"${value.replace(/"/gu, '""')}"`; }
async function assertNoHistory(client: DatabaseClient, value: PeopleAdminPerson): Promise<void> {
  const id = value.id;
  const references = await client.query<{ schema: string; table: string; column: string }>(`SELECT namespace.nspname AS schema,relation.relname AS table,source.attname AS column
    FROM pg_constraint constraint_row JOIN pg_class relation ON relation.oid=constraint_row.conrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    JOIN LATERAL unnest(constraint_row.conkey,constraint_row.confkey) AS columns(source_id,target_id) ON true
    JOIN pg_attribute source ON source.attrelid=constraint_row.conrelid AND source.attnum=columns.source_id
    JOIN pg_attribute target ON target.attrelid=constraint_row.confrelid AND target.attnum=columns.target_id
    WHERE constraint_row.contype='f' AND constraint_row.confrelid='console_users'::regclass AND target.attname='id'`);
  for (const reference of references.rows) {
    const exists = await client.query<{ present: boolean }>(`SELECT EXISTS(SELECT 1 FROM ${identifier(reference.schema)}.${identifier(reference.table)}
      WHERE ${identifier(reference.column)}=$1) AS present`, [id]);
    if (exists.rows[0]?.present) throw new PeopleAdminError('conflict');
  }
  const history = (await client.query<{ present: boolean }>(`SELECT EXISTS(SELECT 1 FROM audit_events WHERE metadata->>'person_id'=$1
    OR metadata->>'actor_subject'=$2) OR EXISTS(SELECT 1 FROM fleet_operation_events WHERE metadata->>'actor_subject'=$2) AS present`, [id, `console:${id}`])).rows[0];
  if (history?.present) throw new PeopleAdminError('conflict');
  const sessions = await client.query<{ operator_id: string; attributed: boolean; console_subject: string }>(
    "SELECT operator_id,attributed,console_subject FROM terminal_sessions WHERE console_subject LIKE 'h2.%' OR operator_id=$1", [value.email]);
  if (sessions.rows.some(row => ownsPeopleTerminalSession(value, row))) throw new PeopleAdminError('conflict');
}

export class PeopleAdminRepository {
  constructor(private readonly pool: DatabasePool) {}
  private async transaction<T>(actor: PeopleAdminActor, action: (client: DatabaseClient) => Promise<T>): Promise<T> {
    try {
      return await withTransaction(this.pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(783_003_004)');
        await assertPeopleAuthority(client, actor);
        const result = await action(client); actor.signal?.throwIfAborted(); return result;
      });
    } catch (error) { mapped(error); }
  }
  async list(actor: PeopleAdminActor) {
    return this.transaction(actor, async client => {
      const rows = await client.query<PeopleAdminPerson>(`SELECT ${COLUMNS} FROM console_users
        WHERE ${peopleCompanyScopeSql('tenant_id')} ORDER BY email_normalized,id LIMIT 1001`, [actor.tenant_id]);
      if (rows.rows.length > 1000) throw new PeopleAdminError('conflict');
      return { items: rows.rows.map(person), capabilities: PEOPLE_ADMIN_CAPABILITIES };
    });
  }
  async create(actor: PeopleAdminActor, input: unknown): Promise<PeopleAdminPerson> {
    let value; try { value = PeopleAdminCreateSchema.parse(input); } catch (error) { mapped(error); }
    const passwordHash = await hashPassword(value.password);
    return this.transaction(actor, async client => {
      await assertPeopleCompany(client, value.tenant_id, actor.tenant_id);
      await peopleAliasAuthority(client, value);
      const row = (await client.query<PeopleAdminPerson>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias,active)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${COLUMNS}`,
      [value.email, normalizeEmail(value.email), passwordHash, value.display_name, value.role, value.tenant_id, value.alias, value.active])).rows[0];
      const result = person(row); await syncMembership(client, result); await audit(client, actor, 'create', result); return result;
    });
  }
  async update(actor: PeopleAdminActor, id: string, input: unknown): Promise<PeopleAdminPerson> {
    let patch; try { PeopleAdminIdSchema.parse(id); patch = PeopleAdminUpdateSchema.parse(input); } catch (error) { mapped(error); }
    const passwordHash = patch.password === undefined ? undefined : await hashPassword(patch.password);
    return this.transaction(actor, async client => {
      const previous = await lockPerson(client, id, patch.expected_revision, actor.tenant_id);
      const next = person({ ...previous, ...Object.fromEntries(Object.entries(patch).filter(([key]) => !['expected_revision', 'password'].includes(key))) });
      await assertPeopleCompany(client, next.tenant_id, actor.tenant_id);
      if (next.active) await peopleAliasAuthority(client, next);
      await protectLastPeopleAdministrator(client, previous, next);
      const authorityChanged = previous.role !== next.role || previous.tenant_id !== next.tenant_id || previous.alias !== next.alias || previous.active !== next.active;
      const securityChanged = authorityChanged || previous.email !== next.email || passwordHash !== undefined;
      if (securityChanged) await revokePeopleAccess(client, previous);
      const row = (await client.query<PeopleAdminPerson>(`UPDATE console_users SET email=$2,email_normalized=$3,display_name=$4,role=$5,tenant_id=$6,alias=$7,active=$8,
        password_hash=COALESCE($9,password_hash),password_changed_at=CASE WHEN $10 THEN GREATEST(clock_timestamp(),password_changed_at+interval '1 microsecond') ELSE password_changed_at END,
        updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=$1 RETURNING ${COLUMNS}`,
      [id, next.email, normalizeEmail(next.email), next.display_name, next.role, next.tenant_id, next.alias, next.active, passwordHash ?? null, securityChanged])).rows[0];
      const result = person(row); if (authorityChanged) await syncMembership(client, result);
      await audit(client, actor, 'update', result, Object.keys(patch).filter(key => key !== 'expected_revision')); return result;
    });
  }
  async retire(actor: PeopleAdminActor, id: string, input: unknown): Promise<PeopleAdminPerson> {
    let control; try { control = PeopleAdminControlSchema.parse(input); } catch (error) { mapped(error); }
    return this.update(actor, id, { ...control, active: false });
  }
  async restore(actor: PeopleAdminActor, id: string, input: unknown): Promise<PeopleAdminPerson> {
    let control; try { control = PeopleAdminControlSchema.parse(input); } catch (error) { mapped(error); }
    return this.update(actor, id, { ...control, active: true });
  }
  async purge(actor: PeopleAdminActor, id: string, input: unknown) {
    let control; try { PeopleAdminIdSchema.parse(id); control = PeopleAdminControlSchema.parse(input); } catch (error) { mapped(error); }
    return this.transaction(actor, async client => {
      const previous = await lockPerson(client, id, control.expected_revision, actor.tenant_id);
      if (previous.active) throw new PeopleAdminError('conflict');
      await assertNoHistory(client, previous);
      const removed = await client.query('DELETE FROM console_users WHERE id=$1 RETURNING id', [id]);
      if (!removed.rowCount) throw new PeopleAdminError('conflict');
      await audit(client, actor, 'purge', previous); return { id, revision: previous.revision, purged: true as const };
    });
  }
}
