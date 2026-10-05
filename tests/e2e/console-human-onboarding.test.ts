import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maintainConsoleUser } from '../../services/gateway/src/console-user-maintenance.js';
import { startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

const execFileAsync = promisify(execFile);

describe('console human membership onboarding', () => {
  let database: TestDatabase | undefined;

  beforeAll(async () => {
    if (process.env.CAUCE_TEST_DATABASE_URL !== undefined) {
      throw new Error('This suite requires its own disposable Testcontainers database');
    }
    database = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    if (database === undefined) return;
    const containerId = database.container.getId();
    let inventory: Record<string, unknown> = { cid: containerId };
    try {
      const { stdout } = await execFileAsync('docker', [
        'inspect',
        '--format',
        '{"cid":{{json .Id}},"mounts":{{json .Mounts}},"vols":{{json .Config.Volumes}},"bindings":{"binds":{{json .HostConfig.Binds}},"ports":{{json .HostConfig.PortBindings}}}}',
        containerId,
      ], { maxBuffer: 1024 * 1024, timeout: 15_000 });
      inventory = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      // Best-effort inventory discovery before container disposal
    }

    const errors: unknown[] = [];
    try {
      await database.pool.end();
    } catch (error) {
      errors.push(error);
    }
    try {
      await database.container.stop();
    } catch (error) {
      errors.push(error);
    }

    console.info('own-human-onboarding-cleanup', JSON.stringify(inventory));

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'owned database cleanup failed');
  }, 60_000);

  function pool() {
    if (database === undefined) throw new Error('Test database did not start');
    return database.pool;
  }

  async function seedAgent(alias: string): Promise<void> {
    const id = randomUUID();
    await pool().query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,
      container_name,runtime_user,home_directory,state_directory)
      VALUES('Steven',$1,'openclaw',$1,true,$2,'stev','/home/stev',$3)`,
    [alias, `onboarding-${id}`, `/home/stev/.cauce-onboarding/${id}`]);
  }

  function options(email: string, alias: string, overrides: Partial<{
    role: 'operator' | 'reader'; tenant: string; updateOnly: boolean; activate: boolean;
  }> = {}) {
    return {
      email, name: 'Onboarding fixture', role: 'operator' as const, tenant: 'Steven', alias,
      updateOnly: false, activate: false, ...overrides,
    };
  }

  const passwordHash = (): string => `$scrypt$fixture-${randomBytes(32).toString('hex')}`;

  it('creates one membership from the new account role and binding in the same operation', async () => {
    const suffix = randomUUID();
    const alias = `onboard-${suffix.replaceAll('-', '').slice(0, 12)}`;
    const email = `new-${suffix}@fixture.invalid`;
    await seedAgent(alias);

    const account = await maintainConsoleUser(pool(), options(email, alias), passwordHash());
    const result = await pool().query<{ human_id: string; tenant_id: string; actor_alias: string;
      role: string; permissions: string[]; enabled: boolean; revoked_at: Date | null }>(
      `SELECT human_id,tenant_id,actor_alias,role,permissions,enabled,revoked_at
       FROM human_tenant_memberships WHERE human_id=$1`, [account.id]);

    expect(result.rows).toEqual([{
      human_id: account.id, tenant_id: 'Steven', actor_alias: alias, role: 'operator',
      permissions: ['route', 'read', 'control', 'notify'], enabled: true, revoked_at: null,
    }]);

    const readerAlias = `reader-${suffix.replaceAll('-', '').slice(0, 12)}`;
    await seedAgent(readerAlias);
    const reader = await maintainConsoleUser(pool(), options(`reader-${suffix}@fixture.invalid`, readerAlias, {
      role: 'reader',
    }), passwordHash());
    const readerGrant = await pool().query<{ role: string; permissions: string[] }>(
      'SELECT role,permissions FROM human_tenant_memberships WHERE human_id=$1', [reader.id]);
    expect(readerGrant.rows).toEqual([{ role: 'reader', permissions: ['read'] }]);
  });

  it('rolls back a new account when its tenant and alias cannot satisfy the membership foreign key', async () => {
    const email = `rollback-${randomUUID()}@fixture.invalid`;
    await expect(maintainConsoleUser(pool(), options(email, `missing-${randomUUID()}`), passwordHash()))
      .rejects.toThrow();

    const result = await pool().query<{ accounts: string; memberships: string }>(
      `SELECT (SELECT count(*)::text FROM console_users WHERE email_normalized=$1) AS accounts,
              (SELECT count(*)::text FROM human_tenant_memberships m
               JOIN console_users u ON u.id=m.human_id WHERE u.email_normalized=$1) AS memberships`,
      [email.toLowerCase()]);
    expect(result.rows[0]).toEqual({ accounts: '0', memberships: '0' });
  });

  it('serializes concurrent first-time provisioning and never rewrites an existing revoked grant', async () => {
    const suffix = randomUUID();
    const alias = `concurrent-${suffix.replaceAll('-', '').slice(0, 10)}`;
    const email = `race-${suffix}@fixture.invalid`;
    await seedAgent(alias);
    const [first, second] = await Promise.all([
      maintainConsoleUser(pool(), options(email, alias), passwordHash()),
      maintainConsoleUser(pool(), options(email, alias, { role: 'reader' }), passwordHash()),
    ]);
    expect(first.id).toBe(second.id);
    const fresh = await pool().query<{ accounts: string; memberships: string }>(
      `SELECT (SELECT count(*)::text FROM console_users WHERE email_normalized=$1) AS accounts,
              (SELECT count(*)::text FROM human_tenant_memberships WHERE human_id=$2) AS memberships`,
      [email.toLowerCase(), first.id]);
    expect(fresh.rows[0]).toEqual({ accounts: '1', memberships: '1' });

    const existingEmail = `revoked-${suffix}@fixture.invalid`;
    const existing = await pool().query<{ id: string }>(
      `INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias,active)
       VALUES($1,$2,$3,'Existing human','reader','Steven',$4,false) RETURNING id`,
      [existingEmail, existingEmail.toLowerCase(), passwordHash(), alias]);
    const existingId = existing.rows[0]?.id;
    if (existingId === undefined) throw new Error('Existing console account was not inserted');
    await pool().query(`INSERT INTO human_tenant_memberships
      (human_id,tenant_id,actor_alias,role,permissions,enabled,revoked_at)
      VALUES($1,'Steven',$2,'reader',ARRAY['read']::text[],false,now())`, [existingId, alias]);

    await maintainConsoleUser(pool(), options(existingEmail, alias, {
      role: 'operator', updateOnly: true, activate: true,
    }), passwordHash());
    const preserved = await pool().query<{ role: string; permissions: string[];
      enabled: boolean; revoked_at: Date | null }>(
      `SELECT role,permissions,enabled,revoked_at FROM human_tenant_memberships
       WHERE human_id=$1 AND tenant_id='Steven'`, [existingId]);
    expect(preserved.rows).toHaveLength(1);
    expect(preserved.rows[0]).toMatchObject({ role: 'reader', permissions: ['read'], enabled: false });
    expect(preserved.rows[0]?.revoked_at).toBeInstanceOf(Date);

    const missingEmail = `missing-membership-${suffix}@fixture.invalid`;
    await pool().query(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      VALUES($1,$2,$3,'Existing without membership','operator','Steven',$4)`,
    [missingEmail, missingEmail.toLowerCase(), passwordHash(), alias]);
    await maintainConsoleUser(pool(), options(missingEmail, alias), passwordHash());
    const missingGrant = await pool().query(
      `SELECT 1 FROM human_tenant_memberships m JOIN console_users u ON u.id=m.human_id
       WHERE u.email_normalized=$1`, [missingEmail.toLowerCase()]);
    expect(missingGrant.rows).toEqual([]);
  });
});
