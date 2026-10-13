import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newTrustedPage, startConsoleFunctionalFixture, type BrowserResponse,
} from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, bodySnippet, fillRegistration, HERMETIC_INSTANCE_RULES, login,
  openRegistration, PATTERN_DEFECT_RULE, syntheticPerson, type IgnoredConsoleRule, type V4Page, type V4Person,
} from './v4-console-real-browser.helpers.js';

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
const readerTerminalCapabilityRule: IgnoredConsoleRule = {
  id: 'reader-terminal-capability-403',
  reason: 'reader role has no terminal capability access',
  matches: (text, url) => {
    try { return text.includes('status of 403') && new URL(url).pathname === '/v3/console/terminal/capability'; }
    catch { return false; }
  },
};
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, readerTerminalCapabilityRule, PATTERN_DEFECT_RULE]);
const unexpectedHttp: string[] = [];
const expectedHttp: { label: string; path: string; statuses: number[] }[] = [];
const observedExpectedHttp: string[] = [];
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let pageA: V4Page | undefined;
let pageB: V4Page | undefined;
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
    if (status < 400) return;
    let path: string;
    try { path = new URL(response.url()).pathname; } catch { path = response.url(); }
    if ((status === 501 && path === '/v3/console/terminal/capability')
        || (status === 404 && path === '/v3/console/mcp/client-delegations')) return;
    if (label === 'same-company-reader' && status === 403 && path === '/v3/console/terminal/capability') {
      observedExpectedHttp.push(`${label} ${status} ${path}`);
      return;
    }
    const expected = expectedHttp.findIndex((item) => item.label === label && item.path === path && item.statuses.includes(status));
    if (expected >= 0) {
      expectedHttp.splice(expected, 1);
      observedExpectedHttp.push(`${label} ${status} ${path}`);
      return;
    }
    unexpectedHttp.push(`${label} ${status} ${path}`);
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

