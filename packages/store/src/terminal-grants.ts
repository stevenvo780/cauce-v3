import type { DatabaseClient, DatabasePool } from './db.js';
import type { CompanyAuthority } from './company-authority.js';
import { StoreError } from './repository/errors.js';

/**
 * Permanent terminal grants in PostgreSQL (migration 086). The grants file remains a second
 * source during the transition: admission accepts a grant from either source, so these rows
 * only widen the file. Every write is audited and a revocation closes the open sessions it fed.
 */

export type TerminalGrantMode = 'shell' | 'harness' | 'harness_rw';

const TERMINAL_GRANT_MODES: readonly TerminalGrantMode[] = ['shell', 'harness', 'harness_rw'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export interface TerminalGrantRecord {
  id: string;
  company_id: string;
  tenant_id: string;
  alias: string;
  grantee_human_id: string;
  grantee_email: string;
  grantee_display_name: string;
  modes: TerminalGrantMode[];
  expires_at: string | null;
  expired: boolean;
  note: string | null;
  granted_by_human_id: string;
  created_at: string;
  updated_at: string;
  version: number;
}

interface TerminalGrantRow {
  id: string;
  company_id: string;
  tenant_id: string;
  alias: string;
  grantee_human_id: string;
  grantee_email: string;
  grantee_display_name: string;
  modes: string[];
  expires_at: Date | null;
  expired: boolean;
  note: string | null;
  granted_by_human_id: string;
  created_at: Date;
  updated_at: Date;
  version: string;
}

const GRANT_COLUMNS = `grant_row.id,grant_row.company_id,grant_row.tenant_id,grant_row.alias,
  grant_row.grantee_human_id,person.email AS grantee_email,person.display_name AS grantee_display_name,
  grant_row.modes,grant_row.expires_at,(grant_row.expires_at IS NOT NULL AND grant_row.expires_at<=now()) AS expired,
  grant_row.note,grant_row.granted_by_human_id,grant_row.created_at,grant_row.updated_at,grant_row.version::text`;

function toRecord(row: TerminalGrantRow): TerminalGrantRecord {
  return {
    id: row.id,
    company_id: row.company_id,
    tenant_id: row.tenant_id,
    alias: row.alias,
    grantee_human_id: row.grantee_human_id,
    grantee_email: row.grantee_email,
    grantee_display_name: row.grantee_display_name,
    modes: row.modes.filter((mode): mode is TerminalGrantMode =>
      (TERMINAL_GRANT_MODES as readonly string[]).includes(mode)),
    expires_at: row.expires_at?.toISOString() ?? null,
    expired: row.expired,
    note: row.note,
    granted_by_human_id: row.granted_by_human_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    version: Number(row.version),
  };
}

/** Only the owner or an admin of the agent's company grants; the platform admin grants anywhere. */
export function assertTerminalGrantManager(authority: CompanyAuthority): void {
  if (authority.humanId === null
    || !['platform_admin', 'company_owner', 'company_admin'].includes(authority.role)) {
    throw new StoreError('forbidden', 'terminal grant authority is required');
  }
}

function assertGrantScope(authority: CompanyAuthority, agentCompany: string): void {
  assertTerminalGrantManager(authority);
  if (authority.role !== 'platform_admin' && authority.actingCompany !== agentCompany) {
    throw new StoreError('not_found', 'terminal grant is unavailable');
  }
}

function grantModes(value: unknown): TerminalGrantMode[] {
  if (!Array.isArray(value) || value.length === 0
    || value.some((mode) => typeof mode !== 'string'
      || !(TERMINAL_GRANT_MODES as readonly string[]).includes(mode))
    || new Set(value).size !== value.length) {
    throw new StoreError('invalid_input', 'terminal grant modes are invalid');
  }
  return value.filter((mode): mode is TerminalGrantMode =>
    typeof mode === 'string' && (TERMINAL_GRANT_MODES as readonly string[]).includes(mode));
}

function grantExpiry(value: unknown): Date | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new StoreError('invalid_input', 'terminal grant expiry is invalid');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new StoreError('invalid_input', 'terminal grant expiry is invalid');
  return parsed;
}

function grantNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 500) {
    throw new StoreError('invalid_input', 'terminal grant note is invalid');
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

async function auditGrant(
  client: DatabaseClient, authority: CompanyAuthority,
  action: 'terminal.grant.create' | 'terminal.grant.update' | 'terminal.grant.revoke',
  grant: Pick<TerminalGrantRecord, 'id' | 'company_id' | 'tenant_id' | 'alias' | 'grantee_human_id' | 'modes' | 'expires_at'>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,company_id,actor_human_id,metadata)
     VALUES($1,$2,$3,'allow',$4,$5,$6::jsonb)`,
    [authority.homeTenant, authority.alias, action, grant.company_id, authority.humanId,
      JSON.stringify({
        grant_id: grant.id, target_tenant: grant.tenant_id, target_alias: grant.alias,
        grantee_human_id: grant.grantee_human_id, modes: grant.modes, expires_at: grant.expires_at,
        component: 'terminal',
      })],
  );
}

/** Closes the open sessions a grant fed, with their control holds, as human revocation does. */
async function revokeGrantSessions(
  client: DatabaseClient,
  target: { tenant_id: string; alias: string; modes: readonly TerminalGrantMode[] },
  granteeEmail: string,
): Promise<number> {
  if (target.modes.length === 0) return 0;
  const revoked = await client.query<{ id: string }>(
    `UPDATE terminal_sessions SET revoked_at=clock_timestamp()
      WHERE operator_id=$1 AND tenant_id=$2 AND ($3='*' OR alias=$3) AND mode=ANY($4::text[])
        AND revoked_at IS NULL AND closed_at IS NULL
      RETURNING id`,
    [granteeEmail, target.tenant_id, target.alias, [...target.modes]],
  );
  if (revoked.rows.length > 0) {
    await client.query(
      `UPDATE terminal_control_holds SET released_at=clock_timestamp(),released_reason='terminal_grant_revoked'
        WHERE session_id=ANY($1::uuid[]) AND released_at IS NULL`,
      [revoked.rows.map((row) => row.id)],
    );
  }
  return revoked.rows.length;
}

export async function listTerminalGrants(
  client: DatabaseClient, authority: CompanyAuthority,
): Promise<{ company_id: string; items: TerminalGrantRecord[] }> {
  assertTerminalGrantManager(authority);
  const rows = await client.query<TerminalGrantRow>(
    `SELECT ${GRANT_COLUMNS} FROM terminal_grants grant_row
       JOIN console_users person ON person.id=grant_row.grantee_human_id
      WHERE grant_row.company_id=$1 AND grant_row.revoked_at IS NULL
      ORDER BY grant_row.tenant_id,grant_row.alias,person.email,grant_row.id`,
    [authority.actingCompany],
  );
  return { company_id: authority.actingCompany, items: rows.rows.map(toRecord) };
}

export interface TerminalGrantCreateInput {
  tenant_id: string;
  alias: string;
  grantee_human_id: string;
  modes: unknown;
  expires_at?: unknown;
  note?: unknown;
}

export async function createTerminalGrant(
  client: DatabaseClient, authority: CompanyAuthority, input: TerminalGrantCreateInput,
): Promise<TerminalGrantRecord> {
  assertTerminalGrantManager(authority);
  if (typeof input.tenant_id !== 'string' || input.tenant_id.length === 0
    || typeof input.alias !== 'string' || (input.alias !== '*' && !ALIAS_PATTERN.test(input.alias))
    || typeof input.grantee_human_id !== 'string' || !UUID_PATTERN.test(input.grantee_human_id)) {
    throw new StoreError('invalid_input', 'terminal grant target is invalid');
  }
  const modes = grantModes(input.modes);
  const expiresAt = grantExpiry(input.expires_at);
  const note = grantNote(input.note);
  // A wildcard grant names the tenant alone; its company comes from the tenant row.
  const company = input.alias === '*'
    ? (await client.query<{ company_id: string }>(
      'SELECT company_id FROM tenants WHERE id=$1 FOR SHARE', [input.tenant_id])).rows[0]?.company_id
    : (await client.query<{ company_id: string }>(
      `SELECT tenant.company_id FROM agents agent JOIN tenants tenant ON tenant.id=agent.tenant_id
        WHERE agent.tenant_id=$1 AND agent.alias=$2 FOR SHARE OF agent,tenant`,
      [input.tenant_id, input.alias])).rows[0]?.company_id;
  if (company === undefined) throw new StoreError('not_found', 'terminal grant target is unavailable');
  assertGrantScope(authority, company);
  const grantee = (await client.query<{ id: string; active: boolean }>(
    'SELECT id,active FROM console_users WHERE id=$1::uuid AND company_id=$2 FOR SHARE',
    [input.grantee_human_id, company],
  )).rows[0];
  if (grantee === undefined) throw new StoreError('not_found', 'terminal grant person is unavailable');
  if (!grantee.active) throw new StoreError('invalid_input', 'terminal grant person is not active');
  let row: { id: string };
  try {
    const inserted = (await client.query<{ id: string }>(
      `INSERT INTO terminal_grants(company_id,tenant_id,alias,grantee_human_id,modes,expires_at,note,granted_by_human_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [company, input.tenant_id, input.alias, input.grantee_human_id, modes,
        expiresAt?.toISOString() ?? null, note, authority.humanId],
    )).rows[0];
    if (inserted === undefined) throw new Error('terminal grant insert lost its row');
    row = inserted;
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === '23505') throw new StoreError('conflict', 'an active terminal grant already covers this person and agent');
    if (code === '23503' || code === '23514') throw new StoreError('invalid_input', 'terminal grant target is invalid');
    throw error;
  }
  const created = (await client.query<TerminalGrantRow>(
    `SELECT ${GRANT_COLUMNS} FROM terminal_grants grant_row
       JOIN console_users person ON person.id=grant_row.grantee_human_id WHERE grant_row.id=$1`,
    [row.id],
  )).rows[0];
  if (created === undefined) throw new Error('terminal grant insert lost its row');
  const record = toRecord(created);
  await auditGrant(client, authority, 'terminal.grant.create', record);
  return record;
}

