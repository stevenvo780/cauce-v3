import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isaTenant, newTrustedPage, startConsoleFunctionalFixture,
} from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, HERMETIC_INSTANCE_RULES, type V4Page,
} from './v4-console-real-browser.helpers.js';
import {
  BATCH_TAIL, DETALLE_OWNER, OTHER_ROOM_TEXT, OTHER_TENANT_TEXT, seedDetalleMensajes, TELEGRAM_TAIL,
  type SeededRoom,
} from './v4-detalle-mensaje-real-browser.helpers.js';

const evidence = resolve('.delegados/v4/recibos', DETALLE_OWNER);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let seeded: SeededRoom | undefined;

function active() {
  if (!fixture || !seeded) throw new Error('Room detail fixture is not initialized');
  return { fixture, seeded };
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('Room detail requires its own Testcontainers database');
  await mkdir(evidence, { recursive: true });
  fixture = await startConsoleFunctionalFixture();
  seeded = await seedDetalleMensajes(fixture.database.pool);
  console.info(JSON.stringify({ owner: DETALLE_OWNER, postgres: fixture.database.container.getId(), browser: fixture.browserContainer }));
}, 10 * 60_000);

afterAll(async () => { await fixture?.close(); });

async function openRoom(viewport: { width: number; height: number }, label: string) {
  const { fixture: runtime, seeded: room } = active();
  const page = asV4Page(await newTrustedPage(runtime, viewport));
  const denied = new Set<string>();
  const unexpected: string[] = [];
  page.on('response', (response) => {
    if (response.status() !== 404) return;
    const path = new URL(response.url()).pathname;
    if (!path.startsWith('/v3/console/messages/')) return;
    if (denied.has(path)) return;
    unexpected.push(`${String(response.status())} ${path}`);
  });
  const errors = new BrowserErrorLog(HERMETIC_INSTANCE_RULES);
  errors.watch(page, label);
  await page.goto(runtime.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Correo', { exact: true }).fill(isaTenant.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(isaTenant.password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  await page.goto(`${runtime.baseUrl}/messages/${isaTenant.tenant}/${isaTenant.operator}`, { waitUntil: 'domcontentloaded' });
  await page.getByText(BATCH_TAIL, { exact: false }).waitFor({ timeout: 20_000 });
  await page.getByText(TELEGRAM_TAIL, { exact: false }).waitFor({ timeout: 20_000 });
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('No se pudo obtener el cuerpo completo');
  expect(body).not.toContain('HTTP 404');
  expect(unexpected).toEqual([]);
  await page.screenshot({ path: resolve(evidence, `${label}.png`), fullPage: false });
  return { page, errors, denied, unexpected, room };
}

async function expectHidden(page: V4Page, id: string, secret: string, denied: Set<string>, errors: BrowserErrorLog) {
  const path = `/v3/console/messages/${id}`;
  denied.add(path);
  errors.expectHttpError(path, 404);
  const response = await apiGet(page, `/v3/console/messages/${encodeURIComponent(id)}`);
  expect(response.status).toBe(404);
  expect(JSON.stringify(response.body)).not.toContain(secret);
}

describe('message detail follows the room list for the human who shares an agent alias', () => {
  it('opens both message bodies on desktop and refuses another room and tenant', async () => {
    const { page, errors, denied, room } = await openRoom({ width: 1440, height: 900 }, 'detalle-escritorio-1440');
    const batch = await apiGet(page, `/v3/console/messages/${room.batchId}`);
    const telegram = await apiGet(page, `/v3/console/messages/${room.telegramId}`);
    expect(batch.status).toBe(200);
    expect(telegram.status).toBe(200);
    expect(JSON.stringify(batch.body)).toContain(BATCH_TAIL);
    expect(JSON.stringify(telegram.body)).toContain(TELEGRAM_TAIL);
    await expectHidden(page, room.otherRoomId, OTHER_ROOM_TEXT, denied, errors);
    await expectHidden(page, room.otherTenantId, OTHER_TENANT_TEXT, denied, errors);
    errors.assertClean();
  });

  it('opens both message bodies on a phone without a view error', async () => {
    const { page, errors } = await openRoom({ width: 390, height: 844 }, 'detalle-movil-390');
    await page.screenshot({ path: resolve(evidence, 'detalle-movil-390.png'), fullPage: false });
    errors.assertClean();
  });
});
