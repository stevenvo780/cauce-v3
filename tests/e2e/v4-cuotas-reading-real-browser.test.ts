import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiGet, asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, login, openRegistration,
  type V4Page, type V4Person } from './v4-console-real-browser.helpers.js';

vi.stubEnv('CAUCE_PLAZOS_FACTOR', '3');
const { newTrustedPage, startConsoleFunctionalFixture, startTrustedBrowser } = await import('./console-functional-browser.fixtures.js');
const { browserDocker } = await import('./browser-owned-lifecycle.js');
const run = randomUUID().replaceAll('-', '').slice(0, 8);
const directory = resolve('.delegados/v4/recibos/e2e-a7-sigue-1025/reading', run);
const person: V4Person = { email: `zz-canary-a7-reading-${run}@example.invalid`, name: 'Lectura cuotas',
  password: `Synthetic-reading-${run}-password`, company: { slug: `zz-canary-a7-reading-${run}`, name: 'Lectura cuotas' } };
let unavailable: 'accounts' | 'environments' | undefined;
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, {
  id: 'owned-quota-reading-relation-unavailable', reason: 'an owned PostgreSQL relation is temporarily unavailable',
  matches: (message, url) => message.includes('status of 500') && (unavailable === 'accounts'
    ? url.endsWith('/v3/console/quota-accounts') : unavailable === 'environments'
      && ['/v3/console/quota-environments', '/v3/console/fleet/capability', '/v3/console/fleet/hosts'].some(path => url.endsWith(path))),
}]);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let page: V4Page;
let accountId: string;
const active = () => { if (!fixture) throw new Error('quota reading fixture missing'); return fixture; };
const screenshot = async (name: string) => page.screenshot({ path: resolve(directory, `${name}.png`), fullPage: false });

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') throw new Error('owned PostgreSQL and mocks=false required');
  await mkdir(directory, { recursive: true });
  fixture = await startConsoleFunctionalFixture();
  page = asV4Page(await newTrustedPage(fixture, { width: 1440, height: 900 }));
  errors.watch(page, 'quota-reading');
  const form = await openRegistration(page, fixture.baseUrl);
  await fillRegistration(form, person);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  await page.goto(`${fixture.baseUrl}/my-quotas`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
  const accountForm = page.getByRole('form', { name: 'Registrar cuenta de cuotas', exact: true });
  await accountForm.getByLabel('Nombre de la cuenta').fill('Cuenta de lectura');
  await accountForm.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
  await page.getByRole('article', { name: 'Cuotas de Cuenta de lectura', exact: true }).waitFor({ timeout: 20_000 });
  const row = (await fixture.database.pool.query<{ id: string }>('SELECT id FROM provider_accounts WHERE company_id=$1 AND label=$2',
    [person.company.slug, 'Cuenta de lectura'])).rows[0];
  if (!row) throw new Error('registered account not persisted');
  accountId = row.id;
  await writeFile(resolve(directory, 'resources.json'), JSON.stringify({ postgres: fixture.database.container.getId(), company: person.company.slug, account: accountId }));
}, 600_000);

afterEach(async context => {
  if (context.task.result?.state !== 'fail') return;
  await screenshot(`failed-${context.task.id.replaceAll(/[^a-z0-9_-]/giu, '_')}`);
  await writeFile(resolve(directory, 'failed-body.txt'), await page.locator('body').innerText());
});
afterAll(async () => {
  try { await fixture?.close(); }
  finally { vi.unstubAllEnvs(); }
});

