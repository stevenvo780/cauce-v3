import { randomUUID } from 'node:crypto';
import type { CompanyOfficeLayout, CompanyOfficeRoom } from '@cauce/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newTrustedPage, startConsoleFunctionalFixture, type BrowserResponse,
} from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, bodySnippet, fillRegistration, HERMETIC_INSTANCE_RULES, login,
  openRegistration, PATTERN_DEFECT_RULE, syntheticPerson, type IgnoredConsoleRule, type V4Page, type V4Person,
} from './v4-console-real-browser.helpers.js';
import {
  apiMutation, applyRegistryChange, configChange, escapeRegex, expectCampusRoom, openRegistry, topologyMember,
} from './v4-office-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const canaryPerson = (label: string): V4Person => {
  const person = syntheticPerson(label, run);
  return {
    ...person,
    email: `zz-canary-${label}-${run}@example.test`,
    name: `zz-canary-${label}-${run}`,
    company: { name: `zz-canary-${label}-${run}`, slug: `zz-canary-${label}-${run}` },
  };
};
const ownerA = canaryPerson('owner');
const readerA = canaryPerson('reader');
const ownerB = canaryPerson('foreign-owner');
const roomId = `zz-canary-room-${run}`;
const destinationRoomId = `zz-canary-destination-${run}`;
const roomLabel = `zz-canary-room-${run}`;
const renamedRoomLabel = `zz-canary-renamed-${run}`;
const destinationRoomLabel = `zz-canary-destination-${run}`;
const agentAlias = `zz-canary-agent-${run}`;
const cycleAlias = `zz-canary-cycle-${run}`;
const cycleName = `zz-canary-cycle-name-${run}`;
const renamedCycleName = `zz-canary-cycle-renamed-${run}`;
const partLabel = `zz-canary-part-${run}`;
const editedPartLabel = `zz-canary-edited-part-${run}`;
const draftPartLabel = `zz-canary-draft-part-${run}`;
const discardedPartLabel = `zz-canary-discarded-part-${run}`;
const layoutPath = '/v3/console/office/layout';
const readerTerminalCapabilityRule: IgnoredConsoleRule = {
  id: 'reader-terminal-capability-403',
  reason: 'reader role has no terminal capability access',
  matches: (text, url) => {
    try { return text.includes('status of 403') && new URL(url).pathname === '/v3/console/terminal/capability'; }
    catch { return false; }
  },
};
const terminalRelay404Rules: IgnoredConsoleRule[] = ['/v3/console/terminal/grants', '/v3/console/terminal/targets'].map((path) => ({
  id: `hermetic-${path.replace(/[/]/gu, '-')}-404`,
  reason: 'hermetic gateway without terminal relay',
  matches: (text: string, url: string) => {
    try { return text.includes('status of 404') && new URL(url).pathname === path; }
    catch { return false; }
  },
}));
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, ...terminalRelay404Rules, readerTerminalCapabilityRule, PATTERN_DEFECT_RULE]);
const unexpectedHttp: string[] = [];
const expectedHttp: { label: string; path: string; statuses: number[] }[] = [];
const observedExpectedHttp: string[] = [];
const officeWrites: { label: string; status: number; input: { expected_version: number; rooms: CompanyOfficeRoom[] } }[] = [];
const quotaReads = new Map<string, number>();
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let pageA: V4Page | undefined;
let pageB: V4Page | undefined;
let readerPage: V4Page | undefined;
let hubA = '';
let hubB = '';

const active = () => { if (!fixture) throw new Error('V4 fixture is not initialized'); return fixture; };
const base = () => active().baseUrl;
const pool = () => active().database.pool;
const ownerPage = () => { if (!pageA) throw new Error('owner A has no page yet'); return pageA; };

function allowHttp(label: string, path: string, ...statuses: number[]): void {
  expectedHttp.push({ label, path, statuses });
}

function watchHttp(page: V4Page, label: string): void {
  page.on('response', (value: unknown) => {
    const response = value as BrowserResponse;
    const status = response.status();
    let path: string;
    try { path = new URL(response.url()).pathname; } catch { path = response.url(); }
    if (path === layoutPath && response.request().method() === 'PUT') {
      const request = response.request() as ReturnType<BrowserResponse['request']> & { postData(): string | null };
      officeWrites.push({ label, status, input: JSON.parse(request.postData() ?? '{}') as typeof officeWrites[number]['input'] });
    }
    if (path === '/v3/console/quota-accounts' && response.request().method() === 'GET') quotaReads.set(label, (quotaReads.get(label) ?? 0) + 1);
    if (status < 400) return;
    if ((status === 501 && path === '/v3/console/terminal/capability')
        || (status === 404 && ['/v3/console/mcp/client-delegations', '/v3/console/terminal/grants', '/v3/console/terminal/targets'].includes(path))) return;
    if (label === 'same-company-reader' && status === 403 && path === '/v3/console/terminal/capability') {
      observedExpectedHttp.push(`${label} ${String(status)} ${path}`);
      return;
    }
    const expected = expectedHttp.findIndex((item) => item.label === label && item.path === path && item.statuses.includes(status));
    if (expected >= 0) {
      expectedHttp.splice(expected, 1);
      observedExpectedHttp.push(`${label} ${String(status)} ${path}`);
      return;
    }
    unexpectedHttp.push(`${label} ${String(status)} ${path}`);
  });
}

async function freshPage(label: string): Promise<V4Page> {
  const page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 1000 }));
  errors.watch(page, label);
  watchHttp(page, label);
  return page;
}

async function step<T>(page: V4Page, name: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (cause) {
    throw new Error(`${name} failed at ${page.url()}: ${await bodySnippet(page)} || console=${JSON.stringify(errors.trace.slice(-12))}`, { cause });
  }
}

async function savedLayout(): Promise<Pick<CompanyOfficeLayout, 'version' | 'rooms'>> {
  const result = await pool().query<Pick<CompanyOfficeLayout, 'version' | 'rooms'>>(
    'SELECT version::int,rooms FROM company_office_layouts WHERE company_id=$1', [ownerA.company.slug]);
  expect(result.rows).toHaveLength(1);
  const stored = result.rows[0];
  if (!stored) throw new Error('company office layout is absent');
  return stored;
}

async function selectRoomEditor(page: V4Page) {
  await page.getByRole('region', { name: planRoom(renamedRoomLabel), exact: true }).locator('button[aria-pressed]').click();
  const editor = page.getByRole('region', { name: `Editar sala ${hubA}/${renamedRoomLabel}`, exact: true });
  await editor.waitFor({ timeout: 20_000 });
  return editor;
}

