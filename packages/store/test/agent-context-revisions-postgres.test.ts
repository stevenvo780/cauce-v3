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

    const { entries, next_cursor } = await journal.listProfileRevisions('Steven', 'argos', 10);
    expect(next_cursor).toBeNull();
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
    const { entries } = await journal.listProfileRevisions('Steven', 'zeus', 10);
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
    expect((await journal.listProfileRevisions('Steven', 'argos', 10)).entries.length).toBe(3);
  });

  /*
   * `directive` y `tools` no son etiquetas de este test: son las que escribe la recarga del
   * gateway (`RELOAD_DOCUMENT_KINDS`) y las únicas que su ruta de historial acepta. Sembrar otra
   * cosa aquí dejaría verde un diario que nadie puede leer.
   */
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
    expect(directives.entries.map((entry) => entry.path)).toEqual(['/home/dev/CLAUDE.md']);
    // There is no column able to hold a body, so nothing the store returns can carry one.
    expect(Object.keys(directives.entries[0] ?? {})).not.toContain('content');
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

  /*
   * La BASE acota lo que una fila puede CONTENER (digest canónico y bytes no negativos); la FORMA
   * de la ruta la acota el ESCRITOR. `041` sólo exige la barra inicial y una longitud, así que el
   * recorrido y el segmento vacío pasarían enteros, y lo que la base sí rechaza llegaría como un
   * error de constraint y no como un `StoreError` que el llamante pueda leer.
   */
  it.each([
    ['relativa', 'home/dev/CLAUDE.md'],
    ['con recorrido', '/home/dev/../../etc/CLAUDE.md'],
    ['con segmento vacío', '/home//dev/CLAUDE.md'],
    ['de longitud desbordada', `/${'a'.repeat(4096)}`],
  ])('refuses a %s path with a typed error instead of trusting the base', async (_caso, path) => {
    await expect(journal.recordDocumentRevision({
      tenantId: 'Steven', alias: 'argos', kind: 'directive',
      path, sha256: null, bytes: 0, actorTenant: null, actorAlias: null,
    })).rejects.toBeInstanceOf(StoreError);
    const filas = await journal.listDocumentRevisions('Steven', 'argos', 'directive', 10);
    expect(filas.entries).toEqual([]);
  });

  async function seedProfileVersions(alias: string, count: number): Promise<void> {
    for (let version = 1; version <= count; version += 1) {
      await profiles.replace(
        profileOf(alias, `v${String(version)}`, []), version === 1 ? null : version - 1, actor,
      );
    }
  }

  /*
   * The walk is the assertion: three pages of three over a journal of seven have to reproduce the
   * single wide read exactly. A duplicate, a gap or an id that stops descending would all leave
   * the operator reading a diary that is not the one the base holds.
   */
  it('walks the whole profile journal by cursor without a duplicate or a gap', async () => {
    await seedProfileVersions('argos', 7);
    const completa = await journal.listProfileRevisions('Steven', 'argos', 200);
    expect(completa.entries).toHaveLength(7);
    expect(completa.next_cursor).toBeNull();

    const recorridas: string[] = [];
    let cursor: string | null = null;
    let vueltas = 0;
    do {
      const pagina: Awaited<ReturnType<typeof journal.listProfileRevisions>> =
        await journal.listProfileRevisions('Steven', 'argos', 3, cursor ?? undefined);
      expect(pagina.entries.length).toBeLessThanOrEqual(3);
      for (const entry of pagina.entries) recorridas.push(entry.id);
      cursor = pagina.next_cursor;
      if (cursor !== null) expect(cursor).toBe(pagina.entries[pagina.entries.length - 1]?.id);
      vueltas += 1;
    } while (cursor !== null && vueltas < 10);

    expect(vueltas).toBe(3);
    expect(recorridas).toEqual(completa.entries.map((entry) => entry.id));
    expect(new Set(recorridas).size).toBe(recorridas.length);
    const ids = recorridas.map((id) => BigInt(id));
    expect(ids.every((id, index) => index === 0 || id < (ids[index - 1] ?? 0n))).toBe(true);
  });

  it('ends the walk without a cursor when the last page lands exactly on the boundary', async () => {
    await seedProfileVersions('argos', 4);
    const primera = await journal.listProfileRevisions('Steven', 'argos', 2);
    expect(primera.entries).toHaveLength(2);
    const segunda = await journal.listProfileRevisions(
      'Steven', 'argos', 2, primera.next_cursor ?? undefined,
    );
    expect(segunda.entries).toHaveLength(2);
    expect(segunda.next_cursor).toBeNull();
    const exacta = await journal.listProfileRevisions('Steven', 'argos', 4);
    expect(exacta.entries).toHaveLength(4);
    expect(exacta.next_cursor).toBeNull();
  });

  /** The predicate wins: a cursor is a position, never a permission to read another alias. */
  it('never leaks rows of another alias through a cursor minted on that alias', async () => {
    await seedProfileVersions('zeus', 4);
    await seedProfileVersions('argos', 2);
    const deZeus = await journal.listProfileRevisions('Steven', 'zeus', 2);
    const conCursorAjeno = await journal.listProfileRevisions(
      'Steven', 'argos', 10, deZeus.next_cursor ?? undefined,
    );
    expect(conCursorAjeno.entries.map((entry) => entry.alias)).not.toContain('zeus');
    // The zeus ids are lower than every argos id, so the cursor NARROWS to nothing at all.
    expect(conCursorAjeno.entries).toEqual([]);
    expect(conCursorAjeno.next_cursor).toBeNull();
  });

  it('never leaks rows of another kind through a cursor minted on that kind', async () => {
    for (const kind of ['directive', 'tools', 'directive', 'tools'] as const) {
      await journal.recordDocumentRevision({
        tenantId: 'Steven', alias: 'argos', kind,
        path: `/home/dev/${kind}.md`, sha256: 'c'.repeat(64), bytes: 10,
        actorTenant: null, actorAlias: null,
      });
    }
    const tools = await journal.listDocumentRevisions('Steven', 'argos', 'tools', 1);
    expect(tools.next_cursor).not.toBeNull();
    const directivas = await journal.listDocumentRevisions(
      'Steven', 'argos', 'directive', 10, tools.next_cursor ?? undefined,
    );
    expect(directivas.entries.length).toBeGreaterThan(0);
    expect(directivas.entries.every((entry) => entry.kind === 'directive')).toBe(true);
  });

  it.each([
    ['no numérico', 'abc'],
    ['con cero a la izquierda', '007'],
    ['negativo', '-1'],
    ['vacío', ''],
    ['fuera del rango de bigint', '9223372036854775808'],
    ['de longitud desbordada', '1'.repeat(40)],
  ])('refuses a %s cursor with a typed error instead of casting it in the base', async (_caso, cursor) => {
    await expect(journal.listProfileRevisions('Steven', 'argos', 10, cursor))
      .rejects.toBeInstanceOf(StoreError);
    await expect(journal.listDocumentRevisions('Steven', 'argos', 'directive', 10, cursor))
      .rejects.toBeInstanceOf(StoreError);
  });

  it('refuses a page size outside its bounds instead of scanning the whole journal', async () => {
    await expect(journal.listProfileRevisions('Steven', 'argos', 0)).rejects.toBeInstanceOf(StoreError);
    await expect(journal.listProfileRevisions('Steven', 'argos', 201)).rejects.toBeInstanceOf(StoreError);
    await expect(journal.listDocumentRevisions('Steven', 'argos', 'directive', 0))
      .rejects.toBeInstanceOf(StoreError);
    await expect(journal.readProfileRevision('Steven', 'argos', 0)).rejects.toBeInstanceOf(StoreError);
  });
});
