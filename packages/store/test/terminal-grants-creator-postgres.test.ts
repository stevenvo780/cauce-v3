import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigurationRepository,
  grantCreatorTerminalAccess, listTerminalGrants, revokeTerminalGrant, withTransaction,
  type CompanyAuthority, type DatabasePool,
} from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let actors: CompanyIsolationFixture;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);

beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  actors = await seedCompanyIsolation(admin);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

const manager: CompanyAuthority = {
  humanId: '', homeTenant: 'Steven', alias: 'kant', homeCompany: 'humanizar',
  actingCompany: 'humanizar', role: 'platform_admin', scope: 'platform', platformOverride: false,
};

describe('creator terminal grant on PostgreSQL', () => {
  it('grants the creator all modes, audits reason creator once and stays revocable', async () => {
    const input = {
      tenant_id: 'Steven', alias: 'zeus', creator_human_id: actors.steven,
      creator_home_tenant: 'Steven', creator_alias: 'kant', can_grant: true,
    };
    const created = await withTransaction(pool, client => grantCreatorTerminalAccess(client, input));
    expect(created).toMatchObject({
      tenant_id: 'Steven', alias: 'zeus', grantee_human_id: actors.steven,
      granted_by_human_id: actors.steven, modes: ['shell', 'harness', 'harness_rw'], expires_at: null,
    });
    const audits = await admin.query<{ action: string; reason: string }>(
      `SELECT action,metadata->>'reason' AS reason FROM audit_events
        WHERE action='terminal.grant.create' AND metadata->>'target_alias'='zeus'`);
    expect(audits.rows).toEqual([{ action: 'terminal.grant.create', reason: 'creator' }]);
    const again = await withTransaction(pool, client => grantCreatorTerminalAccess(client, input));
    expect(again?.id).toBe(created?.id);
    const auditCount = await admin.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM audit_events
        WHERE action='terminal.grant.create' AND metadata->>'target_alias'='zeus'`);
    expect(auditCount.rows).toEqual([{ count: 1 }]);
    const authority = { ...manager, humanId: actors.steven };
    const listed = await withTransaction(pool, client => listTerminalGrants(client, authority));
    expect(listed.items.map(item => item.id)).toEqual([created?.id]);
    await withTransaction(pool, client => revokeTerminalGrant(client, authority, created?.id ?? '', created?.version ?? 1));
    const after = await withTransaction(pool, client => listTerminalGrants(client, authority));
    expect(after.items).toEqual([]);
  });

  it('leaves creation untouched when the creator cannot grant or is not a console person', async () => {
    const base = {
      tenant_id: 'Steven', alias: 'zeus', creator_human_id: actors.steven,
      creator_home_tenant: 'Steven', creator_alias: 'kant', can_grant: true,
    };
    await expect(withTransaction(pool, client => grantCreatorTerminalAccess(client, { ...base, can_grant: false })))
      .resolves.toBeNull();
    await expect(withTransaction(pool, client => grantCreatorTerminalAccess(client, { ...base, creator_human_id: null })))
      .resolves.toBeNull();
    const grants = await admin.query<{ count: number }>('SELECT count(*)::integer AS count FROM terminal_grants');
    expect(grants.rows).toEqual([{ count: 0 }]);
  });

  it('keeps another company creation committed without granting its terminal to the platform creator', async () => {
    const created = await withTransaction(pool, async client => {
      await client.query("UPDATE agents SET display_name='Imported company agent' WHERE tenant_id='PraxisTeam' AND alias='team_agent'");
      return grantCreatorTerminalAccess(client, {
        tenant_id: 'PraxisTeam', alias: 'team_agent', creator_human_id: actors.steven,
        creator_home_tenant: 'Steven', creator_alias: 'kant', can_grant: true,
      });
    });
    expect(created).toBeNull();
    expect((await admin.query<{ display_name: string }>(
      "SELECT display_name FROM agents WHERE tenant_id='PraxisTeam' AND alias='team_agent'")).rows)
      .toEqual([{ display_name: 'Imported company agent' }]);
    expect((await admin.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM terminal_grants WHERE tenant_id='PraxisTeam' AND alias='team_agent'")).rows)
      .toEqual([{ count: 0 }]);
    expect((await admin.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM audit_events WHERE action='terminal.grant.create'")).rows)
      .toEqual([{ count: 0 }]);
  });

  it('purges creator terminal grant and deletes agent when deleted via configuration', async () => {
    const repository = new ConfigurationRepository(pool);
    const steven = { ...manager, humanId: actors.steven };
    const authority = () => Promise.resolve(steven);
    const alias = 'purged_draft';
    const created = await repository.apply('Steven', 'kant', {
      resource: 'agent', action: 'create', tenant_id: 'Steven', alias,
      value: { display_name: 'Purged Draft', harness_id: 'codex' },
    }, false, undefined, authority);
    expect(created.applied).toBe(true);
    expect((await admin.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM terminal_grants WHERE tenant_id='Steven' AND alias=$1", [alias])).rows)
      .toEqual([{ count: 1 }]);
    const deleted = await repository.apply('Steven', 'kant', {
      resource: 'agent', action: 'delete', tenant_id: 'Steven', alias,
    }, false, created.revision, authority);
    expect(deleted.applied).toBe(true);
    expect((await admin.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM terminal_grants WHERE tenant_id='Steven' AND alias=$1", [alias])).rows)
      .toEqual([{ count: 0 }]);
    expect((await admin.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM agents WHERE tenant_id='Steven' AND alias=$1", [alias])).rows)
      .toEqual([{ count: 0 }]);
  });
});