async function savePlan(page: V4Page): Promise<void> {
  await page.getByRole('button', { name: 'Guardar plano', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Plano de oficina guardado para esta empresa.' }).waitFor({ timeout: 20_000 });
}

async function registerCompany(page: V4Page, person: V4Person): Promise<void> {
  const form = await openRegistration(page, base());
  await fillRegistration(form, person);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
}

async function openConfig(page: V4Page, section: string): Promise<void> {
  if (new URL(page.url()).pathname === '/config') {
    await page.goto('about:blank');
  }
  await page.goto(`${base()}/config?seccion=${section}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Ajustes', exact: true }).waitFor({ timeout: 20_000 });
}

async function createRoom(page: V4Page, tenantId: string, id: string, label: string): Promise<void> {
  await openConfig(page, 'espacios');
  await page.getByRole('button', { name: 'Un solo recurso', exact: true }).click();
  await page.getByLabel('Recurso a crear', { exact: true }).selectOption('room');
  await page.getByLabel('Espacio', { exact: true }).fill(tenantId);
  await page.getByLabel('Sala', { exact: true }).fill(id);
  await page.getByLabel('Nombre', { exact: true }).fill(label);
  await page.getByRole('button', { name: 'Crear', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'creado en la revisión' }).waitFor({ timeout: 20_000 });
}

async function openOffice(page: V4Page): Promise<void> {
  if (page.url() !== `${base()}/live`) {
    const nav = page.getByRole('navigation', { name: 'Navegación principal', exact: true });
    if (await nav.isVisible()) {
      await nav.getByRole('link', { name: 'Oficina', exact: true }).click();
    } else {
      await page.goto(`${base()}/live`, { waitUntil: 'domcontentloaded' });
    }
  }
  await page.getByRole('region', { name: 'Oficina', exact: true }).waitFor({ timeout: 30_000 });
  const campus = page.getByRole('toolbar', { name: 'Edificios del campus', exact: true });
  if (!await campus.isVisible()) {
    await page.getByRole('button', { name: 'Campus', exact: true }).click();
  }
  await campus.waitFor({ timeout: 20_000 });
}

async function openPlan(page: V4Page): Promise<void> {
  if (page.url() !== `${base()}/live`) {
    const nav = page.getByRole('navigation', { name: 'Navegación principal', exact: true });
    if (await nav.isVisible()) {
      await nav.getByRole('link', { name: 'Oficina', exact: true }).click();
    } else {
      await page.goto(`${base()}/live`, { waitUntil: 'domcontentloaded' });
    }
  }
  await page.getByRole('region', { name: 'Oficina', exact: true }).waitFor({ timeout: 30_000 });
  const heading = page.getByRole('heading', { name: 'Plano de oficina', exact: true });
  if (!await heading.isVisible()) {
    await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
    await heading.waitFor({ timeout: 20_000 });
  }
}

function planRoom(label: string): string { return `Sala ${hubA}/${label}`; }

async function expectAgentRooms(expectedPrimary: string, expectedRooms: string[], alias = agentAlias): Promise<void> {
  await expect.poll(async () => {
    const agent = await pool().query<{ primary_room_id: string | null }>(
      'SELECT primary_room_id FROM agents WHERE tenant_id=$1 AND alias=$2', [hubA, alias]);
    const memberships = await pool().query<{ room_id: string }>(
      `SELECT room_id FROM memberships WHERE tenant_id=$1 AND alias=$2 AND enabled AND retired_at IS NULL ORDER BY room_id`, [hubA, alias]);
    return { primaryRoomId: agent.rows[0]?.primary_room_id ?? null, rooms: memberships.rows.map((row) => row.room_id) };
  }, { timeout: 20_000 }).toEqual({ primaryRoomId: expectedPrimary, rooms: [...expectedRooms].sort() });
}

async function moveAgent(page: V4Page, destination: string, alias = agentAlias): Promise<void> {
  const ref = encodeURIComponent(`${hubA}/${alias}`);
  if (new URL(page.url()).pathname === '/config') {
    await page.goto('about:blank');
  }
  await page.goto(`${base()}/config?seccion=agentes&agente=${ref}`, { waitUntil: 'domcontentloaded' });
  const sheet = page.getByRole('dialog');
  await sheet.waitFor({ timeout: 20_000 });
  await sheet.getByRole('tab', { name: 'Grupos', exact: true }).click();
  const move = sheet.getByRole('region', { name: 'Mover a otro grupo', exact: true });
  await move.getByLabel('Miembro a mover').selectOption(alias);
  await move.getByLabel('Grupo de destino').selectOption(destination);
  await move.getByRole('button', { name: 'Previsualizar movimiento atómico', exact: true }).click();
  const confirm = move.getByRole('button', { name: 'Confirmar movimiento atómico', exact: true });
  await expect.poll(() => confirm.isDisabled(), { timeout: 20_000 }).toBe(false);
  await confirm.click();
  await move.getByRole('status').waitFor({ timeout: 20_000 });
}

async function assertAgentInPlan(page: V4Page, label: string, alias = agentAlias): Promise<void> {
  const room = page.getByRole('region', { name: planRoom(label), exact: true });
  await room.waitFor({ timeout: 30_000 });
  await room.locator('button[aria-pressed]').click();
  const roster = page.getByRole('region', { name: `Agentes de sala ${hubA}/${label}`, exact: true });
  await roster.getByRole('button', { name: new RegExp(escapeRegex(alias), 'u') }).waitFor({ timeout: 20_000 });
}

async function assertAgentNotInPlan(page: V4Page, label: string, alias = agentAlias): Promise<void> {
  const room = page.getByRole('region', { name: planRoom(label), exact: true });
  await room.waitFor({ timeout: 30_000 });
  await room.locator('button[aria-pressed]').click();
  const roster = page.getByRole('region', { name: `Agentes de sala ${hubA}/${label}`, exact: true });
  await roster.waitFor({ timeout: 20_000 });
  await expect.poll(async () => roster.getByRole('button', { name: new RegExp(escapeRegex(alias), 'u') }).count(), { timeout: 20_000 }).toBe(0);
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  fixture = await startConsoleFunctionalFixture();
}, 600_000);

afterAll(async () => { await fixture?.close(); }, 180_000);

describe('Oficina V4 en navegador Chromium real, gateway y PostgreSQL reales', () => {
  it('prepara dos empresas, una persona lectora de la misma empresa y el agente canario', async () => {
    pageA = await freshPage('owner-a');
    await step(ownerPage(), 'company A registration', async () => { await registerCompany(ownerPage(), ownerA); });
    const registeredA = await pool().query<{ tenant_id: string; company_id: string; role: string }>(
      `SELECT person.tenant_id,person.company_id,admin.role FROM console_users person
        JOIN company_admins admin ON admin.human_id=person.id AND admin.company_id=person.company_id WHERE person.email_normalized=$1`, [ownerA.email]);
    expect(registeredA.rows).toHaveLength(1);
    expect(registeredA.rows[0]).toMatchObject({ company_id: ownerA.company.slug, role: 'owner' });
    expect(typeof registeredA.rows[0]?.tenant_id).toBe('string');
    hubA = registeredA.rows[0]?.tenant_id ?? '';
    await pool().query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,
        home_directory,state_directory,company_id)
      VALUES($1,$2,'codex',$3,true,$4,'dev',$5,$6,$7)`,
    [hubA, agentAlias, agentAlias, `zz-canary-${run}`, `/srv/zz-canary-${run}`, `/srv/zz-canary-${run}/state`, ownerA.company.slug]);
    await pool().query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')", [hubA, agentAlias]);
    await pool().query("UPDATE agents SET primary_room_id='office' WHERE tenant_id=$1 AND alias=$2", [hubA, agentAlias]);
    await expectAgentRooms('office', ['office']);

    await step(ownerPage(), 'same-company reader creation', async () => {
      await openConfig(ownerPage(), 'acceso');
      await ownerPage().getByRole('button', { name: 'Administrar personas', exact: true }).click();
      await ownerPage().getByRole('region', { name: 'Administración de personas', exact: true })
        .getByRole('button', { name: 'Invitar persona', exact: true }).click();
      const form = ownerPage().getByRole('form', { name: 'Invitar persona', exact: true });
      await form.getByLabel('Correo de acceso', { exact: true }).fill(readerA.email);
      await form.getByLabel('Nombre de persona', { exact: true }).fill(readerA.name);
      await form.getByLabel('Permiso web').selectOption('reader');
      await form.getByLabel('Espacio de la persona').selectOption(hubA);
      await form.getByLabel('Identidad de la persona').selectOption(agentAlias);
      await form.getByLabel('Contraseña inicial', { exact: true }).fill(readerA.password);
      await form.getByRole('button', { name: 'Crear cuenta de persona', exact: true }).click();
      await ownerPage().getByRole('status').filter({ hasText: 'Persona creada. Inventario releído.' }).waitFor({ timeout: 20_000 });
    });
    const reader = await pool().query<{ company_id: string; tenant_id: string; role: string; enabled: boolean }>(
      `SELECT person.company_id,person.tenant_id,person.role,identity.enabled FROM console_users person
        JOIN human_tenant_memberships identity ON identity.human_id=person.id WHERE person.email_normalized=$1`, [readerA.email]);
    expect(reader.rows).toEqual([{ company_id: ownerA.company.slug, tenant_id: hubA, role: 'reader', enabled: true }]);

    pageB = await freshPage('owner-b');
    const foreignPage = pageB;
    await step(foreignPage, 'foreign company registration', async () => { await registerCompany(foreignPage, ownerB); });
    const registeredB = await pool().query<{ tenant_id: string; company_id: string; role: string }>(
      `SELECT person.tenant_id,person.company_id,admin.role FROM console_users person
        JOIN company_admins admin ON admin.human_id=person.id AND admin.company_id=person.company_id WHERE person.email_normalized=$1`, [ownerB.email]);
    expect(registeredB.rows).toHaveLength(1);
    expect(registeredB.rows[0]).toMatchObject({ company_id: ownerB.company.slug, role: 'owner' });
    expect(typeof registeredB.rows[0]?.tenant_id).toBe('string');
    hubB = registeredB.rows[0]?.tenant_id ?? '';
    expect(hubB).not.toBe(hubA);

  });

  it('crea dos salas desde la UI y las refleja en el plano editable y el campus', async () => {
    const page = ownerPage();
    await step(page, 'room creation', async () => {
      await createRoom(page, hubA, roomId, roomLabel);
      await createRoom(page, hubA, destinationRoomId, destinationRoomLabel);
    });
    expect((await pool().query('SELECT id FROM rooms WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY id',
      [hubA, [roomId, destinationRoomId]])).rows).toEqual([{ id: destinationRoomId }, { id: roomId }]);
    await step(page, 'new rooms in office plan and campus', async () => {
      await openOffice(page);
      await expectCampusRoom(page, roomLabel, 0);
      await expectCampusRoom(page, destinationRoomLabel, 0);
      await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
      await page.getByRole('region', { name: planRoom(roomLabel), exact: true }).waitFor({ timeout: 20_000 });
      await page.getByRole('region', { name: planRoom(destinationRoomLabel), exact: true }).waitFor({ timeout: 20_000 });
    });
  });

  it('renombra la sala y asigna el agente allí antes de moverlo a otra sala', async () => {
    const page = ownerPage();
    await step(page, 'room rename', async () => {
      await openConfig(page, 'espacios');
      await page.getByRole('button', { name: `Editar sala/grupo ${hubA}/${roomId}`, exact: true }).click();
      const form = page.getByRole('form', { name: 'Editar sala/grupo', exact: true });
      await form.getByLabel('Nombre visible', { exact: true }).fill(renamedRoomLabel);
      await form.getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
      await form.getByRole('button', { name: 'Confirmar edición', exact: true }).click();
    });
    await expect.poll(async () => (await pool().query<{ display_name: string }>(
      'SELECT display_name FROM rooms WHERE tenant_id=$1 AND id=$2', [hubA, roomId])).rows[0]?.display_name,
    { timeout: 20_000 }).toBe(renamedRoomLabel);

    await step(page, 'renamed room in plan and campus', async () => {
      await openOffice(page);
      await expectCampusRoom(page, renamedRoomLabel, 0);
      expect(await page.getByRole('toolbar', { name: 'Edificios del campus', exact: true })
        .getByRole('button', { name: new RegExp(escapeRegex(roomLabel), 'u') }).count()).toBe(0);
      await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
      await page.getByRole('region', { name: planRoom(renamedRoomLabel), exact: true }).waitFor({ timeout: 20_000 });
      expect(await page.getByRole('region', { name: planRoom(roomLabel), exact: true }).count()).toBe(0);
    });

    await step(page, 'assign agent to renamed room', async () => { await moveAgent(page, roomId); });
    await expectAgentRooms(roomId, [roomId]);
    await step(page, 'agent appears in its assigned room', async () => {
      await openPlan(page);
      await assertAgentInPlan(page, renamedRoomLabel);
      await page.getByRole('button', { name: 'Campus', exact: true }).click();
      await expectCampusRoom(page, renamedRoomLabel, 1);
    });

    await step(page, 'move agent to destination room', async () => { await moveAgent(page, destinationRoomId); });
    await expectAgentRooms(destinationRoomId, [destinationRoomId]);
    await step(page, 'moved agent appears in destination room', async () => {
      await openPlan(page);
      await assertAgentInPlan(page, destinationRoomLabel);
      await assertAgentNotInPlan(page, renamedRoomLabel);
      await page.getByRole('button', { name: 'Campus', exact: true }).click();
      await expectCampusRoom(page, destinationRoomLabel, 1);
      await expectCampusRoom(page, renamedRoomLabel, 0);
    });
  });

  it('valida y crea una parte desde la UI, la persiste en SQL y la rehidrata tras recarga', async () => {
    const page = ownerPage();
    await step(page, 'room part validation and creation', async () => {
      await openPlan(page);
      const editor = await selectRoomEditor(page);
      await editor.getByRole('button', { name: 'Añadir parte', exact: true }).click();
      await editor.getByLabel('Nombre de parte', { exact: true }).fill('   ');
      const writesBefore = officeWrites.length;
      await page.getByRole('button', { name: 'Guardar plano', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Cada parte necesita un nombre de 1 a 120 caracteres.' }).waitFor();
      expect(officeWrites).toHaveLength(writesBefore);
      expect((await pool().query('SELECT 1 FROM company_office_layouts WHERE company_id=$1', [ownerA.company.slug])).rowCount).toBe(0);
      await editor.getByLabel('Nombre de parte', { exact: true }).fill(partLabel);
      await editor.getByLabel(`Ancho de ${partLabel}`, { exact: true }).fill('0');
      await page.getByRole('button', { name: 'Guardar plano', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Las posiciones deben ser números finitos y los tamaños mayores que cero.' }).waitFor();
      expect(officeWrites).toHaveLength(writesBefore);
      for (const [field, value] of [['Posición horizontal', '18'], ['Posición vertical', '56'], ['Ancho', '110'], ['Alto', '70']] as const) {
        await editor.getByLabel(`${field} de ${partLabel}`, { exact: true }).fill(value);
      }
      await savePlan(page);
    });
    const stored = await savedLayout();
    expect(stored.version).toBe(1);
    const partId = stored.rooms.find(room => room.room_id === roomId)?.parts[0]?.id;
    expect(partId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(stored.rooms.find(room => room.room_id === roomId)?.parts).toEqual([
      { id: partId, label: partLabel, x: 18, y: 56, width: 110, height: 70 },
    ]);
    expect(officeWrites.at(-1)).toMatchObject({ label: 'owner-a', status: 200, input: { expected_version: 0, rooms: stored.rooms } });
    await step(page, 'saved part after reload and server validation', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
      await page.getByLabel(`Parte ${partLabel}`, { exact: true }).waitFor();
      expect((await apiGet(page, layoutPath)).body).toMatchObject(stored);
      const invalidRooms = stored.rooms.map(room => room.room_id === roomId
        ? { ...room, parts: room.parts.map(part => ({ ...part, label: '   ' })) } : room);
      allowHttp('owner-a', layoutPath, 400);
      errors.expectHttpError(layoutPath, 400);
      expect(await apiMutation(page, layoutPath, { expected_version: stored.version, rooms: invalidRooms }, 'PUT')).toBe(400);
      expect(await savedLayout()).toEqual(stored);
    });
  });

  it('tras el CAS 409 de una edición en otro navegador deja elegir: reaplicar conserva lo ajeno y avisa de lo que pisa; cargar descarta', async () => {
    const page = ownerPage();
    await openPlan(page);
    const staleEditor = await selectRoomEditor(page);
    await staleEditor.getByLabel('Nombre de parte', { exact: true }).fill(draftPartLabel);
    const before = await savedLayout(); const originalPart = before.rooms.find(room => room.room_id === roomId)?.parts[0];
    const second = await freshPage('owner-a-concurrent');
    await step(second, 'concurrent part edit', async () => {
      await login(second, base(), ownerA);
      await openPlan(second);
      const editor = await selectRoomEditor(second);
      await editor.getByLabel('Nombre de parte', { exact: true }).fill(editedPartLabel);
      await editor.getByLabel(`Ancho de ${editedPartLabel}`, { exact: true }).fill('145');
      await savePlan(second);
    });
    const committed = await savedLayout(); expect(committed.version).toBe(before.version + 1);
    expect(committed.rooms.find(room => room.room_id === roomId)?.parts).toEqual([{ ...originalPart, label: editedPartLabel, width: 145 }]);
    expect(officeWrites.at(-1)).toMatchObject({ label: 'owner-a-concurrent', status: 200, input: { expected_version: before.version } });
    const save = page.getByRole('button', { name: 'Guardar plano', exact: true });
    const choice = (target: V4Page) => target.getByRole('group', { name: 'Conflicto de versión', exact: true });
    const conflictOn = async (target: V4Page, label: string) => {
      allowHttp(label, layoutPath, 409); errors.expectHttpError(layoutPath, 409);
      await target.getByRole('button', { name: 'Guardar plano', exact: true }).click();
      await choice(target).waitFor({ timeout: 20_000 });
      expect(await choice(target).innerText()).toContain('Tu borrador se conserva en el formulario');
      expect(await target.getByRole('button', { name: 'Releer plano y cuotas', exact: true }).isDisabled()).toBe(true);
    };
    let persisted = committed;
    await step(page, 'stale draft conflict waits for a choice and reapplies only what the draft changed', async () => {
      await conflictOn(page, 'owner-a');
      const conflict = await choice(page).innerText();
      expect(conflict).toContain('Otra persona guardó una versión nueva del plano.');
      expect(conflict).toContain('Tu borrador se conserva en el formulario');
      expect(conflict).not.toContain('reload and retry');
      expect(await staleEditor.getByLabel('Nombre de parte', { exact: true }).inputValue()).toBe(draftPartLabel);
      await page.getByText('Plano sin guardar', { exact: true }).waitFor(); expect(await save.isDisabled()).toBe(true);
      expect(await savedLayout()).toEqual(committed); const conflicted = officeWrites.at(-1);
      expect(conflicted).toMatchObject({ label: 'owner-a', status: 409, input: { expected_version: before.version } });
      expect(conflicted?.input.rooms.find(room => room.room_id === roomId)?.parts[0]?.label).toBe(draftPartLabel);
      await choice(page).getByRole('button', { name: 'Releer y reintentar con mis cambios', exact: true }).click();
      const notice = page.getByRole('status').filter({ hasText: 'Tu borrador se reaplicó sobre la versión nueva.' }); await notice.waitFor({ timeout: 20_000 });
      expect(await notice.innerText()).toContain(`En ${hubA}/${renamedRoomLabel} tu cambio sustituye al de la otra persona`);
      await expect.poll(() => save.isDisabled(), { timeout: 20_000 }).toBe(false); expect(await choice(page).count()).toBe(0);
      // Both renamed the part: the draft's name wins and is reported. The width only the other browser changed is kept.
      expect(await staleEditor.getByLabel(`Ancho de ${draftPartLabel}`, { exact: true }).inputValue()).toBe('145');
      expect(await savedLayout()).toEqual(committed);
      await savePlan(page);
      const rebased = conflicted?.input.rooms.map(room => room.room_id === roomId ? { ...room, parts: room.parts.map(part => ({ ...part, width: 145 })) } : room);
      expect(officeWrites.at(-1)).toMatchObject({ label: 'owner-a', status: 200, input: { expected_version: committed.version, rooms: rebased } });
      persisted = await savedLayout(); expect(persisted).toMatchObject({ version: committed.version + 1, rooms: rebased });
      expect(persisted.rooms.find(room => room.room_id === roomId)?.parts).toEqual([{ ...originalPart, label: draftPartLabel, width: 145 }]);
    });
    await step(second, 'stale draft loads the other version and drops the draft without writing, then a plain discard and reread', async () => {
      await (await selectRoomEditor(second)).getByLabel('Nombre de parte', { exact: true }).fill(discardedPartLabel);
      const writes = officeWrites.length;
      await conflictOn(second, 'owner-a-concurrent');
      expect(officeWrites.slice(writes)).toMatchObject([{ label: 'owner-a-concurrent', status: 409, input: { expected_version: committed.version } }]);
      await choice(second).getByRole('button', { name: 'Descartar mis cambios', exact: true }).click();
      await second.getByRole('status').filter({ hasText: 'Se cargó el plano que guardó la otra persona y se descartó tu borrador.' }).waitFor({ timeout: 20_000 });
      await second.getByLabel(`Parte ${draftPartLabel}`, { exact: true }).waitFor(); expect(await second.getByLabel(`Parte ${discardedPartLabel}`, { exact: true }).count()).toBe(0);
      expect(await second.getByText('Plano sin guardar', { exact: true }).count()).toBe(0); expect(officeWrites).toHaveLength(writes + 1);
      expect(await savedLayout()).toEqual(persisted);
      await (await selectRoomEditor(second)).getByLabel('Nombre de parte', { exact: true }).fill(discardedPartLabel);
      await second.getByRole('button', { name: 'Descartar cambios de plano', exact: true }).click();
      await second.getByLabel(`Parte ${draftPartLabel}`, { exact: true }).waitFor(); expect(await second.getByLabel(`Parte ${discardedPartLabel}`, { exact: true }).count()).toBe(0);
      await second.getByRole('button', { name: 'Releer plano y cuotas', exact: true }).click();
      await second.getByLabel(`Parte ${draftPartLabel}`, { exact: true }).waitFor(); expect(await second.getByLabel(`Parte ${editedPartLabel}`, { exact: true }).count()).toBe(0);
      await second.reload({ waitUntil: 'domcontentloaded' }); await second.getByRole('button', { name: 'Plano editable', exact: true }).click();
      await second.getByLabel(`Parte ${draftPartLabel}`, { exact: true }).waitFor(); expect((await apiGet(second, layoutPath)).body).toMatchObject(await savedLayout());
      await second.context().close();
    });
  });

  it('mantiene la sala y asignación tras re-login, y las comparte con otra persona de la empresa', async () => {
    const page = ownerPage();
    await step(page, 'owner re-login', async () => {
      await page.getByRole('button', { name: `Cuenta de ${ownerA.name}`, exact: true }).click();
      await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
      await page.getByLabel('Correo', { exact: true }).waitFor({ timeout: 20_000 });
      await login(page, base(), ownerA);
      await openPlan(page);
      await page.getByRole('region', { name: planRoom(renamedRoomLabel), exact: true }).waitFor({ timeout: 20_000 });
      await assertAgentInPlan(page, destinationRoomLabel);
      await page.getByRole('region', { name: planRoom(destinationRoomLabel), exact: true }).waitFor({ timeout: 20_000 });
      await page.getByLabel(`Parte ${draftPartLabel}`, { exact: true }).waitFor();
      expect((await apiGet(page, layoutPath)).body).toMatchObject(await savedLayout());
    });
    expect(await apiGet(page, '/v3/auth/session')).toMatchObject({
      status: 200, body: { authenticated: true, authority: { role: 'company_owner', acting_company: ownerA.company.slug } },
    });
    await expectAgentRooms(destinationRoomId, [destinationRoomId]);

    const second = await freshPage('same-company-reader');
    readerPage = second;
    await step(second, 'same-company second browser context', async () => {
      await login(second, base(), readerA);
      const session = await apiGet(second, '/v3/auth/session');
      expect(session).toMatchObject({ status: 200, body: { authenticated: true, authority: { role: 'reader', acting_company: ownerA.company.slug } } });
      await openPlan(second);
      await second.getByRole('region', { name: planRoom(renamedRoomLabel), exact: true }).waitFor({ timeout: 20_000 });
      await assertAgentInPlan(second, destinationRoomLabel);
      await second.getByLabel(`Parte ${draftPartLabel}`, { exact: true }).waitFor();
      expect((await apiGet(second, layoutPath)).body).toMatchObject(await savedLayout());
      expect(await second.getByRole('button', { name: 'Guardar plano', exact: true }).isDisabled()).toBe(true);
      const topology = await apiGet(second, '/v3/console/topology');
      expect(topology.status).toBe(200);
      expect(JSON.stringify(topology.body)).toContain(agentAlias);
      expect(JSON.stringify(topology.body)).toContain(roomId);
    });
  });

  it('quita la parte desde la UI y conserva la baja tras recarga y en el segundo navegador', async () => {
    const page = ownerPage();
    const before = await savedLayout();
    await step(page, 'room part deletion', async () => {
      await openPlan(page);
      const editor = await selectRoomEditor(page);
      await editor.getByRole('button', { name: `Quitar parte ${draftPartLabel}`, exact: true }).click();
      expect(await page.getByLabel(`Parte ${draftPartLabel}`, { exact: true }).count()).toBe(0);
      await savePlan(page);
    });
    const committed = await savedLayout();
    expect(committed.version).toBe(before.version + 1);
    expect(committed.rooms).toEqual(before.rooms.map(room => room.room_id === roomId ? { ...room, parts: [] } : room));
    expect(officeWrites.at(-1)).toMatchObject({ label: 'owner-a', status: 200, input: { expected_version: before.version } });
    const second = readerPage;
    if (!second) throw new Error('second reader browser was not initialized');
    for (const browser of [page, second]) await step(browser, 'deleted part after reload', async () => {
      await browser.reload({ waitUntil: 'domcontentloaded' });
      await browser.getByRole('button', { name: 'Plano editable', exact: true }).click();
      await browser.getByRole('region', { name: planRoom(renamedRoomLabel), exact: true }).waitFor();
      expect(await browser.getByLabel(`Parte ${draftPartLabel}`, { exact: true }).count()).toBe(0);
      expect((await apiGet(browser, layoutPath)).body).toMatchObject(committed);
    });
  });

  it('la baja de una sala ocupada explica sus dependencias y no deja un agente huérfano', async () => {
    const page = ownerPage();
    await step(page, 'occupied room delete preview', async () => {
      await openConfig(page, 'espacios');
      await page.getByRole('button', { name: `Eliminar sala/grupo ${hubA}/${destinationRoomId}`, exact: true }).click();
      const form = page.getByRole('form', { name: 'Eliminar sala/grupo', exact: true });
      const note = await form.getByRole('note').innerText();
      expect(note).toMatch(/dependencias/iu);
      expect(await form.getByRole('button', { name: 'Confirmar eliminación', exact: true }).isDisabled()).toBe(true);
      allowHttp('owner-a', '/v3/console/config/changes', 409);
      errors.expectHttpError('/v3/console/config/changes', 409);
      await form.getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
      const alert = form.getByRole('alert');
      await alert.waitFor({ timeout: 20_000 });
      expect(await alert.innerText()).toMatch(/lo bloquean membresías/iu);
      expect(await form.getByRole('button', { name: 'Confirmar eliminación', exact: true }).isDisabled()).toBe(true);
    });
    expect((await pool().query('SELECT 1 FROM rooms WHERE tenant_id=$1 AND id=$2', [hubA, destinationRoomId])).rowCount).toBe(1);
    await expectAgentRooms(destinationRoomId, [destinationRoomId]);
  });

  it('reasigna el agente desde la UI, elimina la sala vacía y conserva la asignación válida', async () => {
    const page = ownerPage();
    await step(page, 'reassign agent before room delete', async () => { await moveAgent(page, roomId); });
    await expectAgentRooms(roomId, [roomId]);
    await step(page, 'delete now-empty room from UI', async () => {
      await openConfig(page, 'espacios');
      await page.getByRole('button', { name: `Eliminar sala/grupo ${hubA}/${destinationRoomId}`, exact: true }).click();
      const form = page.getByRole('form', { name: 'Eliminar sala/grupo', exact: true });
      await form.getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
      await form.getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();
    });
    await expect.poll(async () => (await pool().query('SELECT 1 FROM rooms WHERE tenant_id=$1 AND id=$2', [hubA, destinationRoomId])).rowCount,
      { timeout: 20_000 }).toBe(0);
    expect((await pool().query('SELECT 1 FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias=$3',
      [hubA, destinationRoomId, agentAlias])).rowCount).toBe(0);
    await expectAgentRooms(roomId, [roomId]);
    await step(page, 'deleted room removed from plan and campus', async () => {
      await openPlan(page);
      expect(await page.getByRole('region', { name: planRoom(destinationRoomLabel), exact: true }).count()).toBe(0);
      await assertAgentInPlan(page, renamedRoomLabel);
      expect(await page.getByRole('toolbar', { name: 'Edificios del campus', exact: true })
        .getByRole('button', { name: new RegExp(escapeRegex(destinationRoomLabel), 'u') }).count()).toBe(0);
    });
  });

  it('muestra los estados de cansancio persistidos en campus, plano y ficha sin simular HTTP', async () => {
    const page = ownerPage();
    const accountId = `zz-canary-quota-${run}`;
    await pool().query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,label,
        credential_ref_kind,credential_ref,enabled,company_id)
      VALUES($1,'codex',$1,$2,$1,'secret_manager',$3,true,$4)`,
    [accountId, hubA, `op:zz-canary/${run}`, ownerA.company.slug]);
    await pool().query(`INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
      VALUES($1,$2,$3,$1,$1)`, [hubA, agentAlias, accountId]);
    await pool().query('INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority,enabled) VALUES($1,$2,$3,1,true)',
      [hubA, agentAlias, accountId]);
    const cases = [
      { state: 'unknown', label: 'Sin datos', remaining: null, status: 'unknown' },
      { state: 'error', label: 'Error de consulta', remaining: 0, status: 'error' },
      { state: 'stale', label: 'Datos antiguos', remaining: 0, status: 'ok' },
      { state: 'exhausted', label: 'Sin disponibilidad', remaining: 0, status: 'ok' },
      { state: 'low', label: 'Cansado', remaining: 24, status: 'ok' },
      { state: 'available', label: 'Disponible', remaining: 25, status: 'ok' },
      { state: 'paused', label: 'En pausa', remaining: 60, status: 'ok' },
      { state: 'model_dependent', label: 'Varía por modelo', remaining: 0, status: 'ok' },
    ];
    await openOffice(page);
    const readsBefore = quotaReads.get('owner-a') ?? 0;
    const loopStarted = Date.now();
    for (const scenario of cases) await step(page, `persisted fatigue ${scenario.state}`, async () => {
      await pool().query('DELETE FROM quota_window_state WHERE account_id=$1', [accountId]);
      await pool().query(`UPDATE provider_accounts SET paused_until=CASE WHEN $2 THEN now()+interval '1 hour' ELSE NULL END,
        paused_reason=CASE WHEN $2 THEN 'manual' ELSE NULL END WHERE id=$1`, [accountId, scenario.state === 'paused']);
      if (scenario.state !== 'unknown') {
        const observed = new Date(Date.now() - (scenario.state === 'stale' ? 901_000 : 0)).toISOString();
        for (const [model, remaining] of scenario.state === 'model_dependent'
          ? [['model-a', 0], ['model-b', 80]] as const : [[null, scenario.remaining]] as const) {
          await pool().query(`INSERT INTO quota_window_state(collector_tenant,host,provider,group_key,window_key,
              captured_at,received_at,remaining_percent,reset_at,status,model,account_id,company_id)
            VALUES($1,$2,'codex','default','week',$3,$3,$4,now()+interval '1 hour',$5,$6,$7,$8)`,
          [hubA, `zz-canary-host-${run}`, observed, remaining, scenario.status, model, accountId, ownerA.company.slug]);
        }
      }
      const response = await apiGet(page, '/v3/console/quota-accounts');
      expect(response.status).toBe(200);
      const accounts = response.body.accounts as { id: string; observation_status: string; remaining_percent: number | null }[];
      expect(accounts.find(account => account.id === accountId)).toMatchObject({
        observation_status: scenario.state === 'stale' ? 'stale' : scenario.status,
        remaining_percent: ['unknown', 'error', 'stale'].includes(scenario.state) ? null : scenario.remaining,
        agents: [{ tenant_id: hubA, alias: agentAlias, enabled: true }],
      });
      await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
      const refreshed = (page as V4Page & {
        waitForResponse: (predicate: (response: BrowserResponse) => boolean) => Promise<BrowserResponse>;
      }).waitForResponse(response => new URL(response.url()).pathname === '/v3/console/quota-accounts'
        && response.request().method() === 'GET');
      await page.getByRole('button', { name: 'Releer plano y cuotas', exact: true }).click();
      expect((await refreshed).status()).toBe(200);
      await page.getByRole('button', { name: 'Campus', exact: true }).click();
      const team = page.getByRole('region', { name: 'Equipo', exact: true });
      const member = team.getByRole('button', { name: new RegExp(escapeRegex(agentAlias), 'u') });
      await member.waitFor({ timeout: 20_000 });
      await member.click();
      const summary = page.getByRole('region', { name: `Cuota de ${agentAlias}`, exact: true });
      await summary.getByText(new RegExp(escapeRegex(scenario.label), 'u')).first().waitFor({ timeout: 20_000 });
      await page.getByRole('button', { name: 'Cerrar la tarjeta', exact: true }).click();
      await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
      await assertAgentInPlan(page, renamedRoomLabel);
      const roster = page.getByRole('region', { name: `Agentes de sala ${hubA}/${renamedRoomLabel}`, exact: true });
      const planAgent = roster.getByRole('button', { name: new RegExp(escapeRegex(agentAlias), 'u') });
      const planLabel = ['exhausted', 'low', 'available'].includes(scenario.state)
        ? `week ${String(scenario.remaining)}%`
        : scenario.label;
      await planAgent.getByText(planLabel, { exact: true }).waitFor();
      expect(await planAgent.locator(`[data-fatigue="${scenario.state}"]`).count()).toBe(1);
      await planAgent.click();
      const sheet = page.getByRole('dialog');
      const detail = sheet.getByRole('region', { name: `Disponibilidad de ${agentAlias}`, exact: true });
      await detail.getByText(scenario.label, { exact: true }).first().waitFor();
      await expect.poll(() => detail.locator('[data-fatigue]').first().evaluate(element => element.dataset.fatigue)).toBe(scenario.state);
      await detail.getByRole('article', { name: `Cuotas de ${accountId}`, exact: true }).waitFor();
      await sheet.getByRole('button', { name: 'Cerrar el detalle', exact: true }).click();
      process.stdout.write(`V4 office fatigue ${scenario.state}: real SQL + HTTP + campus + plan + agent sheet verified\n`);
    });
    // Each scenario reads twice on purpose: the direct API check and «Releer plano y cuotas». The agent sheet
    // reuses the office's shared read, so besides those only the shared 30 s poller may add reads.
    const polls = Math.floor((Date.now() - loopStarted) / 30_000) + 1;
    const reads = (quotaReads.get('owner-a') ?? 0) - readsBefore;
    process.stdout.write(`V4 office quota reads: ${String(reads)} for ${String(cases.length)} scenarios and ${String(polls)} poll windows\n`);
    expect(reads).toBeGreaterThanOrEqual(cases.length * 2);
    expect(reads).toBeLessThanOrEqual(cases.length * 2 + polls);
  });

  it('ciclo de registro de agente y proyección de su habilitación sembrada en plano, campus, re-login y segundo navegador', async () => {
    const page = ownerPage();
    const reader = readerPage;
    if (!reader) throw new Error('second reader browser was not initialized');
    const officeLabel = (await pool().query<{ label: string }>(
      "SELECT COALESCE(display_name,id) AS label FROM rooms WHERE tenant_id=$1 AND id='office'", [hubA])).rows[0]?.label;
    if (!officeLabel) throw new Error('default office room is absent');
    const cycleRooms = async () => (await pool().query<{ room_id: string }>(
      'SELECT room_id FROM memberships WHERE tenant_id=$1 AND alias=$2 AND enabled ORDER BY room_id', [hubA, cycleAlias])).rows;
    await step(page, 'new agent registration from the wizard', async () => {
      await openConfig(page, 'agentes');
      await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Añadir agente', exact: true });
      await dialog.getByLabel('Espacio de trabajo').selectOption(hubA);
      await dialog.getByLabel('Alias', { exact: true }).fill(cycleAlias);
      await dialog.getByLabel('Nombre visible').fill(cycleName);
      await dialog.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await dialog.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await dialog.getByLabel('Grupo inicial (opcional)').selectOption(roomId);
      await dialog.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await dialog.getByRole('button', { name: 'Previsualizar alta', exact: true }).click();
      const create = dialog.getByRole('button', { name: 'Crear registro', exact: true });
      await expect.poll(() => create.isDisabled(), { timeout: 20_000 }).toBe(false);
      await create.click();
      await dialog.getByText(`Registro creado: ${hubA}/${cycleAlias}.`, { exact: true }).waitFor({ timeout: 20_000 });
      await dialog.getByRole('button', { name: 'Terminar', exact: true }).click();
    });
    expect((await pool().query('SELECT display_name,enabled FROM agents WHERE tenant_id=$1 AND alias=$2', [hubA, cycleAlias])).rows)
      .toEqual([{ display_name: cycleName, enabled: false }]);
    await expect.poll(cycleRooms, { timeout: 20_000 }).toEqual([{ room_id: roomId }]);
    await step(page, 'an unadmitted registration is not an office agent', async () => {
      await openPlan(page);
      await assertAgentNotInPlan(page, renamedRoomLabel, cycleAlias);
      await assertAgentInPlan(page, renamedRoomLabel);
    });

    // This fixture has no host: runtime_key and host_id stay null. It seeds visibility only;
    // managed admission and retirement require a separate E2E with a real executor.
    await pool().query(`UPDATE agents SET enabled=true,harness_id='codex',container_name=$3,runtime_user='dev',
        home_directory=$4,state_directory=$5,primary_room_id=$6 WHERE tenant_id=$1 AND alias=$2`,
    [hubA, cycleAlias, `zz-canary-cycle-${run}`, `/srv/zz-canary-cycle-${run}`, `/srv/zz-canary-cycle-${run}/state`, roomId]);
    await step(page, 'admitted agent in plan and campus', async () => {
      await page.getByRole('button', { name: 'Releer plano y cuotas', exact: true }).click();
      await assertAgentInPlan(page, renamedRoomLabel, cycleAlias);
      await page.getByRole('button', { name: 'Campus', exact: true }).click();
      await expectCampusRoom(page, renamedRoomLabel, 2);
    });

    await step(page, 'agent display name edited from its registry', async () => {
      const { editor } = await openRegistry(page, base(), hubA, cycleAlias);
      await editor.getByRole('textbox', { name: 'Nombre visible', exact: true }).fill(renamedCycleName);
      await applyRegistryChange(page);
    });
    await expect.poll(async () => (await pool().query<{ display_name: string }>(
      'SELECT display_name FROM agents WHERE tenant_id=$1 AND alias=$2', [hubA, cycleAlias])).rows[0]?.display_name,
    { timeout: 20_000 }).toBe(renamedCycleName);

    await step(page, 'assign the new agent to the default room', async () => { await moveAgent(page, 'office', cycleAlias); });
    await expect.poll(cycleRooms, { timeout: 20_000 }).toEqual([{ room_id: 'office' }]);
    await step(page, 'owner re-login keeps the new agent in its room', async () => {
      await openOffice(page);
      await page.getByRole('button', { name: `Cuenta de ${ownerA.name}`, exact: true }).click();
      await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
      await page.getByLabel('Correo', { exact: true }).waitFor({ timeout: 20_000 });
      await login(page, base(), ownerA);
      await openPlan(page);
      await assertAgentInPlan(page, officeLabel, cycleAlias);
      await assertAgentNotInPlan(page, renamedRoomLabel, cycleAlias);
      await page.getByRole('button', { name: 'Campus', exact: true }).click();
      await expectCampusRoom(page, officeLabel, 2);
      await expectCampusRoom(page, renamedRoomLabel, 1);
    });
    await step(reader, 'second browser sees the edited and reassigned agent', async () => {
      await openPlan(reader);
      await assertAgentInPlan(reader, officeLabel, cycleAlias);
      expect(await topologyMember(reader, hubA, cycleAlias)).toMatchObject({
        room_id: 'office', agent_enabled: true, display_name: renamedCycleName,
      });
    });

    // A registered agent that is paused stays visible in its room: only a missing registry row or a disabled
    // membership takes it out of the plan and the campus.
    await step(page, 'pausing the agent keeps it visible as a registered, disabled agent', async () => {
      const { editor } = await openRegistry(page, base(), hubA, cycleAlias);
      await editor.getByRole('combobox', { name: 'Recepción de mensajes', exact: true }).selectOption('false');
      await applyRegistryChange(page);
      expect((await pool().query<{ enabled: boolean }>(
        'SELECT enabled FROM agents WHERE tenant_id=$1 AND alias=$2', [hubA, cycleAlias])).rows).toEqual([{ enabled: false }]);
      expect(await topologyMember(page, hubA, cycleAlias)).toMatchObject({ room_id: 'office', registered: true, agent_enabled: false });
      await openPlan(page);
      await assertAgentInPlan(page, officeLabel, cycleAlias);
      await page.getByRole('button', { name: 'Campus', exact: true }).click();
      await expectCampusRoom(page, officeLabel, 2);
    });
    // The console has no control to detach a primary room or drop a membership; the configuration API it uses does it,
    // as in the CRUD matrix. The primary room must be cleared first: it is a foreign key to the membership.
    expect(await configChange(page, { resource: 'agent', action: 'update', tenant_id: hubA, alias: cycleAlias, value: { primary_room_id: null } }))
      .toBe(201);
    expect(await configChange(page, { resource: 'membership', action: 'delete', tenant_id: hubA, room_id: 'office', alias: cycleAlias }))
      .toBe(201);
    await step(page, 'agent registry deletion from the UI', async () => {
      const { sheet, editor } = await openRegistry(page, base(), hubA, cycleAlias);
      await editor.getByRole('button', { name: 'Eliminar registro', exact: true }).click();
      const form = sheet.getByRole('form', { name: `Eliminar registro de ${hubA}/${cycleAlias}`, exact: true });
      await form.getByRole('button', { name: 'Previsualizar eliminación', exact: true }).click();
      const confirm = form.getByRole('button', { name: 'Confirmar eliminación del registro', exact: true });
      await expect.poll(() => confirm.isDisabled(), { timeout: 20_000 }).toBe(false);
      await confirm.click();
      await page.getByText(`Registro de ${hubA}/${cycleAlias} eliminado del inventario en revisión`, { exact: false }).waitFor({ timeout: 20_000 });
    });
    await expect.poll(async () =>
      (await pool().query('SELECT 1 FROM agents WHERE tenant_id=$1 AND alias=$2 AND purged_at IS NULL', [hubA, cycleAlias])).rowCount,
    { timeout: 20_000 }).toBe(0);
    for (const browser of [page, reader]) await step(browser, 'deleted agent absent after reload in both browsers', async () => {
      await openPlan(browser);
      await assertAgentNotInPlan(browser, officeLabel, cycleAlias);
      await assertAgentInPlan(browser, renamedRoomLabel);
      expect(await topologyMember(browser, hubA, cycleAlias)).toBeUndefined();
    });
  });

  it('una empresa distinta no ve la oficina ni accede al recurso por una petición directa', async () => {
    const page = pageB;
    if (!page) throw new Error('foreign company page was not initialized');
    await step(page, 'foreign company office isolation', async () => {
      await openPlan(page);
      await page.getByRole('region', { name: `Sala ${hubB}/office`, exact: true }).waitFor({ timeout: 20_000 });
      expect(await page.getByRole('region', { name: planRoom(renamedRoomLabel), exact: true }).count()).toBe(0);
      expect(await page.getByRole('region', { name: planRoom(destinationRoomLabel), exact: true }).count()).toBe(0);
      const campus = page.getByRole('toolbar', { name: 'Edificios del campus', exact: true });
      expect(await campus.getByRole('button', { name: new RegExp(escapeRegex(renamedRoomLabel), 'u') }).count()).toBe(0);
      const topology = await apiGet(page, '/v3/console/topology');
      expect(topology.status).toBe(200);
      const body = JSON.stringify(topology.body);
      expect(body).toContain(hubB);
      expect(body).not.toContain(hubA);
      expect(body).not.toContain(roomId);
      expect(body).not.toContain(agentAlias);
      const configuration = await apiGet(page, '/v3/console/config');
      expect(configuration.status).toBe(200);
      const revision = configuration.body.revision;
      expect(typeof revision).toBe('number');
      allowHttp('owner-b', '/v3/console/config/changes', 403, 404);
      errors.expectHttpError('/v3/console/config/changes', 403);
      const status = await apiMutation(page, '/v3/console/config/changes', {
        dry_run: true,
        expected_revision: revision,
        mutation: { resource: 'room', action: 'update', tenant_id: hubA, id: roomId, value: { display_name: 'zz-canary-foreign-edit' } },
      });
      expect([403, 404]).toContain(status);
    });
  });

  it('no registra errores de consola, páginas ni respuestas HTTP inesperadas', () => {
    process.stdout.write(`V4 office expected HTTP responses: ${JSON.stringify(observedExpectedHttp)}\n`);
    process.stdout.write(`V4 office tolerated console messages: ${JSON.stringify(Object.fromEntries(errors.ignored))}\n`);
    errors.assertClean();
    const readerTerminalResponses = observedExpectedHttp.filter((item) =>
      item.startsWith('same-company-reader 403 /v3/console/terminal/capability')).length;
    expect(readerTerminalResponses).toBeGreaterThan(0);
    expect(errors.ignored.get(readerTerminalCapabilityRule.id) ?? 0).toBe(readerTerminalResponses);
    expect(errors.ignored.get(PATTERN_DEFECT_RULE.id) ?? 0).toBe(0);
    expect(unexpectedHttp).toEqual([]);
    expect(expectedHttp).toEqual([]);
  });
});
