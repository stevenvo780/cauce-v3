import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  functionalTenants, newTrustedPage, startConsoleFunctionalFixture,
  type FunctionalTenant,
} from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, HERMETIC_INSTANCE_RULES, type V4Locator, type V4Page,
} from './v4-console-real-browser.helpers.js';

const OWNER = 'e2e-a16-mapa-vistas-1025';
const receipts = resolve('.delegados/v4/recibos', OWNER);

type Fixture = Awaited<ReturnType<typeof startConsoleFunctionalFixture>>;
let fixture: Fixture | undefined;
let errors: BrowserErrorLog | undefined;

function active(): Fixture {
  if (!fixture) throw new Error('appearance nudge fixture is not initialized');
  return fixture;
}

function toneOf(text: string | null): number {
  const match = /^(\d+) grados$/u.exec(text ?? '');
  if (!match?.[1]) throw new Error(`fine hue control has no degree reading: ${text ?? ''}`);
  return Number(match[1]);
}

async function readTone(dialog: V4Locator): Promise<number> {
  return toneOf(await dialog.getByLabel('Tono fino', { exact: true }).evaluate((element) => element.getAttribute('aria-valuetext')));
}

async function openAppearance(current: V4Page, tenant: FunctionalTenant): Promise<V4Locator> {
  await current.getByRole('button', { name: 'Opciones de la conversación', exact: true }).click();
  await current.getByRole('menuitem', { name: 'Personalizar icono…', exact: true }).click();
  const dialog = current.getByRole('dialog', { name: `Personalizar icono de ${tenant.target}`, exact: true });
  await dialog.waitFor({ timeout: 15_000 });
  return dialog;
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('appearance nudge requires its own Testcontainers database');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('appearance nudge refuses mocked APIs');
  await mkdir(receipts, { recursive: true });
  fixture = await startConsoleFunctionalFixture();
  for (const tenant of functionalTenants) await active().database.pool.query(
    "INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'agent') ON CONFLICT DO NOTHING",
    [tenant.tenant, tenant.room, tenant.target],
  );
}, 600_000);

afterEach(async () => {
  try { errors?.assertClean(); }
  finally {
    errors = undefined;
    for (const context of fixture?.contexts.splice(0) ?? []) await context.close();
  }
});

afterAll(async () => { await fixture?.close(); }, 180_000);

describe('fine hue nudge persists through the real appearance API', () => {
  for (const viewport of [
    { width: 1440, height: 900, delta: 5, preset: false },
    { width: 390, height: 844, delta: -5, preset: true },
  ] as const) {
    const tenant = functionalTenants[viewport.width === 1440 ? 0 : 1];
    if (!tenant) throw new Error('missing appearance tenant');
    const size = String(viewport.width);

    it(`nudges the hue by ${String(viewport.delta)} and rereads it from PostgreSQL at ${size}px`, async () => {
      const browser = asV4Page(await newTrustedPage(active(), viewport));
      errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, {
        id: 'hermetic-terminal-targets-404', reason: 'fixture without the terminal plugin',
        matches: (text, url) => text.includes('status of 404') && url === `${active().baseUrl}/v3/console/terminal/targets`,
      }, {
        id: 'hermetic-terminal-grants-404', reason: 'the functional fixture does not register the terminal plugin',
        matches: (text, url) => text.includes('status of 404') && url === `${active().baseUrl}/v3/console/terminal/grants`,
      }]);
      errors.watch(browser, `appearance-nudge-${size}`);
      const writes: { path: string; status: number }[] = [];
      browser.on('response', (response) => {
        const url = new URL(response.url());
        if (response.request().method() === 'PUT' && url.pathname.endsWith('/appearance')) {
          writes.push({ path: url.pathname, status: response.status() });
        }
      });
      await browser.goto(`${active().baseUrl}/messages`, { waitUntil: 'domcontentloaded' });
      await browser.getByLabel('Correo', { exact: true }).fill(tenant.email);
      await browser.getByLabel('Contraseña', { exact: true }).fill(tenant.password);
      await browser.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
      await browser.locator(`a[data-launcher-card][href="/messages/${tenant.tenant}/${tenant.target}"]`).click();
      const dialog = await openAppearance(browser, tenant);
      if (viewport.preset) await dialog.getByRole('button', { name: 'Tono 200°', exact: true }).click();
      const before = await readTone(dialog);
      const control = viewport.delta > 0 ? 'Subir el tono 5°' : 'Bajar el tono 5°';
      await dialog.getByRole('button', { name: control, exact: true }).click();
      const expected = (((before + viewport.delta) % 360) + 360) % 360;
      await expect.poll(() => readTone(dialog), { timeout: 10_000 }).toBe(expected);
      expect(await browser.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      await browser.screenshot({ path: resolve(receipts, `appearance-nudge-${size}.png`), fullPage: false });
      await dialog.getByRole('button', { name: 'Guardar', exact: true }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 20_000 });
      expect(writes).toEqual([{ path: `/v3/console/agents/${tenant.tenant}/${tenant.target}/appearance`, status: 200 }]);
      const saved = await active().database.pool.query<{ glyph: string | null; hue: number; style: string; revision: number }>(
        'SELECT glyph, hue::int AS hue, style, revision::int AS revision FROM agent_appearances WHERE tenant_id=$1 AND alias=$2',
        [tenant.tenant, tenant.target],
      );
      expect(saved.rows).toEqual([{ glyph: null, hue: expected, style: 'orb', revision: 1 }]);
      const preferences = (await apiGet(browser, '/v3/console/agent-preferences')).body as {
        appearances: { tenant_id: string; alias: string; hue: number; style: string }[];
      };
      expect(preferences.appearances).toEqual(expect.arrayContaining([
        expect.objectContaining({ tenant_id: tenant.tenant, alias: tenant.target, hue: expected, style: 'orb' }),
      ]));
      await browser.reload({ waitUntil: 'domcontentloaded' });
      const restored = await openAppearance(browser, tenant);
      expect(await readTone(restored)).toBe(expected);
      await browser.screenshot({ path: resolve(receipts, `appearance-nudge-${size}-persisted.png`), fullPage: false });
    }, 120_000);
  }
});
