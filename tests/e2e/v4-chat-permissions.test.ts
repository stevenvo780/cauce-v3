import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TopologySnapshot } from '../../console/src/api/types/topology.js';
import { browserExec } from './browser-owned-lifecycle.js';
import {
  isaSecondHuman, isaTenant, newTrustedPage, startConsoleFunctionalFixture, type FunctionalTenant,
} from './console-functional-browser.fixtures.js';
import { apiGet, asV4Page, login, type V4Page } from './v4-console-real-browser.helpers.js';

const receipts = join(process.cwd(), '.delegados/v4/recibos/e2e-a6-chat-1025b');
const prefix = 'zz-canary-e2e-a6-chat-1025b-permissions';
const conversationPath = `/messages/${isaTenant.tenant}/${isaTenant.target}`;
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
const pageErrors: string[] = [];

function active() {
  if (!fixture) throw new Error('Missing permissions fixture');
  return fixture;
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('Chat permissions requires isolated Testcontainers PostgreSQL');
  await mkdir(receipts, { recursive: true });
  fixture = await startConsoleFunctionalFixture();
  await fixture.database.pool.query(
    "INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES ($1,$2,$3,'agent')", [isaTenant.tenant, isaTenant.room, isaTenant.target]);
  const provision = await browserExec(join(process.cwd(), 'node_modules/.bin/tsx'), [
    'services/gateway/src/console-user-cli.ts', '--update', '--email', isaSecondHuman.email, '--role', 'reader',
  ], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test',
    DATABASE_URL: fixture.database.url, CAUCE_CONSOLE_USER_PASSWORD: isaSecondHuman.password }, timeout: 60_000 });
  expect(provision.stdout.includes('rol     reader')).toBe(true);
  const authority = await fixture.database.pool.query<{ role: string; permissions: string[] }>(
    `SELECT person.role,member.permissions FROM console_users person JOIN human_tenant_memberships member
     ON member.human_id=person.id AND member.tenant_id=person.tenant_id WHERE person.email_normalized=$1`, [isaSecondHuman.email]);
  expect(authority.rows).toEqual([{ role: 'reader', permissions: ['read'] }]);
  await writeFile(join(receipts, 'permissions-reader-authority.json'), JSON.stringify(authority.rows, null, 2));
  console.info(JSON.stringify({ owner: prefix, syntheticTenantsOnly: true,
    postgres: fixture.database.container.getId(), browser: fixture.browserContainer }));
}, 10 * 60_000);

afterAll(async () => { await fixture?.close(); });

