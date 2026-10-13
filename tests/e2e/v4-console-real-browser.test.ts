import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INVALID_REGISTRATION, REGISTRATION_IN_USE } from '../../services/gateway/src/company-registration.js';
import { isaTenant, newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import { seedQuotaHost } from './v4-console-real-browser.quotas.js';
import {
  apiGet, asV4Page, BrowserErrorLog, bodySnippet, fillRegistration, HERMETIC_INSTANCE_RULES, login, openRegistration,
  PATTERN_DEFECT_RULE, syntheticPerson, validity, type V4Page,
} from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const ownerA = syntheticPerson('a', run);
const ownerB = syntheticPerson('b', run);
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE]);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let pageA: V4Page | undefined;
let hubA = '';

const active = () => { if (!fixture) throw new Error('V4 fixture is not initialized'); return fixture; };
const pool = () => active().database.pool;
const base = () => active().baseUrl;
const ownerPage = () => { if (!pageA) throw new Error('owner A has no page yet'); return pageA; };

async function freshPage(label: string, viewport = { width: 1440, height: 1000 }): Promise<V4Page> {
  const page = asV4Page(await newTrustedPage(active(), viewport));
  errors.watch(page, label);
  return page;
}

/** Fails with the visible state of the page, which is what a person would have seen. */
async function step<T>(page: V4Page, name: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (cause) {
    throw new Error(`${name} failed at ${page.url()}: ${await bodySnippet(page)} || console=${JSON.stringify(errors.trace.slice(-12))}`, { cause });
  }
}

/** Sends a write with the session's own CSRF token, as a person could outside the interface. */
async function apiPost(page: V4Page, path: string, payload: unknown): Promise<number> {
  return page.evaluate(async ({ target, body }: { target: string; body: string }) => {
    const session = await (await fetch('/v3/auth/session', { credentials: 'include', cache: 'no-store' })).json() as { csrf_token?: string };
    const response = await fetch(target, { method: 'POST', credentials: 'include', body,
      headers: { 'Content-Type': 'application/json', 'X-Cauce-Console': '1', 'X-CSRF-Token': session.csrf_token ?? '' } });
    return response.status;
  }, { target: path, body: JSON.stringify(payload) });
}

