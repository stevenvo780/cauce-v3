import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, bodySnippet, fillRegistration, HERMETIC_INSTANCE_RULES,
  login, openRegistration, PATTERN_DEFECT_RULE, syntheticPerson, type IgnoredConsoleRule, type V4Locator, type V4Page, type V4Person,
} from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
function registration(label: string): V4Person {
  const person = syntheticPerson(`admins-${label}`, run);
  const slug = `zz-canary-admins-${label}-${run}`;
  return {
    ...person,
    email: `zz-canary-${label}-${run}@example.test`,
    name: `zz-canary-${label}-${run}`,
    company: { name: `zz-canary-empresa-${label}-${run}`, slug },
  };
}

const owner = registration('owner');
const delegate = {
  email: `zz-canary-delegate-${run}@example.test`,
  name: `zz-canary-delegate-${run}`,
  password: syntheticPerson('admins-delegate', run).password,
  company: { name: '', slug: '' },
};
const agentAlias = `zz-canary-agent-${run}`;
const errors = new BrowserErrorLog([
  ...HERMETIC_INSTANCE_RULES,
  PATTERN_DEFECT_RULE,
  expectedRoleForbidden('/v3/console/fleet/hosts', 'company-operator-host-inventory-403'),
  expectedRoleForbidden('/v3/console/fleet/hosts/enrollments', 'company-operator-host-enrollments-403'),
  expectedRoleForbidden('/v3/console/terminal/capability', 'operator-terminal-capability-403'),
  expectedRoleForbidden('/v3/console/fleet/capability', 'operator-fleet-capability-403'),
  expectedRoleForbidden('/v3/console/fleet/operations/recent', 'operator-fleet-history-403'),
]);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let ownerPage: V4Page | undefined;
let hub = '';

interface CompanyAdminItem {
  user_id: string;
  email: string;
  display_name: string;
  role: 'owner' | 'admin';
  version: number;
}

interface CompanyAdminPayload {
  company_id: string;
  items: CompanyAdminItem[];
  capabilities: { grant_admin: boolean; grant_owner: boolean; revoke: boolean };
}

interface StoredAdmin { email: string; role: string; version: string }

function expectedRoleForbidden(path: string, id: string): IgnoredConsoleRule {
  return {
    id,
    reason: 'un rol sin esa capacidad recibe 403 al abrir ajustes',
    matches: (text, url) => {
      try { return text.includes('status of 403') && new URL(url).pathname === path; }
      catch { return false; }
    },
  };
}

function isAdminItem(value: unknown): value is CompanyAdminItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.user_id === 'string' && typeof row.email === 'string' && typeof row.display_name === 'string'
    && (row.role === 'owner' || row.role === 'admin')
    && typeof row.version === 'number' && Number.isSafeInteger(row.version);
}

function adminPayload(body: Record<string, unknown>): CompanyAdminPayload {
  const capabilities = body.capabilities;
  if (typeof body.company_id !== 'string' || !Array.isArray(body.items)
      || !capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new Error('company admins payload is not the expected shape');
  }
  const flags = capabilities as Record<string, unknown>;
  const items: unknown[] = body.items;
  if (!items.every(isAdminItem)
      || typeof flags.grant_admin !== 'boolean' || typeof flags.grant_owner !== 'boolean' || typeof flags.revoke !== 'boolean') {
    throw new Error('company admins payload included an invalid row');
  }
  return {
    company_id: body.company_id,
    items,
    capabilities: { grant_admin: flags.grant_admin, grant_owner: flags.grant_owner, revoke: flags.revoke },
  };
}

function sessionRole(body: Record<string, unknown>): { authenticated: boolean; role: string | null } {
  if (typeof body.authenticated !== 'boolean') throw new Error('session payload is not the expected shape');
  if (!body.authenticated || !body.authority || typeof body.authority !== 'object' || Array.isArray(body.authority)) {
    return { authenticated: body.authenticated, role: null };
  }
  const role = (body.authority as Record<string, unknown>).role;
  if (typeof role !== 'string') throw new Error('session authority role is missing');
  return { authenticated: true, role };
}

