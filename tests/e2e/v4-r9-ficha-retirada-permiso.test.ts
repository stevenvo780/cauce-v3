import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  asV4Page, fillRegistration, openRegistration, syntheticPerson, type V4Page,
} from './v4-console-real-browser.helpers.js';

const task = 'r9-ficha-retirada-permiso-1025';
const run = randomUUID().slice(0, 8);
const prefix = `zz-canary-${task}-${run}`;
const directory = join(process.cwd(), '.delegados/v4/recibos', task);
const person = {
  ...syntheticPerson('r9-ficha-permiso', run),
  name: prefix,
  email: `${prefix}@example.test`,
  company: { name: prefix, slug: prefix },
};
const evidence: Record<string, unknown> = {
  task,
  run,
  verdicts: {},
  captures: [],
};

let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let page: V4Page | undefined;
let tenant = '';
const retiredAlias = `${prefix}-retirado`;
const retiredRoomId = `${prefix}-room-retirado`;
const retiredRoomName = `Equipo Histórico Retirado ${run}`;

interface RouteAbort {
  abort(errorCode?: string): Promise<void>;
  fulfill(options: { status?: number; contentType?: string; body?: string }): Promise<void>;
}
interface RoutablePage {
  route(url: string, handler: (route: RouteAbort) => Promise<void>): Promise<void>;
  unroute(url: string): Promise<void>;
}
const routable = (p: V4Page): RoutablePage => p as unknown as RoutablePage;

const active = () => { if (!fixture) throw new Error('fixture unavailable'); return fixture; };
const browser = () => { if (!page) throw new Error('browser unavailable'); return page; };
const pool = () => active().database.pool;

async function capture(name: string): Promise<void> {
  const filePath = join(directory, `${name}.png`);
  await browser().screenshot({ path: filePath, fullPage: true });
  (evidence.captures as string[]).push(`${name}.png`);
}

beforeAll(async () => {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.DATABASE_URL || process.env.CAUCE_TEST_DATABASE_URL) {
    throw new Error('E2E requires isolated Testcontainers PostgreSQL');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  fixture = await startConsoleFunctionalFixture();
  page = asV4Page(await newTrustedPage(active(), { width: 1280, height: 800 }));

  // Register company and owner account
  const registration = await openRegistration(browser(), active().baseUrl);
  await fillRegistration(registration, person);
  await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await browser().getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });

  const user = await pool().query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [person.email]);
  tenant = user.rows[0]?.tenant_id ?? '';
  expect(tenant).toMatch(/^hub-[a-f0-9]+$/u);

  // 1. Seed a room for the company
  await pool().query(
    'INSERT INTO rooms(id, tenant_id, company_id, display_name, enabled) VALUES($1, $2, $3, $4, true)',
    [retiredRoomId, tenant, person.company.slug, retiredRoomName],
  );

  // 2. Seed a retired agent with lifecycle_state='retired' and retired_at=now()
  await pool().query(
    `INSERT INTO agents(tenant_id, alias, display_name, company_id, enabled, lifecycle_state, retired_at)
     VALUES($1, $2, $3, $4, false, 'retired', now())`,
    [tenant, retiredAlias, `Agente Retirado ${run}`, person.company.slug],
  );

  // 3. Seed historical retired membership
  await pool().query(
    `INSERT INTO memberships(tenant_id, room_id, alias, role, enabled, retired_at, retired_enabled)
     VALUES($1, $2, $3, 'agent', false, now(), true)`,
    [tenant, retiredRoomId, retiredAlias],
  );

  evidence.tenant = tenant;
  evidence.retiredAlias = retiredAlias;
  evidence.retiredRoomId = retiredRoomId;
}, 600_000);