async function apiPost(page: V4Page, path: string, payload: unknown): Promise<number> {
  return page.evaluate(async ({ target, body }: { target: string; body: string }) => {
    const session = await (await fetch('/v3/auth/session', { credentials: 'include', cache: 'no-store' })).json() as { csrf_token?: string };
    const response = await fetch(target, { method: 'POST', credentials: 'include', body,
      headers: { 'Content-Type': 'application/json', 'X-Cauce-Console': '1', 'X-CSRF-Token': session.csrf_token ?? '' } });
    return response.status;
  }, { target: path, body: JSON.stringify(payload) });
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

async function createRoom(page: V4Page, tenantId: string, id: string, label: string): Promise<void> {
  await openConfig(page, 'espacios');
  await page.getByRole('button', { name: 'Un solo recurso', exact: true }).click();
  await page.getByLabel('Recurso a crear', { exact: true }).selectOption('room');
  await page.getByLabel('Tenant', { exact: true }).fill(tenantId);
  await page.getByLabel('Room', { exact: true }).fill(id);
  await page.getByLabel('Nombre', { exact: true }).fill(label);
  await page.getByRole('button', { name: 'Crear', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'creado en la revisión' }).waitFor({ timeout: 20_000 });
}

async function openOffice(page: V4Page): Promise<void> {
  await page.goto(`${base()}/live`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('region', { name: 'Oficina', exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole('toolbar', { name: 'Edificios del campus', exact: true }).waitFor({ timeout: 20_000 });
}

async function openPlan(page: V4Page): Promise<void> {
  await openOffice(page);
  await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
  await page.getByRole('heading', { name: 'Plano de oficina', exact: true }).waitFor({ timeout: 20_000 });
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }

async function expectCampusRoom(page: V4Page, label: string, agents: number): Promise<void> {
  const accessibleCount = () => page.evaluate((target: string) => {
    const toolbar = document.querySelector('[role="toolbar"][aria-label="Edificios del campus"]');
    const button = Array.from(toolbar?.querySelectorAll('button[aria-label]') ?? [])
      .find((candidate) => candidate.getAttribute('aria-label')?.startsWith(target));
    if (!(button instanceof HTMLElement) || button.getClientRects().length === 0) return null;
    const description = button.getAttribute('aria-label')?.split(': ').at(-1);
    return description?.split(',')[0]?.trim() ?? null;
  }, label);
  const expected = `${String(agents)} ${agents === 1 ? 'agente' : 'agentes'}`;
  await expect.poll(accessibleCount, { timeout: 30_000 }).toBe(expected);
}

function planRoom(label: string): string { return `Sala ${hubA}/${label}`; }

async function expectAgentRooms(expectedPrimary: string, expectedRooms: string[]): Promise<void> {
  await expect.poll(async () => {
    const agent = await pool().query<{ primary_room_id: string | null }>(
      'SELECT primary_room_id FROM agents WHERE tenant_id=$1 AND alias=$2', [hubA, agentAlias]);
    const memberships = await pool().query<{ room_id: string }>(
      `SELECT room_id FROM memberships WHERE tenant_id=$1 AND alias=$2 AND enabled AND retired_at IS NULL ORDER BY room_id`, [hubA, agentAlias]);
    return { primaryRoomId: agent.rows[0]?.primary_room_id ?? null, rooms: memberships.rows.map((row) => row.room_id) };
  }, { timeout: 20_000 }).toEqual({ primaryRoomId: expectedPrimary, rooms: [...expectedRooms].sort() });
}

async function moveAgent(page: V4Page, destination: string): Promise<void> {
  const ref = encodeURIComponent(`${hubA}/${agentAlias}`);
  await page.goto(`${base()}/config?seccion=agentes&agente=${ref}`, { waitUntil: 'domcontentloaded' });
  const sheet = page.getByRole('dialog');
  await sheet.waitFor({ timeout: 20_000 });
  await sheet.getByRole('tab', { name: 'Grupos', exact: true }).click();
  const move = sheet.getByRole('region', { name: 'Mover a otro grupo', exact: true });
  await move.getByLabel('Miembro a mover').selectOption(agentAlias);
  await move.getByLabel('Grupo de destino').selectOption(destination);
  await move.getByRole('button', { name: 'Previsualizar movimiento atómico', exact: true }).click();
  const confirm = move.getByRole('button', { name: 'Confirmar movimiento atómico', exact: true });
  await expect.poll(() => confirm.isDisabled(), { timeout: 20_000 }).toBe(false);
  await confirm.click();
}

async function assertAgentInPlan(page: V4Page, label: string): Promise<void> {
  const room = page.getByRole('region', { name: planRoom(label), exact: true });
  await room.waitFor({ timeout: 30_000 });
  await room.getByRole('button').click();
  const roster = page.getByRole('region', { name: `Agentes de sala ${hubA}/${label}`, exact: true });
  await roster.getByRole('button', { name: new RegExp(escapeRegex(agentAlias), 'u') }).waitFor({ timeout: 20_000 });
}

async function assertAgentNotInPlan(page: V4Page, label: string): Promise<void> {
  const room = page.getByRole('region', { name: planRoom(label), exact: true });
  await room.waitFor({ timeout: 30_000 });
  await room.getByRole('button').click();
  const roster = page.getByRole('region', { name: `Agentes de sala ${hubA}/${label}`, exact: true });
  expect(await roster.getByRole('button', { name: new RegExp(escapeRegex(agentAlias), 'u') }).count()).toBe(0);
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
    expect(registeredA.rows).toEqual([{ tenant_id: expect.any(String), company_id: ownerA.company.slug, role: 'owner' }]);
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
      await ownerPage().getByRole('button', { name: 'Crear persona', exact: true }).click();
      const form = ownerPage().getByRole('form', { name: 'Crear persona', exact: true });
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
    await step(pageB, 'foreign company registration', async () => { await registerCompany(pageB!, ownerB); });
    const registeredB = await pool().query<{ tenant_id: string; company_id: string; role: string }>(
      `SELECT person.tenant_id,person.company_id,admin.role FROM console_users person
        JOIN company_admins admin ON admin.human_id=person.id AND admin.company_id=person.company_id WHERE person.email_normalized=$1`, [ownerB.email]);
    expect(registeredB.rows).toEqual([{ tenant_id: expect.any(String), company_id: ownerB.company.slug, role: 'owner' }]);
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
    });
    expect(await apiGet(page, '/v3/auth/session')).toMatchObject({
      status: 200, body: { authenticated: true, authority: { role: 'company_owner', acting_company: ownerA.company.slug } },
    });
    await expectAgentRooms(destinationRoomId, [destinationRoomId]);

    const second = await freshPage('same-company-reader');
    await step(second, 'same-company second browser context', async () => {
      await login(second, base(), readerA);
      const session = await apiGet(second, '/v3/auth/session');
      expect(session).toMatchObject({ status: 200, body: { authenticated: true, authority: { role: 'reader', acting_company: ownerA.company.slug } } });
      await openPlan(second);
      await second.getByRole('region', { name: planRoom(renamedRoomLabel), exact: true }).waitFor({ timeout: 20_000 });
      await assertAgentInPlan(second, destinationRoomLabel);
      const topology = await apiGet(second, '/v3/console/topology');
      expect(topology.status).toBe(200);
      expect(JSON.stringify(topology.body)).toContain(agentAlias);
      expect(JSON.stringify(topology.body)).toContain(roomId);
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
      expect(await alert.innerText()).toMatch(/dependencias.*miembros/iu);
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
      const status = await apiPost(page, '/v3/console/config/changes', {
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
