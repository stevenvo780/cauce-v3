import { withTransaction, type DatabaseClient, type DatabasePool } from './db.js';
import type { CompanyAuthority } from './company-authority.js';
import { synchronizeContextProfile } from './context-version-profile.js';
import type { CompanyAuthoritySource } from './repository/fleet-hosts.js';
import { StoreError } from './repository/errors.js';
import { ContextNativeIngestSchema, ContextRestoreSchema, ContextUpdateSchema, canonicalContextFiles, contextDigest, contextVersionDiff,
  type ContextSnapshot, type ContextTarget, type ContextVersion } from './context-version-model.js';

interface VersionRow extends Omit<ContextVersion, 'version' | 'created_at' | 'restored_from'> {
  version: string; restored_from: string | null; created_at: Date;
}
export function contextVersionFromRow(row: VersionRow): ContextVersion {
  return { ...row, version: Number(row.version), restored_from: row.restored_from === null ? null : Number(row.restored_from),
    files: canonicalContextFiles(row.files), created_at: row.created_at.toISOString() };
}
export async function readContextVersion(client: DatabaseClient, target: ContextTarget, version: number): Promise<ContextVersion> {
  const row = (await client.query<VersionRow>(`SELECT * FROM agent_context_versions
    WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4`,
  [target.company_id, target.tenant_id, target.alias, version])).rows[0];
  if (!row) throw new StoreError('not_found', 'context version not found');
  return contextVersionFromRow(row);
}
export async function lockContextTarget(client: DatabaseClient, target: ContextTarget): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`context-version:${JSON.stringify([target.company_id, target.tenant_id, target.alias])}`]);
}
async function targetAuthority(client: DatabaseClient, source: CompanyAuthoritySource, tenant: string, alias: string,
  write: boolean): Promise<{ target: ContextTarget; authority: CompanyAuthority }> {
  const authority = await source(client);
  const wide = authority.scope === 'platform' || authority.scope === 'company';
  if (authority.humanId === null || authority.role === 'none'
    || (!wide && authority.homeTenant !== tenant) || (write && !wide && authority.role !== 'tenant_operator')) {
    throw new StoreError('forbidden', 'context authority is required');
  }
  const row = (await client.query<{ company_id: string }>(`SELECT tenant.company_id FROM agents agent
    JOIN tenants tenant ON tenant.id=agent.tenant_id WHERE agent.tenant_id=$1 AND agent.alias=$2
      AND tenant.company_id=$3 AND tenant.enabled AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL
      AND agent.retired_at IS NULL AND agent.purged_at IS NULL FOR SHARE OF agent,tenant`,
  [tenant, alias, authority.actingCompany])).rows[0];
  if (!row) throw new StoreError('not_found', 'context target unavailable');
  return { target: { company_id: row.company_id, tenant_id: tenant, alias }, authority };
}
export async function contextSnapshot(client: DatabaseClient, target: ContextTarget): Promise<ContextSnapshot> {
  const row = (await client.query<{ desired_version: string; applied_version: string; state: 'pending' | 'synced' | 'error' | null;
    git_commit: string | null; pushed_at: Date | null; last_error: string | null; apply_error: string | null; attempts: number | null }>(
    `SELECT current.desired_version,current.applied_version,outbox.state,outbox.git_commit,outbox.pushed_at,
      outbox.last_error,outbox.apply_error,outbox.attempts FROM agent_context_state current LEFT JOIN agent_context_outbox outbox
      ON (outbox.company_id,outbox.tenant_id,outbox.alias,outbox.version)=
         (current.company_id,current.tenant_id,current.alias,current.desired_version)
      WHERE current.company_id=$1 AND current.tenant_id=$2 AND current.alias=$3`,
    [target.company_id, target.tenant_id, target.alias])).rows[0];
  const version = Number(row?.desired_version ?? 0);
  const current = version === 0 ? undefined : await readContextVersion(client, target, version);
  return { ...target, version, desired_version: version, applied_version: Number(row?.applied_version ?? 0),
    files: current?.files ?? [], digest: current?.digest ?? null,
    sync: { state: row?.state ?? 'pending', git_commit: row?.git_commit ?? null,
      pushed_at: row?.pushed_at?.toISOString() ?? null, last_error: row?.last_error ?? null, attempts: row?.attempts ?? 0 },
    application: { state: version > 0 && Number(row?.applied_version ?? 0) === version ? 'applied'
      : row?.apply_error ? 'error' : 'pending', last_error: row?.apply_error ?? null } };
}
export interface ContextVersionActor { readonly humanId: string | null; readonly homeTenant: string; readonly alias: string }
export async function persistContextVersionInTransaction(client: DatabaseClient, target: ContextTarget, authority: ContextVersionActor, expected: number,
  files: ContextVersion['files'], source: ContextVersion['source'], restored: number | null = null): Promise<ContextSnapshot> {
    const previous = await contextSnapshot(client, target);
    if (previous.version !== expected) throw new StoreError('conflict', 'context version changed; reload and retry');
    const canonical = canonicalContextFiles(await synchronizeContextProfile(client, target, files)); const next = expected + 1;
    const scope = [target.company_id, target.tenant_id, target.alias];
    await client.query(`INSERT INTO agent_context_versions(company_id,tenant_id,alias,version,files,digest,source,
      restored_from,actor_human_id,actor_alias) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)`,
    [...scope, next, JSON.stringify(canonical), contextDigest(canonical), source, restored, authority.humanId, authority.alias]);
    await client.query(`INSERT INTO agent_context_state(company_id,tenant_id,alias,desired_version) VALUES($1,$2,$3,$4)
      ON CONFLICT(company_id,tenant_id,alias) DO UPDATE SET desired_version=EXCLUDED.desired_version`, [...scope, next]);
    await client.query(`INSERT INTO agent_context_outbox(company_id,tenant_id,alias,version) VALUES($1,$2,$3,$4)`, [...scope, next]);
    await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,company_id,actor_human_id,metadata)
      VALUES($1,$2,'context.version','allow',$3,$4,$5::jsonb)`, [authority.homeTenant, authority.alias, target.company_id,
      authority.humanId, JSON.stringify({ target_tenant: target.tenant_id, target_alias: target.alias, version: next, source, restored_from: restored })]);
    return contextSnapshot(client, target);
}
export type NativeContextIngestResult =
  | { readonly state: 'ingested'; readonly snapshot: ContextSnapshot }
  | { readonly state: 'conflict'; readonly base_version: number; readonly desired_version: number; readonly applied_version: number };
export async function ingestNativeContextVersion(pool: DatabasePool, tenant: string, alias: string,
  value: unknown): Promise<NativeContextIngestResult> {
  const input = ContextNativeIngestSchema.parse(value);
  return withTransaction(pool, async client => {
    const row = (await client.query<{ company_id: string }>(`SELECT tenant.company_id FROM agents agent
      JOIN tenants tenant ON tenant.id=agent.tenant_id WHERE agent.tenant_id=$1 AND agent.alias=$2
        AND tenant.enabled AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL
        AND agent.retired_at IS NULL AND agent.purged_at IS NULL FOR SHARE OF agent,tenant`,
    [tenant, alias])).rows[0];
    if (!row) throw new StoreError('not_found', 'context target unavailable');
    const target: ContextTarget = { company_id: row.company_id, tenant_id: tenant, alias };
    await lockContextTarget(client, target);
    const canonical = canonicalContextFiles(await synchronizeContextProfile(client, target, input.files));
    const digest = contextDigest(canonical);
    const snapshot = await contextSnapshot(client, target);
    if (snapshot.desired_version === input.base_version + 1 && snapshot.digest === digest) {
      const existing = await readContextVersion(client, target, snapshot.desired_version);
      if (existing.source === 'native' && existing.actor_alias === alias && existing.actor_human_id === null) {
        return { state: 'ingested', snapshot };
      }
    }
    if (snapshot.desired_version !== input.base_version) {
      if (snapshot.desired_version > 0) await client.query(`UPDATE agent_context_outbox SET apply_error='native_context_conflict'
        WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4
          AND (apply_error IS NULL OR apply_error='native_context_conflict')`,
      [target.company_id, tenant, alias, snapshot.desired_version]);
      await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,company_id,metadata)
        VALUES($1,$2,'context.native_conflict','deny',$3,$4::jsonb)`, [tenant, alias, target.company_id,
        JSON.stringify({ target_tenant: tenant, target_alias: alias, base_version: input.base_version,
          desired_version: snapshot.desired_version, applied_version: snapshot.applied_version, candidate_digest: digest })]);
      return { state: 'conflict', base_version: input.base_version,
        desired_version: snapshot.desired_version, applied_version: snapshot.applied_version };
    }
    const next = input.base_version + 1;
    const scope = [target.company_id, tenant, alias];
    await client.query(`INSERT INTO agent_context_versions(company_id,tenant_id,alias,version,files,digest,source,
      restored_from,actor_human_id,actor_alias) VALUES($1,$2,$3,$4,$5::jsonb,$6,'native',NULL,NULL,$7)`,
    [...scope, next, JSON.stringify(canonical), digest, alias]);
    await client.query(`INSERT INTO agent_context_state(company_id,tenant_id,alias,desired_version) VALUES($1,$2,$3,$4)
      ON CONFLICT(company_id,tenant_id,alias) DO UPDATE SET desired_version=EXCLUDED.desired_version`, [...scope, next]);
    await client.query(`INSERT INTO agent_context_outbox(company_id,tenant_id,alias,version) VALUES($1,$2,$3,$4)`, [...scope, next]);
    await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,company_id,actor_human_id,metadata)
      VALUES($1,$2,'context.version','allow',$3,NULL,$4::jsonb)`, [tenant, alias, target.company_id,
      JSON.stringify({ target_tenant: tenant, target_alias: alias, version: next, source: 'native', restored_from: null })]);
    return { state: 'ingested', snapshot: await contextSnapshot(client, target) };
  });
}
export class ContextVersionStore {
  constructor(readonly pool: DatabasePool) {}
  private async scoped<T>(source: CompanyAuthoritySource, tenant: string, alias: string, write: boolean,
    work: (client: DatabaseClient, target: ContextTarget, authority: CompanyAuthority) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, async client => {
      const { target, authority } = await targetAuthority(client, source, tenant, alias, write);
      await lockContextTarget(client, target);
      return work(client, target, authority);
    });
  }
  read(source: CompanyAuthoritySource, tenant: string, alias: string): Promise<ContextSnapshot> {
    return this.scoped(source, tenant, alias, false, (client, target) => contextSnapshot(client, target));
  }
  write(source: CompanyAuthoritySource, tenant: string, alias: string, value: unknown): Promise<ContextSnapshot> {
    const input = ContextUpdateSchema.parse(value);
    return this.scoped(source, tenant, alias, true, (client, target, authority) =>
      this.persist(client, target, authority, input.expected_version, input.files, input.source, null));
  }
  restore(source: CompanyAuthoritySource, tenant: string, alias: string, value: unknown): Promise<ContextSnapshot> {
    const input = ContextRestoreSchema.parse(value);
    return this.scoped(source, tenant, alias, true, async (client, target, authority) => {
      const original = await readContextVersion(client, target, input.version);
      return this.persist(client, target, authority, input.expected_version, original.files, 'restore', input.version);
    });
  }
  private persist(client: DatabaseClient, target: ContextTarget, authority: CompanyAuthority, expected: number,
    files: ContextVersion['files'], source: ContextVersion['source'], restored: number | null): Promise<ContextSnapshot> {
    return persistContextVersionInTransaction(client, target, authority, expected, files, source, restored);
  }
  history(source: CompanyAuthoritySource, tenant: string, alias: string, before?: number): Promise<{
    entries: Omit<ContextVersion, 'files'>[]; next_cursor: number | null;
  }> {
    return this.scoped(source, tenant, alias, false, async (client, target) => {
      const rows = (await client.query<VersionRow>(`SELECT * FROM agent_context_versions
        WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND ($4::bigint IS NULL OR version<$4)
        ORDER BY version DESC LIMIT 51`, [target.company_id, tenant, alias, before ?? null])).rows;
      const entries = rows.slice(0, 50).map(row => { const { files: _files, ...entry } = contextVersionFromRow(row); return entry; });
      return { entries, next_cursor: rows.length > 50 ? entries.at(-1)?.version ?? null : null };
    });
  }
  diff(source: CompanyAuthoritySource, tenant: string, alias: string, from: number, to: number): Promise<{
    from: number; to: number; files: ReturnType<typeof contextVersionDiff>;
  }> {
    return this.scoped(source, tenant, alias, false, async (client, target) => {
      const first = from === 0 ? [] : (await readContextVersion(client, target, from)).files;
      const second = (await readContextVersion(client, target, to)).files;
      return { from, to, files: contextVersionDiff(first, second) };
    });
  }
  retry(source: CompanyAuthoritySource, tenant: string, alias: string): Promise<ContextSnapshot> {
    return this.scoped(source, tenant, alias, true, async (client, target) => {
      await client.query(`UPDATE agent_context_outbox SET state=CASE WHEN pushed_at IS NULL THEN 'pending' ELSE state END,
        retry_at=now(),apply_retry_at=now(),last_error=NULL,apply_error=NULL WHERE company_id=$1 AND tenant_id=$2 AND alias=$3
        AND (state<>'synced' OR (applied_at IS NULL AND version=(SELECT desired_version FROM agent_context_state
          WHERE company_id=$1 AND tenant_id=$2 AND alias=$3)))`, [target.company_id, tenant, alias]);
      return contextSnapshot(client, target);
    });
  }
}
