import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { functionalTenants, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import { apiGet, fillRegistration, openRegistration, syntheticPerson } from './v4-console-real-browser.helpers.js';
import {
  captureLauncher, launcherCard, launcherEvidence, launcherOwner, launcherPage, launcherReads,
  loginLauncher, saveLauncherLog, withFleetReadFault, withFleetReadLock,
  type LauncherFixture, type LauncherPage,
} from './v4-chat-launcher-states.fixtures.js';

let fixture: LauncherFixture | undefined;
let browser: LauncherPage | undefined;
let scenario = '';

function active(): LauncherFixture {
  if (!fixture) throw new Error('Chat launcher fixture is not initialized');
  return fixture;
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('Chat launcher requires its own Testcontainers database');
  await mkdir(launcherEvidence, { recursive: true });
  fixture = await startConsoleFunctionalFixture();
  for (const tenant of functionalTenants) await active().database.pool.query(
    "INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'agent') ON CONFLICT DO NOTHING",
    [tenant.tenant, tenant.room, tenant.target],
  );
  await writeFile(resolve(launcherEvidence, 'launcher-resources.json'), JSON.stringify({
    owner: launcherOwner, postgres: fixture.database.container.getId(), browser: fixture.browserContainer,
  }, null, 2));
}, 600_000);

afterEach(async () => {
  try {
    if (browser) {
      await saveLauncherLog(scenario, browser);
      browser.errors.assertClean();
    }
  } finally {
    browser = undefined;
    for (const context of fixture?.contexts.splice(0) ?? []) await context.close();
  }
});

afterAll(async () => { await fixture?.close(); }, 180_000);