export interface TerminalGrantUpdateInput {
  expected_version: number;
  modes?: unknown;
  expires_at?: unknown;
  note?: unknown;
}

async function loadGrantForUpdate(
  client: DatabaseClient, authority: CompanyAuthority, grantId: string,
): Promise<TerminalGrantRow> {
  if (!UUID_PATTERN.test(grantId)) throw new StoreError('not_found', 'terminal grant is unavailable');
  const row = (await client.query<TerminalGrantRow>(
    `SELECT ${GRANT_COLUMNS} FROM terminal_grants grant_row
       JOIN console_users person ON person.id=grant_row.grantee_human_id
      WHERE grant_row.id=$1::uuid AND grant_row.revoked_at IS NULL FOR UPDATE OF grant_row`,
    [grantId],
  )).rows[0];
  if (row === undefined) throw new StoreError('not_found', 'terminal grant is unavailable');
  assertGrantScope(authority, row.company_id);
  return row;
}

function assertGrantVersion(row: TerminalGrantRow, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new StoreError('invalid_input', 'terminal grant version is invalid');
  }
  if (Number(row.version) !== expected) {
    throw new StoreError('conflict', 'terminal grant changed; reload and retry');
  }
}

export async function updateTerminalGrant(
  client: DatabaseClient, authority: CompanyAuthority, grantId: string, input: TerminalGrantUpdateInput,
): Promise<TerminalGrantRecord> {
  const current = await loadGrantForUpdate(client, authority, grantId);
  assertGrantVersion(current, input.expected_version);
  if (input.modes === undefined && input.expires_at === undefined && input.note === undefined) {
    throw new StoreError('invalid_input', 'terminal grant update is empty');
  }
  const modes = input.modes === undefined ? current.modes as TerminalGrantMode[] : grantModes(input.modes);
  const expiresAt = input.expires_at === undefined ? current.expires_at : grantExpiry(input.expires_at);
  const note = input.note === undefined ? current.note : grantNote(input.note);
  const updated = (await client.query<TerminalGrantRow>(
    `UPDATE terminal_grants SET modes=$2,expires_at=$3,note=$4,updated_at=now(),version=version+1
      WHERE id=$1::uuid RETURNING id`,
    [grantId, modes, expiresAt?.toISOString() ?? null, note],
  )).rows[0];
  if (updated === undefined) throw new Error('terminal grant update lost its row');
  const removed = (current.modes as TerminalGrantMode[]).filter((mode) => !modes.includes(mode));
  const nowExpired = expiresAt !== null && expiresAt.getTime() <= Date.now()
    && (current.expires_at === null || current.expires_at.getTime() > Date.now());
  const affected = [...new Set([...removed, ...(nowExpired ? modes : [])])];
  if (affected.length > 0) {
    await revokeGrantSessions(client,
      { tenant_id: current.tenant_id, alias: current.alias, modes: affected }, current.grantee_email);
  }
  const fresh = (await client.query<TerminalGrantRow>(
    `SELECT ${GRANT_COLUMNS} FROM terminal_grants grant_row
       JOIN console_users person ON person.id=grant_row.grantee_human_id WHERE grant_row.id=$1`,
    [grantId],
  )).rows[0];
  if (fresh === undefined) throw new Error('terminal grant update lost its row');
  const record = toRecord(fresh);
  await auditGrant(client, authority, 'terminal.grant.update', record);
  return record;
}

