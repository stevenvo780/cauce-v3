import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiGet, asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, openRegistration,
  type V4Page, type V4Person } from './v4-console-real-browser.helpers.js';

vi.stubEnv('CAUCE_PLAZOS_FACTOR', '3');
const { newTrustedPage, startConsoleFunctionalFixture } = await import('./console-functional-browser.fixtures.js');
const run = randomUUID().replaceAll('-', '').slice(0, 8);
const directory = resolve('.delegados/v4/recibos/e2e-a7-sigue-1025/empty', run);
const person: V4Person = { email: `zz-canary-a7-empty-${run}@example.invalid`, name: 'Matriz vacía',
  password: `Synthetic-empty-${run}-password`, company: { slug: `zz-canary-a7-empty-${run}`, name: 'Matriz vacía' } };
const errors = new BrowserErrorLog(HERMETIC_INSTANCE_RULES);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let page: V4Page;
let actor: { id: string; tenant_id: string; alias: string };
let observing = false;
const writes: { method: string; path: string }[] = [];
const active = () => { if (!fixture) throw new Error('empty matrix fixture missing'); return fixture; };

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') throw new Error('owned PostgreSQL and mocks=false required');
  await mkdir(directory, { recursive: true });
  fixture = await startConsoleFunctionalFixture();
  page = asV4Page(await newTrustedPage(fixture, { width: 1440, height: 900 }));
  errors.watch(page, 'quota-empty-matrix');
  page.on('request', (value: unknown) => {
    const request = value as { method(): string; url(): string };
    if (observing && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) {
      writes.push({ method: request.method(), path: new URL(request.url()).pathname });
    }
  });
  const form = await openRegistration(page, fixture.baseUrl);
  await fillRegistration(form, person);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  const row = (await fixture.database.pool.query<typeof actor>('SELECT id::text,tenant_id,alias FROM console_users WHERE email=$1 AND company_id=$2',
    [person.email, person.company.slug])).rows[0];
  if (!row) throw new Error('owned canary actor missing');
  actor = row;
  await page.goto(`${fixture.baseUrl}/accounts`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Cuentas', exact: true }).waitFor({ timeout: 20_000 });
  await page.getByRole('tab', { name: 'Asignaciones', exact: true }).click();
}, 600_000);

afterEach(async context => {
  if (context.task.result?.state !== 'fail') return;
  await page.screenshot({ path: resolve(directory, 'failed.png'), fullPage: false });
  await writeFile(resolve(directory, 'failed-body.txt'), await page.locator('body').innerText());
});
afterAll(async () => {
  try { await fixture?.close(); } finally { vi.unstubAllEnvs(); }
});

async function facts() {
  const pool = active().database.adminPool;
  return {
    principals: (await pool.query(`SELECT company_id,kind,tenant_id,principal_alias,delivery_source_only FROM company_system_principals
      WHERE company_id=$1 ORDER BY kind,tenant_id,principal_alias`, [person.company.slug])).rows,
    authority: (await pool.query('SELECT company_id,human_id,role,source FROM company_admins WHERE company_id=$1 ORDER BY human_id', [person.company.slug])).rows,
    home: (await pool.query(`SELECT human_id,tenant_id,actor_alias,permissions,enabled,revoked_at FROM human_tenant_memberships
      WHERE human_id=$1 ORDER BY tenant_id`, [actor.id])).rows,
    memberships: (await pool.query('SELECT tenant_id,room_id,alias,role,enabled FROM memberships WHERE tenant_id=$1 AND alias=$2 ORDER BY room_id', [actor.tenant_id, actor.alias])).rows,
    agent: (await pool.query('SELECT tenant_id,alias,enabled,retired_at,purged_at FROM agents WHERE tenant_id=$1 AND alias=$2', [actor.tenant_id, actor.alias])).rows,
  };
}

