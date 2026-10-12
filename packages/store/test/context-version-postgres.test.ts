import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockCompanyAuthority, type DatabasePool, AgentContextRevisionsStore, AgentProfileRepository, withTransaction } from '../src/index.js';
import { ContextVersionStore } from '../src/context-version.js';
import { recordNativeContextVersionInTransaction } from '../src/context-version-legacy.js';
import { ContextRejectedError } from '../src/context-version-model.js';
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
  it('keeps V3 profile and document writes that the history cannot version and shows the pending reason', async () => {
    await write();
    const profiles = new AgentProfileRepository(pool);
    const profile = await profiles.readWithPresence(target().tenant_id, target().alias);
    const leaked = `Usa sk-proj-${'Ab3_-'.repeat(8)} para el proveedor.`;
    await profiles.replace({ ...profile.perfil, purpose: leaked }, profile.revision, { tenant_id: target().tenant_id, alias: 'owner' });
    expect((await profiles.read(target().tenant_id, target().alias)).purpose).toBe(leaked);
    expect(await store.read(source(), target().tenant_id, target().alias)).toMatchObject({ version: 1,
      versioning: { state: 'unversioned', reason: 'context_secret_detected', source: 'profile', paths: ['context/profile.json'] } });
    const documents = new AgentContextRevisionsStore(pool);
    for (const [content, reason] of [['x'.repeat(70_000), 'context_harness_limit'], ['﻿Equipo 👨‍👩‍👧 listo', 'context_unsafe_text']] as const) {
      const document = { tenantId: target().tenant_id, alias: target().alias, kind: 'directive', path: '/scoped/AGENTS.md',
        sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content), actorTenant: target().tenant_id, actorAlias: 'owner' };
      const refusal = await withTransaction(pool, async client => {
        await new AgentContextRevisionsStore(client as unknown as DatabasePool).recordDocumentRevision(document);
        return recordNativeContextVersionInTransaction(client, document, content, target().human_id);
      });
      expect(refusal).toBeInstanceOf(ContextRejectedError);
      expect(refusal?.reason).toBe(reason);
      expect((await documents.listDocumentRevisions(target().tenant_id, target().alias, 'directive', 5)).entries[0])
        .toMatchObject({ sha256: document.sha256 });
    }
    expect((await store.read(source(), target().tenant_id, target().alias)).versioning)
      .toMatchObject({ state: 'unversioned', reason: 'context_unsafe_text', source: 'directive', paths: ['directives/native-directive.md'] });
    expect((await pool.query(`SELECT metadata->>'reason' AS reason FROM audit_events WHERE action='context.unversioned' ORDER BY id`)).rows)
      .toEqual([{ reason: 'context_secret_detected' }, { reason: 'context_harness_limit' }, { reason: 'context_unsafe_text' }]);
    await expect(write(1, [{ path: 'context/mission.md', content: 'Blocked while the profile holds a secret.' }]))
      .rejects.toMatchObject({ reason: 'context_secret_detected', paths: ['context/profile.json'] });
    const leakedProfile = await profiles.readWithPresence(target().tenant_id, target().alias);
    await profiles.replace({ ...leakedProfile.perfil, purpose: 'Clean purpose' }, leakedProfile.revision, { tenant_id: target().tenant_id, alias: 'owner' });
    expect(await store.read(source(), target().tenant_id, target().alias)).toMatchObject({ version: 2, versioning: { state: 'current' } });
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
