import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserPage } from './console-functional-browser.fixtures.js';
import { startAccountsAssignmentsFixture, type AccountsAssignmentsFixture } from './accounts-assignments-real-browser.fixtures.js';

const execute = promisify(execFile);
const artifactDirectory = process.env.CAUCE_E2E_ARTIFACT_DIR;
let fixture: AccountsAssignmentsFixture | undefined;

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL !== undefined
    || process.env.CAUCE_TEST_DOCKER_NETWORK !== undefined
    || process.env.CAUCE_TEST_DOCKER_NETWORK_OWNER !== undefined) {
    throw new Error('accounts reader E2E requires its own Testcontainers resources');
  }
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mock mode is not accepted by this real-browser test');
  fixture = await startAccountsAssignmentsFixture();
  process.stdout.write(
    `Accounts reader E2E owned resources: run=${fixture.runId} pg=${fixture.database.container.getId()} `
    + `browser=${fixture.browserContainer} image=${fixture.agentImageId} agent=${fixture.agentContainerId}\n`,
  );
}, 10 * 60_000);

afterAll(async () => {
  if (!fixture) return;
  const active = fixture;
  const references = [active.database.container.getId(), active.browserContainer, active.agentContainerId];
  const errors: unknown[] = [];
  try {
    await active.close();
  } catch (error) {
    errors.push(error);
  }
  const absence = await Promise.allSettled(references.map(async (reference) => {
    try {
      await execute('docker', ['inspect', '--format', '{{.Id}}', reference], { timeout: 15_000, maxBuffer: 4 * 1024 });
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      if (/no such (?:object|container)|not found/iu.test(details)) return;
      throw new Error('could not verify an owned container was removed');
    }
    throw new Error('an owned container remains after fixture cleanup');
  }));
  const failed = absence.filter((result) => result.status === 'rejected');
  for (const result of absence) {
    if (result.status === 'rejected') errors.push(result.reason);
  }
  process.stdout.write(`Accounts reader E2E cleanup: checked=${String(absence.length)} absent=${String(absence.length - failed.length)} failed=${String(failed.length)}\n`);
  if (errors.length > 0) throw new AggregateError(errors, 'accounts reader E2E cleanup failed');
});

async function loginReader(page: BrowserPage, active: AccountsAssignmentsFixture): Promise<void> {
  const response = await page.goto(active.baseUrl, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.getByLabel('Correo').waitFor({ timeout: 15_000 });
  await page.getByLabel('Correo').fill(active.readerEmail);
  await page.getByLabel('Contraseña').fill(active.readerPassword);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).locator('a[href="/messages"], a[href^="/messages/"]').waitFor({ state: 'visible', timeout: 20_000 });
}

async function openAccounts(page: BrowserPage): Promise<void> {
  const mobile = await page.evaluate(() => window.innerWidth <= 760);
  await page.getByRole('button', { name: mobile ? 'Más' : 'Gestión', exact: true }).click();
  const tools = mobile ? page.getByRole('dialog', { name: 'Gestión', exact: true }) : page.getByRole('navigation', { name: 'Navegación principal', exact: true });
  await tools.getByRole('link', { name: 'Cuentas y cuotas' }).click();
  await page.getByRole('heading', { name: 'Cuentas y cuotas', exact: true }).waitFor({ timeout: 20_000 });
}

async function saveScreenshot(page: BrowserPage, name: string): Promise<void> {
  if (!artifactDirectory) return;
  await mkdir(artifactDirectory, { recursive: true });
  await page.screenshot({ path: `${artifactDirectory}/${name}`, fullPage: false });
}

function isRequestLike(value: unknown): value is { url(): string; method(): string } {
  return value !== null && typeof value === 'object'
    && 'url' in value && typeof value.url === 'function'
    && 'method' in value && typeof value.method === 'function';
}

