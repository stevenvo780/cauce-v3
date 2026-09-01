import { preparePostgresSuite } from '../../packages/store/test/postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigMutation } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '@cauce/store';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
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
    DELETE FROM egress_destinations;
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
    UPDATE memberships SET role='agent' WHERE tenant_id='Pablo' AND alias='midas';
  `);
});

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('atomic configuration CRUD and rollback', () => {
  it('lets a read-only non-hub principal inspect only its tenant and performs zero writes', async () => {
    await pool.query(`
      INSERT INTO role_policies(role,allow_route,allow_read,allow_control,allow_notify)
      VALUES('observer',false,true,false,false);
      UPDATE memberships SET role='observer' WHERE tenant_id='Pablo' AND alias='midas';
      INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary)
      VALUES
        ('Steven','kant','{}'::jsonb,'{}'::jsonb,'hub revision'),
        ('Pablo','midas','{}'::jsonb,'{}'::jsonb,'tenant revision');
    `);
    interface TableCounts {
      revisions: string;
      audits: string;
      tenants: string;
      memberships: string;
    }
    const beforeResult = await pool.query<TableCounts>(`
      SELECT
        (SELECT count(*)::text FROM config_revisions) AS revisions,
        (SELECT count(*)::text FROM audit_events) AS audits,
        (SELECT count(*)::text FROM tenants) AS tenants,
        (SELECT count(*)::text FROM memberships) AS memberships
    `);
    const before = beforeResult.rows[0];
    if (!before) throw new Error('Expected counts row');

    const snapshot = await repository.getConfiguration('Pablo', 'midas');
    expect((snapshot.tenants as { id: string }[]).map((row) => row.id)).toEqual(['Pablo']);
    expect((snapshot.rooms as { tenant_id: string }[]).every((row) => row.tenant_id === 'Pablo')).toBe(true);
    expect((snapshot.memberships as { tenant_id: string }[]).every(
      (row) => row.tenant_id === 'Pablo'
    )).toBe(true);
    expect((snapshot.agents as { tenant_id: string }[]).every((row) => row.tenant_id === 'Pablo')).toBe(true);
    expect((snapshot.agent_profiles as { tenant_id: string }[]).every(
      (row) => row.tenant_id === 'Pablo'
    )).toBe(true);
    expect(snapshot.revisions).toEqual([
      expect.objectContaining({ actor_tenant: 'Pablo', actor_alias: 'midas' }),
    ]);
    expect((snapshot.acl_edges as { from_tenant: string; to_tenant: string }[]).every(
      (edge) => edge.from_tenant === 'Pablo' || edge.to_tenant === 'Pablo'
    )).toBe(true);

    const mutation: ConfigMutation = {
      resource: 'room', action: 'create', tenant_id: 'Pablo', id: 'reader-must-not-write',
      value: { enabled: true },
    };
    await expect(repository.applyConfigurationChange('Pablo', 'midas', mutation, false, 2))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.rollbackConfiguration('Pablo', 'midas', 2, false, 2))
      .rejects.toMatchObject({ code: 'forbidden' });

    const afterResult = await pool.query<TableCounts>(`
      SELECT
        (SELECT count(*)::text FROM config_revisions) AS revisions,
        (SELECT count(*)::text FROM audit_events) AS audits,
        (SELECT count(*)::text FROM tenants) AS tenants,
        (SELECT count(*)::text FROM memberships) AS memberships
    `);
    const after = afterResult.rows[0];
    if (!after) throw new Error('Expected counts row');
    expect(after).toEqual(before);
    expect((await pool.query(`
      SELECT 1 FROM rooms WHERE tenant_id='Pablo' AND id='reader-must-not-write'
    `)).rowCount).toBe(0);
  });

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
    expect(preview).toMatchObject({
      applied: false, dry_run: true, revision: 0, rolled_back_revision_id: null,
    });
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
    expect(preview).toMatchObject({
      applied: false, dry_run: true, revision: 3,
      rolled_back_revision_id: granted.revision,
    });
    expect((await pool.query(`SELECT allow_route FROM acl_edges WHERE from_tenant='Steven' AND to_tenant='Acme'`)).rows[0])
      .toEqual({ allow_route: true });

    const rolledBack = await repository.rollbackConfiguration('Steven', 'kant', granted.revision, false, 3);
    expect(rolledBack).toMatchObject({
      applied: true, revision: 4, rolled_back_revision_id: granted.revision,
    });
    expect((await pool.query(`SELECT allow_route FROM acl_edges WHERE from_tenant='Steven' AND to_tenant='Acme'`)).rows[0])
      .toEqual({ allow_route: false });
    expect((await pool.query(`SELECT rolled_back_revision_id::int AS source FROM config_revisions WHERE id=4`)).rows[0])
      .toEqual({ source: 3 });
  });

  it('versions the proactive egress allowlist and restores every limit on rollback', async () => {
    const destination: ConfigMutation = {
      resource: 'egress_destination', action: 'create',
      tenant_id: 'Steven', alias: 'argos', handle: 'steven.dm',
      value: {
        conversation_id: '-1001234567890', conversation_kind: 'group',
        allow_kinds: ['task_complete', 'alert'], require_prior_contact: true,
        max_per_hour: 2, max_per_day: 8, max_per_root: 1
      }
    };
    const preview = await repository.applyConfigurationChange('Steven', 'kant', destination, true, 0);
    expect(preview).toMatchObject({ applied: false, dry_run: true });
    expect((await pool.query(`SELECT 1 FROM egress_destinations`)).rowCount).toBe(0);

    const created = await repository.applyConfigurationChange('Steven', 'kant', destination, false, 0);
    expect(created.applied).toBe(true);
    expect(created.inverse_mutation).toMatchObject({
      resource: 'egress_destination', action: 'delete', tenant_id: 'Steven', alias: 'argos', handle: 'steven.dm'
    });

    const relaxed = await repository.applyConfigurationChange('Steven', 'kant', {
      resource: 'egress_destination', action: 'update',
      tenant_id: 'Steven', alias: 'argos', handle: 'steven.dm',
      value: { max_per_hour: 60 }
    }, false, created.revision);
    expect(relaxed.inverse_mutation).toMatchObject({ value: { max_per_hour: 2, max_per_day: 8 } });
    expect((await pool.query<{ max_per_hour: number }>(
      `SELECT max_per_hour FROM egress_destinations`
    )).rows[0]?.max_per_hour).toBe(60);

    await repository.rollbackConfiguration('Steven', 'kant', relaxed.revision, false, relaxed.revision);
    const restored = await pool.query<{ max_per_hour: number; allow_kinds: string[] }>(
      `SELECT max_per_hour,allow_kinds FROM egress_destinations`
    );
    expect(restored.rows[0]?.max_per_hour).toBe(2);
    expect(restored.rows[0]?.allow_kinds).toEqual(['task_complete', 'alert']);

    const snapshot = await repository.getConfiguration('Steven', 'kant');
    expect(snapshot.egress_destinations).toEqual(expect.arrayContaining([
      expect.objectContaining({ handle: 'steven.dm', alias: 'argos' })
    ]));

    // Rolling back the create must remove the destination entirely.
    await repository.rollbackConfiguration('Steven', 'kant', created.revision, false);
    expect((await pool.query(`SELECT 1 FROM egress_destinations`)).rowCount).toBe(0);
  });

  it('keeps cold contact on a group a hub-only decision', async () => {
    await pool.query(`UPDATE memberships SET role='operator' WHERE tenant_id='Pablo' AND alias='midas'`);
    const coldGroup: ConfigMutation = {
      resource: 'egress_destination', action: 'create',
      tenant_id: 'Pablo', alias: 'midas', handle: 'ops.group',
      value: {
        conversation_id: '-1005550000001', conversation_kind: 'group',
        allow_kinds: ['digest'], require_prior_contact: false
      }
    };
    await expect(repository.applyConfigurationChange('Pablo', 'midas', coldGroup, false, 0))
      .rejects.toMatchObject({ code: 'forbidden' });

    // The same tenant operator may still create a normal, contact-gated destination.
    const allowed = await repository.applyConfigurationChange('Pablo', 'midas', {
      ...coldGroup, value: { ...coldGroup.value, require_prior_contact: true }
    }, false, 0);
    expect(allowed.applied).toBe(true);

    // And never one in another tenant.
    await expect(repository.applyConfigurationChange('Pablo', 'midas', {
      resource: 'egress_destination', action: 'create',
      tenant_id: 'Steven', alias: 'argos', handle: 'x',
      value: { conversation_id: '-1005550000002', conversation_kind: 'group', allow_kinds: ['digest'] }
    }, false, allowed.revision)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('carries allow_notify through the role policy lifecycle', async () => {
    const created = await repository.applyConfigurationChange('Steven', 'kant', {
      resource: 'role_policy', action: 'create', role: 'observer',
      value: { allow_read: true, allow_notify: true }
    }, false, 0);
    expect((await pool.query<{ allow_notify: boolean }>(
      `SELECT allow_notify FROM role_policies WHERE role='observer'`
    )).rows[0]?.allow_notify).toBe(true);

    const revoked = await repository.applyConfigurationChange('Steven', 'kant', {
      resource: 'role_policy', action: 'update', role: 'observer', value: { allow_notify: false }
    }, false, created.revision);
    expect(revoked.inverse_mutation).toMatchObject({ value: { allow_notify: true } });
    await repository.rollbackConfiguration('Steven', 'kant', revoked.revision, false);
    expect((await pool.query<{ allow_notify: boolean }>(
      `SELECT allow_notify FROM role_policies WHERE role='observer'`
    )).rows[0]?.allow_notify).toBe(true);
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

  /**
   * The revision list MUST be sorted numerically in descending order, ensuring the limit
   * captures the most recent revisions with no gaps.
   */
  it('lista las revisiones por número y no por texto, para que se puedan deshacer las recientes', async () => {
    await pool.query(`
      INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary)
      SELECT 'Steven','kant','{}'::jsonb,'{}'::jsonb,'relleno ' || g FROM generate_series(1,121) g
    `);
    const snapshot = await repository.getConfiguration('Steven', 'kant');
    const revisions = snapshot.revisions as { id: string }[];
    const ids = revisions.map((revision) => Number(revision.id));

    expect(ids).toHaveLength(100);
    // Descending NUMERIC.
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(ids[0]).toBe(121);
    // The 100 most recent are exactly 22..121: no gap in the middle.
    expect(ids[ids.length - 1]).toBe(22);
    expect(new Set(ids).size).toBe(100);
  });
});