async function loaded() {
  await page.getByRole('article', { name: 'Cuotas de Cuenta de lectura', exact: true }).waitFor({ timeout: 20_000 });
  await expect.poll(async () => page.getByRole('button', { name: 'Actualizar cuotas y entornos', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
}

describe('lecturas reales de Mis cuotas con PostgreSQL propio', () => {
  for (const item of [
    { name: 'cuentas', table: 'provider_accounts', text: 'Leyendo cuentas y ventanas…' },
    { name: 'entornos', table: 'quota_environments', text: 'Leyendo entornos de consulta…' },
  ]) {
    it(`muestra la carga inicial de ${item.name}, bloquea acciones y recupera la lectura al liberar PostgreSQL`, async () => {
      const lock = await active().database.adminPool.connect();
      try {
        await lock.query('BEGIN');
        await lock.query(`LOCK TABLE ${item.table} IN ACCESS EXCLUSIVE MODE`);
        await page.goto(`${active().baseUrl}/my-quotas`, { waitUntil: 'domcontentloaded' });
        await page.getByText(item.text, { exact: true }).waitFor({ timeout: 20_000 });
        expect(await page.getByRole('button', { name: 'Registrar cuenta', exact: true }).isDisabled()).toBe(true);
        expect(await page.getByRole('button', { name: 'Actualizar cuotas y entornos', exact: true }).isDisabled()).toBe(true);
        await screenshot(`${item.name}-loading-1440`);
        await page.setViewportSize({ width: 390, height: 844 });
        await screenshot(`${item.name}-loading-390`);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      } finally {
        try { await lock.query('ROLLBACK'); } finally { lock.release(); }
      }
      await loaded();
      expect((await apiGet(page, '/v3/console/quota-accounts')).body).toMatchObject({ accounts: [expect.objectContaining({ id: accountId })] });
      expect((await apiGet(page, '/v3/console/quota-environments')).body).toMatchObject({ environments: [] });
      await screenshot(`${item.name}-loaded-390`);
      await page.setViewportSize({ width: 1440, height: 900 });
    }, 90_000);
  }

  for (const item of [
    { name: 'accounts', table: 'quota_window_state', endpoint: '/v3/console/quota-accounts' },
    { name: 'environments', table: 'fleet_hosts', endpoint: '/v3/console/quota-environments' },
  ] as const) {
    it(`muestra el error de ${item.name}, conserva la cuenta y reintenta contra la relación restaurada`, async () => {
      await loaded();
      const lock = await active().database.adminPool.connect();
      const temporary = `zz_canary_quota_reading_${item.name}`;
      let renamed = false;
      try {
        await lock.query("SET lock_timeout='5s'");
        unavailable = item.name;
        await lock.query(`ALTER TABLE ${item.table} RENAME TO ${temporary}`);
        renamed = true;
        await page.getByRole('button', { name: 'Actualizar cuotas y entornos', exact: true }).click();
        await page.getByRole('alert').waitFor({ timeout: 20_000 });
        await expect.poll(async () => page.getByRole('button', { name: 'Actualizar cuotas y entornos', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
        expect((await apiGet(page, item.endpoint)).status).toBe(500);
        expect((await active().database.pool.query('SELECT id FROM provider_accounts WHERE id=$1 AND company_id=$2', [accountId, person.company.slug])).rowCount).toBe(1);
        expect(errors.ignored.get('owned-quota-reading-relation-unavailable') ?? 0).toBeGreaterThan(0);
        await screenshot(`${item.name}-failed-1440`);
        await page.setViewportSize({ width: 390, height: 844 });
        await screenshot(`${item.name}-failed-390`);
      } finally {
        try {
          if (renamed) await lock.query(`ALTER TABLE ${temporary} RENAME TO ${item.table}`);
        } finally {
          unavailable = undefined;
          try { await lock.query('RESET lock_timeout'); } finally { lock.release(); }
        }
      }
      await page.getByRole('button', { name: 'Actualizar cuotas y entornos', exact: true }).click();
      await expect.poll(async () => page.getByRole('alert').count(), { timeout: 20_000 }).toBe(0);
      expect((await apiGet(page, item.endpoint)).status).toBe(200);
      await loaded();
      await screenshot(`${item.name}-recovered-390`);
      await page.setViewportSize({ width: 1440, height: 900 });
    }, 90_000);
  }

  it('conserva la duración predeterminada del navegador privado y confirma su cierre después de una lectura real', async () => {
    const contextDirectory = await mkdtemp('/tmp/cauce-quota-reading-default-');
    const trusted = await startTrustedBrowser(active().pki.ca.cert, contextDirectory,
      [Number(new URL(active().baseUrl).port), Number(new URL(active().gatewayUrl).port)]);
    try {
      const command: unknown = JSON.parse((await browserDocker(['container', 'inspect', '--format', '{{json .Config.Cmd}}', trusted.containerId])).stdout);
      expect(command).toEqual(['-lc', 'sleep 600']);
      const other = asV4Page(await newTrustedPage({ ...active(), browser: trusted.browser, contexts: [] }, { width: 1440, height: 900 }));
      errors.watch(other, 'quota-reading-default-browser');
      await login(other, active().baseUrl, person);
      await other.goto(`${active().baseUrl}/my-quotas`, { waitUntil: 'domcontentloaded' });
      await other.getByRole('article', { name: 'Cuotas de Cuenta de lectura', exact: true }).waitFor({ timeout: 20_000 });
      expect((await apiGet(other, '/v3/console/quota-accounts')).body).toMatchObject({ accounts: [expect.objectContaining({ id: accountId })] });
      await other.screenshot({ path: resolve(directory, 'default-browser-1440.png'), fullPage: false });
      await other.setViewportSize({ width: 390, height: 844 });
      await other.screenshot({ path: resolve(directory, 'default-browser-390.png'), fullPage: false });
      await writeFile(resolve(directory, 'default-browser-resources.json'), JSON.stringify({ container: trusted.container,
        container_id: trusted.containerId, image: trusted.runtime.image, image_id: trusted.runtime.imageId, command }));
    } finally {
      await trusted.close();
      await rm(contextDirectory, { recursive: true, force: true });
    }
    await writeFile(resolve(directory, 'default-browser-cleanup.json'), JSON.stringify({ verified: true, container: trusted.container }));
  }, 180_000);

  it('no registra errores inesperados del navegador', async () => {
    errors.assertClean();
    await writeFile(resolve(directory, 'browser-errors.json'), JSON.stringify({ unexpected: errors.unexpected, ignored: Object.fromEntries(errors.ignored) }, null, 2));
  });
});