async function snapshot() {
  const session = await apiGet(page, '/v3/auth/session');
  const access = await apiGet(page, '/v3/console/access');
  const config = await apiGet(page, '/v3/console/config');
  expect([session.status, access.status, config.status]).toEqual([200, 200, 200]);
  const agents = config.body.agents as { tenant_id: string; alias: string; enabled: boolean }[];
  return { authenticated: session.body.authenticated, authority: session.body.authority,
    access: { roles: access.body.roles, permissions: access.body.permissions },
    capabilities: config.body.capabilities,
    agents: agents.map(({ tenant_id, alias, enabled }) => ({ tenant_id, alias, enabled })),
  };
}

describe('matriz sin agentes ante metadatos degradados solo en PostgreSQL desechable', () => {
  it('muestra los dos avisos vacíos sin escrituras, conserva la autoridad y restaura exactamente los principales', async () => {
    const before = await facts();
    const initial = await snapshot();
    expect(initial.authenticated).toBe(true);
    expect(initial.authority).toMatchObject({ role: 'company_owner', acting_company: person.company.slug });
    expect(initial.agents).toMatchObject([{ tenant_id: actor.tenant_id, alias: actor.alias }]);
    expect(initial.agents).toHaveLength(1);
    expect((await active().database.pool.query(`SELECT 1 FROM company_system_principals
      WHERE company_id=$1 AND kind='director' AND tenant_id=$2 AND principal_alias=$3`, [person.company.slug, actor.tenant_id, actor.alias])).rowCount).toBe(0);
    let inserted = false;
    try {
      observing = true;
      // A second source-only principal deliberately corrupts metadata; it never grants authority.
      const result = await active().database.adminPool.query(`INSERT INTO company_system_principals(company_id,kind,tenant_id,principal_alias,delivery_source_only)
        VALUES($1,'director',$2,$3,true)`, [person.company.slug, actor.tenant_id, actor.alias]);
      inserted = result.rowCount === 1;
      expect(inserted).toBe(true);
      const current = await snapshot();
      expect(current).toEqual({ ...initial, agents: [] });
      const during = await facts();
      expect({ ...during, principals: before.principals }).toEqual(before);
      expect(during.principals.length).toBe(before.principals.length + 1);
      await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
      await page.getByText('Sin agentes registrados.', { exact: true }).waitFor({ timeout: 20_000 });
      await page.getByText('El servidor devolvió cero agentes registrados.', { exact: false }).waitFor({ timeout: 20_000 });
      await page.screenshot({ path: resolve(directory, 'empty-matrix-1440.png'), fullPage: false });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: resolve(directory, 'empty-matrix-390.png'), fullPage: false });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(writes).toEqual([]);
      await writeFile(resolve(directory, 'degraded-metadata.json'), JSON.stringify({ scenario: 'owned PostgreSQL metadata corruption; not a public mutation flow', before, during, initial, current, writes }, null, 2));
    } finally {
      observing = false;
      if (inserted) {
        const removed = await active().database.adminPool.query(`DELETE FROM company_system_principals
          WHERE company_id=$1 AND kind='director' AND tenant_id=$2 AND principal_alias=$3 AND delivery_source_only=true`,
        [person.company.slug, actor.tenant_id, actor.alias]);
        expect(removed.rowCount).toBe(1);
      }
      expect(await facts()).toEqual(before);
      expect(await snapshot()).toEqual(initial);
    }
    expect(writes).toEqual([]);
    await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
    await expect.poll(async () => page.getByText('Sin agentes registrados.', { exact: true }).count(), { timeout: 20_000 }).toBe(0);
    await writeFile(resolve(directory, 'restored.json'), JSON.stringify({ verified: true, facts: await facts(), snapshot: await snapshot(), writes }));
  }, 90_000);

  it('no registra errores inesperados del navegador', async () => {
    errors.assertClean();
    await writeFile(resolve(directory, 'browser-errors.json'), JSON.stringify({ unexpected: errors.unexpected, ignored: Object.fromEntries(errors.ignored) }));
  });
});
