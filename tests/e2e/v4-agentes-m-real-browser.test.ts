import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES,
  login, openRegistration, syntheticPerson, type V4Locator, type V4Page,
} from './v4-console-real-browser.helpers.js';

const task = 'e2e-a2-cobertura-w-1025';
const run = randomUUID().slice(0, 8);
const prefix = `zz-canary-${task}-${run}`;
const alias = `${prefix}-mobile`;
const sheetAlias = `${prefix}-sheet`;
const name = `Agente móvil ${run}`;
const person = syntheticPerson('mobile', run);
person.company = { name: prefix, slug: prefix };
const directory = join(process.cwd(), '.delegados/v4/recibos', task, 'm', run);
const errors = new BrowserErrorLog(HERMETIC_INSTANCE_RULES);
const measurements: Record<string, unknown> = {};
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let page: V4Page | undefined;
let tenant = '';
let failureCount = 0;

function active() { if (!fixture) throw new Error('mobile fixture is unavailable'); return fixture; }
function browser() { if (!page) throw new Error('mobile browser is unavailable'); return page; }
function sheet() { return browser().getByRole('dialog', { name, exact: true }); }

async function settle(): Promise<void> {
  await browser().evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(done => { requestAnimationFrame(() => { requestAnimationFrame(() => { done(); }); }); });
  });
}

async function measure(label: string, popup: V4Locator, fullscreen: boolean): Promise<void> {
  if (label.startsWith('M03-form-')) {
    await popup.locator('[aria-label^="Formulario de "]').evaluate(element => { element.scrollIntoView({ block: 'center' }); });
  }
  await settle();
  const geometry = await popup.evaluate(element => {
    const rect = (node: Element) => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    };
    const visible = (node: Element) => node instanceof HTMLElement && node.checkVisibility({ visibilityProperty: true });
    const panels = Array.from(element.querySelectorAll<HTMLElement>('.overflow-y-auto')).filter(visible);
    const controls = Array.from(element.querySelectorAll('input,select,textarea,button,[role="tab"],summary')).filter(visible);
    const grids = Array.from(element.querySelectorAll<HTMLElement>('[class*="sm:grid-cols-"]')).filter(visible);
    const tabs = Array.from(element.querySelectorAll('[role="tab"]')).filter(visible);
    return {
      viewport: { width: innerWidth, height: innerHeight, layoutWidth: document.documentElement.clientWidth },
      popup: rect(element), documentWidth: document.documentElement.scrollWidth,
      panels: panels.map(node => ({ ...rect(node), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
        scrollHeight: node.scrollHeight, clientHeight: node.clientHeight })),
      controls: controls.map(node => ({ ...rect(node), label: node.getAttribute('aria-label') ?? (node.textContent.trim().slice(0, 80) || node.tagName) })),
      grids: grids.map(node => ({ ...rect(node), columns: getComputedStyle(node).gridTemplateColumns.split(' ').length })),
      tabs: tabs.map(rect),
    };
  });
  measurements[label] = geometry;
  await writeFile(join(directory, `${label}.json`), JSON.stringify(geometry, null, 2) + '\n');
  await browser().screenshot({ path: join(directory, `${label}.png`) });
  expect(geometry.documentWidth, label).toBeLessThanOrEqual(geometry.viewport.width);
  expect(geometry.popup.left, label).toBeGreaterThanOrEqual(-1);
  expect(geometry.popup.right, label).toBeLessThanOrEqual(geometry.viewport.width + 1);
  expect(geometry.popup.top, label).toBeGreaterThanOrEqual(-1);
  expect(geometry.popup.bottom, label).toBeLessThanOrEqual(geometry.viewport.height + 1);
  if (fullscreen) {
    expect(geometry.popup.width, label).toBeCloseTo(geometry.viewport.width, 0);
    expect(geometry.popup.height, label).toBeCloseTo(geometry.viewport.height, 0);
  }
  for (const panel of geometry.panels) expect(panel.scrollWidth, label).toBeLessThanOrEqual(panel.clientWidth + 1);
  for (const control of geometry.controls) {
    expect(control.left, `${label}: ${control.label}`).toBeGreaterThanOrEqual(geometry.popup.left - 1);
    expect(control.right, `${label}: ${control.label}`).toBeLessThanOrEqual(geometry.popup.right + 1);
  }
  if (geometry.viewport.width === 390) {
    for (const grid of geometry.grids) expect(grid.columns, `${label}: stacked form`).toBe(1);
    if (geometry.tabs.length === 5) expect(new Set(geometry.tabs.map(tab => Math.round(tab.top))).size).toBeGreaterThan(1);
  }
}