describe('lectura de cuentas y borradores para lectores', () => {
  it('permite inspección y navegación, bloquea borradores y no envía cambios', async () => {
    if (!fixture) throw new Error('accounts reader fixture was not initialized');
    const active = fixture;
    const outcomes: { width: number; configRead: number; accessRead: number; revisionBefore: number; revisionAfter: number; deniedWrite: number }[] = [];

    for (const viewport of [{ width: 1440, height: 950 }, { width: 360, height: 800 }]) {
      const page = await active.browserPage(viewport);
      const configReads: number[] = [];
      const accessReads: number[] = [];
      const changePostRequests: string[] = [];
      const changePostResponses: number[] = [];
      page.on('request', (value) => {
        if (!isRequestLike(value)) return;
        const path = new URL(value.url()).pathname;
        if (path === '/v3/console/config/changes' && value.method() === 'POST') {
          changePostRequests.push(value.method());
        }
      });
      page.on('response', (response) => {
        const path = new URL(response.url()).pathname;
        if (path === '/v3/console/config' && response.request().method() === 'GET') configReads.push(response.status());
        if (path === '/v3/console/access' && response.request().method() === 'GET') accessReads.push(response.status());
        if (path === '/v3/console/config/changes' && response.request().method() === 'POST') {
          changePostResponses.push(response.status());
        }
      });
      await loginReader(page, active);
      await openAccounts(page);

      const initial = await page.evaluate(async () => {
        const [accessResponse, configResponse, sessionResponse] = await Promise.all([
          fetch('/v3/console/access', { credentials: 'include' }),
          fetch('/v3/console/config', { credentials: 'include' }),
          fetch('/v3/auth/session', { credentials: 'include' }),
        ]);
        const access = await accessResponse.json() as { permissions?: string[] };
        const config = await configResponse.json() as { revision?: number };
        const session = await sessionResponse.json() as { authenticated?: boolean; csrf_token?: string };
        return {
          accessStatus: accessResponse.status,
          configStatus: configResponse.status,
          authenticated: session.authenticated,
          csrfToken: session.csrf_token,
          permissions: access.permissions ?? [],
          revision: config.revision,
        };
      });
      expect(initial.accessStatus).toBe(200);
      expect(initial.configStatus).toBe(200);
      expect(initial.authenticated).toBe(true);
      expect(initial.permissions).not.toContain('config.write');
      if (typeof initial.revision !== 'number' || typeof initial.csrfToken !== 'string') {
        throw new Error('reader session or configuration revision was unavailable');
      }

      await page.getByRole('tab', { name: 'Inventario' }).click();
      await page.getByRole('row', { name: new RegExp(active.foreignPoolAccountId, 'u') })
        .waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByRole('button', { name: `Detalle de ${active.foreignPoolAccountId}`, exact: true }).click();
      const inventoryCopy = await page.locator('body').innerText();
      expect(inventoryCopy).toContain(`No visible: la paga Jhon`);
      expect(inventoryCopy).not.toContain(active.foreignExternalMarker);
      expect(inventoryCopy).not.toContain(active.foreignCredentialLocator);

      const createForm = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .filter((button) => button.textContent.trim() === 'Nueva cuenta')
        .map((control) => control.disabled));
      expect(createForm).not.toBeNull();
      expect(createForm.length).toBeGreaterThan(0);
      expect(createForm.every(Boolean)).toBe(true);

      const editActions = await page.evaluate((accountId) => Array.from(
        document.querySelectorAll<HTMLButtonElement>('button[aria-label]'),
      ).filter((button) => button.getAttribute('aria-label')?.includes(`«${accountId}»`))
        .map((button) => ({ label: button.getAttribute('aria-label'), disabled: button.disabled })), active.foreignPoolAccountId);
      expect(editActions.length).toBeGreaterThanOrEqual(4);
      expect(editActions.every((action) => action.disabled)).toBe(true);

      const routeDetail = page.getByRole('button', { name: `Detalle de ${active.foreignPoolAccountId}` });
      await routeDetail.waitFor({ state: 'visible' });
      const expanded = await page.evaluate((accountId) => document.querySelector<HTMLButtonElement>(
        `button[aria-label="Detalle de ${accountId}"]`,
      )?.getAttribute('aria-expanded'), active.foreignPoolAccountId);
      expect(expanded).toBe('true');
      await page.getByRole('heading', { name: 'Identidad', exact: true }).waitFor({ state: 'visible' });
      expect(await page.locator('body').innerText()).not.toContain(active.foreignExternalMarker);
      expect(await page.locator('body').innerText()).not.toContain(active.foreignCredentialLocator);

      await page.getByRole('tab', { name: 'Asignaciones' }).click();
      await page.getByRole('heading', { name: 'Orden de respaldo declarado', exact: true }).waitFor({ state: 'visible' });
      const assignment = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .filter((button) => button.textContent.trim() === 'Nueva asignación')
        .map((control) => ({ disabled: control.disabled, label: control.textContent.trim() })));
      expect(assignment.length).toBeGreaterThan(0);
      expect(assignment.every((control) => control.disabled)).toBe(true);
      const matrixCell = await page.evaluate((alias) => Array.from(
        document.querySelectorAll<HTMLButtonElement>('button[aria-label]'),
      ).filter((button) => button.getAttribute('aria-label')?.startsWith(`${alias} × `))
        .map((button) => ({ label: button.getAttribute('aria-label'), disabled: button.disabled })), `Isa/${active.readerAlias}`);
      expect(matrixCell.length).toBeGreaterThan(0);
      expect(matrixCell.every((cell) => cell.disabled)).toBe(true);
      await page.getByRole('button', { name: `Isa/${active.readerAlias} × ${active.foreignPoolAccountId}: sin techo`, exact: true }).waitFor({ state: 'visible' });
      await page.getByRole('list', { name: 'Orden de fallback por agente', exact: true }).locator('li').filter({ hasText: `Isa/${active.readerAlias}` }).getByText('sin cuentas de respaldo registradas', { exact: true }).waitFor({ state: 'visible' });
      await page.getByRole('button', { name: '¿Cómo se rutea?', exact: true }).click();
      await page.getByText(/Los reintentos conservan la cuenta seleccionada\./u).waitFor({ state: 'visible' });
      const accountRouting = await page.evaluate((accountId) => Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
        .map((button) => button.getAttribute('aria-label') ?? '')
        .filter((label) => label.includes(` × ${accountId}: `)), active.foreignPoolAccountId);
      expect(accountRouting.length).toBeGreaterThan(0);
      expect(accountRouting.every((label) => label.endsWith(': sin techo'))).toBe(true);
      await page.getByRole('tab', { name: 'Consumo' }).click();
      await page.getByRole('heading', { name: 'Recolectores', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByRole('tab', { name: 'Inventario' }).click();
      await page.getByRole('row', { name: new RegExp(active.foreignPoolAccountId, 'u') }).waitFor({ state: 'visible' });

      expect(changePostRequests).toEqual([]);
      expect(changePostResponses).toEqual([]);
      const deniedWrite = await page.evaluate(async ({ revision, csrfToken }) => {
        const response = await fetch('/v3/console/config/changes', {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify({
            dry_run: true, expected_revision: revision,
            mutation: { resource: 'tenant', action: 'update', id: 'Isa', value: { display_name: 'Reader probe', enabled: true } },
          }),
        });
        return { status: response.status };
      }, { revision: initial.revision, csrfToken: initial.csrfToken });
      expect(deniedWrite.status).toBe(403);
      expect(changePostRequests).toEqual(['POST']);
      expect(changePostResponses).toEqual([403]);

      const finalRevision = await page.evaluate(async () => {
        const response = await fetch('/v3/console/config', { credentials: 'include' });
        const body = await response.json() as { revision?: number };
        return { status: response.status, revision: body.revision };
      });
      expect(finalRevision.status).toBe(200);
      if (typeof finalRevision.revision !== 'number') throw new Error('configuration reread omitted its revision');
      expect(finalRevision.revision).toBe(initial.revision);
      expect(configReads).toContain(200);
      expect(accessReads).toContain(200);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow, `accounts reader overflow at ${String(viewport.width)}px`).toBe(false);
      await saveScreenshot(page, `accounts-reader-${String(viewport.width)}.png`);
      outcomes.push({
        width: viewport.width, configRead: 200, accessRead: 200,
        revisionBefore: initial.revision, revisionAfter: finalRevision.revision, deniedWrite: deniedWrite.status,
      });
    }
    process.stdout.write(`accounts reader draft evidence ${JSON.stringify(outcomes)}\n`);
  }, 3 * 60_000);
});
