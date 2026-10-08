import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentAppearanceRevisionError, AgentFavoriteLimitError, AgentPreferencesStore, applyMigrations, applyMigrationsThrough, CauceRepository,
  StoreError, type AgentAppearanceActor, type DatabasePool,
} from '../src/index.js';
import { MAX_AGENT_FAVORITES_PER_HUMAN } from '@cauce/protocol';
import { preparePostgresSuite } from './postgres-suite.js';
import {
  resetTestDatabase, startEmptyTestDatabase, startTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined;
let pool: DatabasePool | undefined;

function currentPool(): DatabasePool {
  if (!pool) throw new Error('agent preferences PostgreSQL fixture is not running');
  return pool;
}

preparePostgresSuite(import.meta.url, async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL !== undefined) {
    throw new Error('agent preference tests require their own disposable Testcontainers database');
  }
  database = await startTestDatabase();
  pool = database.pool;
  console.info(`agent preferences PostgreSQL container ${database.container.getId()}`);
}, 180_000);

beforeEach(async () => {
  await resetTestDatabase(currentPool());
});

afterAll(async () => {
  if (!database || !pool) return;
  try { await pool.end(); } finally { await database.container.stop(); }
});

const actor: AgentAppearanceActor = {
  tenant_id: 'Steven', alias: 'kant', display: 'Alba', human_subject: `human:${'a'.repeat(64)}`,
};

async function agent(tenantId: string, alias: string): Promise<void> {
  await currentPool().query('INSERT INTO agents(tenant_id,alias) VALUES($1,$2) ON CONFLICT DO NOTHING', [tenantId, alias]);
}

async function person(alias = 'kant'): Promise<string> {
  const id = randomUUID();
  await agent('Steven', alias);
  await currentPool().query(`INSERT INTO console_users
    (id,email,email_normalized,password_hash,display_name,role,tenant_id,alias,active)
    VALUES($1,$2,$2,$3,'Fixture human','operator','Steven',$4,true)`,
  [id, `${id}@example.invalid`, `$scrypt$${'x'.repeat(40)}`, alias]);
  return id;
}

async function isolatedTenant(): Promise<string> {
  await currentPool().query("INSERT INTO tenants(id) VALUES('Aislado') ON CONFLICT DO NOTHING");
  await currentPool().query("DELETE FROM acl_edges WHERE from_tenant='Aislado' OR to_tenant='Aislado'");
  return 'Aislado';
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error);
}