describe('Chat launcher states with real Chromium, gateway and PostgreSQL', () => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const size = String(viewport.width);
    const tenant = functionalTenants[viewport.width === 1440 ? 0 : 1];
    if (!tenant) throw new Error('Missing synthetic launcher tenant');

    it(`muestra skeleton durante la primera lectura bloqueada y abre la flota real en ${size}px`, async () => {
      scenario = `launcher-loading-${size}`;
      browser = await launcherPage(active(), viewport);
      const { page } = browser;
      await loginLauncher(active(), page, tenant);
      await withFleetReadLock(active(), async (blocked) => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('#main-content').getByText('Cargando agentes…', { exact: true })
          .waitFor({ state: 'attached', timeout: 20_000 });
        await expect.poll(blocked, { timeout: 10_000 }).toBeGreaterThan(0);
        expect(await page.locator('a[data-launcher-card]').count()).toBe(0);
        const skeletons = await page.locator('ul[aria-hidden="true"] > li').count();
        expect(skeletons).toBe(viewport.width === 390 ? 6 : 8);
        await captureLauncher(page, `${scenario}-blocked`);
      });
      await launcherCard(page, tenant).waitFor({ timeout: 25_000 });
      expect(await page.getByText('Cargando agentes…', { exact: true }).count()).toBe(0);
      expect((await apiGet(page, '/v3/console/activity')).status).toBe(200);
      expect((await active().database.pool.query('SELECT 1 FROM agents WHERE tenant_id=$1 AND alias=$2',
        [tenant.tenant, tenant.target])).rowCount).toBe(1);
      await captureLauncher(page, `${scenario}-recovered`);
    }, 90_000);

    it(`explica el error inicial real y recupera la lista mediante Reintentar en ${size}px`, async () => {
      scenario = `launcher-initial-error-${size}`;
      browser = await launcherPage(active(), viewport, true);
      const { page, responses } = browser;
      await loginLauncher(active(), page, tenant);
      await withFleetReadFault(active(), ['agents', 'messages'], async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        const alert = page.getByRole('alert').filter({ hasText: 'No se pudo leer Cauce V3' });
        await alert.waitFor({ timeout: 25_000 });
        expect(await page.locator('a[data-launcher-card]').count()).toBe(0);
        expect(await page.getByText('Cargando agentes…', { exact: true }).count()).toBe(0);
        for (const path of launcherReads) {
          expect(responses.some((response) => response.path === path && response.status === 400)).toBe(true);
        }
        expect(await alert.innerText()).toContain('does not exist');
        await captureLauncher(page, `${scenario}-failed`);
      });
      const readsBeforeRetry = responses.length;
      await page.getByRole('alert').filter({ hasText: 'No se pudo leer Cauce V3' })
        .getByRole('button', { name: 'Reintentar', exact: true }).click();
      await launcherCard(page, tenant).waitFor({ timeout: 25_000 });
      await page.getByText('No se pudo leer Cauce V3', { exact: true }).waitFor({ state: 'hidden', timeout: 20_000 });
      await expect.poll(() => launcherReads.every((path) => responses.slice(readsBeforeRetry)
        .some((response) => response.path === path && response.status === 200)), { timeout: 20_000 }).toBe(true);
      expect((await active().database.adminPool.query(
        "SELECT to_regclass('public.agents') IS NOT NULL AND to_regclass('public.messages') IS NOT NULL AS restored",
      )).rows).toEqual([{ restored: true }]);
      await captureLauncher(page, `${scenario}-retried`);
    }, 90_000);

    it(`muestra el propietario en borrador tras registrarse y abre Invitar persona desde Ajustes en ${size}px`, async () => {
      scenario = `launcher-registered-owner-${size}`;
      browser = await launcherPage(active(), viewport);
      const { page } = browser;
      const person = syntheticPerson(`chat-owner-${size}`, Date.now().toString(36));
      const form = await openRegistration(page, active().baseUrl);
      await fillRegistration(form, person);
      await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
      await page.goto(`${active().baseUrl}/messages`, { waitUntil: 'domcontentloaded' });
      const registry = await active().database.pool.query<{
        tenant_id: string; alias: string; harness_id: string | null; enabled: boolean;
        lifecycle_state: string; container_name: string | null;
      }>(
        `SELECT a.tenant_id,a.alias,a.harness_id,a.enabled,a.lifecycle_state,a.container_name
         FROM agents a JOIN tenants t ON t.id=a.tenant_id
         WHERE t.company_id=$1 AND NOT EXISTS(SELECT 1 FROM company_system_principals p
           WHERE p.tenant_id=a.tenant_id AND p.principal_alias=a.alias AND to_jsonb(p)->>'delivery_source_only'='true')
         ORDER BY a.alias`,
        [person.company.slug],
      );
      expect(registry.rows).toEqual([expect.objectContaining({
        alias: 'owner', harness_id: null, enabled: false, lifecycle_state: 'draft', container_name: null,
      })]);
      const hub = registry.rows[0]?.tenant_id;
      if (!hub) throw new Error('The registered company has no durable owner identity');
      const activity = await apiGet(page, '/v3/console/activity');
      expect(activity.status).toBe(200);
      expect(activity.body.agents).toEqual([expect.objectContaining({
        tenant_id: hub, alias: 'owner', registered: true, lifecycle_state: 'draft', agent_enabled: false,
      })]);
      expect(await apiGet(page, '/v3/console/messages')).toMatchObject({ status: 200, body: { items: [] } });
      await writeFile(resolve(launcherEvidence, `${scenario}-registry.json`), JSON.stringify({
        registry: registry.rows, activity: activity.body.agents,
      }, null, 2));
      const ownerCard = page.locator(`a[data-launcher-card][href="/messages/${hub}/owner"]`);
      await ownerCard.waitFor({ timeout: 25_000 });
      expect(await page.locator('a[data-launcher-card]').count()).toBe(1);
      await expect.poll(() => ownerCard.innerText(), { timeout: 20_000 }).toContain('Sin preparar');
      expect(await page.getByText('Todavía no hay agentes en la flota.', { exact: true }).count()).toBe(0);
      await captureLauncher(page, `${scenario}-created`);
      await ownerCard.press('Shift+F10');
      const context = page.getByRole('menuitem', { name: 'Perfil y contexto', exact: true });
      await context.waitFor({ timeout: 10_000 });
      expect(await context.evaluate((element) => element.getAttribute('href'))).toBe(`/messages/${hub}/owner?view=context`);
      await page.getByRole('menuitem', { name: 'Personalizar icono…', exact: true }).waitFor({ timeout: 10_000 });
      await captureLauncher(page, `${scenario}-menu`);
      await page.getByRole('menuitem', { name: 'Abrir chat', exact: true }).click();
      await page.getByLabel('Mensaje para owner', { exact: true }).waitFor({ timeout: 20_000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByLabel('Mensaje para owner', { exact: true }).waitFor({ timeout: 20_000 });
      await page.getByRole('button', { name: viewport.width === 390 ? 'Más' : 'Gestión', exact: true }).click();
      await page.getByRole('link', { name: 'Ajustes', exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe('/config');
      await page.getByRole('heading', { name: 'Ajustes', exact: true }).waitFor({ timeout: 25_000 });
      if (viewport.width === 390) {
        const section = page.getByRole('combobox', { name: 'Sección', exact: true });
        await section.selectOption('acceso');
        expect(await section.inputValue()).toBe('acceso');
      } else {
        const section = page.getByRole('tab', { name: 'Acceso y roles', exact: true });
        await section.click();
        await expect.poll(() => section.evaluate((element) => element.getAttribute('aria-selected'))).toBe('true');
      }
      await page.getByRole('heading', { name: 'Acceso y roles', exact: true }).waitFor({ timeout: 20_000 });
      await page.getByRole('button', { name: 'Invitar persona', exact: true }).click();
      const invitation = page.getByRole('form', { name: 'Invitar persona', exact: true });
      await invitation.waitFor({ timeout: 20_000 });
      expect(await invitation.getByLabel('Correo de acceso', { exact: true }).inputValue()).toBe('');
      await captureLauncher(page, `${scenario}-invite-destination`);
      await page.getByRole('button', { name: 'Cerrar invitación', exact: true }).click();
      await invitation.waitFor({ state: 'hidden', timeout: 10_000 });
    }, 90_000);

    it(`preserva tarjeta y vista previa al fallar y bloquear la recarga, y recupera lecturas reales en ${size}px`, async () => {
      scenario = `launcher-refresh-${size}`;
      browser = await launcherPage(active(), viewport, true);
      const { page, responses } = browser;
      await loginLauncher(active(), page, tenant);
      await launcherCard(page, tenant).click();
      const text = `zz-canary-${launcherOwner}-refresh-${size}`;
      const editor = page.getByLabel(`Mensaje para ${tenant.target}`, { exact: true });
      await editor.fill(text);
      const send = page.getByRole('button', { name: 'Enviar', exact: true });
      await expect.poll(() => send.isDisabled(), { timeout: 20_000 }).toBe(false);
      await send.click();
      await expect.poll(() => editor.inputValue(), { timeout: 20_000 }).toBe('');
      const durable = await active().database.pool.query<{ id: string }>(
        "SELECT id FROM messages WHERE tenant_id=$1 AND body->>'text'=$2", [tenant.tenant, text],
      );
      expect(durable.rows).toHaveLength(1);
      await page.goto(`${active().baseUrl}/messages`, { waitUntil: 'domcontentloaded' });
      const card = launcherCard(page, tenant);
      await expect.poll(() => card.innerText(), { timeout: 25_000 }).toContain(text);
      await withFleetReadFault(active(), ['messages'], async () => {
        await page.getByText('No se pudo actualizar la lista de agentes:', { exact: false }).waitFor({ timeout: 20_000 });
        expect(await card.innerText()).toContain(text);
        expect(await page.getByText('Cargando agentes…', { exact: true }).count()).toBe(0);
        await captureLauncher(page, `${scenario}-failed-with-data`);
      });
      const beforeRetry = responses.length;
      await withFleetReadLock(active(), async (blocked) => {
        await page.getByRole('alert').filter({ hasText: 'Se muestra la última lista conocida.' })
          .getByRole('button', { name: 'Reintentar', exact: true }).click();
        await expect.poll(blocked, { timeout: 10_000 }).toBeGreaterThan(0);
        expect(await card.innerText()).toContain(text);
        expect(await page.getByText('Cargando agentes…', { exact: true }).count()).toBe(0);
        await captureLauncher(page, `${scenario}-pending-with-data`);
      });
      await page.getByText('No se pudo actualizar la lista de agentes:', { exact: false })
        .waitFor({ state: 'hidden', timeout: 25_000 });
      await expect.poll(() => launcherReads.every((path) => responses.slice(beforeRetry)
        .some((response) => response.path === path && response.status === 200)), { timeout: 20_000 }).toBe(true);
      expect(await card.innerText()).toContain(text);
      const id = durable.rows[0]?.id;
      if (!id) throw new Error('The UI message has no durable identity');
      expect(await apiGet(page, `/v3/console/messages/${id}`)).toMatchObject({ status: 200, body: { body: { text } } });
      expect((await active().database.pool.query('SELECT 1 FROM messages WHERE id=$1', [id])).rowCount).toBe(1);
      await captureLauncher(page, `${scenario}-recovered`);
    }, 120_000);

    it(`personaliza el icono desde el menú del Chat, persiste y restablece el look en ${size}px`, async () => {
      scenario = `launcher-chat-appearance-${size}`;
      browser = await launcherPage(active(), viewport);
      const { page } = browser;
      await loginLauncher(active(), page, tenant);
      await launcherCard(page, tenant).click();
      const openAppearance = async () => {
        await page.getByRole('button', { name: 'Opciones de la conversación', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Personalizar icono…', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: `Personalizar icono de ${tenant.target}`, exact: true });
        await dialog.waitFor({ timeout: 15_000 });
        return dialog;
      };
      const dialog = await openAppearance();
      await dialog.getByRole('button', { name: 'Emoji o letra', exact: true }).click();
      await dialog.getByRole('button', { name: 'Icono 🦊', exact: true }).click();
      await dialog.getByRole('button', { name: 'Tono 200°', exact: true }).click();
      await dialog.getByRole('button', { name: 'Aurora', exact: true }).click();
      await dialog.getByRole('button', { name: 'Guardar', exact: true }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 20_000 });
      expect((await active().database.pool.query(
        'SELECT glyph,hue,style,revision::int FROM agent_appearances WHERE tenant_id=$1 AND alias=$2',
        [tenant.tenant, tenant.target],
      )).rows).toEqual([{ glyph: '🦊', hue: 200, style: 'aurora', revision: 1 }]);
      expect((await apiGet(page, '/v3/console/agent-preferences')).body.appearances)
        .toEqual(expect.arrayContaining([expect.objectContaining({ tenant_id: tenant.tenant, alias: tenant.target, glyph: '🦊', hue: 200, style: 'aurora' })]));
      await page.reload({ waitUntil: 'domcontentloaded' });
      const restored = await openAppearance();
      expect(await restored.getByRole('button', { name: 'Icono 🦊', exact: true }).evaluate((element) => element.getAttribute('aria-pressed'))).toBe('true');
      await captureLauncher(page, `${scenario}-persisted`);
      await restored.getByRole('button', { name: 'Restablecer', exact: true }).click();
      await restored.getByRole('group', { name: 'Confirmar', exact: true })
        .getByRole('button', { name: 'Restablecer', exact: true }).click();
      await restored.waitFor({ state: 'hidden', timeout: 20_000 });
      expect((await active().database.pool.query(
        'SELECT 1 FROM agent_appearances WHERE tenant_id=$1 AND alias=$2', [tenant.tenant, tenant.target],
      )).rowCount).toBe(0);
      await page.reload({ waitUntil: 'domcontentloaded' });
      const reset = await openAppearance();
      expect(await reset.getByRole('button', { name: 'Restablecer', exact: true }).isDisabled()).toBe(true);
      expect((await apiGet(page, '/v3/console/agent-preferences')).body.appearances).toEqual([]);
      await captureLauncher(page, `${scenario}-reset`);
      await reset.getByRole('button', { name: 'Cancelar', exact: true }).click();
    }, 120_000);
  }
});
