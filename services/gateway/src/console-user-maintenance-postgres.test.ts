import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { preparePostgresSuite } from '../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { consoleRoleAuthority } from './console-user-authority.js';
import { maintainConsoleUser } from './console-user-maintenance.js';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const tsx = join(root, 'node_modules/.bin/tsx');
const cli = join(root, 'services/gateway/src/console-user-cli.ts');
const filler = 'x'.repeat(48);
const HASH = `$scrypt$${filler}`;
const PASSWORD = 'synthetic-private-passphrase';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

function pool(): DatabasePool {
  if (!current) throw new Error('test database absent');
  return current.adminPool;
}

async function place(tenant: string, alias: string): Promise<void> {
  await pool().query('INSERT INTO agents(tenant_id,alias,harness_id) VALUES($1,$2,\'codex\')', [tenant, alias]);
}

async function membership(humanId: string): Promise<{ tenant_id: string; actor_alias: string; permissions: string[];
  enabled: boolean; open: boolean; company_id: string }[]> {
  return (await pool().query<{ tenant_id: string; actor_alias: string; permissions: string[];
    enabled: boolean; open: boolean; company_id: string }>(
    `SELECT tenant_id,actor_alias,permissions,enabled,revoked_at IS NULL AS open,company_id
       FROM human_tenant_memberships WHERE human_id=$1 ORDER BY tenant_id`, [humanId])).rows;
}

describe('alta de consola sobre las migraciones vigentes', () => {
  it('da de alta por el CLI, conserva el rol en la cuenta y no escala los permisos al actualizar', async () => {
    const stored = pool();
    expect((await stored.query(`SELECT 1 FROM schema_migrations WHERE version='081_membresia_rol_derivado.sql'`)).rowCount).toBe(1);
    expect((await stored.query(`SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='human_tenant_memberships' AND column_name='role'`)).rowCount).toBe(0);
    const alias = `maint-${randomUUID().slice(0, 8)}`;
    const email = `reader-${alias}@example.test`;
    await place('Steven', alias);
    if (!current) throw new Error('test database absent');
    const provision = await execute(tsx, [cli, '--email', email, '--name', 'Lector de mantenimiento',
      '--role', 'reader', '--tenant', 'Steven', '--alias', alias], {
      cwd: root, timeout: 30_000,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test',
        DATABASE_URL: current.adminUrl, CAUCE_CONSOLE_USER_PASSWORD: PASSWORD },
    });
    expect(provision.stdout).toContain('cuenta guardada');
    expect(provision.stdout).toContain('rol     reader');
    expect(provision.stdout).not.toContain(PASSWORD);
    const account = (await stored.query<{ id: string; role: string; tenant_id: string; alias: string;
      active: boolean; company_id: string }>(
      `SELECT id,role,tenant_id,alias,active,company_id FROM console_users WHERE email_normalized=$1`, [email])).rows[0];
    expect(account).toMatchObject({ role: 'reader', tenant_id: 'Steven', alias, active: true, company_id: 'humanizar' });
    if (!account) throw new Error('cuenta ausente');
    expect(await membership(account.id)).toEqual([{
      tenant_id: 'Steven', actor_alias: alias, permissions: ['read'], enabled: true, open: true, company_id: 'humanizar',
    }]);

    const updated = await maintainConsoleUser(stored, {
      email, name: 'Lector actualizado', role: undefined, tenant: 'Steven', alias, updateOnly: true, activate: false,
    }, HASH);
    expect(updated).toMatchObject({ id: account.id, role: 'reader', tenant_id: 'Steven', alias, active: true });
    expect(await membership(account.id)).toEqual([{
      tenant_id: 'Steven', actor_alias: alias, permissions: ['read'], enabled: true, open: true, company_id: 'humanizar',
    }]);
    expect((await stored.query<{ display_name: string }>('SELECT display_name FROM console_users WHERE id=$1', [account.id])).rows[0])
      .toEqual({ display_name: 'Lector actualizado' });
  });

  it('escribe el techo del operador y rechaza la otra empresa sin crear membresía', async () => {
    const stored = pool();
    const alias = `maint-${randomUUID().slice(0, 8)}`;
    const email = `Operator-${alias}@Example.test`;
    await place('Steven', alias);
    const foreign = (await stored.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM cauce_register_company($1,'Praxis owner',$2,'praxis','Praxis')`,
      [`praxis-${alias}@example.test`, '$scrypt$n=32768,r=8,p=1$c2FsdA==$aGFzaA=='])).rows[0];
    if (!foreign) throw new Error('empresa ajena ausente');
    const created = await maintainConsoleUser(stored, {
      email, name: 'Operador de mantenimiento', role: 'operator', tenant: 'Steven', alias, updateOnly: false, activate: false,
    }, HASH);
    expect(created).toMatchObject({ role: 'operator', tenant_id: 'Steven', alias, active: true });
    expect(await membership(created.id)).toEqual([{
      tenant_id: 'Steven', actor_alias: alias, permissions: [...consoleRoleAuthority('operator').permissions],
      enabled: true, open: true, company_id: 'humanizar',
    }]);
    const before = await membership(created.id);

    await expect(maintainConsoleUser(stored, {
      email, name: undefined, role: undefined, tenant: foreign.tenant_id, alias, updateOnly: true, activate: false,
    }, HASH)).rejects.toThrow('no cambia de empresa');
    await expect(maintainConsoleUser(stored, {
      email, name: undefined, role: 'operator', tenant: foreign.tenant_id, alias, updateOnly: false, activate: false,
    }, HASH)).rejects.toThrow('no cambia de empresa');
    expect((await stored.query<{ tenant_id: string; role: string; company_id: string }>(
      'SELECT tenant_id,role,company_id FROM console_users WHERE id=$1', [created.id])).rows[0])
      .toEqual({ tenant_id: 'Steven', role: 'operator', company_id: 'humanizar' });
    expect(await membership(created.id)).toEqual(before);
    expect((await stored.query('SELECT 1 FROM human_tenant_memberships WHERE human_id=$1 AND tenant_id=$2',
      [created.id, foreign.tenant_id])).rowCount).toBe(0);
  });
});