async function openConfig(page: V4Page, section: string): Promise<void> {
  await page.goto(`${base()}/config?seccion=${section}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Ajustes', exact: true }).waitFor({ timeout: 20_000 });
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  fixture = await startConsoleFunctionalFixture();
}, 600_000);

afterAll(async () => { await fixture?.close(); }, 180_000);

describe('recorrido V4 de la consola en navegador real contra gateway y PostgreSQL reales', () => {
  it('registro: rechaza entradas inválidas con su mensaje, crea la cuenta y la empresa y entra como dueño', async () => {
    const page = await freshPage('owner-a');
    pageA = page;
    await step(page, 'registration', async () => {
      const form = await openRegistration(page, base());
      await fillRegistration(form, { ...ownerA, password: 'corta' });
      await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      const shortPassword = await validity(form.getByLabel('Contraseña', { exact: true }));
      expect(shortPassword.valid).toBe(false);
      expect(shortPassword.message).not.toBe('');
      expect(await form.isVisible()).toBe(true);
      await fillRegistration(form, { ...ownerA, company: { ...ownerA.company, slug: 'Slug Inválido' } });
      await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      const invalidSlug = await validity(form.getByLabel('Identificador de empresa', { exact: true }));
      expect(invalidSlug.valid).toBe(false);
      expect(invalidSlug.message).not.toBe('');
      errors.expectHttpError('/v3/auth/register', 400);
      await fillRegistration(form, { ...ownerA, name: '   ' });
      await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      await expect.poll(async () => page.getByRole('alert').innerText(), { timeout: 15_000 }).toContain(INVALID_REGISTRATION.message);
      await fillRegistration(form, ownerA);
      await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    });
    const session = await apiGet(page, '/v3/auth/session');
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ authenticated: true, authority: { role: 'company_owner', acting_company: ownerA.company.slug } });
    const owner = await pool().query<{ tenant_id: string; company_role: string }>(
      `SELECT u.tenant_id,a.role AS company_role FROM console_users u
        JOIN company_admins a ON a.human_id=u.id AND a.company_id=u.company_id WHERE u.email=$1`, [ownerA.email]);
    expect(owner.rows).toHaveLength(1);
    expect(owner.rows[0]?.company_role).toBe('owner');
    hubA = owner.rows[0]?.tenant_id ?? '';
    const stored = await pool().query<{ password_hash: string }>('SELECT password_hash FROM console_users WHERE email=$1', [ownerA.email]);
    expect(stored.rows[0]?.password_hash).not.toContain(ownerA.password);
  });

  it('registro duplicado: un identificador o un correo ocupados devuelven el mismo error visible y no crean nada', async () => {
    const page = await freshPage('duplicate-registration');
    const duplicate = syntheticPerson('dup', run);
    for (const [label, attempt] of [
      ['taken company identifier', { ...duplicate, company: { name: 'Otra empresa', slug: ownerA.company.slug } }],
      ['taken email', { ...duplicate, email: ownerA.email }],
    ] as const) {
      await step(page, `duplicate registration with a ${label}`, async () => {
        errors.expectHttpError('/v3/auth/register', 409);
        const form = await openRegistration(page, base());
        await fillRegistration(form, attempt);
        await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
        await expect.poll(async () => page.getByRole('alert').innerText(), { timeout: 15_000 }).toContain(REGISTRATION_IN_USE.message);
      });
    }
    expect((await pool().query('SELECT 1 FROM console_users WHERE email=$1', [duplicate.email])).rowCount).toBe(0);
    expect((await pool().query('SELECT 1 FROM companies WHERE id=$1', [duplicate.company.slug])).rowCount).toBe(0);
  });

  it('empresa: renombra la propia, crea otra con su dueño y rechaza entradas inválidas', async () => {
    const page = ownerPage();
    await step(page, 'company panel', async () => {
      await openConfig(page, 'general');
      const row = page.getByRole('listitem').filter({ hasText: ownerA.company.name });
      await row.getByRole('button', { name: 'Editar', exact: true }).click();
      await page.getByLabel('Nombre de empresa', { exact: true }).fill('   ');
      expect(await page.getByRole('button', { name: 'Guardar empresa', exact: true }).isDisabled()).toBe(true);
      await page.getByLabel('Nombre de empresa', { exact: true }).fill(`${ownerA.company.name} editada`);
      await page.getByRole('button', { name: 'Guardar empresa', exact: true }).click();
      await page.getByText('Empresa actualizada.', { exact: true }).waitFor({ timeout: 15_000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByText(`${ownerA.company.name} editada`, { exact: true }).waitFor({ timeout: 15_000 });
    });
    const renamed = await pool().query<{ name: string; version: number }>('SELECT name,version::int FROM companies WHERE id=$1', [ownerA.company.slug]);
    expect(renamed.rows[0]?.name).toBe(`${ownerA.company.name} editada`);
    expect(renamed.rows[0]?.version).toBeGreaterThan(1);

    await step(page, 'owner without company creation', async () => {
      await page.getByText(`Dueño de empresa · ${ownerA.company.slug}`, { exact: true }).waitFor({ timeout: 15_000 });
      expect(await page.getByRole('button', { name: 'Crear empresa', exact: true }).count()).toBe(0);
      errors.expectHttpError('/v3/console/companies', 403);
      expect(await apiPost(page, '/v3/console/companies', ownerB)).toBe(403);
    });
    expect((await pool().query('SELECT 1 FROM companies WHERE id=$1', [ownerB.company.slug])).rowCount).toBe(0);

    const granted = await active().database.adminPool.query('INSERT INTO platform_admins(human_id) SELECT id FROM console_users WHERE email=$1', [isaTenant.email]);
    expect(granted.rowCount).toBe(1);
    const platform = await freshPage('platform-admin');
    await step(platform, 'company create', async () => {
      await login(platform, base(), { email: isaTenant.email, password: isaTenant.password, name: 'Plataforma', company: { name: '', slug: '' } });
      await openConfig(platform, 'general');
      await platform.getByRole('button', { name: 'Crear empresa', exact: true }).click();
      const form = platform.getByRole('form', { name: 'Crear empresa y dueño' });
      const fill = async (person: typeof ownerB, password = person.password) => {
        for (const [label, value] of [
          ['Nombre de empresa', person.company.name], ['Identificador de empresa', person.company.slug],
          ['Nombre del dueño', person.name], ['Correo del dueño', person.email], ['Contraseña inicial', password],
        ] as const) await form.getByLabel(label, { exact: true }).fill(value);
      };
      await fill(ownerB, 'corta');
      await form.getByRole('button', { name: 'Crear empresa y dueño', exact: true }).click();
      const short = await validity(form.getByLabel('Contraseña inicial', { exact: true }));
      expect(short.valid).toBe(false);
      expect(short.message).not.toBe('');
      errors.expectHttpError('/v3/console/companies', 409);
      await fill({ ...ownerB, company: { ...ownerB.company, slug: ownerA.company.slug } });
      await form.getByRole('button', { name: 'Crear empresa y dueño', exact: true }).click();
      await platform.getByRole('alert').filter({ hasText: 'El correo o el identificador de empresa ya están en uso.' }).waitFor({ timeout: 15_000 });
      expect(await pool().query('SELECT 1 FROM console_users WHERE email=$1', [ownerB.email])).toMatchObject({ rowCount: 0 });
      await fill(ownerB);
      await form.getByRole('button', { name: 'Crear empresa y dueño', exact: true }).click();
      await platform.getByText('Empresa y cuenta de dueño creadas.', { exact: true }).waitFor({ timeout: 20_000 });
    });
    const created = await pool().query<{ company_id: string; role: string }>(
      `SELECT u.company_id,a.role FROM console_users u JOIN company_admins a ON a.human_id=u.id AND a.company_id=u.company_id WHERE u.email=$1`, [ownerB.email]);
    expect(created.rows).toEqual([{ company_id: ownerB.company.slug, role: 'owner' }]);
  });

  it('ordenadores: rechaza una invitación inválida o fuera de la partición de su empresa, entrega la válida una sola vez y la cancela', async () => {
    const page = ownerPage();
    const hostId = `${ownerA.company.slug}-v4${run}`;
    await step(page, 'host invitation', async () => {
      await openConfig(page, 'computadoras');
      const panel = page.getByRole('region', { name: 'Añadir ordenador', exact: true });
      await panel.getByRole('button', { name: 'Añadir ordenador', exact: true }).click();
      const form = page.getByRole('form', { name: 'Invitar ordenador' });
      await form.getByLabel('Identificador del ordenador').fill('Ordenador Inválido');
      await form.getByLabel('Nombre del ordenador').fill('Ordenador V4');
      const malformedHostId = await validity(form.getByLabel('Identificador del ordenador'));
      expect(malformedHostId.valid).toBe(false);
      expect(malformedHostId.message).not.toBe('');
      errors.expectHttpError('/v3/console/fleet/hosts/enrollments', 400);
      expect(await apiPost(page, '/v3/console/fleet/hosts/enrollments', { host_id: 'Ordenador Inválido', display_name: 'Ordenador V4' })).toBe(400);

      await form.getByLabel('Identificador del ordenador').fill(`v4-${run}`);
      const outOfPartitionHostId = await validity(form.getByLabel('Identificador del ordenador'));
      expect(outOfPartitionHostId.valid).toBe(false);
      expect(outOfPartitionHostId.message).not.toBe('');
      errors.expectHttpError('/v3/console/fleet/hosts/enrollments', 403);
      expect(await apiPost(page, '/v3/console/fleet/hosts/enrollments', { host_id: `v4-${run}`, display_name: 'Ordenador V4' })).toBe(403);

      // The company prefix is fixed in the form; only the name part is typed.
      await form.getByLabel('Identificador del ordenador').fill(hostId.slice(ownerA.company.slug.length + 1));
      await form.getByRole('button', { name: 'Crear invitación', exact: true }).click();
      const invitation = panel.locator('textarea');
      await invitation.waitFor({ timeout: 15_000 });
      const receipt = JSON.parse(await invitation.inputValue()) as Record<string, unknown>;
      expect(typeof receipt.enrollment_id).toBe('string');
      expect(receipt.host_id).toBe(hostId);
      expect(await panel.locator('code').innerText()).toBe(`cauce hosts enroll --gateway ${base()} --invitation-stdin`);
      await panel.getByRole('button', { name: 'Cerrar invitación', exact: true }).click();
      await page.reload({ waitUntil: 'domcontentloaded' });
      expect(await panel.locator('textarea').count()).toBe(0);
      const listed = await apiGet(page, '/v3/console/fleet/hosts/enrollments');
      const secrets = Object.entries(receipt).filter(([key, value]) => /token|nonce|secret/iu.test(key) && typeof value === 'string');
      expect(secrets.length).toBeGreaterThan(0);
      for (const [, value] of secrets) expect(JSON.stringify(listed.body)).not.toContain(value as string);
      await panel.getByRole('button', { name: 'Cancelar invitación de Ordenador V4', exact: true }).click();
      await panel.getByText('Invitación cancelada.', { exact: true }).waitFor({ timeout: 15_000 });
      const stored = await pool().query<{ state: string }>('SELECT state FROM fleet_host_enrollments WHERE id=$1', [receipt.enrollment_id]);
      expect(stored.rows[0]?.state).toBe('revoked');
    });
  });

  const roomId = `sala-${run}`;
  const roomLabel = 'Sala V4 uno';
  const renamedLabel = 'Sala V4 renombrada';
  const planRoom = (label: string) => `Sala ${hubA}/${label}`;

  it('oficina: la sala creada en /config aparece en «Plano editable», cambia de nombre y desaparece', async () => {
    const page = ownerPage();
    await step(page, 'room create', async () => {
      await openConfig(page, 'espacios');
      await page.getByRole('button', { name: 'Un solo recurso' }).click();
      await page.getByLabel('Recurso a crear').selectOption('room');
      await page.getByLabel('Tenant', { exact: true }).fill('1-inválido');
      await page.getByLabel('Room', { exact: true }).fill(roomId);
      await page.getByLabel('Nombre', { exact: true }).fill(roomLabel);
      expect(await page.getByRole('button', { name: 'Crear', exact: true }).isDisabled()).toBe(true);
      await page.getByText('El tenant debe empezar con letra (máx. 64 caracteres).').waitFor({ timeout: 15_000 });
      await page.getByLabel('Tenant', { exact: true }).fill(hubA);
      await page.getByRole('button', { name: 'Crear', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'creado en la revisión' }).waitFor({ timeout: 20_000 });
    });
    const created = await pool().query<{ label: string | null }>('SELECT display_name AS label FROM rooms WHERE tenant_id=$1 AND id=$2', [hubA, roomId]);
    expect(created.rows).toEqual([{ label: roomLabel }]);
    await step(page, 'room in plan', async () => {
      await page.goto(`${base()}/live`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
      await page.getByRole('region', { name: planRoom(roomLabel), exact: true }).waitFor({ timeout: 20_000 });
    });
    await step(page, 'room rename', async () => {
      await openConfig(page, 'espacios');
      await page.getByRole('button', { name: `Editar sala/grupo ${hubA}/${roomId}`, exact: true }).click();
      const form = page.getByRole('form', { name: 'Editar sala/grupo', exact: true });
      await form.getByLabel('Nombre visible', { exact: true }).fill(renamedLabel);
      await form.getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
      await form.getByRole('button', { name: 'Confirmar edición', exact: true }).click();
      await expect.poll(async () => (await pool().query<{ label: string }>(
        'SELECT display_name AS label FROM rooms WHERE tenant_id=$1 AND id=$2', [hubA, roomId])).rows[0]?.label, { timeout: 20_000 }).toBe(renamedLabel);
    });
    await step(page, 'renamed room in plan', async () => {
      await page.goto(`${base()}/live`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
      await page.getByRole('region', { name: planRoom(renamedLabel), exact: true }).waitFor({ timeout: 20_000 });
      expect(await page.getByRole('region', { name: planRoom(roomLabel), exact: true }).count()).toBe(0);
    });
    await step(page, 'room delete', async () => {
      await openConfig(page, 'espacios');
      await page.getByRole('button', { name: `Eliminar sala/grupo ${hubA}/${roomId}`, exact: true }).click();
      const form = page.getByRole('form', { name: 'Eliminar sala/grupo', exact: true });
      await form.getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
      await form.getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();
      await expect.poll(async () => (await pool().query('SELECT 1 FROM rooms WHERE tenant_id=$1 AND id=$2', [hubA, roomId])).rowCount, { timeout: 20_000 }).toBe(0);
    });
    await step(page, 'deleted room gone from plan', async () => {
      await page.goto(`${base()}/live`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
      await page.getByRole('region', { name: planRoom('office'), exact: true }).waitFor({ timeout: 20_000 });
      expect(await page.getByRole('region', { name: planRoom(renamedLabel), exact: true }).count()).toBe(0);
    });
  });

  const partLabel = 'Zona V4 persistente';
  const officeRoom = () => `Sala ${hubA}/office`;
  let savedLayout: unknown;

  async function openPlan(page: V4Page): Promise<void> {
    await page.goto(`${base()}/live`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
    await page.getByRole('region', { name: officeRoom(), exact: true }).waitFor({ timeout: 20_000 });
  }

  it('plano: rechaza una parte sin nombre, guarda con CAS y persiste tras cerrar sesión y en un segundo contexto', async () => {
    const page = ownerPage();
    await step(page, 'plan save', async () => {
      await openPlan(page);
      await page.getByRole('region', { name: officeRoom(), exact: true }).getByRole('button').first().click();
      const editor = page.getByRole('region', { name: `Editar sala ${hubA}/office`, exact: true });
      await editor.getByLabel('Posición horizontal de office', { exact: true }).fill('64');
      await editor.getByRole('button', { name: 'Añadir parte', exact: true }).click();
      await editor.getByLabel('Nombre de parte', { exact: true }).fill('   ');
      await page.getByRole('button', { name: 'Guardar plano', exact: true }).click();
      await page.getByText('Cada parte necesita un nombre de 1 a 120 caracteres.', { exact: true }).waitFor({ timeout: 15_000 });
      expect(await pool().query('SELECT 1 FROM company_office_layouts WHERE company_id=$1', [ownerA.company.slug])).toMatchObject({ rowCount: 0 });
      await editor.getByLabel('Nombre de parte', { exact: true }).fill(partLabel);
      await page.getByRole('button', { name: 'Guardar plano', exact: true }).click();
      await page.getByText('Plano de oficina guardado para esta empresa.', { exact: true }).waitFor({ timeout: 15_000 });
    });
    const stored = await apiGet(page, '/v3/console/office/layout');
    expect(stored.status).toBe(200);
    savedLayout = stored.body;
    const sql = await pool().query<{ version: number; rooms: unknown }>('SELECT version::int,rooms FROM company_office_layouts WHERE company_id=$1', [ownerA.company.slug]);
    expect(sql.rows).toHaveLength(1);
    expect(sql.rows[0]?.rooms).toEqual((stored.body as { rooms: unknown }).rooms);
    expect(JSON.stringify(sql.rows[0]?.rooms)).toContain(partLabel);

    await step(page, 'plan after re-login', async () => {
      await page.getByRole('button', { name: `Cuenta de ${ownerA.name}` }).click();
      await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
      await page.getByLabel('Correo', { exact: true }).waitFor({ timeout: 20_000 });
      await login(page, base(), ownerA);
      await openPlan(page);
      await page.getByLabel(`Parte ${partLabel}`, { exact: true }).waitFor({ timeout: 15_000 });
      expect((await apiGet(page, '/v3/console/office/layout')).body).toEqual(savedLayout);
    });

    const second = await freshPage('owner-a-second', { width: 390, height: 844 });
    await step(second, 'plan in second context', async () => {
      await login(second, base(), ownerA);
      await openPlan(second);
      await second.getByLabel(`Parte ${partLabel}`, { exact: true }).waitFor({ timeout: 15_000 });
      expect((await apiGet(second, '/v3/console/office/layout')).body).toEqual(savedLayout);
    });
  });

  const agentAlias = `agente-${run}`;

  it('ficha: el agente del plano abre su ficha y desde ella el historial de contexto', async () => {
    const page = ownerPage();
    const unplacedMessage = 'La consulta de cuota requiere un agente y un harness habilitados, un entorno de contenedor y un ordenador habilitado.';
    const noReaderMessage = 'Sin lector de cuota para este harness: el proveedor no expone una ventana de consumo medible.';
    const revisionMatcher: unknown = expect.any(Number);
    await pool().query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,company_id)
      VALUES($1,$2,'codex',$2,true,$3,'stev',$4,$5,$6)`, [hubA, agentAlias, `cauce-v4-${run}`, `/srv/v4/${run}`, `/srv/v4/${run}/state`, ownerA.company.slug]);
    await pool().query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')", [hubA, agentAlias]);
    await pool().query('INSERT INTO agent_profiles(tenant_id,alias,role_summary) VALUES($1,$2,$3)', [hubA, agentAlias, 'Agente de prueba V4']);
    await step(page, 'agent sheet', async () => {
      await openPlan(page);
      await page.getByRole('region', { name: officeRoom(), exact: true }).getByRole('button').first().click();
      await page.getByRole('region', { name: `Agentes de sala ${hubA}/office`, exact: true })
        .getByRole('button', { name: new RegExp(agentAlias, 'u') }).click();
      const sheet = page.getByRole('dialog');
      await sheet.getByText(agentAlias, { exact: true }).first().waitFor({ timeout: 15_000 });
      await sheet.getByText(unplacedMessage, { exact: true }).waitFor({ timeout: 15_000 });
      expect(await sheet.getByText(noReaderMessage, { exact: true }).count()).toBe(0);
      await sheet.getByText('Todavía no hay una medición persistida.', { exact: true }).waitFor({ timeout: 15_000 });
      const quota = await apiGet(page, `/v3/console/agents/${hubA}/${agentAlias}/quota`);
      expect(quota.status).toBe(200);
      expect(quota.body).toEqual({ tenant_id: hubA, alias: agentAlias, revision: revisionMatcher, configuration_revision: revisionMatcher,
        reader_available: false, can_query: false, reason: 'quota_target_unplaced',
        status: 'unsupported', captured_at: null, binding: null, sample: null, operation: null });
      await sheet.getByRole('link', { name: 'Perfil y contexto', exact: true }).click();
      await page.getByRole('heading', { name: `Perfil y contexto de ${agentAlias}`, exact: true }).waitFor({ timeout: 20_000 });
      await page.getByRole('tab', { name: 'Historial', exact: true }).click();
      await page.getByText('Leyendo el diario del perfil…').waitFor({ state: 'hidden', timeout: 20_000 });
      await page.getByText('Alta del perfil · revisión 1').first().waitFor({ timeout: 15_000 });
      await page.getByRole('button', { name: 'Restaurar esta revisión', exact: true }).first().waitFor({ timeout: 15_000 });
      await page.getByRole('tab', { name: 'Versiones y aplicación', exact: true }).click();
      const versions = page.getByRole('region', { name: 'Versiones de contexto', exact: true });
      await versions.getByLabel('Nuevo archivo', { exact: true }).waitFor({ timeout: 20_000 });
      await versions.getByLabel('Nuevo archivo', { exact: true }).fill('../x');
      await versions.getByRole('button', { name: 'Añadir archivo', exact: true }).click();
      await versions.getByRole('alert').waitFor({ timeout: 15_000 });
      expect(await versions.getByRole('alert').innerText()).toContain('Usa una ruta relativa nueva dentro del contexto.');
    });
    const revisions = await pool().query<{ count: string }>(
      `SELECT count(*)::text FROM agent_profile_revisions WHERE tenant_id=$1 AND alias=$2`, [hubA, agentAlias]);
    expect(Number(revisions.rows[0]?.count)).toBeGreaterThanOrEqual(1);
    expect((await pool().query('SELECT reader_available,status,captured_at,account_id,sample FROM agent_quota_observations WHERE tenant_id=$1 AND alias=$2',
      [hubA, agentAlias])).rows).toEqual([{ reader_available: false, status: 'unsupported', captured_at: null, account_id: null, sample: null }]);
    const noReaderAlias = `sin-lector-${run}`;
    await pool().query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,company_id)
      VALUES($1,$2,'openclaw',$2,true,$3,'stev',$4,$5,$6)`,
    [hubA, noReaderAlias, `cauce-v4-no-reader-${run}`, `/srv/v4/${run}/no-reader`, `/srv/v4/${run}/no-reader/state`, ownerA.company.slug]);
    await pool().query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')", [hubA, noReaderAlias]);
    await step(page, 'agent sheet without quota reader', async () => {
      await openPlan(page);
      await page.getByRole('region', { name: officeRoom(), exact: true }).getByRole('button').first().click();
      await page.getByRole('region', { name: `Agentes de sala ${hubA}/office`, exact: true })
        .getByRole('button', { name: new RegExp(noReaderAlias, 'u') }).click();
      const sheet = page.getByRole('dialog');
      await sheet.getByText(noReaderAlias, { exact: true }).first().waitFor({ timeout: 15_000 });
      await sheet.getByText(noReaderMessage, { exact: true }).waitFor({ timeout: 15_000 });
      expect(await sheet.getByText(unplacedMessage, { exact: true }).count()).toBe(0);
      await sheet.getByText('Todavía no hay una medición persistida.', { exact: true }).waitFor({ timeout: 15_000 });
      const quota = await apiGet(page, `/v3/console/agents/${hubA}/${noReaderAlias}/quota`);
      expect(quota.status).toBe(200);
      expect(quota.body).toEqual({ tenant_id: hubA, alias: noReaderAlias, revision: revisionMatcher, configuration_revision: revisionMatcher,
        reader_available: false, can_query: false, reason: 'quota_reader_unavailable',
        status: 'unsupported', captured_at: null, binding: null, sample: null, operation: null });
      await sheet.getByRole('button', { name: 'Cerrar el detalle', exact: true }).click();
    });
    expect((await pool().query('SELECT reader_available,status,captured_at,account_id,sample FROM agent_quota_observations WHERE tenant_id=$1 AND alias=$2',
      [hubA, noReaderAlias])).rows).toEqual([{ reader_available: false, status: 'unsupported', captured_at: null, account_id: null, sample: null }]);
  });

  it('autoridad de empresa: sin elegir persona no se puede guardar la asignación', async () => {
    const page = ownerPage();
    await step(page, 'company authority', async () => {
      await openConfig(page, 'general');
      const row = page.getByRole('listitem').filter({ hasText: `${ownerA.company.name} editada` });
      await row.getByRole('button', { name: 'Autoridad de empresa', exact: true }).click();
      const panel = page.getByRole('region', { name: 'Autoridad de empresa', exact: true });
      const form = panel.getByRole('form', { name: 'Asignar autoridad de empresa' });
      await form.waitFor({ timeout: 15_000 });
      await expect.poll(async () => form.locator('select').nth(0).isDisabled(), { timeout: 15_000 }).toBe(false);
      expect(await form.getByRole('button', { name: 'Guardar autoridad', exact: true }).isDisabled()).toBe(true);
      const person = await validity(form.locator('select').nth(0));
      expect(person.valid).toBe(false);
      expect(person.message).not.toBe('');
    });
  });

  const quotaHost = `${ownerA.company.slug}-cuotas${run}`;
  const quotaCard = (page: V4Page, label: string) => page.getByRole('article', { name: `Cuotas de ${label}`, exact: true });

  it('mis cuotas: alta sin agente, fijar tarjeta, preferencias en otra sesión, edición con CAS y borrado', async () => {
    const page = ownerPage();
    await seedQuotaHost(pool(), { companyId: ownerA.company.slug, ownerEmail: ownerA.email, hostId: quotaHost });
    let accountId = '';
    let pausedUntil = '';
    const capabilities = await apiGet(page, '/v3/console/quota-environments');
    expect(capabilities.body).toMatchObject({ capabilities: { available: true, providers: ['codex'] } });
    await step(page, 'quota account create', async () => {
      await page.goto(`${base()}/my-quotas`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Mis cuotas', exact: true }).waitFor({ timeout: 20_000 });
      await expect.poll(async () => page.getByRole('button', { name: 'Registrar cuenta', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
      await page.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
      const form = page.getByRole('form', { name: 'Registrar cuenta de cuotas' });
      await form.getByLabel('Nombre de la cuenta', { exact: true }).fill('');
      expect(await form.getByRole('button', { name: 'Registrar cuenta', exact: true }).isDisabled()).toBe(true);
      const missing = await validity(form.getByLabel('Nombre de la cuenta', { exact: true }));
      expect(missing.valid).toBe(false);
      expect(missing.message).not.toBe('');
      await form.getByLabel('Nombre de la cuenta', { exact: true }).fill('   ');
      expect(await form.getByRole('button', { name: 'Registrar cuenta', exact: true }).isDisabled()).toBe(true);
      await form.getByLabel('Nombre de la cuenta', { exact: true }).fill('Cuenta UI local');
      await form.locator('select').selectOption('codex');
      await form.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
      await quotaCard(page, 'Cuenta UI local').waitFor({ timeout: 20_000 });
    });
    const created = (await apiGet(page, '/v3/console/quota-accounts')).body as { accounts: { id: string; label: string; observation_status: string; remaining_percent: number | null; agents: unknown[] }[] };
    const account = created.accounts.find(item => item.label === 'Cuenta UI local');
    expect(account).toMatchObject({ observation_status: 'unknown', remaining_percent: null, agents: [] });
    accountId = account?.id ?? '';
    await step(page, 'quota account pin', async () => {
      await quotaCard(page, 'Cuenta UI local').getByRole('button', { name: 'Fijar cuenta', exact: true }).click();
      await quotaCard(page, 'Cuenta UI local').getByRole('button', { name: 'Desfijar cuenta', exact: true }).waitFor({ timeout: 15_000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await quotaCard(page, 'Cuenta UI local').getByRole('button', { name: 'Desfijar cuenta', exact: true }).waitFor({ timeout: 20_000 });
    });
    expect(((await apiGet(page, '/v3/console/preferences')).body as { pinned_quota_accounts: string[] }).pinned_quota_accounts).toContain(accountId);
    const pinned = await pool().query<{ pinned_quota_accounts: string[] }>('SELECT pinned_quota_accounts FROM console_company_preferences WHERE company_id=$1', [ownerA.company.slug]);
    expect(pinned.rows[0]?.pinned_quota_accounts).toContain(accountId);

    const second = await freshPage('owner-a-quotas-second');
    await step(second, 'preferences in second session', async () => {
      await login(second, base(), ownerA);
      await second.goto(`${base()}/my-quotas`, { waitUntil: 'domcontentloaded' });
      await quotaCard(second, 'Cuenta UI local').getByRole('button', { name: 'Desfijar cuenta', exact: true }).waitFor({ timeout: 20_000 });
      expect(((await apiGet(second, '/v3/console/preferences')).body as { pinned_quota_accounts: string[] }).pinned_quota_accounts).toContain(accountId);
    });

    await step(page, 'quota account edit', async () => {
      await quotaCard(page, 'Cuenta UI local').getByRole('button', { name: 'Editar cuenta', exact: true }).click();
      const form = page.getByRole('form', { name: 'Editar cuenta de cuotas' });
      const pause = form.getByLabel('Pausa hasta (hora de tu navegador)', { exact: true });
      expect(await pause.evaluate(element => { element.value = 'mañana por la tarde'; return { type: element.type, value: element.value }; }))
        .toEqual({ type: 'datetime-local', value: '' });
      await pause.fill('2030-12-10T08:30');
      expect((await validity(pause)).valid).toBe(true);
      pausedUntil = await pause.evaluate(element => new Date(element.value).toISOString());
      await form.getByText(/^Se guardará:/u).waitFor({ timeout: 15_000 });
      await form.getByLabel('Nombre de la cuenta', { exact: true }).fill('Cuenta UI editada');
      await form.getByLabel('Cuenta habilitada', { exact: true }).uncheck();
      await form.getByRole('button', { name: 'Guardar cuenta', exact: true }).click();
      await quotaCard(page, 'Cuenta UI editada').waitFor({ timeout: 20_000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await quotaCard(page, 'Cuenta UI editada').waitFor({ timeout: 20_000 });
      await quotaCard(page, 'Cuenta UI editada').getByRole('button', { name: 'Editar cuenta', exact: true }).click();
      const reread = page.getByRole('form', { name: 'Editar cuenta de cuotas' });
      expect(await reread.getByLabel('Pausa hasta (hora de tu navegador)', { exact: true }).inputValue()).toBe('2030-12-10T08:30');
      await reread.getByRole('button', { name: 'Cancelar', exact: true }).click();
    });
    const edited = ((await apiGet(page, '/v3/console/quota-accounts')).body as { accounts: { id: string; label: string; enabled: boolean; version: number; paused_until: string | null }[] }).accounts.find(item => item.id === accountId);
    expect(edited).toMatchObject({ label: 'Cuenta UI editada', enabled: false, paused_until: pausedUntil });
    expect(edited?.version).toBeGreaterThan(1);
    expect((await pool().query<{ label: string; enabled: boolean; paused_until: Date }>('SELECT label,enabled,paused_until FROM provider_accounts WHERE id=$1', [accountId])).rows)
      .toEqual([{ label: 'Cuenta UI editada', enabled: false, paused_until: new Date(pausedUntil) }]);

    await step(page, 'quota account unpin and delete', async () => {
      const card = quotaCard(page, 'Cuenta UI editada');
      await card.getByRole('button', { name: 'Desfijar cuenta', exact: true }).click();
      await card.getByRole('button', { name: 'Fijar cuenta', exact: true }).waitFor({ timeout: 15_000 });
      await card.getByRole('button', { name: 'Eliminar cuenta', exact: true }).click();
      await page.getByRole('button', { name: 'Confirmar eliminación de cuenta', exact: true }).click();
      await page.getByText('Cuenta eliminada.', { exact: true }).waitFor({ timeout: 15_000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
    });
    expect((await pool().query('SELECT 1 FROM provider_accounts WHERE id=$1', [accountId])).rowCount).toBe(0);
    expect(((await apiGet(page, '/v3/console/preferences')).body as { pinned_quota_accounts: string[] }).pinned_quota_accounts).not.toContain(accountId);
  });

  it('entornos de cuotas: crear y editar rechazan entradas inválidas y aceptan las válidas', async () => {
    const page = ownerPage();
    await step(page, 'quota environment account', async () => {
      await page.goto(`${base()}/my-quotas`, { waitUntil: 'domcontentloaded' });
      await expect.poll(async () => page.getByRole('button', { name: 'Registrar cuenta', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
      await page.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
      const account = page.getByRole('form', { name: 'Registrar cuenta de cuotas' });
      await account.getByLabel('Nombre de la cuenta', { exact: true }).fill('Cuenta de entorno');
      await account.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
      await quotaCard(page, 'Cuenta de entorno').waitFor({ timeout: 20_000 });
    });
    await step(page, 'quota environment create', async () => {
      const form = page.getByRole('form', { name: 'Crear entorno de cuotas' });
      await expect.poll(async () => form.locator('select').nth(0).isDisabled(), { timeout: 20_000 }).toBe(false);
      expect(await form.getByRole('button', { name: 'Crear entorno', exact: true }).isDisabled()).toBe(true);
      const unselected = await validity(form.locator('select').nth(0));
      expect(unselected.valid).toBe(false);
      expect(unselected.message).not.toBe('');
      await form.locator('select').nth(0).selectOption({ label: 'Cuenta de entorno · codex' });
      await form.locator('select').nth(1).selectOption({ label: 'Ordenador de cuotas V4' });
      await form.getByLabel('Nombre del entorno', { exact: true }).fill('   ');
      expect(await form.getByRole('button', { name: 'Crear entorno', exact: true }).isDisabled()).toBe(true);
      await form.getByLabel('Nombre del entorno', { exact: true }).fill('Entorno V4');
      await form.getByRole('button', { name: 'Crear entorno', exact: true }).click();
      await page.getByText('Creación solicitada. Espera su estado completado antes de usar el entorno.', { exact: true }).waitFor({ timeout: 20_000 });
      await page.getByRole('article', { name: 'Entorno Entorno V4', exact: true }).waitFor({ timeout: 20_000 });
    });
    const stored = await pool().query<{ status: string; host_id: string }>('SELECT status,host_id FROM quota_environments WHERE company_id=$1 AND label=$2', [ownerA.company.slug, 'Entorno V4']);
    expect(stored.rows).toEqual([{ status: 'pending', host_id: quotaHost }]);
    await step(page, 'quota environment edit', async () => {
      await page.getByRole('article', { name: 'Entorno Entorno V4', exact: true }).getByRole('button', { name: 'Editar entorno', exact: true }).click();
      const form = page.getByRole('form', { name: 'Editar entorno de cuotas' });
      await form.getByLabel('Nombre del entorno', { exact: true }).fill('');
      await form.getByRole('button', { name: 'Guardar entorno', exact: true }).click();
      const empty = await validity(form.getByLabel('Nombre del entorno', { exact: true }));
      expect(empty.valid).toBe(false);
      expect(empty.message).not.toBe('');
      await form.getByLabel('Nombre del entorno', { exact: true }).fill('Entorno V4 editado');
      await form.getByRole('button', { name: 'Guardar entorno', exact: true }).click();
      await page.getByText('Configuración del entorno guardada.', { exact: true }).waitFor({ timeout: 20_000 });
    });
    const renamed = await pool().query<{ label: string }>('SELECT label FROM quota_environments WHERE company_id=$1', [ownerA.company.slug]);
    expect(renamed.rows).toEqual([{ label: 'Entorno V4 editado' }]);
  });

  let pageB: V4Page | undefined;

  it('aislamiento: el dueño de B no ve nada de A y su acceso a A recibe 403', async () => {
    const page = await freshPage('owner-b', { width: 390, height: 844 });
    pageB = page;
    await step(page, 'isolation', async () => {
      await login(page, base(), ownerB);
      const session = await apiGet(page, '/v3/auth/session');
      expect(session.body).toMatchObject({ authenticated: true, authority: { role: 'company_owner', acting_company: ownerB.company.slug } });
      errors.expectHttpError(`/v3/console/companies/${ownerA.company.slug}`, 403);
      expect((await apiGet(page, `/v3/console/companies/${ownerA.company.slug}`)).status).toBe(403);
      const topology = await apiGet(page, '/v3/console/topology');
      expect(topology.status).toBe(200);
      expect(JSON.stringify(topology.body)).not.toContain(hubA);
      expect(JSON.stringify(topology.body)).not.toContain(agentAlias);
      const layout = await apiGet(page, '/v3/console/office/layout');
      expect(layout.status).toBe(200);
      expect(JSON.stringify(layout.body)).not.toContain(hubA);
      expect(JSON.stringify(layout.body)).not.toContain(partLabel);
      expect((await apiGet(page, '/v3/console/quota-accounts')).body).toMatchObject({ accounts: [] });
      await page.goto(`${base()}/live`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
      await page.getByRole('heading', { name: 'Plano de oficina', exact: true }).waitFor({ timeout: 20_000 });
      expect(await page.getByRole('region', { name: officeRoom(), exact: true }).count()).toBe(0);
      expect(await page.getByText(agentAlias).count()).toBe(0);
    });
  });

  it('retiro: B retira su empresa, se conserva el dato y su autoridad queda en none con 403 en lo protegido', async () => {
    const page = pageB;
    if (!page) throw new Error('owner B has no page yet');
    await step(page, 'company retirement', async () => {
      await openConfig(page, 'general');
      const row = page.getByRole('listitem').filter({ hasText: ownerB.company.name });
      await row.getByRole('button', { name: 'Retirar', exact: true }).click();
      const confirmation = page.getByRole('region', { name: 'Confirmar estado de empresa', exact: true });
      const confirm = confirmation.getByRole('button', { name: 'Confirmar cambio de empresa', exact: true });
      expect(await confirm.isDisabled()).toBe(true);
      await confirmation.getByLabel('Escribe el identificador').fill(ownerA.company.slug);
      expect(await confirm.isDisabled()).toBe(true);
      await confirmation.getByLabel('Escribe el identificador').fill(ownerB.company.slug);
      errors.relaxForbidden('owner-b');
      await confirm.click();
      await expect.poll(async () => (await pool().query<{ enabled: boolean; retired: boolean }>(
        'SELECT enabled,retired_at IS NOT NULL AS retired FROM companies WHERE id=$1', [ownerB.company.slug])).rows[0],
      { timeout: 20_000 }).toEqual({ enabled: false, retired: true });
    });
    const session = await apiGet(page, '/v3/auth/session');
    expect(session.body).toMatchObject({ authenticated: true, authority: { role: 'none' } });
    for (const path of ['/v3/console/companies', '/v3/console/quota-accounts', '/v3/console/preferences', '/v3/console/office/layout']) {
      expect({ path, status: (await apiGet(page, path)).status }).toEqual({ path, status: 403 });
    }
    const kept = await pool().query('SELECT 1 FROM console_users WHERE email=$1', [ownerB.email]);
    expect(kept.rowCount).toBe(1);
    const untouched = await pool().query<{ enabled: boolean }>('SELECT enabled FROM companies WHERE id=$1', [ownerA.company.slug]);
    expect(untouched.rows).toEqual([{ enabled: true }]);
  });

  it('consola: ninguna página del recorrido registró errores del navegador', () => {
    process.stdout.write(`V4 e2e tolerated console messages: ${JSON.stringify(Object.fromEntries(errors.ignored))}\n`);
    errors.assertClean();
    expect(errors.ignored.get(PATTERN_DEFECT_RULE.id) ?? 0).toBe(0);
  });
});
