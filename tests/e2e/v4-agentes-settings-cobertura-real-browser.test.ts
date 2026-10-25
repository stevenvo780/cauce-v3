import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../services/gateway/src/password.js';
import { maintainConsoleUser } from '../../services/gateway/src/console-user-maintenance.js';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES,
  login, openRegistration, syntheticPerson, type V4Locator, type V4Page,
} from './v4-console-real-browser.helpers.js';

const task = 'e2e-a2-cobertura-w-1025';
const run = randomUUID().slice(0, 8);
const prefix = `zz-canary-${task}-${run}`;
const evidenceDirectory = join(process.cwd(), '.delegados/v4/recibos', task, 'settings');
const person = { ...syntheticPerson('settings-coverage', run), name: prefix, email: `${prefix}@example.test`,
  company: { name: prefix, slug: prefix } };
const reader = { ...person, email: `${prefix}-reader@example.test`, password: syntheticPerson('reader', run).password };
const alias = `${prefix}-main`;
const secondary = `${prefix}-secondary`;
const emptyAlias = `${prefix}-empty`;
const legacyAlias = `${prefix}-legacy`;
const fixedAlias = `${prefix}-fixed`;
const retiredAlias = `${prefix}-retired`;
const memberOnly = `${prefix}-member-only`;
const mainName = `Responsable visible ${run}`;
const hostId = `${person.company.slug}-connected`;
const offlineHostId = `${person.company.slug}-offline`;
const disabledHostId = `${person.company.slug}-disabled`;
const rooms = [1, 2, 3, 4, 5].map(index => `${prefix}-group-${String(index)}`);
const ownAccount = `${prefix}-own`;
const sharedAccount = `${prefix}-shared`;
const privateAccount = `${prefix}-private`;
const disabledAccount = `${prefix}-disabled`;
const errors = new BrowserErrorLog(HERMETIC_INSTANCE_RULES);
const readerDeniedPaths = new Set(['/v3/console/terminal/capability', '/v3/console/fleet/hosts', '/v3/console/fleet/capability', '/v3/console/fleet/operations']);
const readerErrors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, {
  id: 'reader-capabilities-denied', reason: 'the real reader role cannot request terminal or fleet write capabilities',
  matches: (text, url) => {
    try { return text.includes('status of 403') && readerDeniedPaths.has(new URL(url).pathname); }
    catch { return false; }
  },
}]);
const receipt: Record<string, unknown> = { task, run, mocks: false, fixtureStates: true, screenshots: [], checks: {} };
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let page: V4Page | undefined;
let tenant = '';
let payerTenant = '';

const active = () => { if (!fixture) throw new Error('settings coverage fixture unavailable'); return fixture; };
const browser = () => { if (!page) throw new Error('settings coverage browser unavailable'); return page; };
const pool = () => active().database.pool;
const ref = (agentAlias = alias) => `${tenant}/${agentAlias}`;
const room = (index: number) => { const id = rooms[index]; if (!id) throw new Error('group unavailable'); return id; };
const sheet = () => browser().getByRole('dialog').first();
const registry = () => sheet().getByRole('region', { name: `Registro de ${ref()}`, exact: true });
const binding = () => sheet().getByRole('region', { name: `Cuentas de cuota de ${ref()}`, exact: true });

function record(label: string, value: unknown): void {
  (receipt.checks as Record<string, unknown>)[label] = value;
  process.stdout.write(`SETTINGS_COVERAGE ${label} ${JSON.stringify(value)}\n`);
}

async function step(label: string, action: () => Promise<void>): Promise<void> {
  try { await action(); }
  catch (cause) {
    const stem = `failure-${run}-${label}`;
    const body = await browser().locator('body').innerText().catch(() => 'Page unavailable');
    const raw = cause instanceof Error ? cause.stack ?? cause.message : String(cause);
    const safe = [person.password, reader.password].reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), `${raw}\n\n${body}`);
    await Promise.allSettled([
      writeFile(join(evidenceDirectory, `${stem}.txt`), safe, { mode: 0o600 }),
      browser().screenshot({ path: join(evidenceDirectory, `${stem}.png`), fullPage: true }),
    ]);
    throw cause;
  }
}

async function capture(label: string, target = browser(), focus?: V4Locator): Promise<void> {
  for (const [device, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]] as const) {
    await target.setViewportSize({ width, height });
    if (focus) await focus.evaluate(element => { element.scrollIntoView({ block: 'center' }); });
    await target.screenshot({ path: join(evidenceDirectory, `${run}-${label}-${device}.png`), fullPage: true });
    (receipt.screenshots as string[]).push(`${run}-${label}-${device}.png`);
  }
  await target.setViewportSize({ width: 1440, height: 900 });
}

