import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigMutation } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '@cauce/store';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`
    TRUNCATE config_revisions RESTART IDENTITY;
    DELETE FROM memberships WHERE tenant_id='Acme';
    DELETE FROM rooms WHERE tenant_id='Acme';
    DELETE FROM acl_edges WHERE from_tenant='Acme' OR to_tenant='Acme'
      OR (from_tenant='Isa' AND to_tenant='Jhon');
    DELETE FROM tenants WHERE id='Acme';
    DELETE FROM harness_definitions WHERE id='custom';
    DELETE FROM role_policies WHERE role='observer';
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
  `);
});

afterAll(async () => {
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});

describe('atomic configuration CRUD and rollback', () => {
  it('re-runs migration 003 without granting a new default-deny edge', async () => {
    await pool.query(`INSERT INTO tenants(id,display_name) VALUES('Acme','Acme')`);
    await pool.query(`INSERT INTO acl_edges(
      from_tenant,to_tenant,enabled,allow_route,allow_read,allow_control
    ) VALUES('Steven','Acme',true,false,false,false)`);
    const migration = await readFile(new URL('../../packages/store/migrations/003_adversarial_hardening.sql', import.meta.url), 'utf8');
    await pool.query(migration);
    expect((await pool.query(
      `SELECT allow_route,allow_read,allow_control FROM acl_edges WHERE from_tenant='Steven' AND to_tenant='Acme'`
    )).rows[0]).toEqual({ allow_route: false, allow_read: false, allow_control: false });
  });

  it('previews without side effects and CRUDs every configuration family', async () => {
    const preview = await repository.applyConfigurationChange('Steven', 'kant', {
      resource: 'tenant', action: 'create', id: 'Acme',
      value: { display_name: 'Acme', is_hub: false, enabled: true }
    }, true, 0);
    expect(preview).toMatchObject({ applied: false, dry_run: true, revision: 0 });
    expect((await pool.query(`SELECT 1 FROM tenants WHERE id='Acme'`)).rowCount).toBe(0);

    let revision = 0;
    const mutations: ConfigMutation[] = [
      { resource: 'tenant', action: 'create', id: 'Acme', value: { display_name: 'Acme', is_hub: false, enabled: true } },
      { resource: 'room', action: 'create', tenant_id: 'Acme', id: 'grp.acme', value: { enabled: true } },
      { resource: 'membership', action: 'create', tenant_id: 'Acme', room_id: 'grp.acme', alias: 'acmebot', value: { role: 'agent', enabled: true } },
      { resource: 'acl_edge', action: 'create', from_tenant: 'Steven', to_tenant: 'Acme', value: { enabled: true } },
      { resource: 'harness', action: 'create', id: 'custom', value: { display_name: 'Custom', command: null, capabilities: ['messages.receive'], enabled: true } },
      { resource: 'role_policy', action: 'create', role: 'observer', value: { allow_read: true } }
    ];
    for (const mutation of mutations) {
      const changed = await repository.applyConfigurationChange('Steven', 'kant', mutation, false, revision);
      revision = changed.revision;
      expect(changed.applied).toBe(true);
    }

    const snapshot = await repository.getConfiguration('Steven', 'kant');
    expect(snapshot.revision).toBe(revision);
    expect(typeof snapshot.observed_at).toBe('string');
    expect(snapshot.tenants).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'Acme' })]));
    expect(snapshot.harness_definitions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'custom' })]));
    expect(snapshot.role_policies).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'observer' })]));
    expect((await pool.query(`SELECT allow_route,allow_read,allow_control FROM acl_edges WHERE from_tenant='Steven' AND to_tenant='Acme'`)).rows[0])
      .toEqual({ allow_route: false, allow_read: false, allow_control: false });
    expect((await pool.query(`SELECT count(*)::int AS count FROM audit_events WHERE action='config.change'`)).rows[0])
      .toEqual({ count: 6 });
  });

  it('rolls an ACL permission back as a new revision and rejects stale writers', async () => {
    await repository.applyConfigurationChange('Steven', 'kant', {
      resource: 'tenant', action: 'create', id: 'Acme', value: { enabled: true }
    }, false, 0);
    await repository.applyConfigurationChange('Steven', 'kant', {
      resource: 'acl_edge', action: 'create', from_tenant: 'Steven', to_tenant: 'Acme',
      value: { enabled: true, allow_route: false, allow_read: false, allow_control: false }
    }, false, 1);
    const granted = await repository.applyConfigurationChange('Steven', 'kant', {
      resource: 'acl_edge', action: 'update', from_tenant: 'Steven', to_tenant: 'Acme',
      value: { allow_route: true }
    }, false, 2);
    expect(granted.revision).toBe(3);

    await expect(repository.applyConfigurationChange('Steven', 'kant', {
      resource: 'acl_edge', action: 'update', from_tenant: 'Steven', to_tenant: 'Acme', value: { allow_read: true }
    }, false, 2)).rejects.toMatchObject({ code: 'conflict' });

    const preview = await repository.rollbackConfiguration('Steven', 'kant', granted.revision, true, 3);
    expect(preview).toMatchObject({ applied: false, dry_run: true, revision: 3 });
    expect((await pool.query(`SELECT allow_route FROM acl_edges WHERE from_tenant='Steven' AND to_tenant='Acme'`)).rows[0])
      .toEqual({ allow_route: true });

    const rolledBack = await repository.rollbackConfiguration('Steven', 'kant', granted.revision, false, 3);
    expect(rolledBack).toMatchObject({ applied: true, revision: 4 });
    expect((await pool.query(`SELECT allow_route FROM acl_edges WHERE from_tenant='Steven' AND to_tenant='Acme'`)).rows[0])
      .toEqual({ allow_route: false });
    expect((await pool.query(`SELECT rolled_back_revision_id::int AS source FROM config_revisions WHERE id=4`)).rows[0])
      .toEqual({ source: 3 });
  });

  it('prevents membership deletion while a delivery is active', async () => {
    const published = await repository.publish({
      version: '3.0', request_id: randomUUID(), trace_id: `trace-${randomUUID()}`,
      tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant',
      recipients: [{ tenant_id: 'Isa', alias: 'salva' }], body: { text: 'active' },
      idempotency_key: randomUUID(), lane: 'interactive', priority: 0
    });
    expect(published.delivery_ids).toHaveLength(1);
    await expect(repository.applyConfigurationChange('Steven', 'kant', {
      resource: 'membership', action: 'delete', tenant_id: 'Isa', room_id: 'grp.isa', alias: 'salva'
    }, false, 0)).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query(`SELECT 1 FROM memberships WHERE tenant_id='Isa' AND alias='salva'`)).rowCount).toBe(1);
  });
});