export async function revokeTerminalGrant(
  client: DatabaseClient, authority: CompanyAuthority, grantId: string, expectedVersion: number,
): Promise<TerminalGrantRecord> {
  const current = await loadGrantForUpdate(client, authority, grantId);
  assertGrantVersion(current, expectedVersion);
  await client.query(
    `UPDATE terminal_grants SET revoked_at=clock_timestamp(),revoked_by_human_id=$2,updated_at=now(),version=version+1
      WHERE id=$1::uuid`,
    [grantId, authority.humanId],
  );
  await revokeGrantSessions(client,
    { tenant_id: current.tenant_id, alias: current.alias, modes: current.modes as TerminalGrantMode[] },
    current.grantee_email);
  const record = toRecord({ ...current, version: String(Number(current.version) + 1) });
  await auditGrant(client, authority, 'terminal.grant.revoke', record);
  return record;
}

/**
 * Database half of gate 5: a live grant for the operator's person over this exact target.
 * The caller unions this with the grants file; either source admitting is enough.
 */
export async function terminalGrantAllows(
  database: DatabasePool | DatabaseClient, operatorEmail: string, tenantId: string, alias: string,
  mode: TerminalGrantMode,
): Promise<boolean> {
  const result = await database.query<{ allowed: boolean }>(
    `SELECT true AS allowed FROM terminal_grants grant_row
       JOIN console_users person ON person.id=grant_row.grantee_human_id
       JOIN tenants tenant ON tenant.id=grant_row.tenant_id AND tenant.company_id=grant_row.company_id
      WHERE person.email_normalized=lower($1) AND person.active
        AND grant_row.tenant_id=$2 AND (grant_row.alias=$3 OR grant_row.alias='*')
        AND grant_row.modes @> ARRAY[$4]::text[]
        AND grant_row.revoked_at IS NULL
        AND (grant_row.expires_at IS NULL OR grant_row.expires_at>now())
      LIMIT 1`,
    [operatorEmail, tenantId, alias, mode],
  );
  return result.rows.length > 0;
}