async function openAgents(target = browser()): Promise<void> {
  await target.goto(`${active().baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
  await target.getByRole('heading', { name: 'Tus agentes', exact: true }).waitFor({ timeout: 20_000 });
}

async function openSheet(agentAlias = alias, tab = 'Estado'): Promise<void> {
  await openAgents();
  await browser().getByLabel('Buscar agente o grupo', { exact: true }).fill(agentAlias);
  await browser().getByRole('button', { name: `Abrir agente ${ref(agentAlias)}`, exact: true }).click();
  await sheet().waitFor();
  if (tab !== 'Estado') await sheet().getByRole('tab', { name: tab, exact: true }).click();
}

async function storedAgent(agentAlias = alias): Promise<Record<string, unknown>> {
  const result = await pool().query(`SELECT display_name,enabled,max_concurrent_deliveries,host_id,primary_room_id,
    lifecycle_state,runtime_key,retired_at FROM agents WHERE tenant_id=$1 AND alias=$2`, [tenant, agentAlias]);
  return result.rows[0] as Record<string, unknown>;
}

async function membershipRows(): Promise<Record<string, unknown>[]> {
  return (await pool().query('SELECT room_id,role,enabled FROM memberships WHERE tenant_id=$1 AND alias=$2 ORDER BY room_id', [tenant, alias])).rows as Record<string, unknown>[];
}

async function bindingRows(): Promise<Record<string, unknown>[]> {
  return (await pool().query(`SELECT account_id,priority,enabled FROM agent_account_bindings
    WHERE tenant_id=$1 AND agent_alias=$2 ORDER BY account_id`, [tenant, alias])).rows as Record<string, unknown>[];
}

async function enabled(button: V4Locator): Promise<void> {
  await expect.poll(() => button.isDisabled(), { timeout: 15_000 }).toBe(false);
}

async function previewAndApply(): Promise<void> {
  await registry().getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
  const apply = registry().getByRole('button', { name: 'Aplicar cambio', exact: true });
  await enabled(apply);
  await apply.click();
  await registry().getByRole('status').filter({ hasText: 'releído' }).waitFor({ timeout: 15_000 });
}

async function synchronizedRegistryRevision(): Promise<number> {
  const snapshot = await apiGet(browser(), '/v3/console/config');
  expect(snapshot.status).toBe(200);
  const revision = snapshot.body.revision;
  if (typeof revision !== 'number') throw new Error('configuration revision unavailable');
  await expect.poll(() => registry().locator('[title^="Revisión esperada:"]').evaluate(element => element.title))
    .toBe(`Revisión esperada: ${String(revision)}`);
  return revision;
}

async function requestConfigChange(target: V4Page, mutation: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const snapshot = await apiGet(target, '/v3/console/config');
  expect(snapshot.status).toBe(200);
  return target.evaluate(async (payload: Record<string, unknown>) => {
    const session = await (await fetch('/v3/auth/session', { credentials: 'include', cache: 'no-store' })).json() as { csrf_token?: string };
    const response = await fetch('/v3/console/config/changes', {
      method: 'POST', credentials: 'include', headers: {
        'content-type': 'application/json', 'x-csrf-token': session.csrf_token ?? '', 'x-cauce-console': '1',
      },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }, { mutation, expected_revision: snapshot.body.revision, dry_run: false });
}

async function configChange(target: V4Page, mutation: Record<string, unknown>): Promise<void> {
  const result = await requestConfigChange(target, mutation);
  expect(result.status, JSON.stringify(result.body)).toBe(201);
}

beforeAll(async () => {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.DATABASE_URL || process.env.CAUCE_TEST_DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') {
    throw new Error('settings coverage requires isolated PostgreSQL and mocks=false');
  }
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  fixture = await startConsoleFunctionalFixture();
  page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
  errors.watch(browser(), 'settings-owner');
  await step('bootstrap', async () => {
    const registration = await openRegistration(browser(), active().baseUrl);
    await fillRegistration(registration, person);
    await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
    await browser().getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  });
  tenant = (await pool().query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [person.email])).rows[0]?.tenant_id ?? '';
  expect(tenant).not.toBe('');
  payerTenant = `${prefix}-payer`;
  await pool().query('UPDATE tenants SET display_name=$2 WHERE id=$1', [tenant, `Espacio operativo ${run}`]);
  await pool().query('INSERT INTO tenants(id,company_id,display_name) VALUES($1,$2,$3)', [payerTenant, person.company.slug, `Pagador auxiliar ${run}`]);
  await pool().query(`INSERT INTO fleet_hosts(host_id,company_id,display_name,controller_status,controller_seen_at,enabled)
    VALUES($1,$4,'Computadora conectada','reachable',now(),true),($2,$4,'Computadora sin conexión','unreachable',now(),true),
      ($3,$4,'Computadora deshabilitada','reachable',now(),false)`, [hostId, offlineHostId, disabledHostId, person.company.slug]);
  for (const [index, id] of rooms.entries()) {
    await pool().query('INSERT INTO rooms(id,tenant_id,company_id,display_name,enabled) VALUES($1,$2,$3,$4,true)',
      [id, tenant, person.company.slug, `Equipo ${String(index + 1)} ${run}`]);
  }
  await pool().query(`INSERT INTO agents(tenant_id,alias,display_name,company_id,enabled,harness_id,max_concurrent_deliveries,primary_room_id)
    VALUES($1,$2,$7,$8,false,'codex',2,NULL),($1,$3,$3,$8,false,NULL,1,NULL),($1,$4,$4,$8,false,NULL,1,NULL),
      ($1,$5,$5,$8,false,'codex',1,NULL),($1,$6,$6,$8,false,'codex',1,NULL)`,
  [tenant, alias, secondary, emptyAlias, legacyAlias, fixedAlias, mainName, person.company.slug]);
  await pool().query(`INSERT INTO agents(tenant_id,alias,display_name,company_id,enabled,lifecycle_state,retired_at)
    VALUES($1,$2,$2,$3,false,'retired',now())`, [tenant, retiredAlias, person.company.slug]);
  await pool().query(`UPDATE agents SET runtime_key=$3,lifecycle_state='ready' WHERE tenant_id=$1 AND alias=$2`, [tenant, legacyAlias, `${prefix}-legacy-runtime`]);
  await pool().query(`UPDATE agents SET runtime_key=$3,host_id=$4,lifecycle_state='ready',runtime_mode='container',
    container_name=$3,runtime_user='node',home_directory='/home/node',state_directory='/home/node/.cauce',enabled=true
    WHERE tenant_id=$1 AND alias=$2`, [tenant, fixedAlias, `${prefix}-fixed-runtime`, hostId]);
  for (const [index, id] of rooms.slice(0, 4).entries()) {
    await pool().query('INSERT INTO memberships(tenant_id,room_id,alias,role,enabled) VALUES($1,$2,$3,\'agent\',$4)', [tenant, id, alias, index !== 1]);
  }
  await pool().query('UPDATE agents SET primary_room_id=$3 WHERE tenant_id=$1 AND alias=$2', [tenant, alias, room(0)]);
  await pool().query('UPDATE agents SET host_id=$3 WHERE tenant_id=$1 AND alias=$2', [tenant, secondary, disabledHostId]);
  await pool().query('INSERT INTO agent_profiles(tenant_id,alias,role_summary) VALUES($1,$2,$3)', [tenant, alias, `Responsabilidad exclusiva ${run}`]);
  await pool().query('INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,\'agent\')', [tenant, room(0), memberOnly]);
  for (const [id, payer, shared, accountEnabled] of [
    [ownAccount, tenant, false, true], [sharedAccount, payerTenant, true, true],
    [privateAccount, payerTenant, false, true], [disabledAccount, tenant, false, false],
  ] as const) {
    await pool().query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,label,
      credential_ref_kind,credential_ref,shared_with_pool,enabled,company_id)
      VALUES($1,'codex',$1,$2,$1,'secret_manager',$3,$4,$5,$6)`,
    [id, payer, `op:zz-canary/settings/${run}`, shared, accountEnabled, person.company.slug]);
  }
  await pool().query('UPDATE agents SET primary_account_id=$3,model_id=\'gpt-5.5\' WHERE tenant_id=$1 AND alias=$2', [tenant, fixedAlias, ownAccount]);
  const readerAlias = `${prefix}-reader`;
  await pool().query('INSERT INTO agents(tenant_id,alias,enabled,company_id) VALUES($1,$2,false,$3)', [tenant, readerAlias, person.company.slug]);
  await pool().query('INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,\'office\',$2,\'agent\')', [tenant, readerAlias]);
  await maintainConsoleUser(pool(), { email: reader.email, name: 'Lector de ajustes', role: 'reader', tenant, alias: readerAlias,
    updateOnly: false, activate: true }, await hashPassword(reader.password));
  receipt.tenant = tenant;
}, 600_000);

