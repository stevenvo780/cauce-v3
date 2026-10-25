import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isaTenant, newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, HERMETIC_INSTANCE_RULES, login, type V4Page,
} from './v4-console-real-browser.helpers.js';
import {
  companiesReceiptDirectory, companyCapture, companyPerson, companyRow, companyState,
  confirmCompanyState, createCompany, openCompanies,
} from './v4-acceso-companies.helpers.js';
import { exerciseAccessTables, exerciseChainPolicy } from './v4-acceso-companies-config.helpers.js';
import { exerciseRolePolicies } from './v4-acceso-role-policies.helpers.js';

const owner = companyPerson('clean');
const blocked = companyPerson('blocked');
const homeOwner = companyPerson('home');
const errors = new BrowserErrorLog(HERMETIC_INSTANCE_RULES);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let page: V4Page | undefined;
let backupDirectory = '';

function active() { if (!fixture) throw new Error('companies fixture is not initialized'); return fixture; }
function view() { if (!page) throw new Error('platform browser is not initialized'); return page; }

afterEach(async ({ task }) => {
  if (page && task.result?.state === 'fail') {
    await companyCapture(page, `failed-${task.name.replaceAll(/[^a-z0-9]+/giu, '-').slice(0, 70)}`);
  }
});

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') throw new Error('isolated PostgreSQL and mocks=false are required');
  backupDirectory = await mkdtemp(join(tmpdir(), 'zz-canary-e2e-a1-acceso-1025b-backups-'));
  vi.stubEnv('CAUCE_SPACE_BACKUP_DIRECTORY', backupDirectory);
  fixture = await startConsoleFunctionalFixture();
  const granted = await active().database.adminPool.query('INSERT INTO platform_admins(human_id) SELECT id FROM console_users WHERE email=$1', [isaTenant.email]);
  expect(granted.rowCount).toBe(1);
  page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
  (page as V4Page & { setDefaultTimeout(timeout: number): void }).setDefaultTimeout(90_000);
  errors.watch(view(), 'platform');
  await login(view(), active().baseUrl, { ...companyPerson('platform'), email: isaTenant.email, password: isaTenant.password });
  await openCompanies(view(), active().baseUrl);
}, 600_000);

afterAll(async () => {
  try {
    await mkdir(companiesReceiptDirectory, { recursive: true });
    await writeFile(join(companiesReceiptDirectory, 'browser-console.json'), JSON.stringify({ errors: errors.unexpected, trace: errors.trace, ignored: Object.fromEntries(errors.ignored) }, null, 2));
    await fixture?.close();
  } finally {
    vi.unstubAllEnvs();
    if (backupDirectory) await rm(backupDirectory, { recursive: true, force: true });
  }
}, 180_000);