function active() {
  if (!fixture) throw new Error('V4 company-admins fixture is not initialized');
  return fixture;
}

function base() { return active().baseUrl; }

function ownerView() {
  if (!ownerPage) throw new Error('owner has no browser page');
  return ownerPage;
}

function pool() { return active().database.pool; }

async function freshPage(label: string): Promise<V4Page> {
  const page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 1000 }));
  errors.watch(page, label);
  return page;
}

async function step<T>(page: V4Page, name: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (cause) {
    throw new Error(`${name} failed at ${page.url()}: ${await bodySnippet(page)} || console=${JSON.stringify(errors.trace.slice(-12))}`, { cause });
  }
}

async function registerOwner(page: V4Page): Promise<void> {
  const form = await openRegistration(page, base());
  await fillRegistration(form, owner);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
}

async function openSection(page: V4Page, section: string): Promise<void> {
  await page.goto(`${base()}/config?seccion=${section}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Ajustes', exact: true }).waitFor({ timeout: 20_000 });
}

async function openAuthority(page: V4Page): Promise<V4Locator> {
  await openSection(page, 'general');
  const panel = page.getByRole('region', { name: 'Autoridad de empresa', exact: true });
  if (await panel.count() === 0) await page.getByRole('button', { name: 'Autoridad de empresa', exact: true }).click();
  await panel.waitFor({ timeout: 20_000 });
  return panel;
}

async function authorityChoices(page: V4Page): Promise<string[]> {
  return page.evaluate(() => {
    const form = document.querySelector('form[aria-label="Asignar autoridad de empresa"]');
    const label = Array.from(form?.querySelectorAll('label') ?? [])
      .find(candidate => candidate.firstChild?.textContent?.trim() === 'Autoridad');
    const select = label?.querySelector('select');
    if (!(select instanceof HTMLSelectElement)) return [];
    return Array.from(select.options, option => option.text);
  });
}

async function storedAdmins(): Promise<StoredAdmin[]> {
  const result = await pool().query<StoredAdmin>(
    `SELECT person.email, admin.role, admin.version::text AS version
     FROM company_admins admin JOIN console_users person ON person.id = admin.human_id
     WHERE admin.company_id = $1 ORDER BY admin.role, person.email`, [owner.company.slug]);
  return result.rows;
}

async function readAdmins(page: V4Page): Promise<{ status: number; body?: CompanyAdminPayload }> {
  const response = await apiGet(page, `/v3/console/companies/${owner.company.slug}/admins`);
  if (response.status !== 200) return { status: response.status };
  return { status: response.status, body: adminPayload(response.body) };
}

const grantedRows = (): StoredAdmin[] => [
  { email: delegate.email, role: 'admin', version: '1' },
  { email: owner.email, role: 'owner', version: '1' },
];

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  fixture = await startConsoleFunctionalFixture();
  ownerPage = await freshPage('owner');
  await registerOwner(ownerView());
  const registered = await pool().query<{ tenant_id: string; company_id: string }>(
    'SELECT tenant_id, company_id FROM console_users WHERE email = $1', [owner.email]);
  expect(registered.rows).toHaveLength(1);
  const row = registered.rows[0];
  if (!row) throw new Error('owner registration did not persist');
  hub = row.tenant_id;
  expect(row.company_id).toBe(owner.company.slug);
  expect(hub).toMatch(/^hub-[a-f0-9]+$/u);
  await pool().query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,company_id)
    VALUES($1,$2,'fake',$2,true,$3,'stev',$4,$5,$6)`,
  [hub, agentAlias, `zz-canary-runtime-${run}`, active().directory, `${active().directory}/state/${agentAlias}`, owner.company.slug]);
  await pool().query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'operator')`, [hub, agentAlias]);
}, 600_000);

afterAll(async () => { await fixture?.close(); }, 180_000);

describe('administradores de empresa V4 en navegador real contra gateway y PostgreSQL reales', () => {
  it('asigna un administrador, rechaza degradar al último dueño y revoca su acceso en un segundo contexto', async () => {
    const ownerBrowser = ownerView();
    await step(ownerBrowser, 'create a qualified operator', async () => {
      await openSection(ownerBrowser, 'acceso');
      await ownerBrowser.getByRole('heading', { name: 'Personas', exact: true }).waitFor({ timeout: 15_000 });
      await ownerBrowser.getByRole('button', { name: 'Administrar personas', exact: true }).click();
      await ownerBrowser.getByRole('button', { name: 'Crear persona', exact: true }).click();
      const form = ownerBrowser.getByRole('form', { name: 'Crear persona', exact: true });
      await form.getByLabel('Correo de acceso', { exact: true }).fill(delegate.email);
      await form.getByLabel('Nombre de persona', { exact: true }).fill(delegate.name);
      const selects = form.locator('select');
      await selects.nth(0).selectOption('operator');
      await selects.nth(1).selectOption(hub);
      await selects.nth(2).selectOption(agentAlias);
      await form.getByLabel('Contraseña inicial', { exact: true }).fill(delegate.password);
      await form.getByRole('button', { name: 'Crear cuenta de persona', exact: true }).click();
      await ownerBrowser.getByRole('status').filter({ hasText: 'Persona creada. Inventario releído.' }).waitFor({ timeout: 20_000 });
    });

    await step(ownerBrowser, 'assign company admin from the owner form', async () => {
      const panel = await openAuthority(ownerBrowser);
      expect(await authorityChoices(ownerBrowser)).toEqual(['Administrador de empresa']);
      expect(await panel.getByRole('button', { name: `Revocar autoridad de ${owner.name}`, exact: true }).isDisabled()).toBe(true);
      const form = panel.getByRole('form', { name: 'Asignar autoridad de empresa', exact: true });
      const selects = form.locator('select');
      await selects.nth(0).selectOption({ label: `${delegate.name} · ${delegate.email}` });
      await selects.nth(1).selectOption('admin');
      await form.getByRole('button', { name: 'Guardar autoridad', exact: true }).click();
      await panel.getByText('Autoridad de empresa guardada.', { exact: true }).waitFor({ timeout: 20_000 });
      await panel.getByText(`${delegate.name} · ${delegate.email} · Administrador`, { exact: true }).waitFor({ timeout: 15_000 });
    });
    expect(await storedAdmins()).toEqual(grantedRows());

    await step(ownerBrowser, 'reload keeps the granted administrator', async () => {
      const panel = await openAuthority(ownerBrowser);
      await panel.getByText(`${delegate.name} · ${delegate.email} · Administrador`, { exact: true }).waitFor({ timeout: 20_000 });
      await panel.getByText(`${owner.name} · ${owner.email} · Dueño`, { exact: true }).waitFor({ timeout: 15_000 });
    });
    expect(await storedAdmins()).toEqual(grantedRows());

    const delegateBrowser = await freshPage('delegate');
    await step(delegateBrowser, 'second context sees company-admin actions and cannot grant', async () => {
      await login(delegateBrowser, base(), delegate);
      await openSection(delegateBrowser, 'general');
      await delegateBrowser.getByText(`Administrador de empresa · ${owner.company.slug}`, { exact: true }).waitFor({ timeout: 20_000 });
      const panel = await openAuthority(delegateBrowser);
      await panel.getByText(`${delegate.name} · ${delegate.email} · Administrador`, { exact: true }).waitFor({ timeout: 15_000 });
      expect(await authorityChoices(delegateBrowser)).toEqual(['Administrador de empresa']);
      expect(await panel.getByRole('button', { name: `Revocar autoridad de ${delegate.name}`, exact: true }).isDisabled()).toBe(true);
      expect(await panel.getByRole('button', { name: `Revocar autoridad de ${owner.name}`, exact: true }).isDisabled()).toBe(true);
      const form = panel.getByRole('form', { name: 'Asignar autoridad de empresa', exact: true });
      expect(await form.locator('select').nth(0).isDisabled()).toBe(true);
      expect(await form.getByRole('button', { name: 'Guardar autoridad', exact: true }).isDisabled()).toBe(true);
      expect(await delegateBrowser.getByText('Selecciona esta empresa en el menú de cuenta', { exact: false }).count()).toBe(0);
    });
    const visible = await readAdmins(delegateBrowser);
    expect(visible.status).toBe(200);
    expect(visible.body?.capabilities).toEqual({ grant_admin: false, grant_owner: false, revoke: false });
    expect(visible.body?.items.map(item => ({ email: item.email, role: item.role, version: item.version }))).toEqual([
      { email: delegate.email, role: 'admin', version: 1 },
      { email: owner.email, role: 'owner', version: 1 },
    ]);

    await step(ownerBrowser, 'the last owner cannot be saved as administrator', async () => {
      const panel = await openAuthority(ownerBrowser);
      errors.expectHttpError(`/v3/console/companies/${owner.company.slug}/admins`, 403);
      const form = panel.getByRole('form', { name: 'Asignar autoridad de empresa', exact: true });
      const selects = form.locator('select');
      await selects.nth(0).selectOption({ label: `${owner.name} · ${owner.email}` });
      await selects.nth(1).selectOption('admin');
      await form.getByRole('button', { name: 'Guardar autoridad', exact: true }).click();
      await expect.poll(async () => panel.getByRole('alert').innerText(), { timeout: 20_000 })
        .toContain('company owner authority is required');
      expect(await panel.getByRole('button', { name: `Revocar autoridad de ${owner.name}`, exact: true }).isDisabled()).toBe(true);
    });
    expect(await storedAdmins()).toEqual(grantedRows());

    await step(ownerBrowser, 'owner revokes the delegated administrator', async () => {
      const panel = await openAuthority(ownerBrowser);
      await panel.getByRole('button', { name: `Revocar autoridad de ${delegate.name}`, exact: true }).click();
      const confirmation = panel.getByRole('region', { name: 'Confirmar revocación de autoridad', exact: true });
      await confirmation.getByRole('button', { name: 'Confirmar revocación', exact: true }).click();
      await panel.getByText('Autoridad de empresa revocada.', { exact: true }).waitFor({ timeout: 20_000 });
      expect(await panel.getByText(delegate.email, { exact: true }).count()).toBe(0);
      await panel.getByText(`${owner.name} · ${owner.email} · Dueño`, { exact: true }).waitFor({ timeout: 15_000 });
    });
    expect(await storedAdmins()).toEqual([{ email: owner.email, role: 'owner', version: '1' }]);
    const history = await pool().query<{ version: string }>(
      `SELECT versions.version::text AS version FROM company_admin_versions versions
       JOIN console_users person ON person.id = versions.human_id
       WHERE versions.company_id = $1 AND person.email = $2`, [owner.company.slug, delegate.email]);
    expect(history.rows).toEqual([{ version: '2' }]);

    await step(delegateBrowser, 'reloaded second context loses company-admin actions', async () => {
      await delegateBrowser.reload({ waitUntil: 'domcontentloaded' });
      await openSection(delegateBrowser, 'general');
      await delegateBrowser.getByText(`Operador · ${owner.company.slug}`, { exact: true }).waitFor({ timeout: 20_000 });
      expect(await delegateBrowser.getByRole('button', { name: 'Autoridad de empresa', exact: true }).isDisabled()).toBe(true);
      expect(await delegateBrowser.getByText(
        'Solo dueños, administradores de empresa y la plataforma ven y asignan la autoridad de empresa.',
        { exact: true },
      ).count()).toBe(1);
      errors.expectHttpError(`/v3/console/companies/${owner.company.slug}/admins`, 403);
      expect((await readAdmins(delegateBrowser)).status).toBe(403);
      expect(sessionRole((await apiGet(delegateBrowser, '/v3/auth/session')).body)).toEqual({ authenticated: true, role: 'tenant_operator' });
    });
    expect(await storedAdmins()).toEqual([{ email: owner.email, role: 'owner', version: '1' }]);
  }, 240_000);

  it('no quedan errores inesperados del navegador', () => {
    process.stdout.write(`V4 company admins e2e tolerated console messages: ${JSON.stringify(Object.fromEntries(errors.ignored))}\n`);
    errors.assertClean();
  });
});
