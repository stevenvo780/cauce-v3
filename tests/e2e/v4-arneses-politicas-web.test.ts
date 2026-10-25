import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, bodySnippet, fillRegistration, HERMETIC_INSTANCE_RULES,
  openRegistration, PATTERN_DEFECT_RULE, syntheticPerson, type IgnoredConsoleRule, type V4Locator, type V4Page, type V4Person,
} from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const evidence = join(process.cwd(), '.delegados/v4/recibos/f2-arneses-politicas-web-1025');
const roleId = `zz_visor_${run}`;

function registration(label: string): V4Person {
  const person = syntheticPerson(`catalog-${label}`, run);
  return {
    ...person,
    email: `zz-canary-${label}-${run}@example.test`,
    name: `zz-canary-${label}-${run}`,
    company: { name: `zz-canary-empresa-${label}-${run}`, slug: `zz-canary-catalog-${label}-${run}` },
  };
}

const empresa = registration('empresa');
const plataforma = registration('plataforma');

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

const errors = new BrowserErrorLog([
  ...HERMETIC_INSTANCE_RULES,
  PATTERN_DEFECT_RULE,
  expectedRoleForbidden('/v3/console/fleet/hosts', 'operator-host-inventory-403'),
  expectedRoleForbidden('/v3/console/fleet/hosts/enrollments', 'operator-host-enrollments-403'),
  expectedRoleForbidden('/v3/console/terminal/capability', 'operator-terminal-capability-403'),
  expectedRoleForbidden('/v3/console/fleet/capability', 'operator-fleet-capability-403'),
  expectedRoleForbidden('/v3/console/fleet/operations/recent', 'operator-fleet-history-403'),
]);

let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let plataformaPage: V4Page | undefined;

const active = () => { if (!fixture) throw new Error('catalog fixture is not initialized'); return fixture; };
const pool = () => active().database.pool;
const base = () => active().baseUrl;

async function freshPage(label: string): Promise<V4Page> {
  const page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
  errors.watch(page, label);
  return page;
}

async function step<T>(page: V4Page, name: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (cause) {
    throw new Error(`${name} failed at ${page.url()}: ${await bodySnippet(page)}`, { cause });
  }
}

async function register(page: V4Page, person: V4Person): Promise<void> {
  const form = await openRegistration(page, base());
  await fillRegistration(form, person);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
}

