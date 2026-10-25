import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../services/gateway/src/password.js';
import { maintainConsoleUser } from '../../services/gateway/src/console-user-maintenance.js';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES,
  login, openRegistration, syntheticPerson, type V4Locator, type V4Page, type V4Person,
} from './v4-console-real-browser.helpers.js';

interface HorizontalBounds { left: number; right: number; width: number }
interface CatalogCardGeometry {
  label: string; card: HorizontalBounds; header: HorizontalBounds | null;
  parts: (HorizontalBounds & { tag: string; text: string })[];
}

const task = 'e2e-a2-agentes-1025';
const prefix = `zz-canary-${task}`;
const run = randomUUID().slice(0, 8);
const evidenceDirectory = join(process.cwd(), '.delegados/v4/recibos', task);
const provisional = syntheticPerson('agentes', run);
const person: V4Person = {
  ...provisional, name: `${prefix}-${run}`, email: `${prefix}-${run}@example.test`,
  company: { name: `${prefix}-${run}`, slug: `${prefix}-${run}` },
};
const reader: V4Person = { ...person, email: `${prefix}-reader-${run}@example.test`, password: syntheticPerson('reader', run).password };
const alias = `${prefix}-${run}`;
const cancelledAlias = `${prefix}-cancel-${run}`;
const name = `${prefix} agente ${run}`;
const accountId = `${prefix}-account-${run}`;
const pagePrefix = `${prefix}-page-${run}`;
const errors = new BrowserErrorLog(HERMETIC_INSTANCE_RULES);
const readerDeniedPaths = new Set([
  '/v3/console/terminal/capability', '/v3/console/fleet/hosts', '/v3/console/fleet/capability',
  '/v3/console/fleet/operations',
]);
const readerDeniedProbes: { path: string; method: string; status: number }[] = [];
const readerErrors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, {
  id: 'reader-capability-denied-403', reason: 'reader permission denies the terminal and fleet GET probes',
  matches: (text, url) => {
    try { return text.includes('status of 403') && readerDeniedPaths.has(new URL(url).pathname); }
    catch { return false; }
  },
}]);
const catalogGeometry: Record<string, CatalogCardGeometry[]> = {};
const receipts: Record<string, unknown> = { task, run, mocks: false, physicalExecutor: false, screenshots: [], catalogGeometry };
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let page: V4Page | undefined;
let tenant = '';

const active = () => { if (!fixture) throw new Error('agent settings fixture is unavailable'); return fixture; };
const browser = () => { if (!page) throw new Error('agent settings browser is unavailable'); return page; };
const pool = () => active().database.pool;
const ref = () => `${tenant}/${alias}`;
const sheet = () => browser().getByRole('dialog', { name, exact: true });

async function step<T>(label: string, action: () => Promise<T>, target = browser()): Promise<T> {
  try { return await action(); }
  catch (cause) {
    const failure = `failure-${run}-${label.replaceAll(/[^a-z0-9]+/gu, '-')}`;
    const body = await target.locator('body').innerText().catch(() => 'Page text unavailable');
    const detail = cause instanceof Error ? cause.stack ?? cause.message : String(cause);
    const redact = (text: string) => [person.password, reader.password].reduce((safe, secret) => safe.replaceAll(secret, '[REDACTED]'), text);
    await Promise.allSettled([
      writeFile(join(evidenceDirectory, `${failure}.txt`), redact(`${label}\n${detail}\n\n${body}\n`), { mode: 0o600 }),
      target.screenshot({ path: join(evidenceDirectory, `${failure}.png`), fullPage: true }),
      permissionReceipt(failure, target),
    ]);
    throw new Error(`${label}: ${redact(cause instanceof Error ? cause.message : String(cause))}\nEvidence: ${failure}.txt`, { cause });
  }
}

async function permissionReceipt(label: string, target = browser()): Promise<{ status: number; permissions: string[] }> {
  const response = await apiGet(target, '/v3/console/access');
  const raw = response.body.permissions;
  const permissions = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : [];
  const safe = { status: response.status, permissions };
  await writeFile(join(evidenceDirectory, `${label}-access.json`), JSON.stringify(safe, null, 2) + '\n', { mode: 0o600 });
  return safe;
}