async function assertPinnedWizard(popup: V4Locator): Promise<void> {
  const pinned = await popup.evaluate(async element => {
    const header = element.firstElementChild;
    const footer = element.lastElementChild;
    const body = element.querySelector<HTMLElement>('.overflow-y-auto');
    if (!header || !footer || !body) throw new Error('wizard scroll regions are missing');
    const position = () => ({ header: header.getBoundingClientRect().top, footer: footer.getBoundingClientRect().bottom });
    const before = position();
    body.scrollTop = body.scrollHeight;
    await new Promise<void>(done => { requestAnimationFrame(() => { done(); }); });
    return { before, after: position(), scrollTop: body.scrollTop, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight };
  });
  measurements.pinnedWizard = pinned;
  expect(pinned.scrollHeight).toBeGreaterThan(pinned.clientHeight);
  expect(pinned.scrollTop).toBeGreaterThan(0);
  expect(pinned.after).toEqual(pinned.before);
  await browser().screenshot({ path: join(directory, 'M01-placement-scrolled.png') });
}

beforeAll(async () => {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.DATABASE_URL || process.env.CAUCE_TEST_DATABASE_URL) {
    throw new Error('mobile E2E requires isolated Testcontainers PostgreSQL');
  }
  await mkdir(directory, { recursive: true });
  fixture = await startConsoleFunctionalFixture();
  const context = await active().browser.newContext({ viewport: { width: 390, height: 844 },
    ignoreHTTPSErrors: false, serviceWorkers: 'block', isMobile: true, hasTouch: true });
  active().contexts.push(context);
  page = asV4Page(await context.newPage());
  errors.watch(browser(), 'mobile-owner');
  const registration = await openRegistration(browser(), active().baseUrl);
  await fillRegistration(registration, person);
  await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await browser().getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  const user = await active().database.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [person.email]);
  tenant = user.rows[0]?.tenant_id ?? '';
  expect(tenant).toMatch(/^hub-/u);
  await active().database.pool.query('INSERT INTO agents(tenant_id,alias,display_name,enabled,company_id) VALUES($1,$2,$3,false,$4)',
    [tenant, sheetAlias, name, person.company.slug]);
}, 600_000);

afterEach(async context => {
  if (context.task.result?.state !== 'fail' || !page) return;
  await writeFile(join(directory, `failure-${String(failureCount)}.txt`),
    (await browser().locator('body').innerText()).replaceAll(person.password, '[REDACTED]'));
  await browser().screenshot({ path: join(directory, `failure-${String(failureCount)}.png`) });
  failureCount += 1;
});

afterAll(async () => {
  try {
    await writeFile(join(directory, 'receipt.json'), JSON.stringify({ task, run, tenant, alias, mocks: false, measurements,
      unexpectedErrors: errors.unexpected, ignoredErrors: Object.fromEntries(errors.ignored) }, null, 2) + '\n');
  } finally { await fixture?.close(); }
}, 120_000);

