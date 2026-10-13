import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, bodySnippet, fillRegistration, HERMETIC_INSTANCE_RULES,
  login, openRegistration, PATTERN_DEFECT_RULE, syntheticPerson, type V4Locator, type V4Page, type V4Person,
} from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
function canaryPerson(label: string): V4Person {
  const person = syntheticPerson(label, run);
  return {
    ...person,
    email: `zz-canary-${label}-${run}@example.test`,
    name: `zz-canary-${label}-${run}`,
    company: { name: `zz-canary-empresa-${label}-${run}`, slug: `zz-canary-${label}-${run}` },
  };
}
const ownerA = canaryPerson('matriz-a');
const ownerB = canaryPerson('matriz-b');
const hostId = `zz-canary-host-${run}`;
const hostName = `zz-canary-equipo-${run}`;
const hostEditedName = `zz-canary-equipo-editado-${run}`;
const hostAgentAlias = `zz-canary-hostagent-${run}`;
const accountId = `zz-canary-acct-${run}`;
const accountLabel = `zz-canary-cuenta-${run}`;
const accountEditedLabel = `zz-canary-cuenta-editada-${run}`;
const accountExternal = `zz-canary-sub-${run}`;
const accountLocator = `CAUCE_ZZ_CANARY_${run.toUpperCase()}_PATH`;
const agentAlias = `zz-canary-agent-${run}`;
const agentName = `zz-canary-agente-${run}`;
const partLabel = `zz-canary-part-${run}`;
const partEditedLabel = `zz-canary-part-editada-${run}`;
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE]);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let pageA: V4Page | undefined;
let pageB: V4Page | undefined;
let hubA = '';
let hubB = '';

const active = () => { if (!fixture) throw new Error('V4 CRUD matrix fixture is not initialized'); return fixture; };
const base = () => active().baseUrl;
const pool = () => active().database.pool;
const ownerPage = () => { if (!pageA) throw new Error('owner A has no page yet'); return pageA; };
const foreignPage = () => { if (!pageB) throw new Error('owner B has no page yet'); return pageB; };

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

async function registerCompany(page: V4Page, person: V4Person): Promise<void> {
  const form = await openRegistration(page, base());
  await fillRegistration(form, person);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
}

