import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  apiGet, asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, openRegistration,
  syntheticPerson, type V4Page,
} from './v4-console-real-browser.helpers.js';
import type { BrowserResponse } from './console-functional-browser.fixtures.js';

vi.stubEnv('CAUCE_PLAZOS_FACTOR', '3');
const { newTrustedPage, startConsoleFunctionalFixture } = await import('./console-functional-browser.fixtures.js');
const run = randomUUID().replaceAll('-', '').slice(0, 8);
const directory = join(process.cwd(), '.delegados/v4/recibos/e2e-a7-sigue-1025/accounts', run);
const person = syntheticPerson('inventory', run);
person.email = `zz-canary-a7-inventory-${run}@example.invalid`;
person.company = { slug: `zz-canary-a7-inventory-${run}`, name: 'Inventario de cuentas' };
const accountId = `zz-canary-a7-inventory-${run}`;
const secondAccountId = `${accountId}-second`;
const degradedAgent = `zz-canary-inventory-${run}`;
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let page: V4Page;
let tenant: string;
let alias: string;
let relationUnavailable = false;
const reads: { at: number; status: number }[] = [];
const consoleReads: { path: string; status: number }[] = [];
let configurationMutations = 0;
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, {
  id: 'owned-inventory-read-failure', reason: 'the owned provider_accounts relation is temporarily unavailable',
  matches: (message, url) => relationUnavailable && message.includes('status of 400') && url.endsWith('/v3/console/config'),
}]);

function active() {
  if (!fixture) throw new Error('inventory fixture missing');
  return fixture;
}

async function screenshot(name: string) {
  await page.screenshot({ path: join(directory, `${name}.png`), fullPage: false });
}

async function frequency(label: string) {
  await page.getByRole('button', { name: /^Frecuencia de lectura:/u }).click();
  await page.getByRole('menuitemradio', { name: label, exact: true }).click();
  await page.getByRole('button', { name: `Frecuencia de lectura: ${label.toLowerCase()}`, exact: true }).waitFor();
}

async function loaded() {
  await page.getByRole('heading', { name: 'Cuentas', exact: true }).waitFor({ timeout: 20_000 });
  await page.locator('button[aria-label="Actualizar"]:not(:disabled)').waitFor({ timeout: 20_000 });
}

async function inventory() {
  await page.getByRole('tab', { name: 'Inventario', exact: true }).click();
  await loaded();
}

function accountRow() {
  return page.getByRole('row', { name: new RegExp(`${accountId}(?!-second)`, 'u') });
}

async function labelFromDatabase() {
  const rows = await active().database.pool.query<{ label: string }>('SELECT label FROM provider_accounts WHERE id=$1 AND company_id=$2',
    [accountId, person.company.slug]);
  expect(rows.rows).toHaveLength(1);
  return rows.rows[0]?.label;
}

