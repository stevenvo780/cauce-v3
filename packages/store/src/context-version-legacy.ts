import { createHash } from 'node:crypto';
import { normalizeAgentProfile, type AgentProfile } from '@cauce/protocol';
import type { DatabaseClient } from './db.js';
import type { DocumentRevisionInput } from './agent-context-revisions.js';
import { ContextRejectedError, nativeDocumentContextPath, type ContextFile, type ContextTarget,
  type ContextVersion } from './context-version-model.js';
import { contextSnapshot, lockContextTarget, persistContextVersionInTransaction } from './context-version.js';
import { CONTEXT_PROFILE_PATH } from './context-version-profile.js';
import { StoreError } from './repository/errors.js';

async function legacyTarget(client: DatabaseClient, tenant: string, alias: string): Promise<ContextTarget | undefined> {
  const enabled = (await client.query<{ enabled: boolean }>("SELECT to_regclass('public.agent_context_versions') IS NOT NULL AS enabled")).rows[0];
  if (!enabled?.enabled) return undefined;
  const row = (await client.query<{ company_id: string }>('SELECT company_id FROM tenants WHERE id=$1', [tenant])).rows[0];
  if (!row) throw new StoreError('not_found', 'context tenant is unavailable');
  return { company_id: row.company_id, tenant_id: tenant, alias };
}
/**
 * The V3 write that calls this already holds its own effect, so versioning can never abort it: a refusal or failure rolls back
 * only to the savepoint, the write stays, and the pending change is audited with its reason. Returns that typed refusal.
 */
async function recordLegacyFile(client: DatabaseClient, target: ContextTarget, file: ContextFile, source: ContextVersion['source'],
  actor: { tenant_id: string; alias: string }, humanId?: string): Promise<ContextRejectedError | undefined> {
  await client.query('SAVEPOINT cauce_context_version');
  try {
    await lockContextTarget(client, target);
    const previous = await contextSnapshot(client, target);
    if (!previous.files.some(existing => existing.path === file.path && existing.content === file.content)) {
      // The versioned profile can predate an unversioned V3 edit: without it, persisting adds the canonical one instead of reverting.
      const kept = previous.files.filter(existing => existing.path !== file.path && existing.path !== CONTEXT_PROFILE_PATH);
      await persistContextVersionInTransaction(client, target, { humanId: humanId ?? null, homeTenant: actor.tenant_id, alias: actor.alias },
        previous.version, [...kept, file], source);
    }
    await client.query('RELEASE SAVEPOINT cauce_context_version');
    return undefined;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT cauce_context_version');
    await client.query('RELEASE SAVEPOINT cauce_context_version');
    const refusal = error instanceof ContextRejectedError ? error : new ContextRejectedError('context_version_failed', [file.path]);
    await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,company_id,actor_human_id,metadata,created_at)
      VALUES($1,$2,'context.unversioned','deny',$3,$4,$5::jsonb,clock_timestamp())`, [target.tenant_id, actor.alias, target.company_id,
      humanId ?? null, JSON.stringify({ target_tenant: target.tenant_id, target_alias: target.alias, actor_tenant: actor.tenant_id,
        source, path: file.path, reason: refusal.reason, paths: refusal.paths, ...refusal.limit })]);
    return refusal;
  }
}
export async function recordProfileContextVersionInTransaction(client: DatabaseClient, profile: AgentProfile,
  actor: { tenant_id: string; alias: string }, humanId?: string): Promise<ContextRejectedError | undefined> {
  const target = await legacyTarget(client, profile.tenant_id, profile.alias);
  if (!target) return undefined;
  return recordLegacyFile(client, target, { path: CONTEXT_PROFILE_PATH, content: JSON.stringify(normalizeAgentProfile({ ...profile })) },
    'profile', actor, humanId);
}
export async function recordNativeContextVersionInTransaction(client: DatabaseClient, entry: DocumentRevisionInput,
  content: string, humanId?: string): Promise<ContextRejectedError | undefined> {
  if (!['directive','identity','human','tools','prompts','heartbeat'].includes(entry.kind)) return undefined;
  if (entry.sha256 !== createHash('sha256').update(content).digest('hex') || entry.bytes !== Buffer.byteLength(content)) {
    throw new StoreError('invalid_input', 'native context content differs from its durable write proof');
  }
  if (entry.actorTenant === null || entry.actorAlias === null) throw new StoreError('forbidden', 'native context requires an attributed actor');
  const target = await legacyTarget(client, entry.tenantId, entry.alias);
  if (!target) return undefined;
  return recordLegacyFile(client, target, { path: nativeDocumentContextPath(entry.kind), content },
    entry.kind === 'directive' ? 'directive' : 'native', { tenant_id: entry.actorTenant, alias: entry.actorAlias }, humanId);
}
