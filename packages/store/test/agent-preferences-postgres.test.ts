import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentAppearanceRevisionError, AgentFavoriteLimitError, AgentPreferencesStore, CauceRepository,
  type AgentAppearanceActor, type DatabasePool,
} from '../src/index.js';
import { MAX_AGENT_FAVORITES_PER_HUMAN } from '@cauce/protocol';
import { preparePostgresSuite } from './postgres-suite.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase,
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
});

describe('agent appearance audit on PostgreSQL', () => {
  const auditRows = async () => (await currentPool().query<{
    action: string; decision: string; tenant_id: string; actor_alias: string; metadata: Record<string, unknown>;
  }>(`SELECT action,decision,tenant_id,actor_alias,metadata FROM audit_events
       WHERE action LIKE 'agent_appearance.%' ORDER BY id`)).rows;

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
});