async function conversation(width: number, human: FunctionalTenant = isaTenant): Promise<V4Page> {
  const page = asV4Page(await newTrustedPage(active(), { width, height: width === 390 ? 844 : 900 }));
  (page as V4Page & { setDefaultNavigationTimeout(timeout: number): void }).setDefaultNavigationTimeout(90_000);
  page.on('pageerror', (error) => { pageErrors.push(error instanceof Error ? error.message : String(error)); });
  await login(page, active().baseUrl, {
    email: human.email, password: human.password, name: 'Canary', company: { name: 'Canary', slug: 'canary' },
  });
  await page.goto(`${active().baseUrl}${conversationPath}`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(`Mensaje para ${isaTenant.target}`, { exact: true }).waitFor({ timeout: 20_000 });
  return page;
}

async function noPublication(text: string): Promise<void> {
  const count = await active().database.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM messages WHERE tenant_id=$1 AND body->>'text'=$2", [isaTenant.tenant, text]);
  expect(count.rows).toEqual([{ count: '0' }]);
}

async function screenshot(page: V4Page, name: string, width: number): Promise<void> {
  await page.screenshot({ path: join(receipts, `permissions-${name}-${String(width)}.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(pageErrors).toEqual([]);
}

describe('Chat V4: autoridad y retorno desde contexto con servicios reales', () => {
  it('mantiene el compositor bloqueado para reader y el gateway rechaza publicación sin escribir mensajes', async () => {
    for (const width of [1440, 390]) {
      const page = await conversation(width, isaSecondHuman);
      const access = await apiGet(page, '/v3/console/access');
      expect(access.status).toBe(200);
      expect(access.body).toMatchObject({ subject: `${isaTenant.tenant}:${isaTenant.operator}`, roles: [], permissions: [] });
      await page.getByText('Requiere el permiso message.publish.', { exact: true }).waitFor();
      expect(await page.getByLabel(`Mensaje para ${isaTenant.target}`, { exact: true }).isDisabled()).toBe(true);
      for (const label of ['Enviar', 'Adjuntar archivos', 'Grabar nota de voz']) {
        expect(await page.getByRole('button', { name: label, exact: true }).isDisabled()).toBe(true);
      }
      const text = `${prefix}-reader-${randomUUID()}`;
      const denied = await page.evaluate(async ({ text, room, tenant, target }) => {
        const session = await fetch('/v3/auth/session', { credentials: 'include', cache: 'no-store' });
        if (!session.ok) throw new Error('Reader session could not be read');
        const state = await session.json() as { csrf_token?: string };
        if (!state.csrf_token) throw new Error('Reader session has no CSRF proof');
        const response = await fetch('/v3/console/messages', { method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf_token },
          body: JSON.stringify({ room_id: room, recipients: [{ tenant_id: tenant, alias: target }],
            body: { text }, lane: 'interactive', priority: 10, idempotency_key: text }) });
        return { status: response.status };
      }, { text, room: isaTenant.room, tenant: isaTenant.tenant, target: isaTenant.target });
      expect(denied.status).toBe(403);
      await noPublication(text);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByText('Requiere el permiso message.publish.', { exact: true }).waitFor();
      await screenshot(page, 'reader-blocked', width);
      await writeFile(join(receipts, `permissions-reader-${String(width)}.json`), JSON.stringify({
        persistedRole: 'reader', effectivePublishPermission: false, controlsDisabled: true, httpStatus: denied.status,
        durableMessageCount: 0, syntheticTenantsOnly: true }, null, 2));
    }
  }, 180_000);

  it('retira solo la ruta por membership y conserva el borrador bloqueado hasta su recuperación sin publicar', async () => {
    for (const width of [1440, 390]) {
      const page = await conversation(width);
      const text = `${prefix}-withdrawn-${randomUUID()}`;
      const editor = page.getByLabel(`Mensaje para ${isaTenant.target}`, { exact: true });
      await editor.fill(text);
      expect(await page.getByRole('button', { name: 'Enviar', exact: true }).isDisabled()).toBe(false);
      const withdrawn = await active().database.pool.query(
        'UPDATE memberships SET enabled=false WHERE tenant_id=$1 AND room_id=$2 AND alias=$3 AND enabled=true RETURNING alias',
        [isaTenant.tenant, isaTenant.room, isaTenant.target]);
      expect(withdrawn.rowCount).toBe(1);
      try {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.getByText('El operador y el destinatario no comparten un room habilitado.', { exact: true }).waitFor({ timeout: 20_000 });
        expect(await editor.isDisabled()).toBe(true);
        expect(await editor.inputValue()).toBe(text);
        for (const label of ['Enviar', 'Adjuntar archivos', 'Grabar nota de voz']) {
          expect(await page.getByRole('button', { name: label, exact: true }).isDisabled()).toBe(true);
        }
        const topology = await apiGet(page, '/v3/console/topology');
        expect(topology.status).toBe(200);
        expect((topology.body as TopologySnapshot).tenants?.find((tenant) => tenant.id === isaTenant.tenant)
          ?.rooms?.find((room) => room.id === isaTenant.room)?.members?.find((member) => member.alias === isaTenant.target)?.enabled).toBe(false);
        const persisted = await active().database.pool.query<{ enabled: boolean }>(
          'SELECT enabled FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias=$3',
          [isaTenant.tenant, isaTenant.room, isaTenant.target]);
        expect(persisted.rows).toEqual([{ enabled: false }]);
        await noPublication(text);
        await screenshot(page, 'route-withdrawn', width);
      } finally {
        const restored = await active().database.pool.query(
          'UPDATE memberships SET enabled=true WHERE tenant_id=$1 AND room_id=$2 AND alias=$3 RETURNING alias',
          [isaTenant.tenant, isaTenant.room, isaTenant.target]);
        expect(restored.rowCount).toBe(1);
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect.poll(async () => editor.isDisabled(), { timeout: 20_000 }).toBe(false);
      expect(await editor.inputValue()).toBe(text);
      expect(await page.getByRole('button', { name: 'Enviar', exact: true }).isDisabled()).toBe(false);
      await noPublication(text);
      await screenshot(page, 'route-restored', width);
      await writeFile(join(receipts, `permissions-route-${String(width)}.json`), JSON.stringify({
        withdrawnMembershipBlocked: true, restoredMembershipEnabled: true, draftPreserved: true,
        durableMessageCount: 0, roomsUnchanged: true }, null, 2));
    }
  }, 180_000);

  it('abre Perfil y contexto desde el menú y vuelve por historial y enlace conservando borrador y foco', async () => {
    for (const width of [1440, 390]) {
      const page = await conversation(width);
      const text = `${prefix}-context-${randomUUID()}`;
      const editor = page.getByLabel(`Mensaje para ${isaTenant.target}`, { exact: true });
      const options = page.getByRole('button', { name: 'Opciones de la conversación', exact: true });
      await editor.fill(text);
      await options.click();
      const context = page.getByRole('menuitem', { name: 'Perfil y contexto', exact: true });
      await context.press('Escape');
      await context.waitFor({ state: 'hidden' });
      await expect.poll(async () => options.evaluate((element) => document.activeElement === element)).toBe(true);
      await options.click();
      await context.click();
      const heading = page.getByRole('heading', { name: `Perfil y contexto de ${isaTenant.target}`, exact: true });
      await heading.waitFor({ timeout: 20_000 });
      expect(new URL(page.url()).search).toBe('?view=context');
      await expect.poll(async () => heading.evaluate((element) => document.activeElement === element)).toBe(true);
      const back = page.getByRole('link', { name: 'Volver a la conversación', exact: true });
      expect(await back.evaluate((element) => element.getAttribute('href'))).toBe(conversationPath);
      await screenshot(page, 'context-open', width);
      await page.evaluate(() => { history.back(); });
      await editor.waitFor({ timeout: 20_000 });
      expect(new URL(page.url()).search).toBe('');
      expect(await editor.inputValue()).toBe(text);
      await expect.poll(async () => options.evaluate((element) => document.activeElement === element)).toBe(true);
      await page.evaluate(() => { history.forward(); });
      await heading.waitFor({ timeout: 20_000 });
      expect(new URL(page.url()).search).toBe('?view=context');
      await back.click();
      await editor.waitFor({ timeout: 20_000 });
      expect(new URL(page.url()).pathname).toBe(conversationPath);
      expect(new URL(page.url()).search).toBe('');
      expect(await editor.inputValue()).toBe(text);
      await expect.poll(async () => options.evaluate((element) => document.activeElement === element)).toBe(true);
      await noPublication(text);
      await screenshot(page, 'context-returned', width);
    }
  }, 180_000);
});
