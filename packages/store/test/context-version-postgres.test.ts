import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockCompanyAuthority, type DatabasePool, AgentContextRevisionsStore, AgentProfileRepository, withTransaction } from '../src/index.js';
import { ContextVersionStore, ingestNativeContextVersion } from '../src/context-version.js';
import { recordNativeContextVersionInTransaction } from '../src/context-version-legacy.js';
import { ContextRejectedError, type ContextSnapshot } from '../src/context-version-model.js';
import { createHash } from 'node:crypto';
import { ContextGitBroker } from '../src/context-git.js';
import { processContextOutbox } from '../src/context-version-worker.js';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

const execute = promisify(execFile);
let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let fixtures: Awaited<ReturnType<typeof seedSyntheticCompanyContexts>>; let directory: string; let store: ContextVersionStore;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('database unavailable');
  current = await startTestCaseDatabase(database); pool = current.pool;
  fixtures = await seedSyntheticCompanyContexts(current.adminUrl); store = new ContextVersionStore(pool);
  directory = await mkdtemp(join(tmpdir(), 'cauce-context-real-')); await chmod(directory, 0o700);
  await execute('git', ['init', '--initial-branch=main', directory]);
});
afterEach(async () => { await current?.close(); current = undefined; if (directory) await rm(directory, { recursive: true, force: true }); });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function target(index = 0) { const value = fixtures[index]; if (!value) throw new Error('fixture absent'); return value; }
function source(index = 0) { const value = target(index); return (client: import('../src/db.js').DatabaseClient) =>
  lockCompanyAuthority(client, { tenant: value.tenant_id, alias: 'owner', humanId: value.human_id }); }
const files = [{ path: 'context/mission.md', content: 'Mission\nUse scoped messages.\n' }];
const write = (expected = 0, content = files) => store.write(source(), target().tenant_id, target().alias,
  { expected_version: expected, source: 'ui', files: content });