async function openConfig(page: V4Page, section: string): Promise<void> {
  await page.goto(`${base()}/config?seccion=${section}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Ajustes', exact: true }).waitFor({ timeout: 20_000 });
}

async function apiMutation(page: V4Page, path: string, method: string, payload?: unknown): Promise<number> {
  return page.evaluate(async ({ target, verb, body }: { target: string; verb: string; body: string }) => {
    const session = await (await fetch('/v3/auth/session', { credentials: 'include', cache: 'no-store' })).json() as { csrf_token?: string };
    const response = await fetch(target, {
      method: verb, credentials: 'include', ...(body ? { body } : {}),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-Cauce-Console': '1', 'X-CSRF-Token': session.csrf_token ?? '' },
    });
    return response.status;
  }, { target: path, verb: method, body: payload === undefined ? '' : JSON.stringify(payload) });
}

async function configChange(page: V4Page, mutation: Record<string, unknown>): Promise<number> {
  const snapshot = await apiGet(page, '/v3/console/config');
  const revision = (snapshot.body as { revision?: unknown }).revision;
  if (typeof revision !== 'number') throw new Error('configuration snapshot has no numeric revision');
  return apiMutation(page, '/v3/console/config/changes', 'POST', { expected_revision: revision, dry_run: false, mutation });
}

interface StoredHost { display_name: string; notes: string; enabled: boolean; version: string; company_id: string }
async function storedHost(): Promise<StoredHost[]> {
  return (await pool().query<StoredHost>('SELECT display_name,notes,enabled,version::text,company_id FROM fleet_hosts WHERE host_id=$1', [hostId])).rows;
}

async function storedAccount(): Promise<Record<string, unknown>[]> {
  return (await pool().query(
    'SELECT provider,external_account_id,payer_tenant_id,label,credential_ref,shared_with_pool,enabled FROM provider_accounts WHERE id=$1',
    [accountId])).rows as Record<string, unknown>[];
}

async function openAccounts(page: V4Page): Promise<void> {
  await page.goto(`${base()}/accounts`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Cuentas y cuotas', exact: true }).waitFor({ timeout: 20_000 });
  await page.getByRole('tab', { name: 'Inventario', exact: true }).click();
  await page.getByRole('button', { name: 'Nueva cuenta', exact: true }).waitFor({ timeout: 20_000 });
}

async function previewAndApply(page: V4Page, dialog: V4Locator, label: string): Promise<void> {
  const actions = dialog.getByRole('group', { name: `Acciones de ${label}`, exact: true });
  await actions.getByRole('button', { name: 'Previsualizar (dry-run)', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Dry-run aceptado:' }).waitFor({ timeout: 20_000 });
  await actions.getByRole('button', { name: 'Aplicar', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor({ timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
}

async function fillAccountForm(dialog: V4Locator, locator: string): Promise<void> {
  await dialog.getByLabel('Id de cuenta').fill(accountId);
  await dialog.getByLabel('Id externo de la suscripción').fill(accountExternal);
  await dialog.getByLabel('Tenant pagador').fill(hubA);
  await dialog.getByLabel('Etiqueta').fill(accountLabel);
  await dialog.getByLabel('Locator de la credencial').fill(locator);
}

async function openPlan(page: V4Page): Promise<void> {
  await page.goto(`${base()}/live`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('region', { name: 'Oficina', exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
  await page.getByRole('heading', { name: 'Plano de oficina', exact: true }).waitFor({ timeout: 20_000 });
  await page.getByRole('region', { name: `Sala ${hubA}/office`, exact: true }).waitFor({ timeout: 20_000 });
}

async function selectOfficeEditor(page: V4Page): Promise<V4Locator> {
  await page.getByRole('region', { name: `Sala ${hubA}/office`, exact: true }).getByRole('button').first().click();
  const editor = page.getByRole('region', { name: `Editar sala ${hubA}/office`, exact: true });
  await editor.waitFor({ timeout: 20_000 });
  return editor;
}

async function savePlan(page: V4Page): Promise<void> {
  await page.getByRole('button', { name: 'Guardar plano', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Plano de oficina guardado para esta empresa.' }).waitFor({ timeout: 20_000 });
}

async function storedParts(): Promise<{ label: string; width: number }[]> {
  const result = await pool().query<{ rooms: { room_id: string; parts: { label: string; width: number }[] }[] }>(
    'SELECT rooms FROM company_office_layouts WHERE company_id=$1', [ownerA.company.slug]);
  const parts = result.rows[0]?.rooms.find((room) => room.room_id === 'office')?.parts ?? [];
  return parts.map((part) => ({ label: part.label, width: part.width }));
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  fixture = await startConsoleFunctionalFixture();
}, 600_000);

afterAll(async () => { await fixture?.close(); }, 180_000);

describe('matriz CRUD V4 en navegador Chromium real, gateway y PostgreSQL reales', () => {
  it('prepara dos empresas canario y la autoridad de plataforma del dueño A', async () => {
    pageA = await freshPage('owner-a');
    await step(ownerPage(), 'company A registration', async () => { await registerCompany(ownerPage(), ownerA); });
    pageB = await freshPage('owner-b');
    await step(foreignPage(), 'company B registration', async () => { await registerCompany(foreignPage(), ownerB); });
    for (const [person, setHub] of [[ownerA, (value: string) => { hubA = value; }], [ownerB, (value: string) => { hubB = value; }]] as const) {
      const registered = await pool().query<{ tenant_id: string; company_id: string }>(
        'SELECT tenant_id,company_id FROM console_users WHERE email=$1', [person.email]);
      expect(registered.rows).toHaveLength(1);
      expect(registered.rows[0]?.company_id).toBe(person.company.slug);
      setHub(registered.rows[0]?.tenant_id ?? '');
    }
    expect(hubA).toMatch(/^hub-[a-f0-9]+$/u);
    expect(hubB).toMatch(/^hub-[a-f0-9]+$/u);
    expect(hubB).not.toBe(hubA);
    const granted = await active().database.adminPool.query(
      'INSERT INTO platform_admins(human_id) SELECT id FROM console_users WHERE email=$1', [ownerA.email]);
    expect(granted.rowCount).toBe(1);
    expect((await apiGet(ownerPage(), '/v3/auth/session')).body).toMatchObject({
      authenticated: true, authority: { role: 'platform_admin', acting_company: ownerA.company.slug },
    });
  }, 240_000);

  it('ordenadores: registra con rechazos por identificador inválido y duplicado, y relee el alta en PostgreSQL', async () => {
    const page = ownerPage();
    await step(page, 'host create with invalid and duplicate rejections', async () => {
      await openConfig(page, 'computadoras');
      await page.getByRole('button', { name: 'Registrar computadora', exact: true }).click();
      let form = page.getByRole('form', { name: 'Registrar computadora', exact: true });
      await form.getByRole('textbox', { name: /identificador/iu }).fill('Ordenador Inválido');
      await form.getByRole('textbox', { name: 'Nombre visible', exact: true }).fill(hostName);
      await form.getByRole('button', { name: 'Guardar', exact: true }).click();
      await form.getByRole('alert').filter({ hasText: 'Revisa el identificador' }).waitFor({ timeout: 15_000 });
      expect(await storedHost()).toEqual([]);
      await form.getByRole('button', { name: 'Cancelar', exact: true }).click();

      await page.getByRole('button', { name: 'Registrar computadora', exact: true }).click();
      form = page.getByRole('form', { name: 'Registrar computadora', exact: true });
      await form.getByRole('textbox', { name: /identificador/iu }).fill(hostId);
      await form.getByRole('textbox', { name: 'Nombre visible', exact: true }).fill(hostName);
      await form.getByRole('textbox', { name: 'Notas', exact: true }).fill('zz-canary notas');
      await form.getByRole('button', { name: 'Guardar', exact: true }).click();
      await page.getByRole('article', { name: hostName, exact: true }).waitFor({ timeout: 20_000 });

      await page.getByRole('button', { name: 'Registrar computadora', exact: true }).click();
      form = page.getByRole('form', { name: 'Registrar computadora', exact: true });
      await form.getByRole('textbox', { name: /identificador/iu }).fill(hostId);
      await form.getByRole('textbox', { name: 'Nombre visible', exact: true }).fill('zz-canary duplicado');
      errors.expectHttpError('/v3/console/fleet/hosts', 409);
      await form.getByRole('button', { name: 'Guardar', exact: true }).click();
      await form.getByRole('alert').filter({ hasText: 'Ya existe una computadora con ese identificador.' }).waitFor({ timeout: 15_000 });
      await form.getByRole('button', { name: 'Cancelar', exact: true }).click();
    });
    expect(await storedHost()).toEqual([
      { display_name: hostName, notes: 'zz-canary notas', enabled: true, version: '1', company_id: ownerA.company.slug },
    ]);
    const listed = await apiGet(page, '/v3/console/fleet/hosts');
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).toContain(hostId);
    await step(page, 'host survives reload', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('article', { name: hostName, exact: true }).waitFor({ timeout: 20_000 });
    });
  }, 240_000);

  it('ordenadores: edita con versión, otra empresa no lo ve ni lo toca y la baja exige quitar sus agentes', async () => {
    const page = ownerPage();
    await step(page, 'host edit', async () => {
      await openConfig(page, 'computadoras');
      const card = page.getByRole('article', { name: hostName, exact: true });
      await card.getByRole('button', { name: 'Editar', exact: true }).click();
      const form = page.getByRole('form', { name: `Editar ${hostId}`, exact: true });
      await form.getByRole('textbox', { name: 'Nombre visible', exact: true }).fill(hostEditedName);
      await form.getByRole('textbox', { name: 'Notas', exact: true }).fill('zz-canary editado');
      await form.getByRole('button', { name: 'Guardar', exact: true }).click();
      await page.getByRole('article', { name: hostEditedName, exact: true }).waitFor({ timeout: 20_000 });
    });
    expect(await storedHost()).toEqual([
      { display_name: hostEditedName, notes: 'zz-canary editado', enabled: true, version: '2', company_id: ownerA.company.slug },
    ]);
    errors.expectHttpError(`/v3/console/fleet/hosts/${hostId}`, 409);
    expect(await apiMutation(page, `/v3/console/fleet/hosts/${hostId}`, 'PATCH', { expected_version: 1, display_name: 'zz-canary obsoleto' })).toBe(409);
    expect((await storedHost())[0]?.display_name).toBe(hostEditedName);

    const foreign = foreignPage();
    await step(foreign, 'foreign company cannot see or touch the host', async () => {
      await openConfig(foreign, 'computadoras');
      expect(await foreign.getByRole('button', { name: 'Registrar computadora', exact: true }).isDisabled()).toBe(true);
      expect(await foreign.getByText(hostEditedName, { exact: true }).count()).toBe(0);
      const listed = await apiGet(foreign, '/v3/console/fleet/hosts');
      expect(listed.status).toBe(200);
      expect(JSON.stringify(listed.body)).not.toContain(hostId);
      errors.expectHttpError(`/v3/console/fleet/hosts/${hostId}`, 404);
      expect(await apiMutation(foreign, `/v3/console/fleet/hosts/${hostId}`, 'PATCH', { expected_version: 2, display_name: 'zz-canary ajeno' })).toBe(404);
      errors.expectHttpError(`/v3/console/fleet/hosts/${hostId}`, 403);
      expect(await apiMutation(foreign, `/v3/console/fleet/hosts/${hostId}?expected_version=2`, 'DELETE')).toBe(403);
      errors.expectHttpError('/v3/console/fleet/hosts', 403);
      expect(await apiMutation(foreign, '/v3/console/fleet/hosts', 'POST', { host_id: `zz-canary-ajeno-${run}`, display_name: 'zz-canary ajeno', notes: '' })).toBe(403);
    });
    expect((await storedHost())[0]).toMatchObject({ display_name: hostEditedName, version: '2' });

    await pool().query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,company_id,host_id)
      VALUES($1,$2,'fake',$2,true,$3,'stev',$4,$5,$6,$7)`,
    [hubA, hostAgentAlias, `zz-canary-runtime-${run}`, active().directory, `${active().directory}/state`, ownerA.company.slug, hostId]);
    await step(page, 'host delete blocked by its agent', async () => {
      await openConfig(page, 'computadoras');
      const card = page.getByRole('article', { name: hostEditedName, exact: true });
      await card.getByText('Para eliminarla, quita antes sus agentes.', { exact: true }).waitFor({ timeout: 20_000 });
      expect(await card.getByRole('button', { name: 'Eliminar', exact: true }).count()).toBe(0);
      errors.expectHttpError(`/v3/console/fleet/hosts/${hostId}`, 409);
      expect(await apiMutation(page, `/v3/console/fleet/hosts/${hostId}?expected_version=2`, 'DELETE')).toBe(409);
    });
    expect(await storedHost()).toHaveLength(1);
    await pool().query('DELETE FROM agents WHERE tenant_id=$1 AND alias=$2', [hubA, hostAgentAlias]);

    await step(page, 'host delete after dependency removal', async () => {
      await openConfig(page, 'computadoras');
      const card = page.getByRole('article', { name: hostEditedName, exact: true });
      await card.getByRole('button', { name: 'Eliminar', exact: true }).click();
      const confirmation = page.getByRole('alertdialog');
      await confirmation.getByRole('button', { name: 'Eliminar', exact: true }).click();
      await expect.poll(async () => page.getByRole('article', { name: hostEditedName, exact: true }).count(), { timeout: 20_000 }).toBe(0);
      await page.reload({ waitUntil: 'domcontentloaded' });
      expect(await page.getByRole('article', { name: hostEditedName, exact: true }).count()).toBe(0);
    });
    expect(await storedHost()).toEqual([]);
    expect(JSON.stringify((await apiGet(page, '/v3/console/fleet/hosts')).body)).not.toContain(hostId);
  }, 240_000);

  it('cuentas de proveedor: alta desde el formulario con locator inválido y duplicado rechazados, y lectura sin credencial', async () => {
    const page = ownerPage();
    await step(page, 'provider account create', async () => {
      await openAccounts(page);
      await page.getByRole('button', { name: 'Nueva cuenta', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await fillAccountForm(dialog, 'locator-invalido');
      await dialog.getByText('Con env_path el locator tiene que ser el nombre de una variable', { exact: false }).waitFor({ timeout: 15_000 });
      expect(await dialog.getByRole('group', { name: 'Acciones de alta de cuenta', exact: true })
        .getByRole('button', { name: 'Previsualizar (dry-run)', exact: true }).isDisabled()).toBe(true);
      expect(await storedAccount()).toEqual([]);
      await dialog.getByLabel('Locator de la credencial').fill(accountLocator);
      await dialog.getByLabel('Habilitada').click();
      await previewAndApply(page, dialog, 'alta de cuenta');
      await page.getByRole('row', { name: new RegExp(accountId, 'u') }).waitFor({ timeout: 20_000 });
    });
    expect(await storedAccount()).toEqual([{
      provider: 'codex', external_account_id: accountExternal, payer_tenant_id: hubA, label: accountLabel,
      credential_ref: accountLocator, shared_with_pool: false, enabled: true,
    }]);
    const snapshot = await apiGet(page, '/v3/console/config');
    expect(snapshot.status).toBe(200);
    expect(JSON.stringify(snapshot.body)).toContain(accountId);
    expect(JSON.stringify(snapshot.body)).not.toContain(accountLocator);
    const accounts = (snapshot.body as { provider_accounts?: Record<string, unknown>[] }).provider_accounts ?? [];
    const projected = accounts.find((row) => row.id === accountId);
    expect(projected).toMatchObject({ provider: 'codex', external_account_id: accountExternal, label: accountLabel });
    expect(projected && Object.hasOwn(projected, 'credential_ref')).toBe(false);

    await step(page, 'provider account duplicate rejected', async () => {
      await page.getByRole('button', { name: 'Nueva cuenta', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await fillAccountForm(dialog, accountLocator);
      errors.expectHttpError('/v3/console/config/changes', 409);
      await dialog.getByRole('group', { name: 'Acciones de alta de cuenta', exact: true })
        .getByRole('button', { name: 'Previsualizar (dry-run)', exact: true }).click();
      await dialog.getByRole('alert').first().waitFor({ timeout: 20_000 });
      expect(await dialog.getByRole('group', { name: 'Acciones de alta de cuenta', exact: true })
        .getByRole('button', { name: 'Aplicar', exact: true }).isDisabled()).toBe(true);
      await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
    });
    expect(await storedAccount()).toHaveLength(1);
    expect((await storedAccount())[0]).toMatchObject({ label: accountLabel });
  }, 240_000);

  it('cuentas de proveedor: edita y publica desde el formulario, otra empresa no la ve ni tras publicarla y el borrado exige confirmación exacta', async () => {
    const page = ownerPage();
    const foreign = foreignPage();
    await step(foreign, 'foreign company cannot read or delete the private account', async () => {
      const snapshot = await apiGet(foreign, '/v3/console/config');
      expect(JSON.stringify(snapshot.body)).not.toContain(accountId);
      errors.expectHttpError('/v3/console/config/changes', 403);
      expect(await configChange(foreign, { resource: 'provider_account', action: 'delete', id: accountId })).toBe(403);
    });
    expect(await storedAccount()).toHaveLength(1);

    await step(page, 'provider account edit and publish', async () => {
      await openAccounts(page);
      await page.getByRole('button', { name: `Editar «${accountId}»`, exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Etiqueta').fill(accountEditedLabel);
      await dialog.getByLabel('Publicada al pool').click();
      await previewAndApply(page, dialog, 'edición de cuenta');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('tab', { name: 'Inventario', exact: true }).click();
      await page.getByRole('row', { name: new RegExp(accountId, 'u') }).waitFor({ timeout: 20_000 });
      expect(await page.getByRole('row', { name: new RegExp(accountId, 'u') }).innerText()).toContain(accountEditedLabel);
    });
    expect(await storedAccount()).toEqual([{
      provider: 'codex', external_account_id: accountExternal, payer_tenant_id: hubA, label: accountEditedLabel,
      credential_ref: accountLocator, shared_with_pool: true, enabled: true,
    }]);

    await step(foreign, 'foreign company still cannot see the pooled account of another company', async () => {
      const snapshot = await apiGet(foreign, '/v3/console/config');
      expect(JSON.stringify(snapshot.body)).not.toContain(accountId);
      expect(JSON.stringify(snapshot.body)).not.toContain(accountLocator);
      expect(JSON.stringify(snapshot.body)).not.toContain(accountExternal);
    });

    await step(page, 'provider account delete needs the exact confirmation', async () => {
      await page.getByRole('button', { name: `Retirar o rotar «${accountId}»`, exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel(`Confirmar borrado de ${accountId}`).fill('zz-canary-equivocado');
      await dialog.getByText(`Escribí exactamente «${accountId}» para confirmar el borrado.`, { exact: true }).waitFor({ timeout: 15_000 });
      expect(await dialog.getByRole('group', { name: 'Acciones de retiro o rotación de cuenta', exact: true })
        .getByRole('button', { name: 'Previsualizar (dry-run)', exact: true }).isDisabled()).toBe(true);
      expect(await storedAccount()).toHaveLength(1);
      await dialog.getByLabel(`Confirmar borrado de ${accountId}`).fill(accountId);
      await previewAndApply(page, dialog, 'retiro o rotación de cuenta');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('tab', { name: 'Inventario', exact: true }).click();
      expect(await page.getByRole('row', { name: new RegExp(accountId, 'u') }).count()).toBe(0);
    });
    expect(await storedAccount()).toEqual([]);
    const afterDelete = (await apiGet(page, '/v3/console/config')).body as { provider_accounts?: Record<string, unknown>[] };
    expect((afterDelete.provider_accounts ?? []).some((row) => row.id === accountId)).toBe(false);
  }, 240_000);

  it('registro de agente: alta desde el asistente con grupo inicial, lectura durable y duplicado rechazado', async () => {
    const page = ownerPage();
    const createAgent = async (duplicate: boolean): Promise<void> => {
      await openConfig(page, 'agentes');
      await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Añadir agente', exact: true });
      await dialog.getByLabel('Espacio de trabajo').selectOption(hubA);
      await dialog.getByLabel('Alias', { exact: true }).fill(agentAlias);
      await dialog.getByLabel('Nombre visible').fill(agentName);
      await dialog.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await dialog.getByRole('button', { name: 'Siguiente', exact: true }).click();
      if (!duplicate) await dialog.getByLabel('Grupo inicial (opcional)').selectOption('office');
      await dialog.getByRole('button', { name: 'Siguiente', exact: true }).click();
      if (duplicate) {
        errors.expectHttpError('/v3/console/config/changes', 409);
        await dialog.getByRole('button', { name: 'Previsualizar alta', exact: true }).click();
        await dialog.getByRole('alert').first().waitFor({ timeout: 20_000 });
        expect(await dialog.getByRole('button', { name: 'Crear registro', exact: true }).isDisabled()).toBe(true);
        await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
        return;
      }
      await dialog.getByRole('button', { name: 'Previsualizar alta', exact: true }).click();
      await expect.poll(async () => dialog.getByRole('button', { name: 'Crear registro', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
      await dialog.getByRole('button', { name: 'Crear registro', exact: true }).click();
      await dialog.getByText(`Registro creado: ${hubA}/${agentAlias}.`, { exact: true }).waitFor({ timeout: 20_000 });
      await dialog.getByRole('button', { name: 'Terminar', exact: true }).click();
    };
    await step(page, 'agent registry create', async () => { await createAgent(false); });
    const stored = await pool().query(
      'SELECT display_name,enabled,harness_id,container_name,host_id FROM agents WHERE tenant_id=$1 AND alias=$2', [hubA, agentAlias]);
    expect(stored.rows).toEqual([{ display_name: agentName, enabled: false, harness_id: null, container_name: null, host_id: null }]);
    await expect.poll(async () => (await pool().query<{ room_id: string; role: string; enabled: boolean }>(
      'SELECT room_id,role,enabled FROM memberships WHERE tenant_id=$1 AND alias=$2', [hubA, agentAlias])).rows,
    { timeout: 20_000 }).toEqual([{ room_id: 'office', role: 'agent', enabled: true }]);
    const listed = await apiGet(page, '/v3/console/agents');
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).toContain(agentAlias);
    await step(page, 'agent registry duplicate rejected', async () => { await createAgent(true); });
    expect((await pool().query('SELECT 1 FROM agents WHERE tenant_id=$1 AND alias=$2', [hubA, agentAlias])).rowCount).toBe(1);
  }, 240_000);

  it('registro de agente: la baja con membresía da 409 y tras quitarla el registro desaparece de la UI y de PostgreSQL', async () => {
    const page = ownerPage();
    const ref = encodeURIComponent(`${hubA}/${agentAlias}`);
    await step(page, 'agent delete blocked by membership', async () => {
      await page.goto(`${base()}/config?seccion=agentes&agente=${ref}`, { waitUntil: 'domcontentloaded' });
      const sheet = page.getByRole('dialog');
      await sheet.waitFor({ timeout: 20_000 });
      await sheet.getByRole('tab', { name: 'Registro', exact: true }).click();
      const editor = sheet.getByRole('region', { name: `Registro de ${hubA}/${agentAlias}`, exact: true });
      await editor.getByRole('button', { name: 'Eliminar registro', exact: true }).click();
      const form = sheet.getByRole('form', { name: `Eliminar registro de ${hubA}/${agentAlias}`, exact: true });
      errors.expectHttpError('/v3/console/config/changes', 409);
      await form.getByRole('button', { name: 'Previsualizar eliminación', exact: true }).click();
      await sheet.getByRole('alert').first().waitFor({ timeout: 20_000 });
      expect(await form.getByRole('button', { name: 'Confirmar eliminación del registro', exact: true }).isDisabled()).toBe(true);
      await form.getByRole('button', { name: 'Cancelar eliminación', exact: true }).click();
    });
    expect((await pool().query('SELECT 1 FROM agents WHERE tenant_id=$1 AND alias=$2', [hubA, agentAlias])).rowCount).toBe(1);
    expect(await configChange(page, { resource: 'membership', action: 'delete', tenant_id: hubA, room_id: 'office', alias: agentAlias })).toBe(201);
    expect((await pool().query('SELECT 1 FROM memberships WHERE tenant_id=$1 AND alias=$2', [hubA, agentAlias])).rowCount).toBe(0);

    await step(page, 'agent delete after membership removal', async () => {
      await page.goto(`${base()}/config?seccion=agentes&agente=${ref}`, { waitUntil: 'domcontentloaded' });
      const sheet = page.getByRole('dialog');
      await sheet.waitFor({ timeout: 20_000 });
      await sheet.getByRole('tab', { name: 'Registro', exact: true }).click();
      const editor = sheet.getByRole('region', { name: `Registro de ${hubA}/${agentAlias}`, exact: true });
      await editor.getByRole('button', { name: 'Eliminar registro', exact: true }).click();
      const form = sheet.getByRole('form', { name: `Eliminar registro de ${hubA}/${agentAlias}`, exact: true });
      await form.getByRole('button', { name: 'Previsualizar eliminación', exact: true }).click();
      await expect.poll(async () => form.getByRole('button', { name: 'Confirmar eliminación del registro', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
      await form.getByRole('button', { name: 'Confirmar eliminación del registro', exact: true }).click();
      await page.getByText(`Registro de ${hubA}/${agentAlias} eliminado en revisión`, { exact: false }).waitFor({ timeout: 20_000 });
    });
    expect((await pool().query('SELECT 1 FROM agents WHERE tenant_id=$1 AND alias=$2', [hubA, agentAlias])).rowCount).toBe(0);
    await step(page, 'deleted agent stays deleted after reload', async () => {
      await openConfig(page, 'agentes');
      await page.getByLabel('Buscar agente o grupo').fill(agentAlias);
      expect(await page.getByText(agentAlias, { exact: true }).count()).toBe(0);
    });
  }, 240_000);

  it('plano: crea, edita y quita una parte desde la UI con persistencia tras recarga y en un segundo navegador', async () => {
    const page = ownerPage();
    await step(page, 'office part create', async () => {
      await openPlan(page);
      const editor = await selectOfficeEditor(page);
      await editor.getByRole('button', { name: 'Añadir parte', exact: true }).click();
      await editor.getByLabel('Nombre de parte', { exact: true }).fill(partLabel);
      await savePlan(page);
    });
    expect(await storedParts()).toEqual([{ label: partLabel, width: 100 }]);
    await step(page, 'office part edit', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
      await page.getByLabel(`Parte ${partLabel}`, { exact: true }).waitFor({ timeout: 20_000 });
      const editor = await selectOfficeEditor(page);
      await editor.getByLabel('Nombre de parte', { exact: true }).fill(partEditedLabel);
      await editor.getByLabel(`Ancho de ${partEditedLabel}`, { exact: true }).fill('145');
      await savePlan(page);
    });
    expect(await storedParts()).toEqual([{ label: partEditedLabel, width: 145 }]);
    await step(page, 'office part delete', async () => {
      const editor = await selectOfficeEditor(page);
      await editor.getByRole('button', { name: `Quitar parte ${partEditedLabel}`, exact: true }).click();
      expect(await page.getByLabel(`Parte ${partEditedLabel}`, { exact: true }).count()).toBe(0);
      await savePlan(page);
    });
    expect(await storedParts()).toEqual([]);
    const second = await freshPage('owner-a-plan-second');
    await step(second, 'deleted part in second browser', async () => {
      await login(second, base(), ownerA);
      await openPlan(second);
      expect(await second.getByLabel(`Parte ${partEditedLabel}`, { exact: true }).count()).toBe(0);
      const layout = await apiGet(second, '/v3/console/office/layout');
      expect(layout.status).toBe(200);
      expect(JSON.stringify(layout.body)).not.toContain(partEditedLabel);
    });
    await step(page, 'deleted part after reload', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
      await page.getByRole('region', { name: `Sala ${hubA}/office`, exact: true }).waitFor({ timeout: 20_000 });
      expect(await page.getByLabel(`Parte ${partEditedLabel}`, { exact: true }).count()).toBe(0);
    });
  }, 240_000);

  it('no quedan errores inesperados del navegador', () => {
    process.stdout.write(`V4 CRUD matrix e2e tolerated console messages: ${JSON.stringify(Object.fromEntries(errors.ignored))}\n`);
    errors.assertClean();
  });
});