async function capture(label: string, target = browser(), focus?: V4Locator): Promise<void> {
  for (const [device, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]] as const) {
    await target.setViewportSize({ width, height });
    if (focus) await focus.evaluate(element => { element.scrollIntoView({ block: 'center' }); });
    if (label === '18-ampliaciones-recursos-borrador') await assertCatalogGeometry(target, width, height);
    await target.screenshot({ path: join(evidenceDirectory, `${label}-${device}.png`), fullPage: true });
    (receipts.screenshots as string[]).push(`${label}-${device}.png`);
  }
  await target.setViewportSize({ width: 1440, height: 900 });
}

async function assertCatalogGeometry(target: V4Page, width: number, height: number): Promise<void> {
  const geometry = await target.evaluate<CatalogCardGeometry[]>(() => {
    const bounds = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    };
    return Array.from(document.querySelectorAll('section[aria-label="Añadir ampliación"] ul > li')).map(card => {
      const header = card.querySelector(':scope > span');
      return {
        label: card.querySelector('strong')?.textContent.trim() ?? '', card: bounds(card),
        header: header ? bounds(header) : null,
        parts: Array.from(header?.children ?? []).map(part => ({
          ...bounds(part), tag: part.tagName, text: part.textContent.trim(),
        })),
      };
    });
  });
  catalogGeometry[`${String(width)}x${String(height)}`] = geometry;
  expect(geometry).toHaveLength(11);
  for (const entry of geometry) {
    expect(entry.card.width, `${entry.label}: card width`).toBeGreaterThan(0);
    if (!entry.header) throw new Error(`${entry.label}: catalog header is missing`);
    expect(entry.parts, `${entry.label}: title and risk pill`).toHaveLength(2);
    for (const part of [entry.header, ...entry.parts]) {
      expect(part.left, `${entry.label}: left containment at ${String(width)}`).toBeGreaterThanOrEqual(entry.card.left - 1);
      expect(part.right, `${entry.label}: right containment at ${String(width)}`).toBeLessThanOrEqual(entry.card.right + 1);
    }
  }
}

async function openAgents(target = browser(), query = ''): Promise<void> {
  await target.goto(`${active().baseUrl}/config?seccion=agentes${query}`, { waitUntil: 'domcontentloaded' });
  if (new URLSearchParams(query).has('agente')) {
    await target.locator('section[aria-label="Tus agentes"]').waitFor({ state: 'attached', timeout: 20_000 });
  } else await target.getByRole('heading', { name: 'Tus agentes', exact: true }).waitFor({ timeout: 20_000 });
}

async function openSheet(tab?: 'operacion'): Promise<void> {
  await openAgents(browser(), `&agente=${encodeURIComponent(ref())}${tab ? '&ficha=operacion' : ''}`);
  await sheet().waitFor({ timeout: 20_000 });
}

async function storedAgent(agentAlias = alias): Promise<Record<string, unknown>[]> {
  return (await pool().query(`SELECT alias,display_name,enabled,max_concurrent_deliveries,
    host_id,container_name,extensions FROM agents WHERE tenant_id=$1 AND alias=$2`, [tenant, agentAlias])).rows as Record<string, unknown>[];
}

async function bindingRows(): Promise<Record<string, unknown>[]> {
  return (await pool().query(`SELECT account_id,priority,enabled FROM agent_account_bindings
    WHERE tenant_id=$1 AND agent_alias=$2`, [tenant, alias])).rows as Record<string, unknown>[];
}

async function configRevision(): Promise<number> {
  const response = await apiGet(browser(), '/v3/console/config');
  expect(response.status).toBe(200);
  if (typeof response.body.revision !== 'number') throw new Error('configuration revision is unavailable');
  return response.body.revision;
}

async function next(dialog: V4Locator): Promise<void> {
  await dialog.getByRole('button', { name: 'Siguiente', exact: true }).click();
}

