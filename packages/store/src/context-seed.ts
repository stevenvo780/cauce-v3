import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withTransaction, type DatabasePool } from './db.js';
import { contextSnapshot, lockContextTarget, persistContextVersionInTransaction } from './context-version.js';
import { CONTEXT_PROFILE_PATH, canonicalProfileContext } from './context-version-profile.js';
import { ContextFilesSchema, assertContextTarget, canonicalContextFiles, contextDigest, type ContextFile,
  type ContextTarget } from './context-version-model.js';

export type NativeContextSource = (target: ContextTarget) => Promise<readonly ContextFile[]>;
export interface ContextSeedOptions { readonly company?: string; readonly natives?: NativeContextSource; readonly dryRun?: boolean }
export interface ContextSeedResult extends ContextTarget {
  readonly state: 'seeded' | 'planned' | 'existing' | 'empty';
  readonly version: number; readonly files: number; readonly digest: string | null;
}
const MAX_NATIVE_BYTES = 262_144;
const decoder = new TextDecoder('utf-8', { fatal: true });

/** A configured runtime remains an agent even when a person also acts through its alias. */
export async function activeContextTargets(pool: DatabasePool, company?: string): Promise<ContextTarget[]> {
  return (await pool.query<ContextTarget>(`SELECT tenant.company_id,agent.tenant_id,agent.alias FROM agents agent
    JOIN tenants tenant ON tenant.id=agent.tenant_id JOIN companies company ON company.id=tenant.company_id
    WHERE agent.retired_at IS NULL AND agent.purged_at IS NULL AND tenant.enabled AND tenant.retired_at IS NULL
      AND tenant.purged_at IS NULL AND company.enabled AND company.retired_at IS NULL AND ($1::text IS NULL OR tenant.company_id=$1)
      AND ((agent.runtime_key IS NOT NULL AND agent.harness_id IS NOT NULL AND agent.container_name IS NOT NULL)
      OR (NOT EXISTS (SELECT 1 FROM console_users person WHERE person.tenant_id=agent.tenant_id AND person.alias=agent.alias)
      AND NOT EXISTS (SELECT 1 FROM human_tenant_memberships human
        WHERE human.tenant_id=agent.tenant_id AND human.actor_alias=agent.alias)))
    ORDER BY tenant.company_id,agent.tenant_id,agent.alias`, [company ?? null])).rows;
}

async function realDirectory(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory()) throw new Error(`native context path is not a real directory: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function collectNatives(base: string, relative: string, files: ContextFile[]): Promise<void> {
  if (!await realDirectory(join(base, relative))) return;
  for (const entry of await readdir(join(base, relative), { withFileTypes: true })) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) { await collectNatives(base, path, files); continue; }
    const location = join(base, path);
    const stat = await lstat(location);
    if (!stat.isFile() || stat.size > MAX_NATIVE_BYTES) throw new Error(`native context file is not allowed: ${location}`);
    const file = { path, content: decoder.decode(await readFile(location)) };
    if (!ContextFilesSchema.safeParse([file]).success) throw new Error(`native context file is not allowed: ${location}`);
    files.push(file);
  }
}
/** Reads `<root>/<tenant>/<alias>/{context,directives}/` without following links; a missing agent folder has no natives. */
export function nativeContextDirectory(root: string): NativeContextSource {
  return async target => {
    assertContextTarget(target);
    const base = join(root, target.tenant_id, target.alias);
    if (!await realDirectory(join(root, target.tenant_id)) || !await realDirectory(base)) return [];
    const files: ContextFile[] = [];
    for (const top of ['context', 'directives']) await collectNatives(base, top, files);
    return canonicalContextFiles(files);
  };
}

async function seedTarget(pool: DatabasePool, target: ContextTarget, natives: NativeContextSource | undefined,
  dryRun: boolean): Promise<ContextSeedResult> {
  // The profile of the database is canonical: a profile.json found on disk never overrides it.
  const supplied = canonicalContextFiles((await natives?.(target) ?? []).filter(file => file.path !== CONTEXT_PROFILE_PATH));
  return withTransaction(pool, async client => {
    await lockContextTarget(client, target);
    const current = await contextSnapshot(client, target);
    if (current.desired_version > 0) {
      return { ...target, state: 'existing', version: current.desired_version, files: current.files.length, digest: current.digest };
    }
    const profile = await canonicalProfileContext(client, target);
    const planned = canonicalContextFiles(profile ? [...supplied, profile] : supplied);
    if (planned.length === 0) return { ...target, state: 'empty', version: 0, files: 0, digest: null };
    if (dryRun) return { ...target, state: 'planned', version: 1, files: planned.length, digest: contextDigest(planned) };
    const seeded = await persistContextVersionInTransaction(client, target,
      { humanId: null, homeTenant: target.tenant_id, alias: target.alias }, 0, supplied, supplied.length > 0 ? 'native' : 'profile');
    return { ...target, state: 'seeded', version: seeded.desired_version, files: seeded.files.length, digest: seeded.digest };
  });
}
/**
 * Records version 1 of every active agent without history from its canonical profile and native documents, queued for the
 * Git broker in the same transaction. Idempotent: an agent that already has a version is reported and left untouched.
 */
export async function seedAgentContextHistory(pool: DatabasePool, options: ContextSeedOptions = {}): Promise<ContextSeedResult[]> {
  const results: ContextSeedResult[] = [];
  for (const target of await activeContextTargets(pool, options.company)) {
    results.push(await seedTarget(pool, target, options.natives, options.dryRun === true));
  }
  return results;
}