const owner = () => ({ tenant_id: target().tenant_id, alias: 'owner' });
const versioning = async () => (await store.read(source(), target().tenant_id, target().alias)).versioning;
/** A V3 console write of the native directive: its journal revision and its legacy version in one transaction. */
function saveDirective(content: string) {
  const document = { tenantId: target().tenant_id, alias: target().alias, kind: 'directive', path: '/scoped/AGENTS.md',
    sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content), actorTenant: target().tenant_id, actorAlias: 'owner' };
  return withTransaction(pool, async client => {
    await new AgentContextRevisionsStore(client as unknown as DatabasePool).recordDocumentRevision(document);
    return recordNativeContextVersionInTransaction(client, document, content, target().human_id);
  });
}
/** Deletes the agent row with what references it and inserts it again: the state cascades away, the versions stay. */
async function recreateAgent(): Promise<void> {
  if (!current) throw new Error('database unavailable');
  const admin = await current.adminPool.connect();
  const tables = [['agents', 'alias'], ['company_agent_roles', 'alias'], ['company_system_principals', 'principal_alias']] as const;
  try {
    await admin.query('BEGIN');
    for (const [table, alias] of tables) {
      await admin.query(`CREATE TEMP TABLE kept_${table} ON COMMIT DROP AS SELECT * FROM ${table} WHERE tenant_id=$1 AND ${alias}=$2`,
        [target().tenant_id, target().alias]);
    }
    for (const [table, alias] of [...tables].reverse()) {
      await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1 AND ${alias}=$2`, [target().tenant_id, target().alias]);
    }
    for (const [table] of tables) await admin.query(`INSERT INTO ${table} SELECT * FROM kept_${table}`);
    await admin.query('COMMIT');
  } catch (error) { await admin.query('ROLLBACK'); throw error; } finally { admin.release(); }
}
async function replacePurpose(purpose: string | null): Promise<void> {
  const profiles = new AgentProfileRepository(pool);
  const profile = await profiles.readWithPresence(target().tenant_id, target().alias);
  await profiles.replace({ ...profile.perfil, purpose }, profile.revision, owner());
}
async function corruptVersion(snapshot: ContextSnapshot, corruption: 'shape' | 'digest') {
  if (!current) throw new Error('database unavailable');
  const stored = corruption === 'shape' ? [...snapshot.files, { path: 'context/.invalid/kept.md', content: 'Keep these bytes too.' }]
    : snapshot.files;
  const digest = corruption === 'digest' ? '0'.repeat(64) : snapshot.digest;
  await current.adminPool.query('ALTER TABLE agent_context_versions DISABLE TRIGGER agent_context_versions_immutable');
  try {
    await current.adminPool.query(`UPDATE agent_context_versions SET files=$5::jsonb,digest=$6
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4`,
    [target().company_id, target().tenant_id, target().alias, snapshot.version, JSON.stringify(stored), digest]);
  } finally {
    await current.adminPool.query('ALTER TABLE agent_context_versions ENABLE TRIGGER agent_context_versions_immutable');
  }
  return { stored, digest };
}

describe('durable context versions with real PostgreSQL and Git', () => {
  it('serializes concurrent writes, preserves restore history and fences the other company', async () => {
    expect((await write()).version).toBe(1);
    const outcomes = await Promise.allSettled([write(1), write(1, [{ path: 'directives/new.md', content: 'new' }])]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect((await store.read(source(), target().tenant_id, target().alias)).version).toBe(2);
    const restored = await store.restore(source(), target().tenant_id, target().alias, { expected_version: 2, version: 1 });
    expect(restored).toMatchObject({ desired_version: 3, applied_version: 0 });
    expect(restored.files).toEqual(expect.arrayContaining(files));
    expect((await store.history(source(), target().tenant_id, target().alias)).entries[0]).toMatchObject({ version: 3, source: 'restore', restored_from: 1 });
    await expect(store.read(source(), target(1).tenant_id, target(1).alias)).rejects.toMatchObject({ code: 'not_found' });
    expect((await store.read(source(1), target(1).tenant_id, target(1).alias)).version).toBe(0);
  });
  it('keeps a real Git commit after failed push, retries idempotently and never credits an unacknowledged runtime return', async () => {
    await write(); const git = new ContextGitBroker(directory);
    const runtime = { apply: async (version: import('../src/context-version-model.js').ContextVersion) => ({ version: version.version, digest: version.digest }) };
    expect(await processContextOutbox(pool, { git, runtime })).toMatchObject({ state: 'error', error: 'context_push_failed' });
    const failed = await store.read(source(), target().tenant_id, target().alias);
    expect(failed).toMatchObject({ applied_version: 0, sync: { state: 'error', attempts: 1 } });
    expect(failed.sync.git_commit).toMatch(/^[a-f0-9]{40}$/u);
    const remote = join(directory, 'remote.git'); await execute('git', ['init', '--bare', remote]);
    await execute('git', ['-C', directory, 'remote', 'add', 'origin', remote]);
    await store.retry(source(), target().tenant_id, target().alias);
    expect(await processContextOutbox(pool, { git })).toMatchObject({ state: 'pending', version: 1 });
    const synced = await store.read(source(), target().tenant_id, target().alias);
    expect(synced.sync.git_commit).toBe(failed.sync.git_commit);
    expect((await execute('git', ['-C', directory, 'rev-list', '--count', 'main'])).stdout.trim()).toBe('1');
    expect((await execute('git', ['--git-dir', remote, 'show', 'main:companies/context_alpha/tenants/ContextAlpha/agents/director/context/mission.md'])).stdout).toBe(files[0]?.content);
    await write(1, [{ path: 'context/mission.md', content: 'Changed' }]);
    expect(await processContextOutbox(pool, { git, runtime: { apply: async () => ({ version: 99, digest: '0'.repeat(64) }) } })).toMatchObject({ state: 'error', error: 'context_runtime_verification_failed' });
    expect((await store.read(source(), target().tenant_id, target().alias)).applied_version).toBe(0);
  });
  it('uses the shared broker lock and never sends another company snapshot to the application sink', async () => {
    await write();
    await store.write(source(1), target(1).tenant_id, target(1).alias, { expected_version: 0, source: 'cli', files });
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(783_003_058)');
      expect(await processContextOutbox(pool, { git: new ContextGitBroker(directory), runtime: { apply: async () => { throw new Error('unexpected sink'); } } })).toEqual({ state: 'busy' });
    } finally { await client.query('ROLLBACK'); client.release(); }
    const observed: string[] = [];
    await processContextOutbox(pool, { git: new ContextGitBroker(directory), runtime: { apply: async version => {
      observed.push(version.company_id); return { version: version.version, digest: version.digest };
    } } }, target(1));
    expect(observed).toEqual(['context_beta']);
  });
  it('captures legacy profile and native directive writes in the same history and restores the canonical profile', async () => {
    const initial = await write();
    const profiles = new AgentProfileRepository(pool);
    const profile = await profiles.readWithPresence(target().tenant_id, target().alias);
    await profiles.replace({ ...profile.perfil, purpose: 'Changed canonical purpose' }, profile.revision,
      { tenant_id: target().tenant_id, alias: 'owner' });
    expect((await store.read(source(), target().tenant_id, target().alias)).version).toBe(2);
    const content = 'A native directive.';
    await withTransaction(pool, client => recordNativeContextVersionInTransaction(client,
      { tenantId: target().tenant_id, alias: target().alias, kind: 'directive', path: '/scoped/AGENTS.md',
        sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content),
        actorTenant: target().tenant_id, actorAlias: 'owner' }, content, target().human_id));
    expect((await store.read(source(), target().tenant_id, target().alias)).files).toEqual(expect.arrayContaining([
      { path: 'directives/native-directive.md', content },
    ]));
    const restored = await store.restore(source(), target().tenant_id, target().alias, { expected_version: 3, version: 1 });
    expect(restored.version).toBe(4);
    expect(restored.files).toEqual(initial.files);
    expect((await profiles.read(target().tenant_id, target().alias)).purpose).toBeNull();
    expect((await store.history(source(), target().tenant_id, target().alias)).entries.map(entry => entry.source))
      .toEqual(['restore','directive','profile','ui']);
  });
  it('rejects a foreign canonical profile and mismatched native bytes without changing history', async () => {
    await write();
    await expect(write(1, [{ path: 'context/profile.json', content: JSON.stringify({ tenant_id: target(1).tenant_id, alias: target(1).alias }) }]))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(withTransaction(pool, client => recordNativeContextVersionInTransaction(client,
      { tenantId: target().tenant_id, alias: target().alias, kind: 'directive', path: '/scoped/AGENTS.md', sha256: 'a'.repeat(64), bytes: 1,
        actorTenant: target().tenant_id, actorAlias: 'owner' }, 'different'))).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await store.read(source(), target().tenant_id, target().alias)).version).toBe(1);
  });
  it.each(['shape', 'digest'] as const)('preserves every stored file when legacy edits encounter an unreadable %s', async corruption => {
    const initial = await write(0, [...files, { path: 'directives/kept.md', content: 'Keep this directive.' }]);
    const scope = [target().company_id, target().tenant_id, target().alias];
    const { stored, digest } = await corruptVersion(initial, corruption);
    expect(await store.read(source(), target().tenant_id, target().alias)).toMatchObject({ version: 1,
      application: { state: 'error', last_error: 'context_version_unreadable' } });
    const content = 'The V3 directive stays durable.';
    expect(await saveDirective(content)).toMatchObject({ reason: 'context_version_unreadable',
      message: 'la versión actual no se puede leer; restaura una versión anterior desde el historial' });
    await replacePurpose('The V3 profile stays durable.');
    expect((await new AgentProfileRepository(pool).read(target().tenant_id, target().alias)).purpose)
      .toBe('The V3 profile stays durable.');
    expect((await new AgentContextRevisionsStore(pool).listDocumentRevisions(target().tenant_id, target().alias, 'directive', 5)).entries[0])
      .toMatchObject({ sha256: createHash('sha256').update(content).digest('hex') });
    expect((await pool.query(`SELECT version::integer,files,digest FROM agent_context_versions
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 ORDER BY version`, scope)).rows)
      .toEqual([{ version: 1, files: stored, digest }]);
    expect((await pool.query(`SELECT desired_version::integer,applied_version::integer FROM agent_context_state
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3`, scope)).rows)
      .toEqual([{ desired_version: 1, applied_version: 0 }]);
    expect((await pool.query(`SELECT version::integer FROM agent_context_outbox
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 ORDER BY version`, scope)).rows).toEqual([{ version: 1 }]);
    expect((await pool.query(`SELECT metadata->>'reason' AS reason,metadata->>'source' AS source,metadata->>'path' AS path
      FROM audit_events WHERE action='context.unversioned' AND company_id=$1 AND metadata->>'target_alias'=$3
        AND metadata->>'target_tenant'=$2 ORDER BY id`, scope)).rows).toEqual([
      { reason: 'context_version_unreadable', source: 'directive', path: 'directives/native-directive.md' },
      { reason: 'context_version_unreadable', source: 'profile', path: 'context/profile.json' },
    ]);
    expect(await versioning()).toMatchObject({ state: 'unversioned', reason: 'context_version_unreadable',
      paths: ['context/profile.json', 'directives/native-directive.md'] });
  });
  it.each(['shape', 'digest'] as const)('recovers an unreadable current %s only through a verified audited restore', async corruption => {
    const initial = await write(0, [...files, { path: 'directives/kept.md', content: 'Original directive.' }]);
    await replacePurpose('Recent purpose');
    const latest = await store.read(source(), target().tenant_id, target().alias);
    const scope = [target().company_id, target().tenant_id, target().alias];
    const { stored, digest } = await corruptVersion(latest, corruption);
    for (const inputSource of ['ui', 'cli'] as const) {
      await expect(store.write(source(), target().tenant_id, target().alias, { expected_version: 2, source: inputSource,
        files: [{ path: 'context/profile.json', content: JSON.stringify({ tenant_id: target().tenant_id,
          alias: target().alias, purpose: 'Rejected purpose' }) }] })).rejects.toMatchObject({
        reason: 'context_version_unreadable',
        message: 'la versión actual no se puede leer; restaura una versión anterior desde el historial',
      });
    }
    expect((await new AgentProfileRepository(pool).read(target().tenant_id, target().alias)).purpose).toBe('Recent purpose');
    expect((await store.history(source(), target().tenant_id, target().alias)).entries.map(entry => entry.version)).toEqual([2, 1]);
    expect((await pool.query(`SELECT version::integer FROM agent_context_outbox
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 ORDER BY version`, scope)).rows).toEqual([{ version: 1 }, { version: 2 }]);
    await expect(store.restore(source(), target().tenant_id, target().alias, { expected_version: 1, version: 1 }))
      .rejects.toMatchObject({ code: 'conflict' });
    const recovered = await store.restore(source(), target().tenant_id, target().alias, { expected_version: 2, version: 1 });
    expect(recovered).toMatchObject({ version: 3, files: initial.files, digest: initial.digest,
      application: { state: 'pending', last_error: null } });
    expect((await new AgentProfileRepository(pool).read(target().tenant_id, target().alias)).purpose).toBeNull();
    expect((await store.history(source(), target().tenant_id, target().alias)).entries[0])
      .toMatchObject({ version: 3, source: 'restore', restored_from: 1 });
    expect((await pool.query(`SELECT version::integer,files,digest FROM agent_context_versions
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=2`, scope)).rows).toEqual([{ version: 2, files: stored, digest }]);
    expect((await pool.query(`SELECT metadata FROM audit_events WHERE action='context.version'
      AND company_id=$1 AND metadata->>'target_tenant'=$2 AND metadata->>'target_alias'=$3 AND metadata->>'version'='3'`, scope)).rows)
      .toEqual([{ metadata: { target_tenant: target().tenant_id, target_alias: target().alias, version: 3, source: 'restore',
        restored_from: 1, recovery_reason: 'context_version_unreadable', recovered_unreadable_version: 2 } }]);
    expect((await pool.query(`SELECT desired_version::integer,applied_version::integer FROM agent_context_state
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3`, scope)).rows).toEqual([{ desired_version: 3, applied_version: 0 }]);
    expect((await pool.query(`SELECT version::integer FROM agent_context_outbox
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 ORDER BY version`, scope)).rows)
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect((await write(3)).version).toBe(4);
  });
  it.each(['shape', 'digest'] as const)('refuses an unreadable restore destination %s without changing a readable current version', async corruption => {
    const initial = await write();
    const latest = await write(1, [{ path: 'context/mission.md', content: 'Latest mission.' }]);
    await corruptVersion(initial, corruption);
    await expect(store.restore(source(), target().tenant_id, target().alias, { expected_version: 2, version: 1 }))
      .rejects.toMatchObject({ reason: 'context_version_unreadable' });
    expect(await store.read(source(), target().tenant_id, target().alias)).toMatchObject({ version: 2, files: latest.files, digest: latest.digest });
    expect((await store.history(source(), target().tenant_id, target().alias)).entries.map(entry => entry.version)).toEqual([2, 1]);
    expect((await pool.query("SELECT count(*)::integer AS count FROM audit_events WHERE action='context.version' AND metadata->>'source'='restore'"))
      .rows).toEqual([{ count: 0 }]);
    expect((await pool.query('SELECT version::integer FROM agent_context_outbox ORDER BY version')).rows)
      .toEqual([{ version: 1 }, { version: 2 }]);
  });
  it('allows a new version of readable files despite an obsolete unreadable application error', async () => {
    const initial = await write();
    await pool.query(`UPDATE agent_context_outbox SET apply_error='context_version_unreadable'
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=1`,
    [target().company_id, target().tenant_id, target().alias]);
    expect(await store.read(source(), target().tenant_id, target().alias)).toMatchObject({ version: 1, digest: initial.digest,
      files: initial.files, application: { state: 'error', last_error: 'context_version_unreadable' } });
    await expect(write(1)).resolves.toMatchObject({ version: 2, files: initial.files,
      application: { state: 'pending', last_error: null } });
  });
  it('keeps V3 profile and document writes that the history cannot version and shows the pending reason', async () => {
    await write();
    const documents = new AgentContextRevisionsStore(pool);
    for (const [content, reason] of [['x'.repeat(70_000), 'context_harness_limit'], ['\uFEFFEquipo 👨‍👩‍👧 listo', 'context_unsafe_text']] as const) {
      const refusal = await saveDirective(content);
      expect(refusal).toBeInstanceOf(ContextRejectedError);
      expect(refusal?.reason).toBe(reason);
      expect((await documents.listDocumentRevisions(target().tenant_id, target().alias, 'directive', 5)).entries[0])
        .toMatchObject({ sha256: createHash('sha256').update(content).digest('hex') });
    }
    expect(await versioning()).toMatchObject({ state: 'unversioned', reason: 'context_unsafe_text', source: 'directive',
      paths: ['directives/native-directive.md'] });
    const leaked = `Usa sk-proj-${'Ab3_-'.repeat(8)} para el proveedor.`;
    await replacePurpose(leaked);
    expect((await new AgentProfileRepository(pool).read(target().tenant_id, target().alias)).purpose).toBe(leaked);
    expect(await store.read(source(), target().tenant_id, target().alias)).toMatchObject({ version: 1, versioning: { state: 'unversioned',
      reason: 'context_secret_detected', source: 'profile', paths: ['context/profile.json', 'directives/native-directive.md'] } });
    expect((await pool.query(`SELECT metadata->>'reason' AS reason,metadata->>'path' AS path FROM audit_events
      WHERE action='context.unversioned' ORDER BY id`)).rows).toEqual([
      { reason: 'context_harness_limit', path: 'directives/native-directive.md' },
      { reason: 'context_unsafe_text', path: 'directives/native-directive.md' },
      { reason: 'context_secret_detected', path: 'context/profile.json' }]);
    await expect(write(1, [{ path: 'context/mission.md', content: 'Blocked while the profile holds a secret.' }]))
      .rejects.toMatchObject({ reason: 'context_secret_detected', paths: ['context/profile.json'] });
    await replacePurpose('Clean purpose');
    expect(await store.read(source(), target().tenant_id, target().alias)).toMatchObject({ version: 2, versioning: { state: 'unversioned',
      reason: 'context_unsafe_text', paths: ['directives/native-directive.md'] } });
    expect(await saveDirective('Directiva revisada.')).toBeUndefined();
    expect(await store.read(source(), target().tenant_id, target().alias)).toMatchObject({ version: 3, versioning: { state: 'current' } });
  });
  it('never reverts an unversioned V3 profile edit when a later version records another file', async () => {
    const initial = await write();
    const versionedPurpose = (await new AgentProfileRepository(pool).read(target().tenant_id, target().alias)).purpose;
    const edited = 'Equipo 👨‍👩‍👧 de soporte';
    await replacePurpose(edited);
    const purpose = async () => (await new AgentProfileRepository(pool).read(target().tenant_id, target().alias)).purpose;
    expect(await saveDirective('Directiva limpia.')).toMatchObject({ reason: 'context_unsafe_text', paths: ['context/profile.json'] });
    expect(await purpose()).toBe(edited);
    const ingested = await ingestNativeContextVersion(pool, target().tenant_id, target().alias,
      { base_version: 1, files: [...initial.files, { path: 'context/notes/turno.md', content: 'Nota del agente.' }] });
    expect(ingested).toMatchObject({ state: 'ingested', snapshot: { version: 2 } });
    expect(await purpose()).toBe(edited);
    const snapshot = await store.read(source(), target().tenant_id, target().alias);
    expect(snapshot.versioning).toMatchObject({ state: 'unversioned', reason: 'context_unsafe_text', source: 'directive',
      paths: ['context/profile.json', 'directives/native-directive.md'] });
    const resent = snapshot.files.map(file => file.path === 'context/mission.md' ? { ...file, content: 'Misión revisada.' } : file);
    expect(resent.some(file => file.path === 'context/profile.json')).toBe(true);
    await expect(write(2, resent)).rejects.toMatchObject({ reason: 'context_unsafe_text', paths: ['context/profile.json'] });
    expect(await purpose()).toBe(edited);
    await replacePurpose(versionedPurpose);
    expect(await store.read(source(), target().tenant_id, target().alias)).toMatchObject({ version: 2,
      versioning: { state: 'unversioned', paths: ['directives/native-directive.md'] } });
    expect(await saveDirective('Directiva limpia.')).toBeUndefined();
    expect(await store.read(source(), target().tenant_id, target().alias)).toMatchObject({ version: 3, versioning: { state: 'current' } });
    expect((await store.write(source(), target().tenant_id, target().alias, { expected_version: 3, source: 'ui',
      files: (await store.read(source(), target().tenant_id, target().alias)).files
        .map(file => file.path === 'context/mission.md' ? { ...file, content: 'Misión revisada.' } : file) })).version).toBe(4);
    expect(await purpose()).toBe(versionedPurpose);
  });
  it('blocks secrets and harness overflow as typed refusals that leave no version and roll back the profile', async () => {
    await write();
    const purpose = (await new AgentProfileRepository(pool).read(target().tenant_id, target().alias)).purpose;
    const profile = { path: 'context/profile.json', content: JSON.stringify({ tenant_id: target().tenant_id, alias: target().alias, purpose: 'Rolled back' }) };
    await expect(write(1, [profile, { path: 'context/notes/keys.md', content: `token ghp_${'a1B2'.repeat(6)}` }]))
      .rejects.toMatchObject({ code: 'invalid_input', reason: 'context_secret_detected', paths: ['context/notes/keys.md'] });
    expect((await new AgentProfileRepository(pool).read(target().tenant_id, target().alias)).purpose).toBe(purpose);
    const refused = await write(1, [{ path: 'context/mission.md', content: 'x'.repeat(70_000) }]).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ContextRejectedError);
    expect(refused).toMatchObject({ reason: 'context_harness_limit', limit: { max_bytes: 65_536 } });
    expect((await store.read(source(), target().tenant_id, target().alias)).version).toBe(1);
  });
  it('continues the numbering of a recreated alias instead of colliding with the history it kept', async () => {
    expect((await write()).version).toBe(1);
    expect((await write(1, [{ path: 'directives/new.md', content: 'new' }])).version).toBe(2);
    await recreateAgent();
    expect(await store.read(source(), target().tenant_id, target().alias)).toMatchObject({ version: 0, files: [] });
    const native = await ingestNativeContextVersion(pool, target().tenant_id, target().alias,
      { base_version: 0, files: [{ path: 'context/notes/after.md', content: 'Recreated note.' }] });
    expect(native).toMatchObject({ state: 'ingested', snapshot: { version: 3, desired_version: 3 } });
    await recreateAgent();
    expect((await write()).version).toBe(4);
    expect((await store.history(source(), target().tenant_id, target().alias)).entries.map(entry => entry.version)).toEqual([4, 3, 2, 1]);
  });
  it('preserves context identity and Git folder when display name and primary room change', async () => {
    await write();
    if (!current) throw new Error('database unavailable');
    await current.adminPool.query("INSERT INTO rooms(tenant_id,id) VALUES('ContextAlpha','renamed-room')");
    await current.adminPool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('ContextAlpha','renamed-room','director','agent')");
    await current.adminPool.query("UPDATE agents SET display_name='Renamed director',primary_room_id='renamed-room' WHERE tenant_id='ContextAlpha' AND alias='director'");
    const snapshot = await store.read(source(), target().tenant_id, target().alias);
    expect(snapshot).toMatchObject({ company_id: 'context_alpha', tenant_id: 'ContextAlpha', alias: 'director', version: 1 });
    const remote = join(directory, 'remote.git'); await execute('git', ['init', '--bare', remote]);
    await execute('git', ['-C', directory, 'remote', 'add', 'origin', remote]);
    await processContextOutbox(pool, { git: new ContextGitBroker(directory) });
    expect((await execute('git', ['--git-dir', remote, 'show', 'main:companies/context_alpha/tenants/ContextAlpha/agents/director/context/mission.md'])).stdout).toBe(files[0]?.content);
  });

});