beforeAll(async () => {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.CAUCE_TEST_DATABASE_URL
      || process.env.DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') {
    throw new Error('agent settings E2E requires isolated Testcontainers PostgreSQL and mocks=false');
  }
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  fixture = await startConsoleFunctionalFixture();
  page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
  errors.watch(browser(), 'agent-owner');
  const registration = await openRegistration(browser(), active().baseUrl);
  await fillRegistration(registration, person);
  await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await browser().getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  const result = await pool().query<{ tenant_id: string; company_id: string }>(
    'SELECT tenant_id,company_id FROM console_users WHERE email=$1', [person.email]);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]?.company_id).toBe(person.company.slug);
  tenant = result.rows[0]?.tenant_id ?? '';
  expect(tenant).toMatch(/^hub-[a-f0-9]+$/u);
  await pool().query(`INSERT INTO agents(tenant_id,alias,display_name,enabled,company_id)
    SELECT $1,$2||'-'||lpad(position::text,2,'0'),$2||'-'||lpad(position::text,2,'0'),false,$3
    FROM generate_series(1,13) position`, [tenant, pagePrefix, person.company.slug]);
  await pool().query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,label,
    credential_ref_kind,credential_ref,enabled,company_id)
    VALUES($1,'codex',$1,$2,$1,'secret_manager',$3,true,$4)`,
  [accountId, tenant, `op:zz-canary/${task}/${run}`, person.company.slug]);
  const readerAlias = `${prefix}-reader-${run}`;
  await pool().query('INSERT INTO agents(tenant_id,alias,enabled,company_id) VALUES($1,$2,false,$3)',
    [tenant, readerAlias, person.company.slug]);
  await pool().query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')", [tenant, readerAlias]);
  await maintainConsoleUser(pool(), { email: reader.email, name: `${prefix} lector`, role: 'reader',
    tenant, alias: readerAlias, updateOnly: false, activate: true }, await hashPassword(reader.password));
  receipts.company = person.company.slug;
  receipts.tenant = tenant;
}, 600_000);

afterAll(async () => {
  try {
    await writeFile(join(evidenceDirectory, 'settings-receipt.json'), JSON.stringify({
      ...receipts, browserErrors: errors.unexpected, ignoredConsoleRules: Object.fromEntries(errors.ignored),
      readerBrowserErrors: readerErrors.unexpected, readerIgnoredConsoleRules: Object.fromEntries(readerErrors.ignored),
      readerDeniedProbes, readerDeniedCounts: Object.fromEntries([...readerDeniedPaths].map(path => [path,
        readerDeniedProbes.filter(probe => probe.path === path).length])),
    }, null, 2) + '\n', { mode: 0o600 });
  } finally { await fixture?.close(); }
}, 180_000);

describe.sequential('Agentes en Ajustes con Chromium, gateway y PostgreSQL reales', () => {
  it('valida cada paso, conserva el borrador al volver y cierra el alta sin persistirla', async () => {
    await step('wizard validation and cancellation', async () => {
      await openAgents();
      receipts.ownerAccess = await permissionReceipt('owner');
      const revision = await configRevision();
      await browser().getByRole('button', { name: 'Añadir agente', exact: true }).click();
      const dialog = browser().getByRole('dialog', { name: 'Añadir agente', exact: true });
      await next(dialog);
      await dialog.getByRole('alert').filter({ hasText: 'Elige un espacio de trabajo' }).waitFor();
      await dialog.getByRole('combobox', { name: 'Espacio de trabajo', exact: true }).selectOption(tenant);
      await dialog.getByLabel('Alias', { exact: true }).fill('Alias Inválido');
      await next(dialog);
      await dialog.getByRole('alert').filter({ hasText: 'El alias debe empezar' }).waitFor();
      await dialog.getByLabel('Alias', { exact: true }).fill(cancelledAlias);
      await next(dialog);
      await dialog.getByRole('alert').filter({ hasText: 'Indica un nombre visible' }).waitFor();
      await dialog.getByLabel('Nombre visible', { exact: true }).fill(name);
      await capture('01-wizard-identidad');
      await next(dialog);
      await dialog.getByLabel('Mensajes a la vez', { exact: true }).fill('0');
      await next(dialog);
      await dialog.getByRole('alert').filter({ hasText: 'La capacidad debe ser un entero' }).waitFor();
      await dialog.getByLabel('Mensajes a la vez', { exact: true }).fill('3');
      await dialog.getByText('Entorno de ejecución (opcional)', { exact: true }).click();
      await dialog.getByLabel('Nombre del contenedor', { exact: true }).fill(`${prefix}-container`);
      await next(dialog);
      await dialog.getByRole('alert').filter({ hasText: 'Completa los cuatro campos' }).waitFor();
      await capture('02-wizard-computadora-validacion');
      await dialog.getByLabel('Nombre del contenedor', { exact: true }).fill('');
      await next(dialog);
      await dialog.getByRole('combobox', { name: 'Grupo inicial (opcional)', exact: true }).selectOption('office');
      await dialog.getByLabel('Rol en el grupo', { exact: true }).fill('');
      await next(dialog);
      await dialog.getByRole('alert').filter({ hasText: 'Indica el rol' }).waitFor();
      await dialog.getByLabel('Rol en el grupo', { exact: true }).fill('agent');
      await capture('03-wizard-grupos-validacion');
      await dialog.getByRole('button', { name: 'Atrás', exact: true }).click();
      expect(await dialog.getByLabel('Mensajes a la vez', { exact: true }).inputValue()).toBe('3');
      await dialog.getByRole('button', { name: 'Atrás', exact: true }).click();
      expect(await dialog.getByLabel('Alias', { exact: true }).inputValue()).toBe(cancelledAlias);
      expect(await dialog.getByLabel('Nombre visible', { exact: true }).inputValue()).toBe(name);
      await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      expect(await storedAgent(cancelledAlias)).toEqual([]);
      expect(await configRevision()).toBe(revision);
      receipts.cancelledWizard = { persistedAgents: 0, unchangedRevision: revision };
    });
  }, 180_000);

  it('previsualiza y crea el registro con grupo; relee API y PostgreSQL y abre su ficha', async () => {
    await step('wizard creation and durable reread', async () => {
      await openAgents();
      await browser().getByRole('button', { name: 'Añadir agente', exact: true }).click();
      const dialog = browser().getByRole('dialog', { name: 'Añadir agente', exact: true });
      await dialog.getByRole('combobox', { name: 'Espacio de trabajo', exact: true }).selectOption(tenant);
      await dialog.getByLabel('Alias', { exact: true }).fill(alias);
      await dialog.getByLabel('Nombre visible', { exact: true }).fill(name);
      await next(dialog);
      await dialog.getByLabel('Mensajes a la vez', { exact: true }).fill('3');
      await next(dialog);
      await dialog.getByRole('combobox', { name: 'Grupo inicial (opcional)', exact: true }).selectOption('office');
      await dialog.getByLabel('Rol en el grupo', { exact: true }).fill('agent');
      await next(dialog);
      await dialog.getByRole('heading', { name: 'Revisar y crear', exact: true }).waitFor();
      expect(await dialog.getByRole('button', { name: 'Crear registro', exact: true }).isDisabled()).toBe(true);
      await capture('04-wizard-revision');
      const revision = await configRevision();
      await dialog.getByRole('button', { name: 'Previsualizar alta', exact: true }).click();
      await expect.poll(() => dialog.getByRole('button', { name: 'Crear registro', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
      expect(await storedAgent()).toEqual([]);
      expect(await configRevision()).toBe(revision);
      await dialog.getByRole('button', { name: 'Crear registro', exact: true }).click();
      await dialog.getByText(`Registro creado: ${ref()}.`, { exact: true }).waitFor({ timeout: 20_000 });
      await expect.poll(async () => (await pool().query<{ room_id: string; role: string; enabled: boolean }>('SELECT room_id,role,enabled FROM memberships WHERE tenant_id=$1 AND alias=$2',
        [tenant, alias])).rows, { timeout: 20_000 }).toEqual([{ room_id: 'office', role: 'agent', enabled: true }]);
      const durable = await storedAgent();
      expect(durable).toEqual([{ alias, display_name: name, enabled: false, max_concurrent_deliveries: 3,
        host_id: null, container_name: null, extensions: [] }]);
      const remote = await apiGet(browser(), '/v3/console/config');
      expect(remote.status).toBe(200);
      expect((remote.body.agents as Record<string, unknown>[]).find(row => row.tenant_id === tenant && row.alias === alias)).toMatchObject(durable[0] ?? {});
      await capture('05-wizard-creado');
      await dialog.getByRole('button', { name: 'Abrir ficha', exact: true }).click();
      await sheet().waitFor();
      expect(new URL(browser().url()).searchParams.get('agente')).toBe(ref());
      await capture('06-ficha-estado');
      receipts.created = { durable, membership: { room: 'office', role: 'agent', enabled: true } };
    });
  }, 180_000);

  it('recorre pestañas, enlace directo, recarga y descarte confirmado de ajustes', async () => {
    await step('sheet tabs and navigation', async () => {
      await sheet().getByRole('tab', { name: 'Grupos', exact: true }).click();
      await sheet().getByRole('list', { name: `Grupos de ${ref()}`, exact: true }).waitFor();
      await capture('07-ficha-grupos');
      await sheet().getByRole('tab', { name: 'Ajustes', exact: true }).click();
      const registry = sheet().getByRole('region', { name: `Registro de ${ref()}`, exact: true });
      await registry.getByLabel('Nombre visible', { exact: true }).fill(`${name} pendiente`);
      await sheet().getByRole('button', { name: 'Cerrar', exact: true }).click();
      await sheet().getByText('Tenés cambios sin guardar.', { exact: true }).waitFor();
      await capture('08-ficha-cierre-borrador');
      await sheet().getByRole('button', { name: 'Seguir editando', exact: true }).click();
      expect(await registry.getByLabel('Nombre visible', { exact: true }).inputValue()).toBe(`${name} pendiente`);
      await sheet().getByRole('button', { name: 'Cerrar', exact: true }).click();
      await sheet().getByRole('button', { name: 'Descartar y cerrar', exact: true }).click();
      await sheet().waitFor({ state: 'hidden' });
      expect(new URL(browser().url()).searchParams.has('agente')).toBe(false);
      expect((await storedAgent())[0]?.display_name).toBe(name);
      await openSheet('operacion');
      await sheet().getByText('Esta acción no está disponible en el ejecutor publicado:', { exact: false }).waitFor({ timeout: 20_000 });
      expect(await sheet().getByRole('button', { name: 'Previsualizar operación', exact: true }).isDisabled()).toBe(true);
      expect((await apiGet(browser(), '/v3/console/fleet/capability')).body).toMatchObject({ available: false });
      await capture('09-ficha-ejecucion-sin-executor');
      await browser().reload({ waitUntil: 'domcontentloaded' });
      await sheet().getByRole('button', { name: 'Previsualizar operación', exact: true }).waitFor({ timeout: 20_000 });
      expect(new URL(browser().url()).searchParams.get('agente')).toBe(ref());
      await sheet().getByRole('button', { name: 'Cerrar', exact: true }).click();
      await sheet().waitFor({ state: 'hidden' });
      await openAgents(browser(), `&agente=${encodeURIComponent(`${tenant}/${prefix}-missing`)}`);
      await expect.poll(() => new URL(browser().url()).searchParams.has('agente'), { timeout: 20_000 }).toBe(false);
      receipts.sheet = { tabs: ['Estado', 'Grupos', 'Ajustes', 'Ejecución'], deepLink: true, reload: true, discardedDraft: true, unavailableExecutor: true };
    });
  }, 180_000);

  it('vincula una cuenta de cuota con previsualización sin escritura y persistencia atómica', async () => {
    await step('quota account binding', async () => {
      await openSheet();
      await sheet().getByRole('tab', { name: 'Ajustes', exact: true }).click();
      const quota = sheet().getByRole('region', { name: `Cuentas de cuota de ${ref()}`, exact: true });
      await quota.getByRole('combobox', { name: 'Cuenta de cuota', exact: true }).selectOption(accountId);
      expect(await quota.getByRole('button', { name: 'Guardar cuenta de cuota', exact: true }).isDisabled()).toBe(true);
      await quota.getByRole('button', { name: 'Previsualizar cuenta', exact: true }).click();
      await expect.poll(() => quota.getByRole('button', { name: 'Guardar cuenta de cuota', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
      expect(await bindingRows()).toEqual([]);
      expect((await pool().query('SELECT 1 FROM alias_routing_ceiling WHERE tenant_id=$1 AND alias=$2 AND account_id=$3', [tenant, alias, accountId])).rows).toEqual([]);
      await capture('10-cuenta-cuota-preview', browser(), quota.getByRole('button', { name: 'Guardar cuenta de cuota', exact: true }));
      await quota.getByRole('button', { name: 'Guardar cuenta de cuota', exact: true }).click();
      await quota.getByText('Esta cuenta ya está vinculada.', { exact: true }).waitFor({ timeout: 20_000 });
      expect(await bindingRows()).toEqual([{ account_id: accountId, priority: 0, enabled: true }]);
      expect((await pool().query('SELECT account_id,account_payer_tenant FROM alias_routing_ceiling WHERE tenant_id=$1 AND alias=$2 AND account_id=$3',
        [tenant, alias, accountId])).rows).toEqual([{ account_id: accountId, account_payer_tenant: tenant }]);
      const remote = await apiGet(browser(), '/v3/console/config');
      expect((remote.body.agent_account_bindings as Record<string, unknown>[]).find(row => row.tenant_id === tenant && row.agent_alias === alias))
        .toMatchObject({ account_id: accountId, priority: 0, enabled: true });
      await capture('11-cuenta-cuota-persistida', browser(), quota.getByText('Esta cuenta ya está vinculada.', { exact: true }));
      await browser().reload({ waitUntil: 'domcontentloaded' });
      await sheet().getByRole('tab', { name: 'Ajustes', exact: true }).click();
      await sheet().getByRole('region', { name: `Cuentas de cuota de ${ref()}`, exact: true }).getByText(`${accountId} · paga ${tenant}`, { exact: true }).waitFor({ timeout: 20_000 });
      receipts.quotaBinding = { accountId, binding: await bindingRows(), routingCeilingPersisted: true };
    });
  }, 180_000);

  it('valida borradores de ampliaciones y los descarta sin cambiar ampliaciones ni crear operaciones', async () => {
    await step('extensions drafts without a physical executor', async () => {
      await openSheet();
      await sheet().getByRole('tab', { name: 'Ampliaciones', exact: true }).click();
      const revision = await configRevision();
      await sheet().getByRole('button', { name: 'Añadir ampliación Montaje', exact: true }).click();
      await sheet().getByRole('button', { name: 'Añadir al borrador', exact: true }).click();
      await sheet().getByRole('alert').filter({ hasText: 'deben ser rutas absolutas' }).waitFor();
      await capture('12-ampliaciones-validacion', browser(), sheet().getByRole('alert').filter({ hasText: 'deben ser rutas absolutas' }));
      await sheet().getByLabel('Origen en el ordenador', { exact: true }).fill(`/datos/${prefix}`);
      await sheet().getByLabel('Destino en el contenedor', { exact: true }).fill('/workspace/canary');
      await sheet().getByRole('button', { name: 'Añadir al borrador', exact: true }).click();
      await sheet().getByRole('heading', { name: 'Borrador de ampliaciones (1)', exact: true }).waitFor();
      await sheet().getByRole('button', { name: 'Añadir ampliación Montaje', exact: true }).click();
      await sheet().getByLabel('Origen en el ordenador', { exact: true }).fill('/datos/otra');
      await sheet().getByLabel('Destino en el contenedor', { exact: true }).fill('/workspace/canary');
      await sheet().getByRole('button', { name: 'Añadir al borrador', exact: true }).click();
      await sheet().getByRole('alert').filter({ hasText: 'Ya hay una ampliación' }).waitFor();
      await sheet().getByRole('button', { name: 'Cancelar', exact: true }).click();
      await sheet().getByRole('button', { name: 'Quitar ampliación Montaje', exact: true }).click();
      await sheet().getByRole('button', { name: 'Añadir ampliación Navegador', exact: true }).click();
      await sheet().getByRole('combobox', { name: 'Modo', exact: true }).selectOption('ssh_tunnel');
      await sheet().getByLabel('Host del navegador', { exact: true }).fill('zz-canary.example.invalid');
      await sheet().getByLabel('Puerto CDP', { exact: true }).fill('9222');
      await sheet().getByRole('button', { name: 'Añadir al borrador', exact: true }).click();
      await sheet().getByRole('alert').filter({ hasText: 'necesita la ampliación SSH' }).waitFor();
      await sheet().getByRole('button', { name: 'Cancelar', exact: true }).click();
      await sheet().getByRole('button', { name: 'Añadir ampliación Control total', exact: true }).click();
      await sheet().getByRole('button', { name: 'Añadir al borrador', exact: true }).click();
      await sheet().getByLabel(`Escribe el alias ${alias} para confirmar el control total`, { exact: true }).fill('incorrecto');
      const aliasWarning = sheet().getByText('Escribe exactamente el alias para habilitar la vista previa con control total.', { exact: true });
      await aliasWarning.waitFor();
      expect(await sheet().getByRole('button', { name: 'Vista previa', exact: true }).isDisabled()).toBe(true);
      await sheet().getByLabel(`Escribe el alias ${alias} para confirmar el control total`, { exact: true }).fill(alias);
      await aliasWarning.waitFor({ state: 'hidden' });
      expect(await sheet().getByRole('button', { name: 'Aplicar y recrear', exact: true }).isDisabled()).toBe(true);
      await capture('13-ampliaciones-control-total-bloqueado', browser(),
        sheet().getByLabel(`Escribe el alias ${alias} para confirmar el control total`, { exact: true }));
      await sheet().getByRole('button', { name: 'Descartar borrador', exact: true }).click();
      await sheet().getByRole('heading', { name: 'Ampliaciones activas (0)', exact: true }).waitFor();
      const catalogDrafts: { label: string; fields: [string, string][]; selection?: [string, string] }[] = [
        { label: 'Red adicional', fields: [['Nombre de la red Docker', `${prefix}-network`]] },
        { label: 'Recursos', fields: [['Memoria', '512m'], ['CPU', '1.5'], ['Procesos (máx. 4096)', '256']] },
        { label: 'GPU', fields: [] },
        { label: 'SSH saliente', fields: [['Destinos (uno por línea, usuario@host[:puerto])', 'zz-canary@host.example.invalid:22']] },
        { label: 'Docker', fields: [], selection: ['Acceso', 'control'] },
        { label: 'Navegador', fields: [], selection: ['Modo', 'sidecar'] },
        { label: 'Servidor MCP', fields: [['Nombre', `${prefix}-mcp`], ['Comando', 'node'], ['Argumentos (uno por línea)', '--version'],
          ['Variables de entorno (solo nombres, nunca valores)', 'ZZ_CANARY']] },
        { label: 'Herramientas', fields: [['Paquetes con versión fija (uno por línea)', 'npm:zz-canary@1.0.0']] },
        { label: 'Respaldo Muse', fields: [['Alias del otro agente del par', `${prefix}-partner`], ['Modelo Muse', 'muse-spark-1.3']] },
      ];
      for (const draft of catalogDrafts) {
        await sheet().getByRole('button', { name: `Añadir ampliación ${draft.label}`, exact: true }).click();
        for (const [label, value] of draft.fields) await sheet().getByLabel(label, { exact: true }).fill(value);
        if (draft.selection) await sheet().getByRole('combobox', { name: draft.selection[0], exact: true }).selectOption(draft.selection[1]);
        await sheet().getByRole('button', { name: 'Añadir al borrador', exact: true }).click();
        await sheet().getByRole('heading', { name: 'Borrador de ampliaciones (1)', exact: true }).waitFor();
        if (draft.label === 'Recursos') await capture('18-ampliaciones-recursos-borrador', browser(),
          sheet().getByRole('heading', { name: 'Borrador de ampliaciones (1)', exact: true }));
        await sheet().getByRole('button', { name: `Quitar ampliación ${draft.label}`, exact: true }).click();
        await sheet().getByRole('heading', { name: 'Borrador de ampliaciones (0)', exact: true }).waitFor();
      }
      await sheet().getByRole('button', { name: 'Descartar borrador', exact: true }).click();
      await sheet().getByRole('heading', { name: 'Ampliaciones activas (0)', exact: true }).waitFor();
      await sheet().getByRole('button', { name: 'Releer inventario', exact: true }).click();
      expect((await storedAgent())[0]?.extensions).toEqual([]);
      expect(await configRevision()).toBe(revision);
      expect((await pool().query('SELECT 1 FROM fleet_operations WHERE target->>\'tenant_id\'=$1 AND target->>\'alias\'=$2', [tenant, alias])).rows).toEqual([]);
      receipts.extensions = { catalogDrafts: ['Montaje', 'Control total', ...catalogDrafts.map(draft => draft.label)],
        validation: ['absolute mount paths', 'duplicate mount target', 'browser SSH prerequisite', 'full control alias'],
        persisted: [], operations: 0, applicationTested: false };
    });
  }, 180_000);

  it('busca sin coincidencias, pagina trece agentes y vuelve a la primera página al filtrar', async () => {
    await step('agent search and pagination', async () => {
      await openAgents();
      await browser().setViewportSize({ width: 390, height: 844 });
      await browser().getByLabel('Buscar agente o grupo', { exact: true }).fill(`${prefix}-no-existe`);
      await browser().getByText('No hay agentes que coincidan con la búsqueda.', { exact: true }).waitFor();
      await capture('14-busqueda-vacia');
      await browser().setViewportSize({ width: 390, height: 844 });
      await browser().getByLabel('Buscar agente o grupo', { exact: true }).fill(pagePrefix);
      const pagination = browser().getByRole('navigation', { name: 'Páginas de agentes', exact: true });
      await pagination.getByText('Agentes 1–12 de 13', { exact: true }).waitFor();
      expect(await browser().getByRole('list', { name: 'Agentes configurados', exact: true }).getByRole('listitem').count()).toBe(12);
      expect(await pagination.getByRole('button', { name: 'Anterior', exact: true }).isDisabled()).toBe(true);
      await capture('15-paginacion-primera');
      await browser().setViewportSize({ width: 390, height: 844 });
      await pagination.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await pagination.getByText('Agentes 13–13 de 13', { exact: true }).waitFor();
      expect(await browser().getByRole('list', { name: 'Agentes configurados', exact: true }).getByRole('listitem').count()).toBe(1);
      expect(await pagination.getByRole('button', { name: 'Siguiente', exact: true }).isDisabled()).toBe(true);
      await capture('16-paginacion-segunda');
      await browser().setViewportSize({ width: 390, height: 844 });
      await pagination.getByRole('button', { name: 'Anterior', exact: true }).click();
      await pagination.getByText('Agentes 1–12 de 13', { exact: true }).waitFor();
      await pagination.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await browser().getByLabel('Buscar agente o grupo', { exact: true }).fill(`${pagePrefix}-01`);
      await browser().getByRole('button', { name: `Abrir agente ${tenant}/${pagePrefix}-01`, exact: true }).waitFor();
      expect(await pagination.count()).toBe(0);
      await browser().getByRole('button', { name: `Abrir agente ${tenant}/${pagePrefix}-01`, exact: true }).click();
      const mobileSheet = browser().getByRole('dialog', { name: `${pagePrefix}-01`, exact: true });
      await mobileSheet.waitFor();
      await capture('19-ficha-desde-paginacion-movil');
      await browser().setViewportSize({ width: 390, height: 844 });
      await mobileSheet.getByRole('button', { name: 'Cerrar', exact: true }).click();
      await mobileSheet.waitFor({ state: 'hidden' });
      await browser().setViewportSize({ width: 1440, height: 900 });
      expect((await pool().query('SELECT count(*)::int AS count FROM agents WHERE tenant_id=$1 AND alias LIKE $2', [tenant, `${pagePrefix}%`])).rows).toEqual([{ count: 13 }]);
      receipts.search = { empty: true, seededAgents: 13, pageSizes: [12, 1], filterResetsPage: true,
        mobileActions: ['search', 'next page', 'previous page', 'open sheet', 'close sheet'] };
    });
  }, 180_000);

  it('el lector usa la ficha con controles deshabilitados y no escribe por la API real', async () => {
    const readerPage = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
    readerErrors.watch(readerPage, 'agent-reader');
    readerPage.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (response.status() === 403 && readerDeniedPaths.has(path)) {
        readerDeniedProbes.push({ path, method: response.request().method(), status: response.status() });
      }
    });
    await step('reader permissions', async () => {
    await login(readerPage, active().baseUrl, reader);
    await openAgents(readerPage, `&agente=${encodeURIComponent(ref())}`);
    const readerSheet = readerPage.getByRole('dialog', { name, exact: true });
    await readerSheet.getByRole('tab', { name: 'Ajustes', exact: true }).click();
    expect(await readerSheet.getByLabel('Nombre visible', { exact: true }).isDisabled()).toBe(true);
    expect(await readerSheet.getByRole('combobox', { name: 'Cuenta de cuota', exact: true }).isDisabled()).toBe(true);
    await readerSheet.getByRole('tab', { name: 'Ampliaciones', exact: true }).click();
    expect(await readerSheet.getByRole('button', { name: 'Añadir ampliación Montaje', exact: true }).isDisabled()).toBe(true);
    await capture('17-lector-sin-escritura', readerPage);
    const before = await storedAgent();
    const revision = await configRevision();
    readerErrors.expectHttpError('/v3/console/config/changes', 403);
    const rejected = await readerPage.evaluate(async ({ expectedRevision, tenantId, agentAlias }) => {
      const session = await (await fetch('/v3/auth/session', { credentials: 'include' })).json() as { csrf_token?: string };
      const response = await fetch('/v3/console/config/changes', { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrf_token ?? '' },
        body: JSON.stringify({ expected_revision: expectedRevision, dry_run: false,
          mutation: { resource: 'agent', action: 'update', tenant_id: tenantId, alias: agentAlias, value: { display_name: 'zz-canary-denied' } } }),
      });
      return response.status;
    }, { expectedRevision: revision, tenantId: tenant, agentAlias: alias });
    expect(rejected).toBe(403);
    expect(await storedAgent()).toEqual(before);
    expect(await configRevision()).toBe(revision);
    receipts.reader = { disabledControls: true, writeStatus: rejected, unchangedRevision: revision };
    expect(readerDeniedProbes.length).toBeGreaterThan(0);
    expect([...new Set(readerDeniedProbes.map(probe => probe.method))]).toEqual(['GET']);
    readerErrors.assertClean();
    errors.assertClean();
    }, readerPage);
  }, 180_000);
});