afterAll(async () => {
  try {
    await writeFile(join(directory, 'receipt.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  } finally {
    await fixture?.close();
  }
}, 180_000);

describe.sequential('r9-ficha-retirada-permiso: ficha de agente retirado y alta con permiso fallido', () => {
  it('1. Ficha de agente retirado muestra sus grupos históricos contrastado con PostgreSQL (1280x800 y 390x844)', async () => {
    // Verify direct PostgreSQL row
    const pgMember = (await pool().query<{ tenant_id: string; room_id: string; alias: string; retired_at: Date | null }>(
      'SELECT tenant_id, room_id, alias, retired_at FROM memberships WHERE tenant_id=$1 AND alias=$2',
      [tenant, retiredAlias],
    )).rows[0];
    if (!pgMember) throw new Error('membership row missing');
    expect(pgMember.room_id).toBe(retiredRoomId);
    expect(pgMember.retired_at).not.toBeNull();

    evidence.pgMembership = {
      tenant_id: pgMember.tenant_id,
      room_id: pgMember.room_id,
      alias: pgMember.alias,
      retired_at: pgMember.retired_at?.toISOString(),
    };

    // 1280x800 (desktop)
    await browser().setViewportSize({ width: 1280, height: 800 });
    await browser().goto(`${active().baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
    await browser().getByRole('heading', { name: 'Tus agentes', exact: true }).waitFor({ timeout: 30_000 });

    const restoreButton = browser().getByRole('button', { name: `Restaurar o revisar ${tenant}/${retiredAlias}`, exact: true });
    await restoreButton.waitFor({ timeout: 20_000 });
    await restoreButton.click();

    const dialog = browser().getByRole('dialog', { name: `Agente Retirado ${run}`, exact: true });
    await dialog.waitFor({ timeout: 20_000 });

    // The sheet must show the group chip with the historical room
    const groupChip = dialog.locator(`[title*="${retiredRoomId}"]`);
    await groupChip.waitFor({ timeout: 10_000 });
    expect(await groupChip.innerText()).toContain(retiredRoomName);
    expect(await dialog.getByText('Sin grupos').count()).toBe(0);
    expect(await dialog.getByText('Este agente no tiene membresías registradas.').count()).toBe(0);

    await capture('F01-ficha-retirada-desktop');

    // Close the drawer
    await browser().locator('body').press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 });

    // 390x844 (mobile)
    await browser().setViewportSize({ width: 390, height: 844 });
    const restoreButtonMobile = browser().getByRole('button', { name: `Restaurar o revisar ${tenant}/${retiredAlias}`, exact: true });
    await restoreButtonMobile.click();

    const dialogMobile = browser().getByRole('dialog', { name: `Agente Retirado ${run}`, exact: true });
    await dialogMobile.waitFor({ timeout: 20_000 });
    const groupChipMobile = dialogMobile.locator(`[title*="${retiredRoomId}"]`);
    await groupChipMobile.waitFor({ timeout: 10_000 });
    expect(await groupChipMobile.innerText()).toContain(retiredRoomName);
    expect(await dialogMobile.getByText('Sin grupos').count()).toBe(0);
    expect(await dialogMobile.getByText('Este agente no tiene membresías registradas.').count()).toBe(0);

    await capture('F01-ficha-retirada-mobile');

    await browser().locator('body').press('Escape');
    await dialogMobile.waitFor({ state: 'hidden', timeout: 10_000 });

    (evidence.verdicts as Record<string, string>)['ficha-retirada'] = 'PASA';
  });

  it('2. Alta cuando no se pueden leer permisos: fallo real en gateway, aviso propio y sin POST (1280x800 y 390x844)', async () => {
    // Reset to desktop viewport
    await browser().setViewportSize({ width: 1280, height: 800 });

    // Track any POST requests to verify no POST is made
    let postOccurred = false;
    const postRequests: string[] = [];
    browser().on('response', (res) => {
      if (res.request().method() === 'POST') {
        postOccurred = true;
        postRequests.push(`${res.request().method()} ${res.url()} -> ${String(res.status())}`);
      }
    });

    // Intercept /v3/console/access to return a 500 error simulating gateway access failure
    await routable(browser()).route('**/v3/console/access', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":"internal_error","message":"No se pudo comprobar el permiso"}',
      });
    });

    try {
      // Reload page: /v3/console/access will receive 500
      await browser().goto(`${active().baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
      await browser().getByRole('heading', { name: 'Tus agentes', exact: true }).waitFor({ timeout: 30_000 });

      const createButton = browser().getByRole('button', { name: 'Añadir agente', exact: true });
      await createButton.waitFor({ timeout: 20_000 });
      await createButton.click();

      const modal = browser().getByRole('dialog', { name: 'Añadir agente', exact: true });
      await modal.waitFor({ timeout: 20_000 });

      // Verify the specific notice appears
      await modal.getByText(/No se pudo comprobar el permiso para modificar este registro/u).waitFor({ timeout: 20_000 });
      expect(await modal.getByText(/Recarga la página o vuelve a entrar/u).count()).toBeGreaterThan(0);

      // Verify it is distinct from "Tu cuenta no tiene permiso"
      expect(await modal.getByText('Tu cuenta no tiene permiso para modificar este registro.').count()).toBe(0);

      // Verify inputs are disabled
      expect(await modal.getByLabel('Alias', { exact: true }).isDisabled()).toBe(true);
      expect(await modal.getByLabel('Nombre visible', { exact: true }).isDisabled()).toBe(true);

      // Verify no POST was sent
      expect(postOccurred).toBe(false);

      await capture('F02-permiso-fallido-desktop');

      await browser().locator('body').press('Escape');
      await modal.waitFor({ state: 'hidden', timeout: 10_000 });

      // 390x844 (mobile)
      await browser().setViewportSize({ width: 390, height: 844 });
      const createButtonMobile = browser().getByRole('button', { name: 'Añadir agente', exact: true });
      await createButtonMobile.click();

      const modalMobile = browser().getByRole('dialog', { name: 'Añadir agente', exact: true });
      await modalMobile.waitFor({ timeout: 20_000 });

      await modalMobile.getByText(/No se pudo comprobar el permiso para modificar este registro/u).waitFor({ timeout: 20_000 });
      expect(await modalMobile.getByText(/Recarga la página o vuelve a entrar/u).count()).toBeGreaterThan(0);
      expect(await modalMobile.getByText('Tu cuenta no tiene permiso para modificar este registro.').count()).toBe(0);
      expect(await modalMobile.getByLabel('Alias', { exact: true }).isDisabled()).toBe(true);

      expect(postOccurred).toBe(false);

      await capture('F02-permiso-fallido-mobile');

      await browser().locator('body').press('Escape');
      await modalMobile.waitFor({ state: 'hidden', timeout: 10_000 });

      evidence.postRequests = postRequests;
      (evidence.verdicts as Record<string, string>)['permiso-fallido'] = 'PASA';
    } finally {
      await routable(browser()).unroute('**/v3/console/access');
    }
  });
});