afterAll(async () => {
  try {
    await writeFile(join(evidenceDirectory, `${run}-receipt.json`), JSON.stringify({ ...receipt,
      browserErrors: errors.unexpected, ignoredConsoleRules: Object.fromEntries(errors.ignored),
      readerBrowserErrors: readerErrors.unexpected, readerIgnoredConsoleRules: Object.fromEntries(readerErrors.ignored) }, null, 2) + '\n', { mode: 0o600 });
  } finally { await fixture?.close(); }
}, 180_000);

describe.sequential('Cobertura pendiente de ajustes de agentes con Chromium y PostgreSQL reales', () => {
  it('A04 A06 A14 A15 A16 A18 T02 T04 T06: busca datos publicados, abre acciones y restaura el foco', async () => {
    await step('search-navigation-focus', async () => {
      await openAgents();
      const search = browser().getByLabel('Buscar agente o grupo', { exact: true });
      for (const query of [mainName, room(0), `Equipo 1 ${run}`, tenant, 'codex', `Responsabilidad exclusiva ${run}`]) {
        await search.fill(query);
        await browser().getByRole('button', { name: `Abrir agente ${ref()}`, exact: true }).waitFor();
      }
      await search.fill(alias);
      const tile = browser().getByRole('button', { name: `Abrir agente ${ref()}`, exact: true });
      await tile.getByText('Sin preparar', { exact: true }).waitFor();
      expect(await tile.getByText('Sin preparar', { exact: true }).isVisible()).toBe(true);
      for (const text of [mainName, alias, 'En pausa', 'Sin computadora', 'codex', `Equipo 1 ${run}`, '(pausada)', '+1']) {
        expect(await tile.innerText()).toContain(text);
      }
      await capture('A-T-busquedas-tarjeta');
      await tile.click();
      await sheet().getByRole('button', { name: 'Cerrar', exact: true }).click();
      await expect.poll(() => browser().evaluate(() => document.activeElement?.getAttribute('data-agent-tile'))).toBe(ref());
      await browser().getByRole('button', { name: `Acciones de ${ref()}`, exact: true }).click();
      await browser().getByRole('menuitem', { name: 'Cambiar ejecución', exact: true }).click();
      await sheet().getByRole('tab', { name: 'Ejecución', exact: true }).waitFor();
      expect(await sheet().getByRole('tab', { name: 'Ejecución', exact: true }).evaluate(element => element.getAttribute('aria-selected'))).toBe('true');
      await sheet().getByRole('button', { name: 'Cerrar', exact: true }).click();
      await browser().getByRole('button', { name: `Acciones de ${ref()}`, exact: true }).click();
      await browser().getByRole('menuitem', { name: `Perfil y contexto de ${ref()}`, exact: true }).click();
      await expect.poll(() => browser().url()).toContain(`/messages/${encodeURIComponent(tenant)}/${alias}?view=context`);
      await openAgents();
      await browser().getByText('Detalles técnicos: registro completo en tabla', { exact: true }).click();
      await browser().getByRole('columnheader', { name: 'Alias', exact: true }).waitFor();
      await capture('A14-tabla-completa');
      await browser().getByRole('link', { name: 'Ir a Cuentas', exact: true }).click();
      await expect.poll(() => browser().url()).toContain('/accounts');
      await openAgents();
      await browser().getByRole('link', { name: 'Ir a Mis cuotas', exact: true }).click();
      await expect.poll(() => browser().url()).toContain('/my-quotas');
      record('A04-A06-A14-A15-A16-A18-T02-T04-T06', { queries: [mainName, room(0), `Equipo 1 ${run}`, tenant, 'codex', `Responsabilidad exclusiva ${run}`], focus: ref() });
    });
  }, 180_000);

  it('A11 F06: un miembro sin registro muestra solo Estado y Grupos y no ofrece menú de escritura', async () => {
    await step('member-only-sheet', async () => {
      await openAgents();
      await browser().getByLabel('Buscar agente o grupo', { exact: true }).fill(memberOnly);
      const tile = browser().getByRole('button', { name: `Abrir agente ${ref(memberOnly)}`, exact: true });
      expect(await tile.innerText()).toContain('Solo en grupos');
      expect(await browser().getByRole('button', { name: `Acciones de ${ref(memberOnly)}`, exact: true }).count()).toBe(0);
      await browser().getByText(/Los agentes marcados «Solo en grupos» aparecen porque son miembros/u).waitFor();
      await tile.click();
      expect(await sheet().getByRole('tab').count()).toBe(2);
      await sheet().getByRole('note').filter({ hasText: 'No tiene ajustes propios en Cauce' }).waitFor();
      await sheet().getByRole('tab', { name: 'Grupos', exact: true }).click();
      await sheet().getByRole('list', { name: `Grupos de ${ref(memberOnly)}`, exact: true }).waitFor();
      expect((await pool().query('SELECT 1 FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, memberOnly])).rowCount).toBe(0);
      expect((await pool().query('SELECT enabled FROM memberships WHERE tenant_id=$1 AND alias=$2', [tenant, memberOnly])).rows).toEqual([{ enabled: true }]);
      await capture('A11-F06-solo-grupos');
      record('A11-F06', { registered: false, tabs: ['Estado', 'Grupos'], writeMenu: false });
    });
  }, 180_000);

  it('F02 F03 E01 E02 E04 E05 E06 E09: conserva borradores, valida límites y guarda solo el cambio revisado', async () => {
    await step('draft-validation-and-write', async () => {
      await openSheet(alias, 'Ajustes');
      const before = await storedAgent();
      const name = registry().getByLabel('Nombre visible', { exact: true });
      await name.fill(`${mainName} borrador`);
      await sheet().getByRole('tab', { name: 'Grupos', exact: true }).click();
      await sheet().getByRole('tab', { name: 'Ajustes', exact: true }).click();
      expect(await name.inputValue()).toBe(`${mainName} borrador`);
      expect(await registry().getByRole('option', { name: 'Activo: recibe mensajes', exact: true }).evaluate(element => element.disabled)).toBe(true);
      for (const label of ['Computadora sin conexión · sin conexión', 'Computadora deshabilitada · deshabilitada']) {
        expect(await registry().getByRole('option', { name: label, exact: true }).evaluate(element => element.disabled)).toBe(true);
      }
      const capacity = registry().getByLabel('Mensajes a la vez', { exact: true });
      for (const invalid of ['0', '101', '1.5', '-1']) {
        await capacity.fill(invalid);
        await registry().getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
        await registry().getByRole('alert').filter({ hasText: 'La capacidad debe ser un entero entre 1 y 100.' }).waitFor();
        expect(await registry().getByRole('button', { name: 'Aplicar cambio', exact: true }).isDisabled()).toBe(true);
        expect(await storedAgent()).toEqual(before);
      }
      await capacity.fill('100');
      await registry().getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
      await enabled(registry().getByRole('button', { name: 'Aplicar cambio', exact: true }));
      await capacity.fill('3');
      expect(await registry().getByRole('button', { name: 'Aplicar cambio', exact: true }).isDisabled()).toBe(true);
      await name.fill('');
      await registry().getByLabel('Computadora').selectOption(hostId);
      await registry().getByLabel('Recepción de mensajes').selectOption('false');
      await capture('E-validacion-borrador');
      await previewAndApply();
      expect(await storedAgent()).toMatchObject({ display_name: null, max_concurrent_deliveries: 3, host_id: hostId, enabled: false });
      await capture('E01-E02-E06-aplicado');
      await name.fill(mainName);
      await previewAndApply();
      await sheet().getByRole('button', { name: 'Cerrar', exact: true }).press('Escape');
      await sheet().waitFor({ state: 'hidden' });
      await openSheet();
      const pointer = browser() as V4Page & { mouse: { click(x: number, y: number): Promise<void> } };
      await pointer.mouse.click(30, 450);
      await sheet().waitFor({ state: 'hidden' });
      record('F02-F03-E01-E02-E04-E05-E06-E09', { stored: await storedAgent(), invalidCapacities: ['0', '101', '1.5', '-1'], previewInvalidated: true });
    });
  }, 180_000);

  it('E09 E10: resuelve dos conflictos reales y preserva un campo modificado por otro operador', async () => {
    await step('concurrent-conflicts', async () => {
      const other = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
      errors.watch(other, 'settings-concurrent-owner');
      await login(other, active().baseUrl, person);
      await openSheet(alias, 'Ajustes');
      await synchronizedRegistryRevision();
      await registry().getByLabel('Nombre visible', { exact: true }).fill(`${mainName} mío`);
      await configChange(other, { resource: 'agent', action: 'update', tenant_id: tenant, alias, value: { max_concurrent_deliveries: 7 } });
      errors.expectHttpError('/v3/console/config/changes', 409);
      await registry().getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
      const conflict = registry().getByRole('group', { name: 'Conflicto de versión', exact: true });
      await conflict.waitFor();
      expect(await conflict.innerText()).toContain('Mensajes a la vez');
      expect(await registry().getByLabel('Nombre visible', { exact: true }).inputValue()).toBe(`${mainName} mío`);
      await capture('E10-conflicto-reintentar');
      await conflict.getByRole('button', { name: 'Releer y reintentar con mis cambios', exact: true }).click();
      const apply = registry().getByRole('button', { name: 'Aplicar cambio', exact: true });
      await enabled(apply);
      await apply.click();
      await expect.poll(async () => (await storedAgent()).display_name).toBe(`${mainName} mío`);
      await registry().getByRole('status').filter({ hasText: 'releído' }).waitFor({ timeout: 15_000 });
      await synchronizedRegistryRevision();
      expect((await storedAgent()).max_concurrent_deliveries).toBe(7);
      await registry().getByLabel('Nombre visible', { exact: true }).fill('Borrador descartable');
      await configChange(other, { resource: 'agent', action: 'update', tenant_id: tenant, alias, value: { display_name: mainName } });
      errors.expectHttpError('/v3/console/config/changes', 409);
      await registry().getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
      await conflict.waitFor();
      await conflict.getByRole('button', { name: 'Descartar mis cambios', exact: true }).click();
      expect(await registry().getByLabel('Nombre visible', { exact: true }).inputValue()).toBe(mainName);
      expect(await registry().getByRole('button', { name: 'Aplicar cambio', exact: true }).isDisabled()).toBe(true);
      await capture('E10-conflicto-descartado');
      record('E09-E10', { stored: await storedAgent(), untouchedConcurrentCapacity: 7, retry: true, discard: true });
      await other.context().close();
    });
  }, 180_000);

  it('G01 G02 G03 G04 G05: lista membresías y mueve grupo principal en una transacción desde la ficha', async () => {
    await step('groups-atomic-move', async () => {
      await openSheet(alias, 'Grupos');
      const groups = sheet().getByRole('list', { name: `Grupos de ${ref()}`, exact: true });
      expect(await groups.getByText('Activa', { exact: true }).count()).toBe(3);
      expect(await groups.getByText('Membresía deshabilitada', { exact: true }).count()).toBe(1);
      await sheet().getByLabel('Grupo de origen').selectOption(room(0));
      const moving = sheet().getByRole('region', { name: `Movimiento de miembros de ${tenant}/${room(0)}`, exact: true });
      await moving.getByLabel('Grupo de destino').selectOption(room(4));
      const before = await membershipRows();
      const beforeAgent = await storedAgent();
      expect(await moving.getByRole('button', { name: 'Confirmar movimiento atómico', exact: true }).isDisabled()).toBe(true);
      await moving.getByRole('button', { name: 'Previsualizar movimiento atómico', exact: true }).click();
      await moving.locator('pre[aria-label="Movimiento atómico propuesto"]').waitFor();
      expect(await membershipRows()).toEqual(before);
      expect(await storedAgent()).toEqual(beforeAgent);
      await capture('G04-G05-preview-atomico');
      await moving.getByRole('button', { name: 'Confirmar movimiento atómico', exact: true }).click();
      await expect.poll(async () => (await storedAgent()).primary_room_id).toBe(room(4));
      const after = await membershipRows();
      expect(after).toHaveLength(4);
      expect(after.some(row => row.room_id === room(0))).toBe(false);
      expect(after.find(row => row.room_id === room(4))).toMatchObject({ role: 'agent', enabled: true });
      await sheet().getByRole('button', { name: `Editar equipo ${room(4)}`, exact: true }).click();
      const team = browser().getByRole('dialog', { name: 'Editar equipo', exact: true });
      await team.getByLabel('Nombre visible', { exact: true }).fill(`Equipo movido ${run}`);
      await team.getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
      await enabled(team.getByRole('button', { name: 'Confirmar edición', exact: true }));
      await team.getByRole('button', { name: 'Confirmar edición', exact: true }).click();
      await team.waitFor({ state: 'hidden' });
      expect((await pool().query('SELECT display_name FROM rooms WHERE tenant_id=$1 AND id=$2', [tenant, room(4)])).rows).toEqual([{ display_name: `Equipo movido ${run}` }]);
      await capture('G01-G03-grupo-editado');
      await openSheet(emptyAlias, 'Grupos');
      await sheet().getByText('Este agente no tiene membresías registradas.', { exact: true }).waitFor();
      await capture('G02-sin-membresias');
      record('G01-G02-G03-G04-G05', { before, after, primaryRoom: room(4), roomName: `Equipo movido ${run}`, unknownMembershipState: 'not emitted by real NOT NULL schema' });
    });
  }, 180_000);

  it('B01 B02 B03 B04 B06 B07: filtra cuentas, crea y reactiva bindings y detecta prioridad agotada', async () => {
    await step('quota-bindings', async () => {
      await openSheet(alias, 'Ajustes');
      await binding().getByText('Sin cuentas de cuota vinculadas.', { exact: true }).waitFor();
      const select = binding().getByLabel('Cuenta de cuota');
      expect(await select.locator('option').first().evaluate(element => Array.from((element.parentElement as HTMLSelectElement).options).map(option => option.value))).toEqual(['', ownAccount, sharedAccount]);
      const before = await bindingRows();
      await select.selectOption(ownAccount);
      expect(await binding().getByRole('button', { name: 'Guardar cuenta de cuota', exact: true }).isDisabled()).toBe(true);
      await binding().getByRole('button', { name: 'Previsualizar cuenta', exact: true }).click();
      await enabled(binding().getByRole('button', { name: 'Guardar cuenta de cuota', exact: true }));
      expect(await bindingRows()).toEqual(before);
      expect((await pool().query('SELECT 1 FROM alias_routing_ceiling WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows).toEqual([]);
      await binding().getByRole('button', { name: 'Guardar cuenta de cuota', exact: true }).click();
      await expect.poll(async () => (await bindingRows()).length).toBe(1);
      await openSheet(alias, 'Ajustes');
      await binding().getByLabel('Cuenta de cuota').selectOption(ownAccount);
      await binding().getByText('Esta cuenta ya está vinculada.', { exact: true }).waitFor();
      expect(await binding().getByRole('button', { name: 'Previsualizar cuenta', exact: true }).isDisabled()).toBe(true);
      await capture('B01-B02-B03-vinculada', browser(), binding().getByText('Esta cuenta ya está vinculada.', { exact: true }));
      await pool().query('UPDATE agent_account_bindings SET enabled=false WHERE tenant_id=$1 AND agent_alias=$2 AND account_id=$3', [tenant, alias, ownAccount]);
      await openSheet(alias, 'Ajustes');
      await binding().getByLabel('Cuenta de cuota').selectOption(ownAccount);
      await binding().getByRole('button', { name: 'Previsualizar cuenta', exact: true }).click();
      await enabled(binding().getByRole('button', { name: 'Guardar cuenta de cuota', exact: true }));
      await binding().getByRole('button', { name: 'Guardar cuenta de cuota', exact: true }).click();
      await expect.poll(async () => (await bindingRows())[0]?.enabled).toBe(true);
      await pool().query('UPDATE agent_account_bindings SET priority=32767 WHERE tenant_id=$1 AND agent_alias=$2', [tenant, alias]);
      await openSheet(alias, 'Ajustes');
      await binding().getByLabel('Cuenta de cuota').selectOption(sharedAccount);
      await binding().getByRole('note').filter({ hasText: 'No queda un orden de respaldo disponible' }).waitFor();
      expect(await binding().getByRole('button', { name: 'Previsualizar cuenta', exact: true }).isDisabled()).toBe(true);
      expect(await binding().getByRole('button', { name: 'Guardar cuenta de cuota', exact: true }).isDisabled()).toBe(true);
      await capture('B04-prioridad-agotada', browser(), binding().getByRole('note').filter({ hasText: 'No queda un orden de respaldo disponible' }));
      await pool().query('UPDATE agent_account_bindings SET priority=0 WHERE tenant_id=$1 AND agent_alias=$2', [tenant, alias]);
      await openSheet(alias, 'Ajustes');
      await binding().getByLabel('Cuenta de cuota').selectOption(sharedAccount);
      await binding().getByRole('button', { name: 'Previsualizar cuenta', exact: true }).click();
      await enabled(binding().getByRole('button', { name: 'Guardar cuenta de cuota', exact: true }));
      await binding().getByRole('button', { name: 'Guardar cuenta de cuota', exact: true }).click();
      await expect.poll(async () => (await bindingRows()).length).toBe(2);
      await openSheet(alias, 'Ajustes');
      await binding().getByText(`${ownAccount} · paga ${tenant}`, { exact: true }).waitFor();
      await binding().getByText(`${sharedAccount} · paga ${payerTenant}`, { exact: true }).waitFor();
      const reloaded = await apiGet(browser(), '/v3/console/config');
      expect(reloaded.status).toBe(200);
      expect(reloaded.body.agent_account_bindings).toEqual(expect.arrayContaining([
        expect.objectContaining({ tenant_id: tenant, agent_alias: alias, account_id: ownAccount, enabled: true }),
        expect.objectContaining({ tenant_id: tenant, agent_alias: alias, account_id: sharedAccount, enabled: true }),
      ]));
      await capture('B07-reactivada-compartida', browser(), binding().getByText(`${sharedAccount} · paga ${payerTenant}`, { exact: true }));
      record('B01-B02-B03-B04-B06-B07', { rows: await bindingRows(), ineligible: [privateAccount, disabledAccount], sharedAccount, reactivated: ownAccount });
    });
  }, 180_000);

  it('E03 R02 T07 F07 A13: muestra placement fijo, guía legado, retiro conservado y bloqueos reales', async () => {
    await step('legacy-retired-guards', async () => {
      await openSheet(fixedAlias, 'Ajustes');
      await sheet().getByText('La computadora se cambia desde «Ejecución» mediante una operación de flota. Esa operación no copia los datos del espacio.', { exact: true }).waitFor();
      expect(await sheet().getByLabel('Computadora', { exact: true }).count()).toBe(0);
      await capture('E03-computadora-fija');
      const fixedEditor = sheet().getByRole('region', { name: `Registro de ${ref(fixedAlias)}`, exact: true });
      await fixedEditor.getByLabel('Recepción de mensajes').selectOption('false');
      await fixedEditor.getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
      await enabled(fixedEditor.getByRole('button', { name: 'Aplicar cambio', exact: true }));
      expect((await storedAgent(fixedAlias)).enabled).toBe(true);
      await fixedEditor.getByRole('button', { name: 'Aplicar cambio', exact: true }).click();
      await expect.poll(async () => (await storedAgent(fixedAlias)).enabled).toBe(false);
      await capture('E05-pausa-admision');
      await sheet().getByRole('tab', { name: 'Estado', exact: true }).click();
      await sheet().getByRole('button', { name: `Eliminar agente ${ref(fixedAlias)}`, exact: true }).click();
      const activeGuide = browser().getByRole('dialog', { name: `Eliminar agente ${ref(fixedAlias)}`, exact: true });
      const activeSteps = activeGuide.getByRole('list', { name: 'Pasos para eliminar el agente', exact: true });
      expect(await activeSteps.getByRole('listitem').count()).toBe(2);
      expect(await activeSteps.locator('li[data-current]').innerText()).toContain('1. Retirar');
      expect(await activeSteps.innerText()).toContain('se puede deshacer');
      expect(await activeSteps.innerText()).toContain('No se puede deshacer');
      await capture('R01-guia-retiro');
      await activeGuide.getByRole('button', { name: 'Cerrar', exact: true }).first().click();
      await activeGuide.waitFor({ state: 'hidden' });
      await openSheet(secondary, 'Ajustes');
      const unavailableEditor = sheet().getByRole('region', { name: `Registro de ${ref(secondary)}`, exact: true });
      await unavailableEditor.getByText('La computadora Computadora deshabilitada está deshabilitada.', { exact: true }).waitFor();
      expect(await unavailableEditor.getByRole('option', { name: 'Computadora deshabilitada · deshabilitada', exact: true }).evaluate(element => element.disabled)).toBe(true);
      await capture('E04-computadora-inutilizable');
      await openSheet(legacyAlias, 'Ajustes');
      const adopted = sheet().getByRole('region', { name: `Registro de ${ref(legacyAlias)}`, exact: true });
      await adopted.getByLabel('Computadora').selectOption(hostId);
      await adopted.getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
      await enabled(adopted.getByRole('button', { name: 'Aplicar cambio', exact: true }));
      expect((await storedAgent(legacyAlias)).host_id).toBe(null);
      await adopted.getByRole('button', { name: 'Aplicar cambio', exact: true }).click();
      await expect.poll(async () => (await storedAgent(legacyAlias)).host_id).toBe(hostId);
      await capture('E02-primera-computadora-runtime');
      await openSheet(legacyAlias);
      await sheet().getByRole('button', { name: `Eliminar agente ${ref(legacyAlias)}`, exact: true }).click();
      const guide = browser().getByRole('dialog', { name: `Eliminar agente ${ref(legacyAlias)}`, exact: true });
      await guide.getByRole('note').filter({ hasText: 'se instaló antes del ejecutor de flota' }).waitFor();
      expect(await guide.getByRole('button', { name: 'Previsualizar operación', exact: true }).count()).toBe(0);
      await capture('R02-guia-legado');
      await guide.getByRole('button', { name: 'Cerrar', exact: true }).first().click();
      await guide.waitFor({ state: 'hidden' });
      await openAgents();
      await browser().getByLabel('Buscar agente o grupo', { exact: true }).fill(fixedAlias);
      await browser().getByRole('button', { name: `Acciones de ${ref(fixedAlias)}`, exact: true }).click();
      const retire = browser().getByRole('menuitem', { name: 'Retirar agente', exact: true });
      await expect.poll(() => retire.evaluate(element => element.getAttribute('aria-disabled'))).toBe('true');
      await capture('T07-retiro-sin-ejecutor');
      await openAgents();
      await browser().getByRole('button', { name: `Restaurar o revisar ${ref(retiredAlias)}`, exact: true }).click();
      await sheet().getByRole('note').filter({ hasText: 'su historial se conserva' }).waitFor();
      expect((await storedAgent(retiredAlias)).lifecycle_state).toBe('retired');
      await capture('F07-ficha-retirada');
      await sheet().getByRole('button', { name: `Eliminar agente ${ref(retiredAlias)}`, exact: true }).click();
      const retiredGuide = browser().getByRole('dialog', { name: `Eliminar agente ${ref(retiredAlias)}`, exact: true });
      const retiredSteps = retiredGuide.getByRole('list', { name: 'Pasos para eliminar el agente', exact: true });
      expect(await retiredSteps.locator('li[data-current]').innerText()).toContain('2. Eliminar definitivamente');
      await retiredSteps.getByText('Hecho', { exact: true }).waitFor();
      expect(await retiredGuide.getByRole('button', { name: 'Previsualizar operación', exact: true }).isDisabled()).toBe(true);
      await capture('R01-guia-purga');
      await retiredGuide.getByRole('link', { name: 'Descargar copia', exact: true }).click();
      await expect.poll(() => browser().url()).toContain(`/messages/${encodeURIComponent(tenant)}/${retiredAlias}?view=context`);
      record('E03-R01-R02-T07-F07-R04', { legacyRuntime: (await storedAgent(legacyAlias)).runtime_key,
        retired: await storedAgent(retiredAlias), physicalOperationExecuted: false, backupLinkNavigatesToContext: true, backupDownloaded: false });
    });
  }, 180_000);

  it('A03 A18 E15: elimina un registro no iniciado, vuelve el foco a Añadir y cierra el aviso durable', async () => {
    await step('registry-notice-and-fallback-focus', async () => {
      await openSheet(emptyAlias, 'Ajustes');
      const editor = sheet().getByRole('region', { name: `Registro de ${ref(emptyAlias)}`, exact: true });
      await editor.getByRole('button', { name: 'Eliminar registro', exact: true }).click();
      await editor.getByRole('button', { name: 'Previsualizar eliminación', exact: true }).click();
      await enabled(editor.getByRole('button', { name: 'Confirmar eliminación del registro', exact: true }));
      expect((await pool().query('SELECT 1 FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, emptyAlias])).rowCount).toBe(1);
      await editor.getByRole('button', { name: 'Confirmar eliminación del registro', exact: true }).click();
      await browser().getByRole('status').filter({ hasText: `Registro de ${ref(emptyAlias)} eliminado` }).waitFor();
      await expect.poll(() => browser().getByRole('dialog').count()).toBe(0);
      await expect.poll(() => browser().evaluate(() => document.activeElement?.textContent.trim())).toBe('Añadir agente');
      expect((await pool().query('SELECT 1 FROM agents WHERE tenant_id=$1 AND alias=$2 AND purged_at IS NULL', [tenant, emptyAlias])).rowCount).toBe(0);
      const durableRemoval = await pool().query<Record<string, unknown>>(`SELECT enabled,lifecycle_state,purged_at,retired_at,
        primary_room_id,harness_id,host_id,container_name,runtime_user,home_directory,state_directory,runtime_key
        FROM agents WHERE tenant_id=$1 AND alias=$2`, [tenant, emptyAlias]);
      expect(durableRemoval.rows.length).toBeLessThanOrEqual(1);
      for (const tombstone of durableRemoval.rows) {
        expect(tombstone.purged_at).toBeInstanceOf(Date);
        expect(tombstone.retired_at).toBeInstanceOf(Date);
        expect(tombstone).toMatchObject({ enabled: false, lifecycle_state: 'retired',
          primary_room_id: null, harness_id: null, host_id: null, container_name: null, runtime_user: null,
          home_directory: null, state_directory: null, runtime_key: null });
      }
      const remote = await apiGet(browser(), '/v3/console/config');
      expect(remote.status).toBe(200);
      expect(Array.isArray(remote.body.agents)).toBe(true);
      expect(remote.body.agents).not.toEqual(expect.arrayContaining([expect.objectContaining({ tenant_id: tenant, alias: emptyAlias })]));
      await capture('A03-E15-aviso-registro');
      await browser().getByRole('button', { name: 'Cerrar aviso del registro', exact: true }).click();
      await browser().getByRole('button', { name: 'Cerrar aviso del registro', exact: true }).waitFor({ state: 'hidden' });
      record('A03-A18-E15', { removed: emptyAlias, durableRemoval: durableRemoval.rows,
        focusFallback: 'Añadir agente', inventoryReloaded: true, noticeDismissed: true });
    });
  }, 180_000);

  it('B03 B05 E11 G03 A13: lector no modifica ajustes ni grupos; sin elegibles enlaza a Mis cuotas', async () => {
    await step('reader-and-no-eligible', async () => {
      const readerPage = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
      readerErrors.watch(readerPage, 'settings-reader');
      await login(readerPage, active().baseUrl, reader);
      await openAgents(readerPage);
      await readerPage.getByLabel('Buscar agente o grupo', { exact: true }).fill(alias);
      await readerPage.getByRole('button', { name: `Abrir agente ${ref()}`, exact: true }).click();
      const readerSheet = readerPage.getByRole('dialog').first();
      await readerSheet.getByRole('tab', { name: 'Ajustes', exact: true }).click();
      await readerSheet.getByRole('note').filter({ hasText: 'Solo lectura: tu cuenta no tiene permiso' }).waitFor();
      for (const field of ['Nombre visible', 'Cuenta de cuota', 'Mensajes a la vez']) {
        expect(await readerSheet.getByLabel(field).isDisabled()).toBe(true);
      }
      for (const text of ['Previsualizar cuenta', 'Guardar cuenta de cuota']) {
        expect(await readerSheet.getByRole('button', { name: text, exact: true }).isDisabled()).toBe(true);
      }
      const beforeDenied = { agent: await storedAgent(), bindings: await bindingRows() };
      for (const mutation of [
        { resource: 'agent_account_binding', action: 'update', tenant_id: tenant, agent_alias: alias,
          account_id: ownAccount, value: { priority: 2, enabled: false } },
        { resource: 'alias_routing_ceiling', action: 'delete', tenant_id: tenant, alias, account_id: sharedAccount },
        { resource: 'agent', action: 'update', tenant_id: tenant, alias, value: { display_name: 'Cambio denegado' } },
      ]) {
        readerErrors.expectHttpError('/v3/console/config/changes', 403);
        const result = await requestConfigChange(readerPage, mutation);
        expect(result.status, JSON.stringify(result.body)).toBe(403);
      }
      expect({ agent: await storedAgent(), bindings: await bindingRows() }).toEqual(beforeDenied);
      await capture('B05-E11-solo-lectura', readerPage,
        readerSheet.getByRole('note').filter({ hasText: 'No tienes permiso para cambiar las cuentas de cuota.' }));
      await readerSheet.getByRole('tab', { name: 'Grupos', exact: true }).click();
      expect(await readerSheet.getByRole('button', { name: `Editar equipo ${room(2)}`, exact: true }).isDisabled()).toBe(true);
      await capture('B05-E11-G03-lector', readerPage);
      await readerSheet.getByRole('button', { name: 'Cerrar', exact: true }).click();
      expect(await readerPage.getByRole('button', { name: `Eliminar definitivamente ${ref(retiredAlias)}`, exact: true }).isDisabled()).toBe(true);
      await readerPage.context().close();
      await pool().query('UPDATE provider_accounts SET enabled=false WHERE company_id=$1', [person.company.slug]);
      await openSheet(alias, 'Ajustes');
      await binding().getByText(/Solo aparecen cuentas habilitadas de este espacio o compartidas con él/u).waitFor();
      expect(await binding().getByLabel('Cuenta de cuota').locator('option').count()).toBe(1);
      await capture('B03-sin-elegibles', browser(), binding().getByText(/Solo aparecen cuentas habilitadas de este espacio o compartidas con él/u));
      await binding().getByRole('link', { name: 'Mis cuotas', exact: true }).click();
      await expect.poll(() => browser().url()).toContain('/my-quotas');
      record('B03-B05-E11-G03-A13', { readOnly: true, noEligibleAccounts: true, retiredPurgeDenied: true, bindingsUnchanged: await bindingRows() });
      errors.assertClean();
      readerErrors.assertClean();
    });
  }, 180_000);
});
