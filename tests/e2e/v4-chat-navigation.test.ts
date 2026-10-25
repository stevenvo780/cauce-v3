import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  functionalTenants, newTrustedPage, startConsoleFunctionalFixture, type FunctionalTenant,
} from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, HERMETIC_INSTANCE_RULES, type V4Page,
} from './v4-console-real-browser.helpers.js';

const owner = 'e2e-a6-chat-1025b';
const prefix = `zz-canary-${owner}`;
const evidence = resolve('.delegados/v4/recibos', owner);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;

interface WheelPage extends V4Page {
  mouse: { move(x: number, y: number): Promise<void>; wheel(x: number, y: number): Promise<void> };
}

function active() {
  if (!fixture) throw new Error('Chat navigation fixture is not initialized');
  return fixture;
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('Chat navigation requires its own Testcontainers database');
  await mkdir(evidence, { recursive: true });
  fixture = await startConsoleFunctionalFixture();
  console.info(JSON.stringify({ owner, postgres: fixture.database.container.getId(), browser: fixture.browserContainer }));
  for (const tenant of functionalTenants) {
    await active().database.pool.query(
      "INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'agent') ON CONFLICT DO NOTHING",
      [tenant.tenant, tenant.room, tenant.target],
    );
  }
}, 10 * 60_000);

afterAll(async () => { await fixture?.close(); });

async function login(tenant: FunctionalTenant, viewport: { width: number; height: number }) {
  const page = asV4Page(await newTrustedPage(active(), viewport));
  const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, {
    id: 'hermetic-terminal-targets-404', reason: 'fixture without a terminal relay mount',
    matches: (text, url) => text.includes('status of 404') && url === `${active().baseUrl}/v3/console/terminal/targets`,
  }]);
  errors.watch(page, `${tenant.tenant}-${String(viewport.width)}`);
  await page.goto(active().baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Correo', { exact: true }).fill(tenant.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(tenant.password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  return { page, errors };
}

async function screenshot(page: V4Page, label: string) {
  await page.screenshot({ path: resolve(evidence, `${label}.png`), fullPage: false });
}

async function publish(page: V4Page, tenant: FunctionalTenant, text: string, lane: 'batch' | 'interactive') {
  const editor = page.getByLabel(`Mensaje para ${tenant.target}`, { exact: true });
  const expectedText = text.trim();
  const send = page.getByRole('button', { name: 'Enviar', exact: true });
  await editor.fill(text);
  await expect.poll(() => send.isDisabled(), { timeout: 20_000 }).toBe(false);
  await send.click();
  const entry = page.locator('article[data-direction="input"][data-message-id]').filter({ hasText: expectedText.split('\n')[0] ?? expectedText });
  await entry.waitFor({ timeout: 20_000 });
  await expect.poll(async () => editor.inputValue(), { timeout: 20_000 }).toBe('');
  const persisted = await active().database.pool.query<{
    id: string; lane: string; actor_alias: string; status: string; body: { text: string };
  }>(
    `SELECT m.id,m.lane,m.actor_alias,m.body,d.status FROM messages m
       JOIN deliveries d ON d.message_id=m.id
      WHERE m.tenant_id=$1 AND m.body->>'text'=$2 AND d.recipient_alias=$3`,
    [tenant.tenant, expectedText, tenant.target],
  );
  expect(persisted.rows).toHaveLength(1);
  expect(persisted.rows[0]).toMatchObject({ lane, actor_alias: tenant.operator, body: { text: expectedText }, status: 'pending' });
  const id = persisted.rows[0]?.id;
  if (!id) throw new Error('UI-published message is absent from PostgreSQL');
  const detail = await apiGet(page, `/v3/console/messages/${encodeURIComponent(id)}`);
  expect(detail.status).toBe(200);
  expect(detail.body).toMatchObject({ lane, body: { text: expectedText }, actor_alias: tenant.operator, room_id: tenant.room });
  await page.getByRole('button', { name: 'Enviar', exact: true }).waitFor({ timeout: 20_000 });
  return { id, entry };
}

async function chooseLane(page: V4Page, label: string) {
  await page.getByRole('button', { name: 'Opciones de la conversación', exact: true }).click();
  await page.getByRole('menuitemradio', { name: label, exact: true }).click();
}

