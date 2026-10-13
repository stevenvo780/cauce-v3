import { createHash } from 'node:crypto';
import { withTransaction, type DatabaseClient, type DatabasePool } from './db.js';
import type { CompanyAuthority } from './company-authority.js';
import { CONTEXT_PROFILE_PATH, canonicalProfileContext, synchronizeContextProfile } from './context-version-profile.js';
import type { CompanyAuthoritySource } from './repository/fleet-hosts.js';
import { StoreError } from './repository/errors.js';
import { ContextNativeIngestSchema, ContextRejectedError, ContextRestoreSchema, ContextUpdateSchema, NATIVE_CONTEXT_WRITABLE_PREFIX,
  contextDigest, contextVersionDiff, harnessContextMaxBytes, nativeDocumentContextPath, storedContextFiles, versionableContextFiles,
  type ContextFile, type ContextRejectionReason, type ContextSnapshot, type ContextTarget, type ContextVersion } from './context-version-model.js';

type ContextVersionEntry = Omit<ContextVersion, 'files'>;
interface VersionEntryRow extends Omit<ContextVersionEntry, 'version' | 'created_at' | 'restored_from'> {
  version: string; restored_from: string | null; created_at: Date;
}
const VERSION_ENTRY_COLUMNS = 'company_id,tenant_id,alias,version,digest,source,restored_from,actor_human_id,actor_alias,created_at';
function versionEntryFromRow(row: VersionEntryRow): ContextVersionEntry {
  return { ...row, version: Number(row.version), restored_from: row.restored_from === null ? null : Number(row.restored_from),
    created_at: row.created_at.toISOString() };
}
async function harnessMaxBytes(client: DatabaseClient, target: ContextTarget): Promise<number> {
  const row = (await client.query<{ harness_id: string | null }>('SELECT harness_id FROM agents WHERE tenant_id=$1 AND alias=$2',
    [target.tenant_id, target.alias])).rows[0];
  return harnessContextMaxBytes(row?.harness_id ?? null);
}
/** Throws a ContextRejectedError `context_version_unreadable` when the stored files no longer match their shape or digest. */
export async function readContextVersion(client: DatabaseClient, target: ContextTarget, version: number): Promise<ContextVersion> {
  const row = (await client.query<VersionEntryRow & { files: unknown }>(`SELECT ${VERSION_ENTRY_COLUMNS},files
    FROM agent_context_versions WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4`,
  [target.company_id, target.tenant_id, target.alias, version])).rows[0];
  if (!row) throw new StoreError('not_found', 'context version not found');
  const { files, ...entry } = row;
  return { ...versionEntryFromRow(entry), files: storedContextFiles(files, row.digest) };
}
/** undefined when the stored version is unreadable: its readers report it instead of failing. */
export async function readableContextVersion(client: DatabaseClient, target: ContextTarget,
  version: number): Promise<ContextVersion | undefined> {
  try { return await readContextVersion(client, target, version); } catch (error) {
    if (error instanceof ContextRejectedError && error.reason === 'context_version_unreadable') return undefined;
    throw error;
  }
}
/** The history outlives the agent row: a recreated alias starts with an empty state but continues its numbering. */
async function nextContextVersion(client: DatabaseClient, target: ContextTarget): Promise<number> {
  const row = (await client.query<{ latest: string }>(`SELECT COALESCE(MAX(version),0) AS latest FROM agent_context_versions
    WHERE company_id=$1 AND tenant_id=$2 AND alias=$3`, [target.company_id, target.tenant_id, target.alias])).rows[0];
  return Number(row?.latest ?? 0) + 1;
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
  const current = version === 0 ? undefined : await readableContextVersion(client, target, version);
  const unreadable = version > 0 && current === undefined;
  return { ...target, version, desired_version: version, applied_version: Number(row?.applied_version ?? 0),
    files: current?.files ?? [], digest: current?.digest ?? null,
    sync: { state: row?.state ?? 'pending', git_commit: row?.git_commit ?? null,
      pushed_at: row?.pushed_at?.toISOString() ?? null, last_error: row?.last_error ?? null, attempts: row?.attempts ?? 0 },
    application: unreadable ? { state: 'error', last_error: 'context_version_unreadable' }
      : { state: version > 0 && Number(row?.applied_version ?? 0) === version ? 'applied'
        : row?.apply_error ? 'error' : 'pending', last_error: row?.apply_error ?? null } };
}
export interface ContextVersionActor { readonly humanId: string | null; readonly homeTenant: string; readonly alias: string }
export async function persistContextVersionInTransaction(client: DatabaseClient, target: ContextTarget, authority: ContextVersionActor, expected: number,
  files: ContextVersion['files'], source: ContextVersion['source'], restored: number | null = null): Promise<ContextSnapshot> {
    const previous = await contextSnapshot(client, target);
    if (previous.version !== expected) throw new StoreError('conflict', 'context version changed; reload and retry');
    const canonical = versionableContextFiles(await synchronizeContextProfile(client, target, files), await harnessMaxBytes(client, target));
    const next = await nextContextVersion(client, target);
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
  | { readonly state: 'conflict'; readonly base_version: number; readonly desired_version: number; readonly applied_version: number;
      readonly digest_exists_in_history: boolean }
  | { readonly state: 'rejected'; readonly error: ContextRejectedError };
const NATIVE_REFUSAL_AUDIT_LIMIT = 20;
const NATIVE_REFUSAL_AUDIT_WINDOW_SECONDS = 60;
/** The refusal stays visible in the application state of the current version, as the operator panel shows it. */
async function recordNativeRefusal(client: DatabaseClient, target: ContextTarget, snapshot: ContextSnapshot, applyError: string,
  action: 'context.native_conflict' | 'context.native_rejected', metadata: Readonly<Record<string, unknown>>): Promise<void> {
  if (snapshot.desired_version > 0) await client.query(`UPDATE agent_context_outbox SET apply_error=$5
    WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4 AND (apply_error IS NULL OR starts_with(apply_error,'native_context_'))`,
  [target.company_id, target.tenant_id, target.alias, snapshot.desired_version, applyError]);
  await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,company_id,metadata)
    SELECT $1,$2,$3,'deny',$4,$5::jsonb WHERE NOT EXISTS (
      SELECT 1 FROM audit_events WHERE tenant_id=$1 AND actor_alias=$2 AND action=$3 AND company_id=$4
        AND metadata-'applied_version'=$5::jsonb-'applied_version') AND (
      SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND actor_alias=$2 AND company_id=$4
        AND action IN ('context.native_conflict','context.native_rejected')
        AND created_at>clock_timestamp()-make_interval(secs => $6))<$7`, [target.tenant_id, target.alias, action, target.company_id,
    JSON.stringify({ target_tenant: target.tenant_id, target_alias: target.alias, ...metadata }),
    NATIVE_REFUSAL_AUDIT_WINDOW_SECONDS, NATIVE_REFUSAL_AUDIT_LIMIT]);
}
/** Judges the agent files against the locked server version, before anything is written. */
function nativeIngestFiles(current: readonly ContextFile[], candidate: readonly ContextFile[], maxBytes: number): ContextFile[] {
  const governed = contextVersionDiff(current, candidate).map(change => change.path)
    .filter(path => !path.startsWith(NATIVE_CONTEXT_WRITABLE_PREFIX));
  if (governed.length > 0) throw new ContextRejectedError('context_governed_path', governed);
  return versionableContextFiles(candidate, maxBytes);
}
export async function ingestNativeContextVersion(pool: DatabasePool, tenant: string, alias: string,
  value: unknown): Promise<NativeContextIngestResult> {
  const input = ContextNativeIngestSchema.parse(value);
  return withTransaction(pool, async client => {
    const row = (await client.query<{ company_id: string; harness_id: string | null }>(`SELECT tenant.company_id,agent.harness_id
      FROM agents agent JOIN tenants tenant ON tenant.id=agent.tenant_id WHERE agent.tenant_id=$1 AND agent.alias=$2
        AND tenant.enabled AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL
        AND agent.retired_at IS NULL AND agent.purged_at IS NULL FOR SHARE OF agent,tenant`,
    [tenant, alias])).rows[0];
    if (!row) throw new StoreError('not_found', 'context target unavailable');
    const target: ContextTarget = { company_id: row.company_id, tenant_id: tenant, alias };
    await lockContextTarget(client, target);
    const snapshot = await contextSnapshot(client, target);
    const digest = contextDigest(input.files);
    if (snapshot.desired_version === input.base_version && snapshot.digest === digest) return { state: 'ingested', snapshot };
    if (snapshot.desired_version === input.base_version + 1 && snapshot.digest === digest) {
      const existing = await readContextVersion(client, target, snapshot.desired_version);
      if (existing.source === 'native' && existing.actor_alias === alias && existing.actor_human_id === null) {
        return { state: 'ingested', snapshot };
      }
    }
    if (snapshot.desired_version !== input.base_version) {
      const history = (await client.query<{ exists: boolean }>(`SELECT EXISTS(SELECT 1 FROM agent_context_versions
        WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND digest=$4) AS exists`,
      [target.company_id, tenant, alias, digest])).rows[0];
      await recordNativeRefusal(client, target, snapshot, 'native_context_conflict', 'context.native_conflict', {
        base_version: input.base_version, desired_version: snapshot.desired_version, applied_version: snapshot.applied_version,
        candidate_digest: digest });
      return { state: 'conflict', base_version: input.base_version,
        desired_version: snapshot.desired_version, applied_version: snapshot.applied_version,
        digest_exists_in_history: history?.exists ?? false };
    }
    let canonical: ContextFile[];
    try { canonical = nativeIngestFiles(snapshot.files, input.files, harnessContextMaxBytes(row.harness_id)); }
    catch (error) {
      if (!(error instanceof ContextRejectedError)) throw error;
      await recordNativeRefusal(client, target, snapshot, `native_${error.reason}`, 'context.native_rejected', {
        base_version: input.base_version, reason: error.reason, paths: error.paths, ...error.limit });
      return { state: 'rejected', error };
    }
    const next = await nextContextVersion(client, target);
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
export type ContextVersioning =
  | { readonly state: 'current' }
  | { readonly state: 'unversioned'; readonly reason: ContextRejectionReason; readonly source: string | null;
    readonly paths: readonly string[]; readonly recorded_at: string };
function contentDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
/** What the V3 tables hold now for each file the legacy hooks version, by sha256; null when the V3 side has no such file. */
async function legacyFileDigests(client: DatabaseClient, target: ContextTarget): Promise<Map<string, string | null>> {
  const profile = await canonicalProfileContext(client, target);
  const documents = (await client.query<{ kind: string; sha256: string | null }>(`SELECT DISTINCT ON (kind) kind,sha256
    FROM agent_document_revisions WHERE tenant_id=$1 AND alias=$2 ORDER BY kind,id DESC`, [target.tenant_id, target.alias])).rows;
  return new Map([[CONTEXT_PROFILE_PATH, profile === undefined ? null : contentDigest(profile.content)],
    ...documents.map(row => [nativeDocumentContextPath(row.kind), row.sha256] as const)]);
}
/**
 * A V3 write kept without a version stays pending while its V3 file still differs from the current version: a later version of
 * another file never hides it, and returning to the versioned content clears it. The target tenant bounds the audit scan.
 */
async function contextVersioning(client: DatabaseClient, target: ContextTarget, files: readonly ContextFile[]): Promise<ContextVersioning> {
  const refusals = (await client.query<{ path: string; reason: ContextRejectionReason; source: string | null; created_at: Date }>(
    `SELECT DISTINCT ON (audit.metadata->>'path') audit.metadata->>'path' AS path,audit.metadata->>'reason' AS reason,
      audit.metadata->>'source' AS source,audit.created_at FROM audit_events audit
      WHERE audit.tenant_id=$2 AND audit.action='context.unversioned' AND audit.company_id=$1
        AND audit.metadata->>'target_alias'=$3 AND audit.metadata->>'path' IS NOT NULL
      ORDER BY audit.metadata->>'path',audit.created_at DESC,audit.id DESC`, [target.company_id, target.tenant_id, target.alias])).rows;
  if (refusals.length === 0) return { state: 'current' };
  const live = await legacyFileDigests(client, target);
  const versioned = new Map(files.map(file => [file.path, contentDigest(file.content)]));
  const pending = refusals.filter(row => live.has(row.path) && live.get(row.path) !== (versioned.get(row.path) ?? null))
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  const latest = pending[0];
  if (latest === undefined) return { state: 'current' };
  return { state: 'unversioned', reason: latest.reason, source: latest.source, recorded_at: latest.created_at.toISOString(),
    paths: pending.map(row => row.path).sort() };
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
  read(source: CompanyAuthoritySource, tenant: string, alias: string): Promise<ContextSnapshot & { versioning: ContextVersioning }> {
    return this.scoped(source, tenant, alias, false, async (client, target) => {
      const snapshot = await contextSnapshot(client, target);
      return { ...snapshot, versioning: await contextVersioning(client, target, snapshot.files) };
    });
  }
  write(source: CompanyAuthoritySource, tenant: string, alias: string, value: unknown): Promise<ContextSnapshot> {
    const input = ContextUpdateSchema.parse(value);
    return this.scoped(source, tenant, alias, true, async (client, target, authority) => {
      // Sending back the profile of the snapshot is no edit: the canonical one replaces it, so an unversioned V3 edit is never reverted.
      const versioned = (await contextSnapshot(client, target)).files.find(file => file.path === CONTEXT_PROFILE_PATH);
      const files = input.files.filter(file => file.path !== CONTEXT_PROFILE_PATH || file.content !== versioned?.content);
      return this.persist(client, target, authority, input.expected_version, files, input.source, null);
    });
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
    entries: ContextVersionEntry[]; next_cursor: number | null;
  }> {
    return this.scoped(source, tenant, alias, false, async (client, target) => {
      const rows = (await client.query<VersionEntryRow>(`SELECT ${VERSION_ENTRY_COLUMNS} FROM agent_context_versions
        WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND ($4::bigint IS NULL OR version<$4)
        ORDER BY version DESC LIMIT 51`, [target.company_id, tenant, alias, before ?? null])).rows;
      const entries = rows.slice(0, 50).map(versionEntryFromRow);
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