async function applyAssignment() {
  const actions = page.getByRole('group', { name: 'Acciones de asignación', exact: true });
  await actions.getByRole('button', { name: 'Previsualizar (dry-run)', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Dry-run aceptado:' }).waitFor({ timeout: 20_000 });
  await actions.getByRole('button', { name: 'Aplicar', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor({ timeout: 20_000 });
  await page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') throw new Error('owned PostgreSQL and mocks=false required');
  await mkdir(directory, { recursive: true });
  fixture = await startConsoleFunctionalFixture({ sessionTtlMs: 20 * 60_000 });
  page = asV4Page(await newTrustedPage(fixture, { width: 1440, height: 900 }));
  errors.watch(page, 'inventory');
  page.on('response', (response: BrowserResponse) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/v3/console/') && response.request().method() === 'GET') consoleReads.push({ path, status: response.status() });
    if (path === '/v3/console/config/changes' && response.request().method() === 'POST') configurationMutations += 1;
    if (path === '/v3/console/config' && response.request().method() === 'GET') {
      reads.push({ at: performance.now(), status: response.status() });
    }
  });
  const form = await openRegistration(page, fixture.baseUrl);
  await fillRegistration(form, person);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  expect((await apiGet(page, '/v3/auth/session')).body).toMatchObject({ authenticated: true,
    authority: { role: 'company_owner', acting_company: person.company.slug } });
  const identity = (await fixture.database.pool.query<{ tenant_id: string; alias: string }>(
    'SELECT tenant_id,alias FROM console_users WHERE email=$1 AND company_id=$2', [person.email, person.company.slug])).rows[0];
  if (!identity) throw new Error('canonical inventory owner missing');
  tenant = identity.tenant_id;
  alias = identity.alias;
  await fixture.database.pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,label,
    credential_ref_kind,credential_ref,shared_with_pool,enabled,company_id)
    VALUES($1,'codex',$1,$3,'Cuenta inicial','env_path','CAUCE_SYNTHETIC_INVENTORY_PATH',false,true,$4),
          ($2,'codex',$2,$3,'Cuenta secundaria','env_path','CAUCE_SYNTHETIC_INVENTORY_SECOND_PATH',false,true,$4)`,
  [accountId, secondAccountId, tenant, person.company.slug]);
  await fixture.database.pool.query('INSERT INTO agents(tenant_id,alias,display_name,enabled,company_id) VALUES($1,$2,$3,false,$4)',
    [tenant, degradedAgent, 'Agente de lectura degradada', person.company.slug]);
  await page.goto(`${fixture.baseUrl}/accounts`, { waitUntil: 'domcontentloaded' });
  await loaded();
  await accountRow().filter({ hasText: 'Cuenta inicial' }).waitFor();
  await frequency('En pausa');
  const resources = { run, postgres: fixture.database.container.getId(), browser: fixture.browserContainer,
    image: fixture.browserRuntime.image, company: person.company.slug };
  await writeFile(join(directory, 'resources.json'), JSON.stringify(resources, null, 2));
  process.stdout.write(`Inventory resources ${JSON.stringify(resources)}\n`);
}, 600_000);

afterEach(async context => {
  if (context.task.result?.state !== 'fail') return;
  try {
    await screenshot(`failed-${context.task.id.replaceAll(/[^a-z0-9_-]/giu, '_')}`);
    await writeFile(join(directory, 'failed-body.txt'), await page.locator('body').innerText());
  } finally { await page.setViewportSize({ width: 1440, height: 900 }); }
});

afterAll(async () => {
  try {
    await fixture?.close();
    process.stdout.write(`Inventory cleanup verified: ${run}\n`);
  } finally { vi.unstubAllEnvs(); }
}, 180_000);

describe('inventario y lecturas reales de cuentas sin respuestas simuladas', () => {
  it('verifica el contrato publicado y conserva el último dueño calificado al rechazar quitar su membresía', async () => {
    const configuration = await apiGet(page, '/v3/console/config');
    expect(configuration.status).toBe(200);
    const sections = ['agents', 'provider_accounts', 'alias_routing_ceiling', 'agent_account_bindings'] as const;
    for (const key of sections) expect(Array.isArray(configuration.body[key])).toBe(true);
    const accounts = configuration.body.provider_accounts as Record<string, unknown>[];
    expect(accounts).toHaveLength(2);
    for (const account of accounts) {
      expect(typeof account.enabled).toBe('boolean');
      expect(typeof account.shared_with_pool).toBe('boolean');
    }
    const columns = await active().database.adminPool.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name,column_name,is_nullable FROM information_schema.columns
       WHERE table_schema='public' AND ((table_name='provider_accounts' AND column_name IN('enabled','shared_with_pool'))
         OR (table_name='agent_account_bindings' AND column_name='enabled')) ORDER BY table_name,column_name`,
    );
    expect(columns.rows).toEqual([
      { table_name: 'agent_account_bindings', column_name: 'enabled', is_nullable: 'NO' },
      { table_name: 'provider_accounts', column_name: 'enabled', is_nullable: 'NO' },
      { table_name: 'provider_accounts', column_name: 'shared_with_pool', is_nullable: 'NO' },
    ]);
    errors.expectHttpError('/v3/console/config/changes', 409);
    const denied = await page.evaluate(async target => {
      const session = await (await fetch('/v3/auth/session', { credentials: 'include', cache: 'no-store' })).json() as { csrf_token: string };
      const response = await fetch('/v3/console/config/changes', { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Cauce-Console': '1', 'X-CSRF-Token': session.csrf_token },
        body: JSON.stringify({ dry_run: false, mutation: { resource: 'membership', action: 'delete',
          tenant_id: target.tenant, room_id: 'office', alias: target.alias } }) });
      return { status: response.status, body: await response.json() as { message: string } };
    }, { tenant, alias });
    expect(denied.status).toBe(409);
    expect(denied.body.message).toContain('qualified company owner');
    expect((await active().database.pool.query('SELECT alias FROM memberships WHERE tenant_id=$1 AND alias=$2 AND room_id=$3',
      [tenant, alias, 'office'])).rows).toEqual([{ alias }]);
    const after = await apiGet(page, '/v3/console/config');
    expect(after.body.revision).toBe(configuration.body.revision);
    expect((after.body.agents as Record<string, unknown>[]).some(agent => agent.tenant_id === tenant && agent.alias === alias)).toBe(true);
    await writeFile(join(directory, 'snapshot-contract.json'), JSON.stringify({ sections, columns: columns.rows,
      agents: after.body.agents, membership_denial: denied, revision: after.body.revision }, null, 2));
    await screenshot('inventory-contract-1440');
  }, 90_000);

  it('muestra SIN DATO y bloquea la edición ante booleanos nulos inyectados en el PostgreSQL efímero', async () => {
    await inventory();
    const connection = await active().database.adminPool.connect();
    try {
      const originalAccount = (await connection.query<{ enabled: boolean; shared_with_pool: boolean }>(
        'SELECT enabled,shared_with_pool FROM provider_accounts WHERE id=$1', [secondAccountId])).rows[0];
      const originalAgent = (await connection.query<{ enabled: boolean }>(
        'SELECT enabled FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, degradedAgent])).rows[0];
      if (!originalAccount || !originalAgent) throw new Error('owned degradation rows missing');
      expect(degradedAgent).not.toBe(alias);
      expect((await connection.query('SELECT account_id FROM alias_routing_ceiling WHERE account_id=$1', [secondAccountId])).rows).toEqual([]);
      expect((await connection.query('SELECT account_id FROM agent_account_bindings WHERE account_id=$1', [secondAccountId])).rows).toEqual([]);
      const mutationsBefore = configurationMutations;
      let degraded = false;
      let degradedSnapshot: Record<string, unknown> | undefined;
      try {
        await connection.query('BEGIN');
        await connection.query("SET LOCAL lock_timeout='5s'");
        await connection.query('ALTER TABLE provider_accounts ALTER COLUMN enabled DROP NOT NULL, ALTER COLUMN shared_with_pool DROP NOT NULL');
        await connection.query('ALTER TABLE agents ALTER COLUMN enabled DROP NOT NULL');
        await connection.query('UPDATE provider_accounts SET enabled=NULL,shared_with_pool=NULL WHERE id=$1', [secondAccountId]);
        await connection.query('UPDATE agents SET enabled=NULL WHERE tenant_id=$1 AND alias=$2', [tenant, degradedAgent]);
        await connection.query('COMMIT');
        degraded = true;
        const snapshot = await apiGet(page, '/v3/console/config');
        expect(snapshot.status).toBe(200);
        degradedSnapshot = snapshot.body;
        expect((snapshot.body.provider_accounts as Record<string, unknown>[]).find(account => account.id === secondAccountId))
          .toMatchObject({ enabled: null, shared_with_pool: null });
        expect((snapshot.body.agents as Record<string, unknown>[]).find(agent => agent.alias === degradedAgent)).toMatchObject({ enabled: null });
        await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
        await loaded();
        const row = page.getByRole('row', { name: new RegExp(secondAccountId, 'u') });
        expect(await row.getByText('SIN DATO', { exact: true }).count()).toBe(2);
        await screenshot('inventory-null-fault-1440');
        await page.setViewportSize({ width: 390, height: 844 });
        await screenshot('inventory-null-fault-390');
        for (const name of [`Editar «${secondAccountId}»`, `Publicar «${secondAccountId}» al pool`, `Habilitar «${secondAccountId}»`]) {
          await row.getByRole('button', { name, exact: true }).click();
          const dialog = page.getByRole('dialog');
          await dialog.getByRole('note').filter({ hasText: 'El snapshot no trae shared_with_pool y/o enabled' }).waitFor();
          expect(await dialog.getByRole('button', { name: 'Previsualizar (dry-run)', exact: true }).isDisabled()).toBe(true);
          expect(await dialog.getByRole('button', { name: 'Aplicar', exact: true }).isDisabled()).toBe(true);
          if (name === `Editar «${secondAccountId}»`) await screenshot('inventory-null-edit-blocked-390');
          await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
        }
        await page.getByRole('tab', { name: 'Asignaciones', exact: true }).click();
        await page.getByRole('button', { name: `${tenant}/${degradedAgent} × ${secondAccountId}: Sin acceso`, exact: true }).waitFor();
        expect(configurationMutations).toBe(mutationsBefore);
      } finally {
        await connection.query('ROLLBACK');
        if (degraded) {
          await connection.query('BEGIN');
          await connection.query("SET LOCAL lock_timeout='5s'");
          await connection.query('UPDATE provider_accounts SET enabled=$2,shared_with_pool=$3 WHERE id=$1',
            [secondAccountId, originalAccount.enabled, originalAccount.shared_with_pool]);
          await connection.query('UPDATE agents SET enabled=$3 WHERE tenant_id=$1 AND alias=$2', [tenant, degradedAgent, originalAgent.enabled]);
          await connection.query('ALTER TABLE provider_accounts ALTER COLUMN enabled SET NOT NULL, ALTER COLUMN shared_with_pool SET NOT NULL');
          await connection.query('ALTER TABLE agents ALTER COLUMN enabled SET NOT NULL');
          await connection.query('COMMIT');
        }
      }
      const columns = (await active().database.adminPool.query<{ table_name: string; column_name: string; is_nullable: string }>(
        `SELECT table_name,column_name,is_nullable FROM information_schema.columns WHERE table_schema='public'
         AND ((table_name='provider_accounts' AND column_name IN('enabled','shared_with_pool')) OR (table_name='agents' AND column_name='enabled'))
         ORDER BY table_name,column_name`,
      )).rows;
      expect(columns).toHaveLength(3);
      expect(columns.every(column => column.is_nullable === 'NO')).toBe(true);
      const restored = await apiGet(page, '/v3/console/config');
      expect(restored.status).toBe(200);
      expect((restored.body.provider_accounts as Record<string, unknown>[]).find(account => account.id === secondAccountId)).toMatchObject(originalAccount);
      expect((restored.body.agents as Record<string, unknown>[]).find(agent => agent.alias === degradedAgent)).toMatchObject(originalAgent);
      await writeFile(join(directory, 'null-fault.json'), JSON.stringify({ classification: 'fault injection in owned ephemeral PostgreSQL; not a canonical or legacy state',
        account: secondAccountId, agent: degradedAgent, degraded: degradedSnapshot, restored_columns: columns,
        configuration_mutations: configurationMutations - mutationsBefore }, null, 2));
      await page.setViewportSize({ width: 1440, height: 900 });
      await inventory();
      await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
      await loaded();
      expect(await page.getByRole('row', { name: new RegExp(secondAccountId, 'u') }).getByText('SIN DATO', { exact: true }).count()).toBe(0);
    } finally {
      try { await connection.query('ROLLBACK'); } finally { connection.release(); }
    }
  }, 90_000);

  it('asigna y ordena desde escritorio, muestra las ayudas y conserva la vinculación en móvil', async () => {
    await inventory();
    await page.getByText('¿Cómo se conecta una cuenta?', { exact: true }).click();
    await page.getByText(/La credencial se mantiene en el perfil autenticado del proveedor/u).waitFor();
    await screenshot('inventory-help-1440');
    await page.getByRole('tab', { name: 'Asignaciones', exact: true }).click();
    await page.getByText('¿Qué cambia esta asignación?', { exact: true }).click();
    await page.getByText(/El acceso marca qué cuentas puede consultar cada agente/u).waitFor();
    const cell = `${tenant}/${alias} × ${accountId}`;
    await page.getByRole('button', { name: `${cell}: Sin acceso`, exact: true }).click();
    await screenshot('assign-grant-dialog-1440');
    await applyAssignment();
    await page.getByRole('button', { name: `${cell}: Sin orden`, exact: true }).click();
    await page.getByRole('textbox', { name: /^Orden de consulta/u }).fill('2');
    await applyAssignment();
    await page.getByRole('button', { name: `${cell}: 1.º en consulta`, exact: true }).waitFor();
    expect((await active().database.pool.query('SELECT priority,enabled FROM agent_account_bindings WHERE tenant_id=$1 AND agent_alias=$2 AND account_id=$3',
      [tenant, alias, accountId])).rows).toEqual([{ priority: 2, enabled: true }]);
    await screenshot('assign-bound-1440');
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot('assign-bound-390');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
  }, 120_000);

  it('conserva la última lectura, informa el error real del refresco y reintenta sin perder cuentas', async () => {
    await inventory();
    const oldLabel = await labelFromDatabase();
    const connection = await active().database.adminPool.connect();
    let renamed = false;
    try {
      await connection.query("SET lock_timeout='5s'");
      await connection.query('ALTER TABLE provider_accounts RENAME TO zz_canary_inventory_unavailable');
      renamed = true;
      relationUnavailable = true;
      const marker = reads.length;
      await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
      await expect.poll(() => reads.slice(marker).some(read => read.status === 400), { timeout: 20_000 }).toBe(true);
      await expect.poll(async () => page.getByRole('button', { name: 'Actualizar', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
      await accountRow().filter({ hasText: oldLabel ?? '' }).waitFor();
      await writeFile(join(directory, 'refresh-failure.json'), JSON.stringify({ reads: reads.slice(marker),
        retained_label: oldLabel, retained_row: await accountRow().innerText() }, null, 2));
      const warning = page.getByRole('alert').filter({ hasText: 'Se conserva la última lectura' });
      await warning.waitFor({ timeout: 5_000 });
      expect(await page.locator('header').getByRole('status').filter({ hasText: 'Actualizado' }).count()).toBe(0);
      await screenshot('inventory-refresh-failed-1440');
      await page.setViewportSize({ width: 390, height: 844 });
      await screenshot('inventory-refresh-failed-390');
    } finally {
      try {
        if (renamed) await connection.query('ALTER TABLE zz_canary_inventory_unavailable RENAME TO provider_accounts');
        await connection.query('RESET lock_timeout');
      } finally { connection.release(); relationUnavailable = false; }
    }
    await active().database.pool.query('UPDATE provider_accounts SET label=$2 WHERE id=$1', [accountId, 'Cuenta recuperada']);
    await page.getByRole('button', { name: 'Reintentar lectura', exact: true }).click();
    await loaded();
    await accountRow().filter({ hasText: 'Cuenta recuperada' }).waitFor();
    expect(await page.getByRole('alert').count()).toBe(0);
    expect(await labelFromDatabase()).toBe('Cuenta recuperada');
    await screenshot('inventory-refresh-recovered-390');
    await page.setViewportSize({ width: 1440, height: 900 });
  }, 90_000);

  it('mantiene el inventario visible y bloquea Actualizar mientras PostgreSQL retiene la relectura', async () => {
    await inventory();
    const oldLabel = await labelFromDatabase();
    await active().database.pool.query('UPDATE provider_accounts SET label=$2 WHERE id=$1', [accountId, 'Cuenta releída manualmente']);
    const connection = await active().database.adminPool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query("SET LOCAL lock_timeout='5s'");
      await connection.query('LOCK TABLE provider_accounts IN ACCESS EXCLUSIVE MODE');
      await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
      await expect.poll(async () => page.getByRole('button', { name: 'Actualizar', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(true);
      await page.getByRole('button', { name: 'Actualizar', exact: true }).getByText('Releyendo…', { exact: true }).waitFor();
      expect(await page.locator('header').getByRole('status').filter({ hasText: 'Actualizado' }).count()).toBe(0);
      await accountRow().filter({ hasText: oldLabel ?? '' }).waitFor();
      expect(await page.getByText('Leyendo cuentas y asignaciones…', { exact: true }).count()).toBe(0);
      await screenshot('inventory-refresh-loading-1440');
      await page.setViewportSize({ width: 390, height: 844 });
      await screenshot('inventory-refresh-loading-390');
    } finally {
      try { await connection.query('ROLLBACK'); } finally { connection.release(); }
    }
    await loaded();
    await accountRow().filter({ hasText: 'Cuenta releída manualmente' }).waitFor();
    expect(await labelFromDatabase()).toBe('Cuenta releída manualmente');
    await screenshot('inventory-manual-read-390');
    await page.setViewportSize({ width: 1440, height: 900 });
  }, 90_000);

  it('pausa realmente una lectura de 30 segundos y Actualizar relee el cambio de PostgreSQL', async () => {
    await inventory();
    const previous = await labelFromDatabase();
    await frequency('Cada 30 s');
    await frequency('En pausa');
    await active().database.pool.query('UPDATE provider_accounts SET label=$2 WHERE id=$1', [accountId, 'Cuenta tras pausa']);
    expect(await labelFromDatabase()).toBe('Cuenta tras pausa');
    const started = performance.now();
    await delay(36_000);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(35_000);
    await accountRow().filter({ hasText: previous ?? '' }).waitFor();
    await screenshot('inventory-paused-1440');
    await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
    await loaded();
    await accountRow().filter({ hasText: 'Cuenta tras pausa' }).waitFor();
    await writeFile(join(directory, 'pause-clock.json'), JSON.stringify({ waited_ms: elapsed, database_label: await labelFromDatabase() }, null, 2));
  }, 90_000);

  it('conserva los consumidores compartidos al releer Señales, Colas, DLQ y Ajustes desde la interfaz', async () => {
    const evidence: Record<string, unknown>[] = [];
    for (const view of [
      { path: '/observability', heading: 'Señales y auditoría', routes: ['/v3/console/observability', '/v3/console/origin-relays'] },
      { path: '/queues', heading: 'Colas y DLQ operativo', routes: ['/v3/console/queues'] },
      { path: '/config', heading: 'Ajustes', routes: ['/v3/console/config'] },
    ]) {
      await page.goto(`${active().baseUrl}${view.path}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: view.heading, exact: true }).waitFor({ timeout: 20_000 });
      await page.locator('header button[aria-label="Actualizar"]:not(:disabled)').waitFor({ timeout: 20_000 });
      const marker = consoleReads.length;
      await page.locator('header').getByRole('button', { name: 'Actualizar', exact: true }).click();
      await expect.poll(() => view.routes.every(path => consoleReads.slice(marker).some(read => read.path === path && read.status === 200)),
        { timeout: 20_000 }).toBe(true);
      await page.locator('header').getByRole('status').filter({ hasText: 'Actualizado' }).waitFor({ timeout: 20_000 });
      const snapshots = [];
      for (const path of view.routes) {
        const snapshot = await apiGet(page, path);
        expect(snapshot.status).toBe(200);
        snapshots.push({ path, body: snapshot.body });
      }
      evidence.push({ view: view.path, reads: consoleReads.slice(marker), snapshots });
      await screenshot(`shared-refresh${view.path.replaceAll('/', '-')}-1440`);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await screenshot(`shared-refresh${view.path.replaceAll('/', '-')}-390`);
      await page.setViewportSize({ width: 1440, height: 900 });
      if (view.path === '/queues') {
        await page.getByRole('tab', { name: 'DLQ operativo', exact: true }).click();
        const panel = page.getByRole('tabpanel', { name: 'DLQ operativo', exact: true });
        await panel.locator('button[aria-label="Actualizar"]:not(:disabled)').waitFor({ timeout: 20_000 });
        const dlqMarker = consoleReads.length;
        await panel.getByRole('button', { name: 'Actualizar', exact: true }).click();
        await expect.poll(() => consoleReads.slice(dlqMarker).some(read => read.path === '/v3/console/dlq' && read.status === 200),
          { timeout: 20_000 }).toBe(true);
        await panel.getByRole('status').filter({ hasText: 'Actualizado' }).waitFor({ timeout: 20_000 });
        const snapshot = await apiGet(page, '/v3/console/dlq?limit=200');
        expect(snapshot.status).toBe(200);
        expect(snapshot.body.items).toEqual([]);
        evidence.push({ view: 'OperationalDlqPanel', reads: consoleReads.slice(dlqMarker), snapshot: snapshot.body });
        await screenshot('shared-refresh-dlq-1440');
        await page.setViewportSize({ width: 390, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await screenshot('shared-refresh-dlq-390');
        await page.setViewportSize({ width: 1440, height: 900 });
      }
    }
    const durable = (await active().database.pool.query<{ accounts: number; messages: number; deliveries: number; dead_letters: number }>(
      `SELECT (SELECT count(*)::int FROM provider_accounts WHERE company_id=$2) AS accounts,
         (SELECT count(*)::int FROM messages WHERE tenant_id=$1) AS messages,
         (SELECT count(*)::int FROM deliveries WHERE recipient_tenant=$1) AS deliveries,
         (SELECT count(*)::int FROM dead_letters WHERE tenant_id=$1) AS dead_letters`, [tenant, person.company.slug],
    )).rows[0];
    expect(durable).toEqual({ accounts: 2, messages: 0, deliveries: 0, dead_letters: 0 });
    await page.goto(`${active().baseUrl}/ayuda`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Ayuda y documentación', exact: true }).waitFor({ timeout: 20_000 });
    await screenshot('shared-header-help-1440');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await screenshot('shared-header-help-390');
    await page.setViewportSize({ width: 1440, height: 900 });
    await writeFile(join(directory, 'shared-consumers.json'), JSON.stringify({ evidence, durable }, null, 2));
    await page.goto(`${active().baseUrl}/accounts`, { waitUntil: 'domcontentloaded' });
    await loaded();
    await frequency('En pausa');
  }, 180_000);

  it('espera cinco minutos reales con la pestaña visible y relee automáticamente el cambio persistido', async () => {
    await inventory();
    await frequency('En pausa');
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
    const visibilityChanges: string[] = [];
    await page.evaluate(() => {
      const target = window as Window & { inventoryVisibilityChanges?: string[] };
      target.inventoryVisibilityChanges = [];
      document.addEventListener('visibilitychange', () => { target.inventoryVisibilityChanges?.push(document.visibilityState); });
    });
    await page.getByRole('button', { name: /^Frecuencia de lectura:/u }).click();
    const started = performance.now();
    const wallStarted = new Date().toISOString();
    const marker = reads.length;
    await page.getByRole('menuitemradio', { name: 'Cada 5 min', exact: true }).click();
    await page.getByRole('button', { name: 'Frecuencia de lectura: cada 5 min', exact: true }).waitFor();
    await active().database.pool.query('UPDATE provider_accounts SET label=$2 WHERE id=$1', [accountId, 'Cuenta refrescada a cinco minutos']);
    expect(await labelFromDatabase()).toBe('Cuenta refrescada a cinco minutos');
    process.stdout.write(`Inventory five-minute read started ${wallStarted}; run=${run}\n`);
    await accountRow().filter({ hasText: 'Cuenta refrescada a cinco minutos' }).waitFor({ timeout: 330_000 });
    const elapsed = performance.now() - started;
    const requests = reads.slice(marker).map(read => ({ elapsed_ms: read.at - started, status: read.status }));
    expect(elapsed).toBeGreaterThanOrEqual(300_000);
    expect(requests.some(read => read.status === 200 && read.elapsed_ms >= 300_000)).toBe(true);
    visibilityChanges.push(...await page.evaluate(() =>
      (window as Window & { inventoryVisibilityChanges?: string[] }).inventoryVisibilityChanges ?? []));
    expect(visibilityChanges).toEqual([]);
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
    const snapshot = await apiGet(page, '/v3/console/config');
    expect((snapshot.body.provider_accounts as Record<string, unknown>[]).find(account => account.id === accountId)?.label)
      .toBe('Cuenta refrescada a cinco minutos');
    await screenshot('inventory-auto-five-minutes-1440');
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot('inventory-auto-five-minutes-390');
    await frequency('En pausa');
    await writeFile(join(directory, 'five-minute-clock.json'), JSON.stringify({ wall_started: wallStarted,
      wall_finished: new Date().toISOString(), elapsed_ms: elapsed, reads: requests,
      visibility_changes: visibilityChanges, database_label: await labelFromDatabase() }, null, 2));
    process.stdout.write(`Inventory five-minute read verified elapsed_ms=${String(elapsed)}; run=${run}\n`);
  }, 420_000);

  it('termina el recorrido sin errores inesperados de navegador', () => {
    errors.assertClean();
  });
});