describe('console favorites on PostgreSQL', () => {
  it('adds and removes idempotently and isolates two people behind the same technical alias', async () => {
    const store = new AgentPreferencesStore(currentPool());
    const alba = await person();
    const bruno = await person();
    await agent('Steven', 'argos');
    await store.addFavorite(alba, 'Steven', 'Steven', 'argos');
    await store.addFavorite(alba, 'Steven', 'Steven', 'argos');
    const favorites = await store.listFavorites(alba, 'Steven');
    expect(favorites).toEqual([{ tenant_id: 'Steven', alias: 'argos', created_at: expect.any(String) as string }]);
    expect(Number.isNaN(Date.parse(favorites[0]?.created_at ?? ''))).toBe(false);
    expect(await store.listFavorites(bruno, 'Steven')).toEqual([]);
    await store.removeFavorite(alba, 'Steven', 'argos');
    await store.removeFavorite(alba, 'Steven', 'argos');
    expect(await store.listFavorites(alba, 'Steven')).toEqual([]);
  });

  it('lists only agents the viewing tenant can read and rejects unknown agents', async () => {
    const store = new AgentPreferencesStore(currentPool());
    const alba = await person();
    const hidden = await isolatedTenant();
    await agent(hidden, 'iris');
    await store.addFavorite(alba, 'Steven', hidden, 'iris');
    expect(await store.listFavorites(alba, 'Steven')).toEqual([]);
    await currentPool().query(`INSERT INTO acl_edges(from_tenant,to_tenant,enabled,allow_read)
      VALUES('Steven',$1,true,true)`, [hidden]);
    try {
      expect((await store.listFavorites(alba, 'Steven')).map((item) => item.alias)).toEqual(['iris']);
    } finally {
      await currentPool().query('DELETE FROM acl_edges WHERE to_tenant=$1', [hidden]);
    }
    const missing = await rejection(store.addFavorite(alba, 'Steven', 'Steven', 'ghost'));
    expect(missing).toBeInstanceOf(StoreError);
    expect(missing).toMatchObject({ code: 'not_found' });
    expect(await rejection(store.addFavorite('not-a-uuid', 'Steven', 'Steven', 'argos'))).toMatchObject({ code: 'invalid_input' });
  });

  it('enforces the per-person cap under concurrency while re-adding stays idempotent', async () => {
    const store = new AgentPreferencesStore(currentPool());
    const alba = await person();
    const bruno = await person();
    const aliases = Array.from({ length: MAX_AGENT_FAVORITES_PER_HUMAN + 1 }, (_, index) => `cap${String(index)}`);
    await currentPool().query(
      `INSERT INTO agents(tenant_id,alias) SELECT 'Steven',alias FROM unnest($1::text[]) alias`, [aliases],
    );
    await currentPool().query(
      `INSERT INTO console_agent_favorites(human_id,tenant_id,alias)
       SELECT $1,'Steven',alias FROM unnest($2::text[]) alias`,
      [alba, aliases.slice(0, MAX_AGENT_FAVORITES_PER_HUMAN - 1)],
    );
    const results = await Promise.allSettled([
      store.addFavorite(alba, 'Steven', 'Steven', aliases[MAX_AGENT_FAVORITES_PER_HUMAN - 1] ?? ''),
      store.addFavorite(alba, 'Steven', 'Steven', aliases[MAX_AGENT_FAVORITES_PER_HUMAN] ?? ''),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected');
    expect(failed?.status === 'rejected' ? failed.reason : undefined).toBeInstanceOf(AgentFavoriteLimitError);
    const count = async (human: string) => Number((await currentPool().query<{ total: string }>(
      'SELECT count(*)::text AS total FROM console_agent_favorites WHERE human_id=$1', [human],
    )).rows[0]?.total);
    expect(await count(alba)).toBe(MAX_AGENT_FAVORITES_PER_HUMAN);
    await store.addFavorite(alba, 'Steven', 'Steven', aliases[0] ?? '');
    expect(await count(alba)).toBe(MAX_AGENT_FAVORITES_PER_HUMAN);
    await store.addFavorite(bruno, 'Steven', 'Steven', aliases[0] ?? '');
    expect(await count(bruno)).toBe(1);
  });
});

describe('agent appearance on PostgreSQL', () => {
  it('creates, updates and resets with optimistic concurrency and audits each change', async () => {
    const store = new AgentPreferencesStore(currentPool());
    await agent('Steven', 'argos');
    const created = await store.setAppearance({
      tenant_id: 'Steven', alias: 'argos', glyph: '\u{1F989}', hue: 210, style: 'aurora', expected_revision: null,
    }, actor);
    expect(created).toMatchObject({
      tenant_id: 'Steven', alias: 'argos', glyph: '\u{1F989}', hue: 210, style: 'aurora', revision: 1, updated_by: 'Alba',
    });
    const duplicate = await rejection(store.setAppearance({
      tenant_id: 'Steven', alias: 'argos', glyph: null, hue: null, style: 'orb', expected_revision: null,
    }, actor));
    expect(duplicate).toBeInstanceOf(AgentAppearanceRevisionError);
    expect(duplicate).toMatchObject({ currentRevision: 1 });
    const updated = await store.setAppearance({
      tenant_id: 'Steven', alias: 'argos', glyph: null, hue: null, style: 'pixel', expected_revision: 1,
    }, { ...actor, display: 'Bruno' });
    expect(updated).toMatchObject({ revision: 2, glyph: null, hue: null, style: 'pixel', updated_by: 'Bruno' });
    expect(await rejection(store.setAppearance({
      tenant_id: 'Steven', alias: 'argos', glyph: 'A', hue: 1, style: 'orb', expected_revision: 1,
    }, actor))).toMatchObject({ currentRevision: 2 });
    expect(await store.listAppearances('Steven')).toEqual([updated]);
    expect(await store.listAppearances(await isolatedTenant())).toEqual([]);
    expect(await rejection(store.resetAppearance('Steven', 'argos', 1, actor))).toMatchObject({ currentRevision: 2 });
    await store.resetAppearance('Steven', 'argos', 2, actor);
    expect(await store.listAppearances('Steven')).toEqual([]);
    expect(await rejection(store.resetAppearance('Steven', 'argos', 2, actor))).toMatchObject({ currentRevision: null });
    const audit = await currentPool().query<{ action: string; tenant_id: string; actor_alias: string; metadata: Record<string, unknown> }>(
      `SELECT action,tenant_id,actor_alias,metadata FROM audit_events
        WHERE action LIKE 'agent_appearance.%' ORDER BY id`,
    );
    expect(audit.rows.map((row) => [row.action, row.metadata.revision ?? null, row.metadata.previous_revision])).toEqual([
      ['agent_appearance.set', 1, null],
      ['agent_appearance.set', 2, 1],
      ['agent_appearance.reset', null, 2],
    ]);
    for (const row of audit.rows) {
      expect(row).toMatchObject({ tenant_id: 'Steven', actor_alias: 'kant' });
      expect(row.metadata).toMatchObject({ target_tenant: 'Steven', target_alias: 'argos', human_subject: actor.human_subject });
    }
  });

  it('lets exactly one concurrent creator win', async () => {
    const store = new AgentPreferencesStore(currentPool());
    await agent('Steven', 'argos');
    const results = await Promise.allSettled(['orb', 'pulse', 'pixel'].map((style) => store.setAppearance({
      tenant_id: 'Steven', alias: 'argos', glyph: null, hue: null, style: style as 'orb', expected_revision: null,
    }, actor)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ currentRevision: 1 });
    }
  });

  it('refuses invalid values in the store and in the schema constraints', async () => {
    const store = new AgentPreferencesStore(currentPool());
    await agent('Steven', 'argos');
    for (const glyph of ['AB', ' ', '\u202eA']) {
      expect(await rejection(store.setAppearance({
        tenant_id: 'Steven', alias: 'argos', glyph, hue: null, style: 'orb', expected_revision: null,
      }, actor))).toMatchObject({ code: 'invalid_input' });
    }
    expect(await rejection(store.setAppearance({
      tenant_id: 'Steven', alias: 'ghost', glyph: null, hue: null, style: 'orb', expected_revision: null,
    }, actor))).toMatchObject({ code: 'not_found' });
    await currentPool().query(
      "INSERT INTO agent_appearances(tenant_id,alias,style,updated_by) VALUES('Steven','argos','orb','t')",
    );
    for (const [column, value] of [
      ['hue', 360], ['style', 'neon'], ['glyph', 'A\n'], ['glyph', 'x'.repeat(17)], ['revision', 0], ['updated_by', ''],
    ] as const) {
      await expect(currentPool().query(
        `UPDATE agent_appearances SET ${column}=$1 WHERE tenant_id='Steven' AND alias='argos'`, [value],
      )).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('drops preferences together with the agent they decorate', async () => {
    const store = new AgentPreferencesStore(currentPool());
    const alba = await person();
    await agent('Steven', 'argos');
    await store.addFavorite(alba, 'Steven', 'Steven', 'argos');
    await store.setAppearance({
      tenant_id: 'Steven', alias: 'argos', glyph: 'A', hue: 1, style: 'orb', expected_revision: null,
    }, actor);
    await currentPool().query("DELETE FROM agents WHERE tenant_id='Steven' AND alias='argos'");
    expect(await store.listFavorites(alba, 'Steven')).toEqual([]);
    expect(await store.listAppearances('Steven')).toEqual([]);
  });
});

describe('agent preference visibility on PostgreSQL', () => {
  it('lists exactly the agents authorizeAgentTarget lets the viewer read', async () => {
    const store = new AgentPreferencesStore(currentPool());
    const repository = new CauceRepository(currentPool());
    const salva = randomUUID();
    await agent('Isa', 'salva');
    await currentPool().query(`INSERT INTO console_users
      (id,email,email_normalized,password_hash,display_name,role,tenant_id,alias,active)
      VALUES($1,$2,$2,$3,'Fixture human','reader','Isa','salva',true)`,
    [salva, `${salva}@example.invalid`, `$scrypt$${'x'.repeat(40)}`]);
    await agent('Steven', 'argos');
    await store.setAppearance({
      tenant_id: 'Steven', alias: 'argos', glyph: 'A', hue: 1, style: 'orb', expected_revision: null,
    }, actor);
    await currentPool().query(
      "INSERT INTO console_agent_favorites(human_id,tenant_id,alias) VALUES($1,'Steven','argos')", [salva],
    );
    const scenarios: readonly [string, string, boolean][] = [
      ['readable edge', 'UPDATE acl_edges SET enabled=true,allow_read=true WHERE from_tenant=\'Isa\' AND to_tenant=\'Steven\'', true],
      ['edge without read', 'UPDATE acl_edges SET allow_read=false WHERE from_tenant=\'Isa\' AND to_tenant=\'Steven\'', false],
      ['disabled edge', 'UPDATE acl_edges SET enabled=false,allow_read=true WHERE from_tenant=\'Isa\' AND to_tenant=\'Steven\'', false],
      ['disabled target tenant', `UPDATE acl_edges SET enabled=true,allow_read=true WHERE from_tenant='Isa' AND to_tenant='Steven';
        UPDATE tenants SET enabled=false WHERE id='Steven'`, false],
      ['re-enabled target tenant', "UPDATE tenants SET enabled=true WHERE id='Steven'", true],
    ];
    for (const [label, change, expected] of scenarios) {
      await currentPool().query(change);
      const authorized = await repository.authorizeAgentTarget('Isa', 'salva', 'Steven', 'argos', 'read');
      const looks = (await store.listAppearances('Isa')).map((item) => `${item.tenant_id}/${item.alias}`);
      const favorites = (await store.listFavorites(salva, 'Isa')).map((item) => `${item.tenant_id}/${item.alias}`);
      expect({ label, authorized: authorized !== undefined }).toEqual({ label, authorized: expected });
      expect({ label, looks }).toEqual({ label, looks: expected ? ['Steven/argos'] : [] });
      expect({ label, favorites }).toEqual({ label, favorites: expected ? ['Steven/argos'] : [] });
    }
    await currentPool().query("UPDATE tenants SET enabled=false WHERE id='Steven'");
    expect(await store.listAppearances('Steven')).toEqual([]);
  });

  it('frees the cap from favorites that are no longer visible and keeps them below it', async () => {
    const store = new AgentPreferencesStore(currentPool());
    const alba = await person();
    const remote = await isolatedTenant();
    await currentPool().query(`INSERT INTO acl_edges(from_tenant,to_tenant,enabled,allow_read)
      VALUES('Steven',$1,true,true)`, [remote]);
    const aliases = Array.from({ length: MAX_AGENT_FAVORITES_PER_HUMAN }, (_, index) => `far${String(index)}`);
    await currentPool().query(`INSERT INTO agents(tenant_id,alias) SELECT $1,alias FROM unnest($2::text[]) alias`,
      [remote, aliases]);
    await currentPool().query(`INSERT INTO console_agent_favorites(human_id,tenant_id,alias)
      SELECT $1,$2,alias FROM unnest($3::text[]) alias`, [alba, remote, aliases]);
    await agent('Steven', 'argos');
    await agent('Steven', 'iris');
    expect(await rejection(store.addFavorite(alba, 'Steven', 'Steven', 'argos'))).toBeInstanceOf(AgentFavoriteLimitError);
    expect(await store.listFavorites(alba, 'Steven')).toHaveLength(MAX_AGENT_FAVORITES_PER_HUMAN);

    await currentPool().query("UPDATE acl_edges SET allow_read=false WHERE from_tenant='Steven' AND to_tenant=$1", [remote]);
    expect(await store.listFavorites(alba, 'Steven')).toEqual([]);
    await store.addFavorite(alba, 'Steven', 'Steven', 'argos');
    expect((await store.listFavorites(alba, 'Steven')).map((item) => item.alias)).toEqual(['argos']);
    const stored = await currentPool().query<{ tenant_id: string; alias: string }>(
      'SELECT tenant_id,alias FROM console_agent_favorites WHERE human_id=$1', [alba],
    );
    expect(stored.rows).toEqual([{ tenant_id: 'Steven', alias: 'argos' }]);

    await currentPool().query("UPDATE acl_edges SET allow_read=true WHERE from_tenant='Steven' AND to_tenant=$1", [remote]);
    await currentPool().query(`INSERT INTO console_agent_favorites(human_id,tenant_id,alias)
      SELECT $1,$2,alias FROM unnest($3::text[]) alias`, [alba, remote, aliases.slice(1)]);
    expect(await rejection(store.addFavorite(alba, 'Steven', 'Steven', 'iris'))).toBeInstanceOf(AgentFavoriteLimitError);
    expect(await store.listFavorites(alba, 'Steven')).toHaveLength(MAX_AGENT_FAVORITES_PER_HUMAN);
  });
});

describe('agent appearance audit on PostgreSQL', () => {
  const auditRows = async () => (await currentPool().query<{
    action: string; decision: string; tenant_id: string; actor_alias: string; metadata: Record<string, unknown>;
  }>(`SELECT action,decision,tenant_id,actor_alias,metadata FROM audit_events
       WHERE action LIKE 'agent_appearance.%' ORDER BY id`)).rows;

  it('keeps revision, author and audit trail unchanged for an identical write', async () => {
    const store = new AgentPreferencesStore(currentPool());
    await agent('Steven', 'argos');
    const created = await store.setAppearance({
      tenant_id: 'Steven', alias: 'argos', glyph: '\u{1F989}', hue: 0, style: 'pulse', expected_revision: null,
    }, actor);
    const same = await store.setAppearance({
      tenant_id: 'Steven', alias: 'argos', glyph: '\u{1F989}', hue: 0, style: 'pulse', expected_revision: 1,
    }, { ...actor, display: 'Bruno' });
    expect(same).toEqual(created);
    expect(await auditRows()).toHaveLength(1);
    expect(await rejection(store.setAppearance({
      tenant_id: 'Steven', alias: 'argos', glyph: '\u{1F989}', hue: 0, style: 'pulse', expected_revision: 2,
    }, actor))).toMatchObject({ currentRevision: 1 });
  });

  it('records denials as deny rows attributed to the acting identity', async () => {
    const store = new AgentPreferencesStore(currentPool());
    await store.recordAppearanceDenial(actor, {
      target_tenant: 'Isa', target_alias: 'salva', operation: 'set', reason: 'forbidden',
    });
    await store.recordAppearanceDenial(actor, {
      target_tenant: 'Steven', target_alias: 'argos', operation: 'reset', reason: 'revision_conflict',
      expected_revision: 3, current_revision: null,
    });
    expect(await auditRows()).toEqual([
      {
        action: 'agent_appearance.denied', decision: 'deny', tenant_id: 'Steven', actor_alias: 'kant',
        metadata: {
          target_tenant: 'Isa', target_alias: 'salva', operation: 'set', reason: 'forbidden',
          human_subject: actor.human_subject,
        },
      },
      {
        action: 'agent_appearance.denied', decision: 'deny', tenant_id: 'Steven', actor_alias: 'kant',
        metadata: {
          target_tenant: 'Steven', target_alias: 'argos', operation: 'reset', reason: 'revision_conflict',
          expected_revision: 3, current_revision: null, human_subject: actor.human_subject,
        },
      },
    ]);
    expect(await rejection(store.recordAppearanceDenial(actor, {
      target_tenant: 'Steven', target_alias: 'Bad Alias', operation: 'set', reason: 'not_found',
    }))).toMatchObject({ code: 'invalid_input' });
  });

  it('stores subdivision flags and keycaps that the glyph contract accepts', async () => {
    const store = new AgentPreferencesStore(currentPool());
    await agent('Steven', 'argos');
    await agent('Steven', 'iris');
    const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
    expect((await store.setAppearance({
      tenant_id: 'Steven', alias: 'argos', glyph: england, hue: null, style: 'orb', expected_revision: null,
    }, actor)).glyph).toBe(england);
    expect((await store.setAppearance({
      tenant_id: 'Steven', alias: 'iris', glyph: '#\ufe0f\u20e3', hue: null, style: 'orb', expected_revision: null,
    }, actor)).glyph).toBe('#\ufe0f\u20e3');
  });
});

describe('migration 047 rollback on PostgreSQL', () => {
  const version = '047_agent_preferences.sql';
  const tables = ['console_agent_favorites', 'agent_appearances'] as const;
  const downSql = () => readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8');
  const relation = async (target: DatabasePool, table: string) => (await target.query<{ name: string | null }>(
    'SELECT to_regclass($1) AS name', [table],
  )).rows[0]?.name ?? null;
  const recorded = async (target: DatabasePool) => (await target.query(
    `SELECT version FROM schema_migrations WHERE version=$1
     UNION ALL SELECT version FROM schema_migration_ledger WHERE version=$1`, [version],
  )).rowCount;

  async function migrated<T>(run: (target: DatabasePool) => Promise<T>): Promise<T> {
    if (!database) throw new Error('agent preferences PostgreSQL fixture is not running');
    const fresh = await startEmptyTestDatabase(database.url);
    try {
      await applyMigrationsThrough(fresh.pool, version);
      return await run(fresh.pool);
    } finally {
      await fresh.close();
    }
  }

  it('removes the empty schema with both records and migrates up again', async () => {
    await migrated(async (target) => {
      await target.query(await downSql());
      for (const table of tables) expect(await relation(target, table)).toBeNull();
      expect(await recorded(target)).toBe(0);
      await applyMigrations(target);
      for (const table of tables) expect(await relation(target, table)).toBe(table);
      expect(await recorded(target)).toBe(2);
    });
  });

  it('refuses while preferences exist or a later migration is recorded', async () => {
    await migrated(async (target) => {
      const down = await downSql();
      await target.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','argos') ON CONFLICT DO NOTHING");
      await target.query(
        "INSERT INTO agent_appearances(tenant_id,alias,style,updated_by) VALUES('Steven','argos','orb','Alba')",
      );
      await expect(target.query(down)).rejects.toThrow('populated preference schema cannot be removed');
      for (const table of tables) expect(await relation(target, table)).toBe(table);
      await target.query('DELETE FROM agent_appearances');
      await applyMigrations(target);
      await expect(target.query(down)).rejects.toThrow('cannot downgrade schema 047 while a later migration is present');
      for (const table of tables) expect(await relation(target, table)).toBe(table);
      expect(await recorded(target)).toBe(2);
    });
  });

  it('waits behind both advisory migration locks', async () => {
    await migrated(async (target) => {
      const down = await downSql();
      for (const key of ['783003003', '783003047']) {
        const holder = await target.connect();
        try {
          await holder.query('BEGIN');
          await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
          const rollback = await target.connect();
          try {
            await rollback.query("SET lock_timeout='100ms'");
            await expect(rollback.query(down)).rejects.toMatchObject({ code: '55P03' });
          } finally {
            rollback.release();
          }
          for (const table of tables) expect(await relation(target, table)).toBe(table);
        } finally {
          await holder.query('ROLLBACK');
          holder.release();
        }
      }
    });
  });
});