describe.sequential('Agentes: contención real de wizard, ficha y formularios móviles', () => {
  it('M01 crea desde el wizard móvil, conserva header/footer al desplazar y relee PostgreSQL', async () => {
    await browser().goto(`${active().baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
    await browser().getByRole('heading', { name: 'Tus agentes', exact: true }).waitFor({ timeout: 30_000 });
    await settle();
    await browser().getByRole('button', { name: 'Añadir agente', exact: true }).click();
    const popup = browser().getByRole('dialog', { name: 'Añadir agente', exact: true });
    await popup.waitFor({ timeout: 20_000 });
    await popup.getByRole('combobox', { name: 'Espacio de trabajo', exact: true }).selectOption(tenant);
    await popup.getByLabel('Alias', { exact: true }).fill(alias);
    await popup.getByLabel('Nombre visible', { exact: true }).fill(name);
    await measure('M01-identity-390', popup, true);
    await popup.getByRole('button', { name: 'Siguiente', exact: true }).click();
    await popup.locator('summary').filter({ hasText: 'Entorno de ejecución' }).click();
    await measure('M01-placement-390', popup, true);
    await assertPinnedWizard(popup);
    await popup.getByRole('button', { name: 'Siguiente', exact: true }).click();
    await popup.getByRole('combobox', { name: 'Grupo inicial (opcional)', exact: true }).selectOption('office');
    await measure('M01-groups-390', popup, true);
    await popup.getByRole('button', { name: 'Siguiente', exact: true }).click();
    await popup.getByRole('button', { name: 'Previsualizar alta', exact: true }).click();
    const create = popup.getByRole('button', { name: 'Crear registro', exact: true });
    await expect.poll(() => create.isDisabled(), { timeout: 20_000 }).toBe(false);
    expect((await active().database.pool.query('SELECT 1 FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows).toEqual([]);
    await measure('M01-preview-390', popup, true);
    await create.click();
    await popup.getByText(`Registro creado: ${tenant}/${alias}.`, { exact: true }).waitFor({ timeout: 20_000 });
    await popup.getByText(/Grupo inicial: .*, creada\./u).waitFor({ timeout: 20_000 });
    const stored = (await active().database.pool.query<{ display_name: string; enabled: boolean }>(
      'SELECT display_name,enabled FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows;
    expect(stored).toEqual([{ display_name: name, enabled: false }]);
    expect((await active().database.pool.query('SELECT room_id,role,enabled FROM memberships WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows)
      .toEqual([{ room_id: 'office', role: 'agent', enabled: true }]);
    measurements.created = stored;
    await measure('M01-created-390', popup, true);
    await popup.getByRole('button', { name: 'Abrir ficha', exact: true }).click();
    await sheet().waitFor();
    errors.assertClean();
  }, 120_000);

  it('M02/M03 contiene cada pestaña a 390×844 y drawer a 1440×900, con catálogo en una columna', async () => {
    const mobile = browser();
    await browser().goto(`${active().baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
    await browser().getByRole('heading', { name: 'Tus agentes', exact: true }).waitFor({ timeout: 30_000 });
    await browser().getByLabel('Buscar agente o grupo', { exact: true }).fill(sheetAlias);
    await browser().getByRole('button', { name: `Abrir agente ${tenant}/${sheetAlias}`, exact: true }).click();
    await sheet().waitFor({ timeout: 20_000 });
    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      if (viewport.width === 1440) {
        page = asV4Page(await newTrustedPage(active(), viewport));
        errors.watch(browser(), 'desktop-owner');
        await login(browser(), active().baseUrl, person);
        await browser().goto(`${active().baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
        await browser().getByRole('heading', { name: 'Tus agentes', exact: true }).waitFor({ timeout: 30_000 });
        await browser().getByLabel('Buscar agente o grupo', { exact: true }).fill(sheetAlias);
        await browser().getByRole('button', { name: `Abrir agente ${tenant}/${sheetAlias}`, exact: true }).click();
        await sheet().waitFor();
      }
      await browser().setViewportSize(viewport);
      for (const tab of ['Estado', 'Ajustes', 'Ejecución', 'Ampliaciones', 'Grupos']) {
        await sheet().getByRole('tab', { name: tab, exact: true }).click();
        await measure(`M02-${tab}-${String(viewport.width)}`, sheet(), viewport.width === 390);
      }
      if (viewport.width === 1440) {
        const box = await sheet().boundingBox();
        expect(box?.width).toBe(600);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBe(await browser().evaluate(() => document.documentElement.scrollWidth));
      }
    }
    page = mobile;
    await browser().setViewportSize({ width: 390, height: 844 });
    await sheet().getByRole('tab', { name: 'Ampliaciones', exact: true }).click();
    const catalog = await sheet().locator('section[aria-label="Añadir ampliación"] ul').evaluate(element => ({
      columns: getComputedStyle(element).gridTemplateColumns.split(' ').length,
      count: element.children.length,
      cards: Array.from(element.children).map(child => ({ left: child.getBoundingClientRect().left, width: child.getBoundingClientRect().width })),
    }));
    expect(catalog.columns).toBe(1);
    expect(catalog.count).toBe(11);
    expect(new Set(catalog.cards.map(card => Math.round(card.left))).size).toBe(1);
    measurements.catalog = catalog;
    for (const label of ['Montaje', 'Red adicional', 'Recursos', 'GPU', 'SSH saliente', 'Docker', 'Navegador', 'Servidor MCP', 'Herramientas', 'Respaldo Muse', 'Control total']) {
      await sheet().getByRole('button', { name: `Añadir ampliación ${label}`, exact: true }).click();
      if (label === 'Navegador') await sheet().getByRole('combobox', { name: 'Modo', exact: true }).selectOption('ssh_tunnel');
      await measure(`M03-form-${label}-390`, sheet(), true);
      await sheet().getByRole('button', { name: 'Cancelar', exact: true }).click();
    }
    expect((await active().database.pool.query('SELECT extensions FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, sheetAlias])).rows).toEqual([{ extensions: [] }]);
    const config = await apiGet(browser(), '/v3/console/config');
    expect(config.status).toBe(200);
    expect((config.body.agents as Record<string, unknown>[]).find(row => row.tenant_id === tenant && row.alias === sheetAlias)).toMatchObject({ display_name: name });
    errors.assertClean();
  }, 180_000);
});