async function openConfig(page: V4Page, section: string): Promise<void> {
  await page.goto(`${base()}/config?seccion=${section}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Ajustes', exact: true }).waitFor({ timeout: 20_000 });
}

async function apiSend(
  page: V4Page, method: string, path: string, payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(async ({ method, target, body }) => {
    const session = await (await fetch('/v3/auth/session', { credentials: 'include', cache: 'no-store' }))
      .json() as { csrf_token?: string };
    const response = await fetch(target, {
      method, credentials: 'include',
      headers: { 'X-Cauce-Console': '1', 'X-CSRF-Token': session.csrf_token ?? '' },
      ...(body === undefined ? {} : { body, headers: { 'Content-Type': 'application/json', 'X-Cauce-Console': '1', 'X-CSRF-Token': session.csrf_token ?? '' } }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
  }, { method, target: path, body: payload === undefined ? undefined : JSON.stringify(payload) });
}

function harnessIds(body: Record<string, unknown>): string[] {
  const rows = body.harness_definitions;
  if (!Array.isArray(rows)) throw new Error('configuration snapshot has no harness_definitions');
  return rows.flatMap((row) => {
    const id = (row as Record<string, unknown>).id;
    return typeof id === 'string' ? [id] : [];
  });
}

function roleIds(body: Record<string, unknown>): string[] {
  const rows = body.role_policies;
  if (!Array.isArray(rows)) throw new Error('configuration snapshot has no role_policies');
  return rows.flatMap((row) => {
    const role = (row as Record<string, unknown>).role;
    return typeof role === 'string' ? [role] : [];
  });
}

function selectValues(locator: V4Locator): Promise<string[]> {
  return locator.evaluate((element) => Array.from(
    (element as unknown as HTMLSelectElement).options, (option) => option.value).filter(Boolean));
}

/** Opens the agent-create wizard far enough to read the harness options it offers, then leaves. */
async function altaHarnessOptions(page: V4Page): Promise<string[]> {
  await openConfig(page, 'agentes');
  await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
  const tenant = page.getByLabel('Espacio de trabajo');
  await tenant.waitFor({ timeout: 20_000 });
  const tenants = await selectValues(tenant);
  const firstTenant = tenants[0];
  if (firstTenant === undefined) throw new Error('the create wizard offers no tenant');
  await tenant.selectOption(firstTenant);
  await page.getByLabel('Alias', { exact: true }).fill(`zz-probe-${run}`);
  await page.getByLabel('Nombre visible', { exact: true }).fill('Sonda E2E');
  await page.getByRole('button', { name: 'Siguiente', exact: true }).click();
  const harness = page.getByLabel('Tipo de agente (opcional)');
  await harness.waitFor({ timeout: 20_000 });
  return selectValues(harness);
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  await mkdir(evidence, { recursive: true });
  fixture = await startConsoleFunctionalFixture();
}, 600_000);

afterAll(async () => { await fixture?.close(); }, 180_000);

describe('CRUD web de definiciones de arnés y políticas de rol', () => {
  it('un admin de empresa sin autoridad de plataforma solo lee y recibe 403 al escribir', async () => {
    const page = await freshPage('empresa');
    await step(page, 'registro de empresa', () => register(page, empresa));
    await step(page, 'arneses de solo lectura', async () => {
      await openConfig(page, 'arneses');
      await page.getByText(/Solo el administrador de plataforma puede crear, editar o borrar definiciones de arnés/)
        .waitFor({ timeout: 20_000 });
      expect(await page.getByRole('button', { name: 'Crear definición de arnés', exact: true }).count()).toBe(0);
      await page.screenshot({ path: join(evidence, '01-arneses-solo-lectura.png'), fullPage: true });
    });
    await step(page, 'API de plataforma denegada', async () => {
      errors.expectHttpError('/v3/console/platform/catalog', 403);
      const catalog = await apiGet(page, '/v3/console/platform/catalog');
      expect(catalog.status).toBe(403);
      errors.expectHttpError('/v3/console/platform/harnesses', 403);
      const create = await apiSend(page, 'POST', '/v3/console/platform/harnesses', {
        id: 'muse', display_name: 'Intruso', capabilities: ['messages.receive'], expected_revision: 0,
      });
      expect(create.status).toBe(403);
      errors.expectHttpError('/v3/console/platform/role-policies', 403);
      const role = await apiSend(page, 'POST', '/v3/console/platform/role-policies', {
        role: roleId, allow_read: true, expected_revision: 0,
      });
      expect(role.status).toBe(403);
      const snapshot = await apiGet(page, '/v3/console/config');
      expect(snapshot.status).toBe(200);
      expect(roleIds(snapshot.body)).not.toContain(roleId);
    });
  });

  it('el administrador de plataforma borra y recrea muse y el alta de agente lo refleja', async () => {
    const page = await freshPage('plataforma');
    plataformaPage = page;
    await step(page, 'registro de plataforma', () => register(page, plataforma));
    await pool().query(
      `INSERT INTO platform_admins(human_id)
       SELECT id FROM console_users WHERE email_normalized=$1
         AND NOT EXISTS (SELECT 1 FROM platform_admins WHERE human_id=console_users.id)`,
      [plataforma.email.toLowerCase()],
    );
    const session = await apiGet(page, '/v3/auth/session');
    expect((session.body.authority as Record<string, unknown> | undefined)?.role).toBe('platform_admin');

    await step(page, 'el alta ofrece muse antes de tocar el catálogo', async () => {
      expect(await altaHarnessOptions(page)).toContain('muse');
    });

    await step(page, 'borrar muse desde la web', async () => {
      await openConfig(page, 'arneses');
      await page.getByRole('button', { name: 'Eliminar arnés muse', exact: true }).click();
      await page.getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();
      await page.getByText(/Aplicado en revisión/).waitFor({ timeout: 20_000 });
      await expect.poll(async () => page.getByRole('button', { name: 'Editar arnés muse', exact: true }).count())
        .toBe(0);
      const snapshot = await apiGet(page, '/v3/console/config');
      expect(harnessIds(snapshot.body)).not.toContain('muse');
    });

    await step(page, 'el alta ya no ofrece muse', async () => {
      expect(await altaHarnessOptions(page)).not.toContain('muse');
    });

    await step(page, 'crear muse desde la web', async () => {
      await openConfig(page, 'arneses');
      await page.getByRole('button', { name: 'Crear definición de arnés', exact: true }).click();
      await page.getByLabel('Id del arnés', { exact: true }).selectOption('muse');
      await page.getByLabel('Nombre visible', { exact: true }).fill('Muse E2E');
      await page.getByLabel('Capacidad jobs.batch', { exact: true }).check();
      await page.getByRole('button', { name: 'Confirmar creación', exact: true }).click();
      await page.getByText(/Aplicado en revisión/).waitFor({ timeout: 20_000 });
      await page.getByRole('button', { name: 'Editar arnés muse', exact: true }).waitFor({ timeout: 20_000 });
      await page.screenshot({ path: join(evidence, '02-arneses-creado.png'), fullPage: true });
      const snapshot = await apiGet(page, '/v3/console/config');
      expect(harnessIds(snapshot.body)).toContain('muse');
      const stored = await pool().query<{ display_name: string; enabled: boolean }>(
        'SELECT display_name,enabled FROM harness_definitions WHERE id=$1', ['muse']);
      expect(stored.rows).toEqual([{ display_name: 'Muse E2E', enabled: true }]);
    });

    await step(page, 'el alta vuelve a ofrecer muse', async () => {
      expect(await altaHarnessOptions(page)).toContain('muse');
    });
  });

  it('editar usa CAS: aplica sobre la revisión actual y rechaza la vencida', async () => {
    const page = plataformaPage;
    if (!page) throw new Error('platform page is not initialized');
    await step(page, 'editar muse desde la web', async () => {
      await openConfig(page, 'arneses');
      await page.getByRole('button', { name: 'Editar arnés muse', exact: true }).click();
      await page.getByLabel('Nombre visible', { exact: true }).fill('Muse Editado');
      await page.getByRole('button', { name: 'Confirmar edición', exact: true }).click();
      await page.getByText(/Aplicado en revisión/).waitFor({ timeout: 20_000 });
      const stored = await pool().query<{ display_name: string }>(
        'SELECT display_name FROM harness_definitions WHERE id=$1', ['muse']);
      expect(stored.rows).toEqual([{ display_name: 'Muse Editado' }]);
    });
    await step(page, 'CAS vencido da 409 en español', async () => {
      errors.expectHttpError('/v3/console/platform/harnesses/muse', 409);
      const stale = await apiSend(page, 'PATCH', '/v3/console/platform/harnesses/muse', {
        display_name: 'Vencido', expected_revision: 0,
      });
      expect(stale.status).toBe(409);
      expect(String(stale.body.message)).toContain('Conflicto de revisión');
      const stored = await pool().query<{ display_name: string }>(
        'SELECT display_name FROM harness_definitions WHERE id=$1', ['muse']);
      expect(stored.rows).toEqual([{ display_name: 'Muse Editado' }]);
    });
    await step(page, 'auditoría y revisiones de plataforma quedaron registradas', async () => {
      const revisions = await pool().query<{ count: string }>(
        "SELECT count(*)::text AS count FROM config_revisions WHERE scope='platform'");
      expect(Number(revisions.rows[0]?.count ?? '0')).toBeGreaterThanOrEqual(3);
      const audits = await pool().query<{ count: string }>(
        "SELECT count(*)::text AS count FROM audit_events WHERE action='config.change' AND company_id IS NULL");
      expect(Number(audits.rows[0]?.count ?? '0')).toBeGreaterThanOrEqual(3);
    });
  });

  it('políticas de rol: crear, editar y borrar desde Acceso y roles, con borrado bloqueado si está en uso', async () => {
    const page = plataformaPage;
    if (!page) throw new Error('platform page is not initialized');
    await step(page, 'crear el rol desde la web', async () => {
      await openConfig(page, 'acceso');
      await page.getByRole('button', { name: 'Crear política de rol', exact: true }).click();
      await page.getByLabel('Id del rol', { exact: true }).fill(roleId);
      await page.getByLabel('Permitir lectura', { exact: true }).check();
      await page.getByRole('button', { name: 'Confirmar creación', exact: true }).click();
      await page.getByText(/Aplicado en revisión/).waitFor({ timeout: 20_000 });
      await page.getByRole('button', { name: `Editar rol ${roleId}`, exact: true }).waitFor({ timeout: 20_000 });
      await page.screenshot({ path: join(evidence, '03-politicas-rol.png'), fullPage: true });
      const snapshot = await apiGet(page, '/v3/console/config');
      expect(roleIds(snapshot.body)).toContain(roleId);
    });
    await step(page, 'editar el rol desde la web', async () => {
      await page.getByRole('button', { name: `Editar rol ${roleId}`, exact: true }).click();
      await page.getByLabel('Permitir ruta', { exact: true }).check();
      await page.getByRole('button', { name: 'Confirmar edición', exact: true }).click();
      await page.getByText(/Aplicado en revisión/).waitFor({ timeout: 20_000 });
      const stored = await pool().query<{ allow_route: boolean; allow_read: boolean }>(
        'SELECT allow_route,allow_read FROM role_policies WHERE role=$1', [roleId]);
      expect(stored.rows).toEqual([{ allow_route: true, allow_read: true }]);
    });
    await step(page, 'borrar operator está bloqueado por sus membresías', async () => {
      const catalog = await apiGet(page, '/v3/console/platform/catalog');
      expect(catalog.status).toBe(200);
      const revision = catalog.body.revision;
      if (typeof revision !== 'number') throw new Error('platform catalog has no revision');
      errors.expectHttpError('/v3/console/platform/role-policies/operator', 409);
      const blocked = await apiSend(
        page, 'DELETE', `/v3/console/platform/role-policies/operator?expected_revision=${String(revision)}`);
      expect(blocked.status).toBe(409);
      const snapshot = await apiGet(page, '/v3/console/config');
      expect(roleIds(snapshot.body)).toContain('operator');
    });
    await step(page, 'borrar el rol creado desde la web', async () => {
      await page.getByRole('button', { name: `Eliminar rol ${roleId}`, exact: true }).click();
      await page.getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();
      await page.getByText(/Aplicado en revisión/).waitFor({ timeout: 20_000 });
      const snapshot = await apiGet(page, '/v3/console/config');
      expect(roleIds(snapshot.body)).not.toContain(roleId);
      const stored = await pool().query('SELECT 1 FROM role_policies WHERE role=$1', [roleId]);
      expect(stored.rowCount).toBe(0);
    });
    errors.assertClean();
  });
});
