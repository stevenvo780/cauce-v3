import { createHash } from 'node:crypto';
import { normalizeAgentProfile, type AgentProfile } from '@cauce/protocol';
import type { DatabaseClient } from './db.js';
import type { DocumentRevisionInput } from './agent-context-revisions.js';
import { canonicalContextFiles, type ContextTarget } from './context-version-model.js';
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
async function recordLegacyFile(client: DatabaseClient, target: ContextTarget, file: { path: string; content: string },
  source: 'profile' | 'native' | 'directive', actor: { tenant_id: string; alias: string }, humanId?: string): Promise<void> {
  await lockContextTarget(client, target);
  const previous = await contextSnapshot(client, target);
  if (previous.files.some(existing => existing.path === file.path && existing.content === file.content)) return;
  const files = canonicalContextFiles([...previous.files.filter(existing => existing.path !== file.path), file]);
  await persistContextVersionInTransaction(client, target, { humanId: humanId ?? null, homeTenant: actor.tenant_id, alias: actor.alias },
    previous.version, files, source);
}
export async function recordProfileContextVersionInTransaction(client: DatabaseClient, profile: AgentProfile,
  actor: { tenant_id: string; alias: string }, humanId?: string): Promise<void> {
  const target = await legacyTarget(client, profile.tenant_id, profile.alias);
  if (!target) return;
  await recordLegacyFile(client, target, { path: CONTEXT_PROFILE_PATH, content: JSON.stringify(normalizeAgentProfile({ ...profile })) }, 'profile', actor, humanId);
}
export async function recordNativeContextVersionInTransaction(client: DatabaseClient, entry: DocumentRevisionInput,
  content: string, humanId?: string): Promise<void> {
  if (!['directive','identity','human','tools','prompts','heartbeat'].includes(entry.kind)) return;
  if (entry.sha256 !== createHash('sha256').update(content).digest('hex') || entry.bytes !== Buffer.byteLength(content)) {
    throw new StoreError('invalid_input', 'native context content differs from its durable write proof');
  }
  if (entry.actorTenant === null || entry.actorAlias === null) throw new StoreError('forbidden', 'native context requires an attributed actor');
  const target = await legacyTarget(client, entry.tenantId, entry.alias);
  if (!target) return;
  await recordLegacyFile(client, target, { path: `directives/native-${entry.kind}.md`, content },
    entry.kind === 'directive' ? 'directive' : 'native', { tenant_id: entry.actorTenant, alias: entry.actorAlias }, humanId);
}