describe('V4 chat navigation with real Chromium, gateway and PostgreSQL', () => {
  for (const [index, viewport] of [
    { width: 1440, height: 900, label: 'navigation-desktop' },
    { width: 390, height: 844, label: 'navigation-mobile' },
  ].entries()) {
    it(`opens, configures and navigates durable conversation history at ${String(viewport.width)}px`, async () => {
      const tenant = functionalTenants[index];
      if (!tenant) throw new Error('Missing synthetic chat tenant');
      const { page, errors } = await login(tenant, viewport);
      const label = viewport.label;
      await page.goto(`${active().baseUrl}/messages`, { waitUntil: 'domcontentloaded' });
      const search = page.getByRole('searchbox', { name: 'Buscar un agente para chatear', exact: true });
      const card = page.locator(`a[data-launcher-card][href="/messages/${tenant.tenant}/${tenant.target}"]`);
      await card.waitFor({ timeout: 20_000 });
      await card.press('/');
      expect(await search.evaluate((element) => document.activeElement === element)).toBe(true);
      await screenshot(page, `${label}-launcher`);
      await search.fill(`${prefix}-no-agent`);
      await page.getByText('Ningún agente coincide con', { exact: false }).waitFor({ timeout: 10_000 });
      expect(await card.count()).toBe(0);
      await screenshot(page, `${label}-search-empty`);
      await search.press('Escape');
      expect(await search.inputValue()).toBe('');
      await card.waitFor({ timeout: 10_000 });
      await search.fill(tenant.target);
      await search.press('ArrowDown');
      await search.press('Enter');
      const editor = page.getByLabel(`Mensaje para ${tenant.target}`, { exact: true });
      await editor.waitFor({ timeout: 20_000 });
      expect(new URL(page.url()).pathname).toBe(`/messages/${tenant.tenant}/${tenant.target}`);
      await page.getByRole('heading', { name: `Empieza la conversación con ${tenant.target}`, exact: true }).waitFor({ timeout: 20_000 });
      await page.getByRole('button', { name: '¿Qué te bloquea?', exact: true }).click();
      expect(await editor.inputValue()).toBe('¿Qué te bloquea?');
      expect(await page.evaluate(() => document.activeElement?.matches('[data-chat-composer] textarea'))).toBe(true);
      await screenshot(page, `${label}-empty-suggestion`);

      const lease = await active().database.pool.query(
        'SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2', [tenant.tenant, tenant.target],
      );
      expect(lease.rowCount).toBe(0);
      await page.getByText('Conexión sin dato · envío en cola', { exact: true }).waitFor({ timeout: 20_000 });
      await page.getByRole('button', { name: /^Ver detalles:.*Conexión sin dato/u }).click();
      const notices = page.getByRole('region', { name: 'Detalles de los avisos', exact: true });
      await notices.waitFor({ timeout: 10_000 });
      expect(await notices.innerText()).toContain(`El servidor no informa el lease de ${tenant.target}`);
      await screenshot(page, `${label}-notices`);
      await page.getByRole('button', { name: 'Cerrar avisos', exact: true }).click();
      await notices.waitFor({ state: 'hidden', timeout: 10_000 });

      await chooseLane(page, 'Batch · prioridad 0');
      const batchText = `${prefix}-${label}-batch`;
      const batch = await publish(page, tenant, batchText, 'batch');
      await screenshot(page, `${label}-batch-persisted`);
      await page.getByRole('button', { name: 'Opciones de la conversación', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Detalles de la conversación', exact: true }).click();
      const conversationDetails = page.getByRole('dialog', { name: 'Detalles de la conversación', exact: true });
      await conversationDetails.waitFor({ timeout: 10_000 });
      expect(await conversationDetails.innerText()).toContain('Carril: Batch · prioridad 0');
      expect(await conversationDetails.innerText()).toContain(tenant.room);
      await screenshot(page, `${label}-conversation-details`);
      await page.getByRole('button', { name: 'Cerrar detalles', exact: true }).click();
      await conversationDetails.waitFor({ state: 'hidden', timeout: 10_000 });

      await batch.entry.getByRole('button', { name: 'Opciones del mensaje', exact: true }).press('Enter');
      await page.getByRole('menuitem', { name: 'Ver detalle', exact: true }).press('Enter');
      const messageDetails = page.getByRole('group', { name: 'Detalle del mensaje seleccionado', exact: true });
      await messageDetails.waitFor({ timeout: 10_000 });
      expect(await messageDetails.innerText()).toContain(batch.id);
      expect(await messageDetails.innerText()).toContain(batchText);
      expect(await messageDetails.innerText()).toContain('batch');
      await screenshot(page, `${label}-message-details`);
      await page.getByRole('button', { name: 'Cerrar detalle', exact: true }).click();
      await messageDetails.waitFor({ state: 'hidden', timeout: 10_000 });
      await batch.entry.getByRole('button', { name: 'Citar en la respuesta', exact: true }).press('Enter');
      expect(await editor.inputValue()).toBe(`> ${batchText}\n\n`);
      await chooseLane(page, 'Interactivo · prioridad 10');
      const quoted = `${await editor.inputValue()}${prefix}-${label}-quoted`;
      await publish(page, tenant, quoted, 'interactive');
      await screenshot(page, `${label}-quote-persisted`);

      await page.getByRole('button', { name: 'Opciones de la conversación', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Agregar a favoritos', exact: true }).click();
      const favorite = { tenant_id: tenant.tenant, alias: tenant.target };
      await expect.poll(async () => (await apiGet(page, '/v3/console/agent-preferences')).body.favorites, { timeout: 10_000 })
        .toEqual(expect.arrayContaining([expect.objectContaining(favorite)]));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Opciones de la conversación', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Quitar de favoritos', exact: true }).waitFor({ timeout: 10_000 });
      await screenshot(page, `${label}-favorite-persisted`);
      await page.getByRole('menuitem', { name: 'Quitar de favoritos', exact: true }).click();
      await expect.poll(async () => (await apiGet(page, '/v3/console/agent-preferences')).body.favorites, { timeout: 10_000 })
        .toEqual([]);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Opciones de la conversación', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Agregar a favoritos', exact: true }).waitFor({ timeout: 10_000 });
      const syncReads: number[] = [];
      page.on('response', (response) => {
        if (response.request().method() === 'GET' && new URL(response.url()).pathname === '/v3/console/messages') {
          syncReads.push(response.status());
        }
      });
      await page.getByRole('menuitem', { name: 'Sincronizar', exact: true }).click();
      await expect.poll(() => syncReads.includes(200), { timeout: 15_000 }).toBe(true);
      await page.locator(`article[data-message-id="${batch.id}"]`).waitFor({ timeout: 20_000 });
      expect(await page.locator(`article[data-message-id="${batch.id}"]`).count()).toBe(1);
      await screenshot(page, `${label}-synchronized`);

      for (let message = 0; message < 4; message += 1) {
        const text = `${prefix}-${label}-history-${String(message)}\n${'Historia visible para recorrer.\n'.repeat(12)}`;
        await publish(page, tenant, text, 'interactive');
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByLabel('Historial de la conversación', { exact: true }).waitFor({ timeout: 20_000 });
      expect(await page.locator(`article[data-message-id="${batch.id}"]`).count()).toBe(1);
      const scroll = page.locator('[data-thread-scroll]');
      await expect.poll(async () => page.evaluate(() => {
        const pane = document.querySelector('[data-thread-scroll]');
        return pane instanceof HTMLElement && pane.scrollHeight > pane.clientHeight + 200;
      }), { timeout: 20_000 }).toBe(true);
      const bounds = await scroll.boundingBox();
      if (!bounds) throw new Error('Thread scroll pane is not visible');
      const wheelPage = page as WheelPage;
      await wheelPage.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await wheelPage.mouse.wheel(0, -10_000);
      const last = page.getByRole('button', { name: /^Ir al último/u });
      await last.waitFor({ timeout: 10_000 });
      await screenshot(page, `${label}-history-reading`);
      await last.click();
      await expect.poll(async () => page.evaluate(() => {
        const pane = document.querySelector('[data-thread-scroll]');
        return pane instanceof HTMLElement ? pane.scrollHeight - pane.scrollTop - pane.clientHeight : Infinity;
      }), { timeout: 10_000 }).toBeLessThan(12);
      await last.waitFor({ state: 'hidden', timeout: 10_000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      await screenshot(page, `${label}-history-latest`);
      if (viewport.width === 390) {
        await page.getByRole('link', { name: 'Volver a los agentes', exact: true }).click();
        await page.getByRole('heading', { name: 'Chats', exact: true }).waitFor({ timeout: 10_000 });
        await card.waitFor({ timeout: 10_000 });
        await card.click();
        await page.locator(`article[data-message-id="${batch.id}"]`).waitFor({ state: 'attached', timeout: 20_000 });
      }
      await page.goto(`${active().baseUrl}/messages/${tenant.tenant}/${prefix}-missing`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'No encontramos esa conversación', exact: true }).waitFor({ timeout: 20_000 });
      await page.getByText('Cauce no inventa un agente que no existe.', { exact: false }).waitFor({ timeout: 20_000 });
      await screenshot(page, `${label}-missing-conversation`);
      await page.getByRole('link', { name: 'Volver a los chats', exact: true }).click();
      await card.waitFor({ timeout: 20_000 });
      expect(new URL(page.url()).pathname).toBe('/messages');
      errors.assertClean();
    }, 180_000);
  }
});
