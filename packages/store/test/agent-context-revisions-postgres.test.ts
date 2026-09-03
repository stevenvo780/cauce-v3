import { preparePostgresSuite } from './postgres-suite.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentContextRevisionsStore, AgentProfileRepository, StoreError, type DatabasePool,
} from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let journal: AgentContextRevisionsStore;
let profiles: AgentProfileRepository;

const actor = { tenant_id: 'Steven', alias: 'kant' } as const;

async function seedAgent(alias: string): Promise<void> {
  await pool.query(
    `INSERT INTO agents(
       tenant_id,alias,harness_id,display_name,enabled,
       container_name,runtime_user,home_directory,state_directory
     ) VALUES('Steven',$1,'claude',$1,true,'ws-'||$1,'dev','/home/dev','/home/dev/.cauce/'||$1)
     ON CONFLICT(tenant_id,alias) DO UPDATE SET enabled=true`,
    [alias],
  );
}

function profileOf(alias: string, summary: string, tools: readonly string[]) {
  return {
    tenant_id: 'Steven',
    alias,
    purpose: 'orquestar',
    role_summary: summary,
    human_brief: null,
    responsibilities: ['una'],
    restrictions: [],
    tools: [...tools],
    operating_rules: ['no romper la flota'],
  };
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  journal = new AgentContextRevisionsStore(pool);
  profiles = new AgentProfileRepository(pool);
}, 120_000);

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query('TRUNCATE TABLE agent_profile_revisions, agent_document_revisions');
  await seedAgent('argos');
  await seedAgent('zeus');
});

describe('agent context revisions store', () => {
  it('reads back every authored version the profile repository wrote, newest first', async () => {
    await profiles.replace(profileOf('argos', 'primera', ['bash']), null, actor);
    await profiles.replace(profileOf('argos', 'segunda', ['bash', 'grep']), 1, actor);

    const entries = await journal.listProfileRevisions('Steven', 'argos', 10);
    expect(entries.map((entry) => [entry.revision, entry.operation, entry.role_summary])).toEqual([
      [2, 'update', 'segunda'],
      [1, 'insert', 'primera'],
    ]);
    // The seven fields come back whole: a restore hands the snapshot straight to the canonical PUT.
    expect(entries[1]).toMatchObject({
      purpose: 'orquestar',
      responsibilities: ['una'],
      restrictions: [],
      tools: ['bash'],
      operating_rules: ['no romper la flota'],
      actor_tenant: null,
      actor_alias: null,
    });
    expect(Date.parse(entries[0]?.changed_at ?? '')).toBeGreaterThan(0);
  });

  it('never mixes the journal of two aliases of the same tenant', async () => {
    await profiles.replace(profileOf('argos', 'de argos', []), null, actor);
    await profiles.replace(profileOf('zeus', 'de zeus', []), null, actor);
    const entries = await journal.listProfileRevisions('Steven', 'zeus', 10);
    expect(entries.map((entry) => entry.role_summary)).toEqual(['de zeus']);
  });

  it('reads one version by number and answers undefined for one that never existed', async () => {
    await profiles.replace(profileOf('argos', 'primera', []), null, actor);
    await profiles.replace(profileOf('argos', 'segunda', []), 1, actor);
    expect(await journal.readProfileRevision('Steven', 'argos', 1)).toMatchObject({
      revision: 1, role_summary: 'primera',
    });
    expect(await journal.readProfileRevision('Steven', 'argos', 3)).toBeUndefined();
  });

  /** A revision number repeats when an alias is dropped and re-created; the latest one wins. */
  it('returns the most recent row when a revision number repeats', async () => {
    await profiles.replace(profileOf('argos', 'la vieja', []), null, actor);
    await pool.query(`DELETE FROM agent_profiles WHERE tenant_id='Steven' AND alias='argos'`);
    await profiles.replace(profileOf('argos', 'la nueva', []), null, actor);
    expect(await journal.readProfileRevision('Steven', 'argos', 1)).toMatchObject({
      role_summary: 'la nueva',
    });
    expect((await journal.listProfileRevisions('Steven', 'argos', 10)).length).toBe(3);
  });

  it('records a document write by fingerprint and lists it by kind', async () => {
    const written = await journal.recordDocumentRevision({
      tenantId: 'Steven', alias: 'argos', kind: 'directive',
      path: '/home/dev/CLAUDE.md', sha256: 'a'.repeat(64), bytes: 4096,
      actorTenant: 'Steven', actorAlias: 'kant',
    });
    expect(written).toMatchObject({
      kind: 'directive', path: '/home/dev/CLAUDE.md', sha256: 'a'.repeat(64), bytes: 4096,
    });
    await journal.recordDocumentRevision({
      tenantId: 'Steven', alias: 'argos', kind: 'tools',
      path: '/home/dev/TOOLS.md', sha256: 'b'.repeat(64), bytes: 12,
      actorTenant: null, actorAlias: null,
    });
    const directives = await journal.listDocumentRevisions('Steven', 'argos', 'directive', 10);
    expect(directives.map((entry) => entry.path)).toEqual(['/home/dev/CLAUDE.md']);
    // There is no column able to hold a body, so nothing the store returns can carry one.
    expect(Object.keys(directives[0] ?? {})).not.toContain('content');
  });

  it('records an absent file as a null fingerprint with zero bytes', async () => {
    const written = await journal.recordDocumentRevision({
      tenantId: 'Steven', alias: 'argos', kind: 'directive',
      path: '/home/dev/CLAUDE.md', sha256: null, bytes: 0,
      actorTenant: 'Steven', actorAlias: 'kant',
    });
    expect(written.sha256).toBeNull();
    expect(written.bytes).toBe(0);
  });

  it('refuses a page size outside its bounds instead of scanning the whole journal', async () => {
    await expect(journal.listProfileRevisions('Steven', 'argos', 0)).rejects.toBeInstanceOf(StoreError);
    await expect(journal.listProfileRevisions('Steven', 'argos', 201)).rejects.toBeInstanceOf(StoreError);
    await expect(journal.listDocumentRevisions('Steven', 'argos', 'directive', 0))
      .rejects.toBeInstanceOf(StoreError);
    await expect(journal.readProfileRevision('Steven', 'argos', 0)).rejects.toBeInstanceOf(StoreError);
  });
});