describe('empresas de plataforma y ajustes con Chromium, gateway y PostgreSQL reales', () => {
  it('anuncia la lectura pendiente y bloquea el alta hasta completar una consulta real', async () => {
    const browser = view();
    const blocker = await active().database.adminPool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE companies IN ACCESS EXCLUSIVE MODE');
      await browser.getByRole('button', { name: 'Releer empresas', exact: true }).click();
      await browser.getByText('Leyendo empresas…', { exact: true }).waitFor({ timeout: 20_000 });
      expect(await browser.getByRole('button', { name: 'Crear empresa', exact: true }).isDisabled()).toBe(true);
      await companyCapture(browser, '00-loading-desktop-1440x900');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    await expect.poll(() => browser.getByRole('button', { name: 'Crear empresa', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
  }, 60_000);

  it('crea empresa y dueño, relee el alta y cancela formularios sin escribir', async () => {
    const browser = view();
    const panel = browser.getByRole('region', { name: 'Empresas', exact: true });
    await panel.getByRole('button', { name: 'Crear empresa', exact: true }).click();
    await panel.getByRole('form', { name: 'Crear empresa y dueño', exact: true }).getByRole('button', { name: 'Cancelar', exact: true }).click();
    expect(await panel.getByRole('form', { name: 'Crear empresa y dueño', exact: true }).count()).toBe(0);
    await createCompany(browser, owner);
    const persisted = await active().database.pool.query<{ company_id: string; role: string }>(
      `SELECT person.company_id,admin.role FROM console_users person JOIN company_admins admin ON admin.human_id=person.id AND admin.company_id=person.company_id WHERE person.email=$1`, [owner.email]);
    expect(persisted.rows).toEqual([{ company_id: owner.company.slug, role: 'owner' }]);
    await panel.getByRole('button', { name: 'Releer empresas', exact: true }).click();
    await companyState(browser, owner.company.slug, 'enabled');
    await companyCapture(browser, '01-create-desktop-1440x900');
    await companyRow(browser, owner.company.name).getByRole('button', { name: 'Editar', exact: true }).click();
    await panel.getByLabel('Nombre de empresa', { exact: true }).fill('Cambio descartado');
    await panel.getByRole('button', { name: 'Cancelar', exact: true }).click();
    expect((await apiGet(browser, `/v3/console/companies/${owner.company.slug}`)).body.name).toBe(owner.company.name);
  }, 120_000);

  it('resuelve un conflicto real entre dos pestañas conservando o descartando el borrador', async () => {
    const browser = view();
    const peer = asV4Page(await browser.context().newPage());
    errors.watch(peer, 'peer');
    await openCompanies(peer, active().baseUrl);
    await companyRow(browser, owner.company.name).getByRole('button', { name: 'Editar', exact: true }).click();
    await browser.getByLabel('Nombre de empresa', { exact: true }).fill(`${owner.company.name} borrador`);
    await companyRow(peer, owner.company.name).getByRole('button', { name: 'Editar', exact: true }).click();
    await peer.getByLabel('Nombre de empresa', { exact: true }).fill(`${owner.company.name} remoto`);
    await peer.getByRole('button', { name: 'Guardar empresa', exact: true }).click();
    await peer.getByText('Empresa actualizada.', { exact: true }).waitFor({ timeout: 20_000 });
    errors.expectHttpError(`/v3/console/companies/${owner.company.slug}`, 409);
    await browser.getByRole('button', { name: 'Guardar empresa', exact: true }).click();
    const conflict = browser.getByRole('group', { name: 'Conflicto de versión', exact: true });
    await conflict.waitFor({ timeout: 20_000 });
    expect(await browser.getByLabel('Nombre de empresa', { exact: true }).inputValue()).toBe(`${owner.company.name} borrador`);
    await companyCapture(browser, '02-conflict-desktop-1440x900');
    await conflict.getByRole('button', { name: 'Descartar mis cambios', exact: true }).click();
    expect(await browser.getByLabel('Nombre de empresa', { exact: true }).inputValue()).toBe(`${owner.company.name} remoto`);
    await browser.getByLabel('Nombre de empresa', { exact: true }).fill(owner.company.name);
    await browser.getByRole('button', { name: 'Guardar empresa', exact: true }).click();
    await browser.getByText('Empresa actualizada.', { exact: true }).waitFor({ timeout: 20_000 });
    await openCompanies(peer, active().baseUrl);
    await companyRow(browser, owner.company.name).getByRole('button', { name: 'Editar', exact: true }).click();
    await browser.getByLabel('Nombre de empresa', { exact: true }).fill(owner.company.name);
    await companyRow(peer, owner.company.name).getByRole('button', { name: 'Editar', exact: true }).click();
    await peer.getByLabel('Nombre de empresa', { exact: true }).fill(`${owner.company.name} paralelo`);
    await peer.getByRole('button', { name: 'Guardar empresa', exact: true }).click();
    await peer.getByText('Empresa actualizada.', { exact: true }).waitFor({ timeout: 20_000 });
    errors.expectHttpError(`/v3/console/companies/${owner.company.slug}`, 409);
    await browser.getByRole('button', { name: 'Guardar empresa', exact: true }).click();
    await conflict.waitFor({ timeout: 20_000 });
    await conflict.getByRole('button', { name: 'Releer y reintentar con mis cambios', exact: true }).click();
    await conflict.waitFor({ state: 'hidden', timeout: 20_000 });
    const persisted = await active().database.pool.query<{ name: string; version: number }>('SELECT name,version::int AS version FROM companies WHERE id=$1', [owner.company.slug]);
    expect(persisted.rows).toEqual([{ name: owner.company.name, version: 5 }]);
  }, 120_000);

  it('deshabilita y habilita, retira y restaura con confirmación exacta y conserva los datos', async () => {
    const browser = view();
    await companyRow(browser, owner.company.name).getByRole('button', { name: 'Retirar', exact: true }).click();
    await browser.getByRole('region', { name: 'Confirmar estado de empresa', exact: true }).getByRole('button', { name: 'Cancelar', exact: true }).click();
    await companyState(browser, owner.company.slug, 'enabled');
    await confirmCompanyState(browser, owner, 'Deshabilitar', 'disabled');
    await companyCapture(browser, '03-disabled-desktop-1440x900');
    await confirmCompanyState(browser, owner, 'Habilitar', 'enabled');
    await confirmCompanyState(browser, owner, 'Retirar', 'retired');
    expect((await active().database.pool.query('SELECT 1 FROM console_users WHERE email=$1', [owner.email])).rowCount).toBe(1);
    await companyCapture(browser, '04-retired-desktop-1440x900');
    await confirmCompanyState(browser, owner, 'Restaurar', 'enabled');
    await browser.reload({ waitUntil: 'domcontentloaded' });
    await companyRow(browser, owner.company.name).getByText('Activa · versión 9', { exact: true }).waitFor({ timeout: 20_000 });
  }, 120_000);

  it('retirar el origen advierte la pérdida de acceso y restaurarlo permite volver a entrar', async () => {
    const platform = view();
    await openCompanies(platform, active().baseUrl);
    await createCompany(platform, homeOwner);
    const home = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
    errors.watch(home, 'own-home');
    await login(home, active().baseUrl, homeOwner);
    await home.goto(`${active().baseUrl}/config?seccion=general`, { waitUntil: 'domcontentloaded' });
    await companyRow(home, homeOwner.company.name).getByRole('button', { name: 'Retirar', exact: true }).click();
    const confirmation = home.getByRole('region', { name: 'Confirmar estado de empresa', exact: true });
    await confirmation.getByText('Es tu empresa de origen:', { exact: false }).waitFor();
    await confirmation.getByRole('textbox').fill(homeOwner.company.slug);
    await companyCapture(home, '16-own-home-warning-desktop-1440x900');
    errors.relaxForbidden('own-home');
    await confirmation.getByRole('button', { name: 'Confirmar cambio de empresa', exact: true }).click();
    await home.getByRole('heading', { name: 'Tu cuenta no tiene acceso vigente', exact: true }).waitFor({ timeout: 30_000 });
    await companyState(platform, homeOwner.company.slug, 'retired');
    expect((await active().database.pool.query('SELECT 1 FROM console_users WHERE email=$1', [homeOwner.email])).rowCount).toBe(1);
    await home.setViewportSize({ width: 390, height: 844 });
    await companyCapture(home, '17-own-home-retired-mobile-390x844');
    await openCompanies(platform, active().baseUrl);
    await confirmCompanyState(platform, homeOwner, 'Restaurar', 'enabled');
    await home.reload({ waitUntil: 'domcontentloaded' });
    await home.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  }, 120_000);

  it('muestra el bloqueo real de purga y conserva empresa y agente', async () => {
    const browser = view();
    await createCompany(browser, blocked);
    const registered = await active().database.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [blocked.email]);
    const hub = registered.rows[0]?.tenant_id;
    if (!hub) throw new Error('blocked company hub is missing');
    await active().database.pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,lifecycle_state,retired_at,company_id,runtime_mode)
      VALUES($1,'zz-canary-blocker','fake2','Canary blocker',false,'retired',now(),$2,'native')`, [hub, blocked.company.slug]);
    await confirmCompanyState(browser, blocked, 'Retirar', 'retired');
    await companyRow(browser, blocked.company.name).getByRole('button', { name: 'Purgar definitivamente', exact: true }).click();
    const confirmation = browser.getByRole('region', { name: 'Confirmar estado de empresa', exact: true });
    await confirmation.getByRole('textbox').fill(blocked.company.slug);
    errors.expectHttpError(`/v3/console/companies/${blocked.company.slug}/purge`, 409);
    await confirmation.getByRole('button', { name: 'Confirmar purga definitiva', exact: true }).click();
    await browser.getByRole('alert').filter({ hasText: 'Qué bloquea la purga de la empresa:' }).waitFor({ timeout: 20_000 });
    await browser.getByText('Purga el agente y sus recursos desde Flota.', { exact: false }).waitFor();
    await companyCapture(browser, '05-purge-blocked-desktop-1440x900');
    await confirmation.getByRole('button', { name: 'Cancelar', exact: true }).click();
    expect((await active().database.pool.query('SELECT 1 FROM agents WHERE tenant_id=$1 AND alias=$2', [hub, 'zz-canary-blocker'])).rowCount).toBe(1);
    await companyState(browser, blocked.company.slug, 'retired');
    await confirmCompanyState(browser, blocked, 'Restaurar', 'enabled');
  }, 120_000);

  it('purga una canaria retirada con copia JSON privada y conteos reales', async () => {
    const browser = view();
    await confirmCompanyState(browser, owner, 'Retirar', 'retired');
    await companyRow(browser, owner.company.name).getByRole('button', { name: 'Purgar definitivamente', exact: true }).click();
    const confirmation = browser.getByRole('region', { name: 'Confirmar estado de empresa', exact: true });
    const confirm = confirmation.getByRole('button', { name: 'Confirmar purga definitiva', exact: true });
    expect(await confirm.isDisabled()).toBe(true);
    await confirmation.getByRole('textbox').fill(`${owner.company.slug} `);
    expect(await confirm.isDisabled()).toBe(true);
    await companyCapture(browser, '06-purge-confirm-desktop-1440x900');
    await confirmation.getByRole('textbox').fill(owner.company.slug);
    await confirm.click();
    const receipt = browser.getByRole('status').filter({ hasText: 'purgada definitivamente.' });
    await receipt.waitFor({ timeout: 30_000 });
    await receipt.getByText('Conteos por tabla', { exact: true }).click();
    const backupPath = await receipt.locator('code').nth(1).innerText();
    expect(backupPath.startsWith(`${backupDirectory}/companies/${owner.company.slug}-`)).toBe(true);
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    const snapshot = JSON.parse(await readFile(backupPath, 'utf8')) as { company_id: string; records: Record<string, unknown[]> };
    expect(snapshot.company_id).toBe(owner.company.slug);
    expect(snapshot.records.companies).toHaveLength(1);
    expect((await active().database.pool.query('SELECT 1 FROM companies WHERE id=$1', [owner.company.slug])).rowCount).toBe(0);
    expect((await active().database.pool.query('SELECT 1 FROM console_users WHERE email=$1', [owner.email])).rowCount).toBe(0);
    expect(await companyRow(browser, owner.company.name).count()).toBe(0);
    await companyCapture(browser, '07-purge-receipt-desktop-1440x900');
    await browser.setViewportSize({ width: 390, height: 844 });
    await companyCapture(browser, '08-purge-receipt-mobile-390x844');
    await browser.setViewportSize({ width: 1440, height: 900 });
  }, 120_000);

  it('General enlaza sus cinco contadores y Acceso muestra personas y colecciones en escritorio y móvil', async () => {
    const browser = view();
    for (const [label, , heading] of [
      ['Clientes', 'espacios', 'Espacios y salas'], ['Salas', 'espacios', 'Espacios y salas'],
      ['Membresías', 'espacios', 'Espacios y salas'], ['Agentes registrados', 'agentes', 'Agentes'],
      ['Permisos entre clientes', 'acceso', 'Acceso y roles'],
    ] as const) {
      await openCompanies(browser, active().baseUrl);
      await browser.getByRole('button', { name: new RegExp(`^${label}`, 'u') }).click();
      await browser.getByRole('heading', { name: heading, exact: true }).first().waitFor({ timeout: 20_000 });
      expect(await browser.getByRole('heading', { name: heading, exact: true }).first().isVisible()).toBe(true);
    }
    await browser.getByRole('heading', { name: 'Personas', exact: true }).waitFor();
    await browser.getByRole('tabpanel', { name: 'Acceso y roles', exact: true }).getByText('¿Qué es esto?', { exact: true }).click();
    await companyCapture(browser, '09-access-desktop-1440x900');
    await browser.setViewportSize({ width: 390, height: 844 });
    await companyCapture(browser, '10-access-mobile-390x844');
    await openCompanies(browser, active().baseUrl);
    await companyCapture(browser, '11-companies-mobile-390x844');
    const overflow = await browser.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  }, 120_000);

  it('edita y previsualiza la política de cadena y persiste su límite real', async () => {
    await view().setViewportSize({ width: 1440, height: 900 });
    await openCompanies(view(), active().baseUrl);
    await exerciseChainPolicy(view(), active().database.pool);
  }, 120_000);

  it('crea, valida, edita y elimina políticas de rol de plataforma con confirmaciones reales', async () => {
    await view().setViewportSize({ width: 1440, height: 900 });
    await view().goto(`${active().baseUrl}/config?seccion=acceso`, { waitUntil: 'domcontentloaded' });
    await exerciseRolePolicies(view(), active().database.pool);
  }, 180_000);

  it('gestiona permisos entre espacios propios y destinos sin enviar avisos', async () => {
    await exerciseAccessTables(view(), active().database.pool, active().baseUrl, isaTenant.email);
  }, 180_000);

  it('no quedan errores inesperados del navegador', () => {
    errors.assertClean();
  });
});
