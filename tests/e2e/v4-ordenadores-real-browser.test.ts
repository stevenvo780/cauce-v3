import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES,
  login, openRegistration, PATTERN_DEFECT_RULE, syntheticPerson, validity,
  type V4Page, type V4Person,
} from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const OWNER = 'e2e-a3-ordenadores-1025b';
const receipts = `/datos/workspaces/personal/cauce-v3/.delegados/v4/recibos/${OWNER}`;
const owner = syntheticPerson('ordenadores', run);
const foreignPerson = syntheticPerson('ord-ajena', run);
const inviteSuffix = 'equipo_1';
const inviteName = 'Ordenador del equipo';
const hostId = `zzord${run}`;
const tenantId = `Zz${run}`;
const roomId = `sala${run}`;
const extraRoomId = `otra${run}`;
const memberAlias = `miembro${run}`;
const otherAlias = `otro${run}`;
const backupAlias = `copia${run}`;
const policySha = 'ab'.repeat(32);
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE]);

let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let backupDirectory = '';
let pageA: V4Page | undefined;
let hub = '';
let ownerId = '';
let visibleName = `Ordenador ${run}`;

const active = (): NonNullable<typeof fixture> => {
  if (!fixture) throw new Error('ordenadores fixture is not initialized');
  return fixture;
};
const base = (): string => active().baseUrl;
const pool = () => active().database.pool;
const ownerPage = (): V4Page => {
  if (!pageA) throw new Error('ordenadores owner has no page yet');
  return pageA;
};
const inviteHostId = (): string => `${owner.company.slug}-${inviteSuffix}`;

async function freshPage(label: string, viewport = { width: 1440, height: 900 }): Promise<V4Page> {
  const page = asV4Page(await newTrustedPage(active(), viewport));
  errors.watch(page, label);
  return page;
}

async function step<T>(page: V4Page, name: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (cause) {
    throw new Error(`${name} failed at ${page.url()}: ${await bodySnippet(page)}`, { cause });
  }
}

async function shot(page: V4Page, name: string): Promise<void> {
  await page.screenshot({ path: `${receipts}/${name}.png`, fullPage: true });
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

async function fleetCount(page: V4Page, label: string): Promise<number> {
  const text = await page.getByRole('list', { name: 'Resumen de la flota', exact: true })
    .getByRole('listitem').filter({ hasText: label }).innerText();
  const match = /(\d+)/u.exec(text);
  if (!match?.[1]) throw new Error(`resumen sin número para ${label}: ${text}`);
  return Number(match[1]);
}

async function apiStatus(page: V4Page, method: string, path: string, payload?: unknown): Promise<{ status: number; text: string }> {
  return page.evaluate(async ({ target, verb, body }: { target: string; verb: string; body: string }) => {
    const session = await (await fetch('/v3/auth/session', { credentials: 'include', cache: 'no-store' })).json() as { csrf_token?: string };
    const response = await fetch(target, {
      method: verb, credentials: 'include', ...(body ? { body } : {}),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-Cauce-Console': '1', 'X-CSRF-Token': session.csrf_token ?? '' },
    });
    return { status: response.status, text: (await response.text()).slice(0, 240) };
  }, { target: path, verb: method, body: payload === undefined ? '' : JSON.stringify(payload) });
}

interface TrackedPage {
  waitForRequest(
    predicate: (request: { method(): string; url(): string }) => boolean,
    options?: { timeout?: number },
  ): Promise<{ url(): string }>;
}

function tracked(page: V4Page): TrackedPage {
  if (!('waitForRequest' in page)) throw new Error('browser page does not expose waitForRequest');
  return page as V4Page & TrackedPage;
}

interface ClipboardContext {
  grantPermissions(permissions: string[], options?: { origin: string }): Promise<void>;
}

async function allowClipboard(page: V4Page): Promise<void> {
  const context = page.context() as unknown as ClipboardContext;
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base()).origin });
}

async function hostRow(): Promise<{ display_name: string; notes: string; enabled: boolean; version: string; extensions_allowed: Record<string, unknown> }[]> {
  const stored = await pool().query<{ display_name: string; notes: string; enabled: boolean; version: string; extensions_allowed: Record<string, unknown> }>(
    'SELECT display_name,notes,enabled,version::text,extensions_allowed FROM fleet_hosts WHERE host_id=$1 AND company_id=$2',
    [hostId, owner.company.slug]);
  return stored.rows;
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  await mkdir(receipts, { recursive: true });
  backupDirectory = await mkdtemp(join(tmpdir(), `cauce-ord-backups-${run}-`));
  await chmod(backupDirectory, 0o700);
  process.env.CAUCE_SPACE_BACKUP_DIRECTORY = backupDirectory;
  try { fixture = await startConsoleFunctionalFixture(); }
  finally { delete process.env.CAUCE_SPACE_BACKUP_DIRECTORY; }
}, 600_000);

afterAll(async () => {
  try { if (backupDirectory) await rm(backupDirectory, { recursive: true, force: true }); }
  finally { await fixture?.close(); }
}, 180_000);

describe('ordenadores y espacios desde Chromium, gateway y PostgreSQL reales', () => {
  it('muestra la sección vacía en escritorio y en el teléfono', async () => {
    pageA = await freshPage('owner');
    const page = ownerPage();
    await step(page, 'registro del dueño', async () => { await registerCompany(page, owner); });
    const identity = await pool().query<{ id: string; tenant_id: string }>(
      'SELECT id::text,tenant_id FROM console_users WHERE email=$1', [owner.email]);
    ownerId = identity.rows[0]?.id ?? '';
    hub = identity.rows[0]?.tenant_id ?? '';
    expect(ownerId).not.toBe('');
    expect(hub).toMatch(/^hub-/u);
    await step(page, 'computadoras vacías', async () => {
      await openConfig(page, 'computadoras');
      await page.getByText('No hay computadoras registradas ni conocidas todavía. Conecta la primera desde «Añadir ordenador».', { exact: true }).waitFor({ timeout: 20_000 });
      expect(await page.getByRole('button', { name: 'Registrar computadora', exact: true }).isDisabled()).toBe(true);
      expect(await fleetCount(page, 'Registradas')).toBe(0);
      expect(await fleetCount(page, 'Agentes')).toBe(0);
      await shot(page, 'computadoras-vacio-1440');
      await page.setViewportSize({ width: 390, height: 844 });
      await shot(page, 'computadoras-vacio-390');
      await page.setViewportSize({ width: 1440, height: 900 });
    });
  }, 180_000);

  it('invita un ordenador, copia la invitación, rechaza el duplicado pendiente y la cancela', async () => {
    const page = ownerPage();
    await allowClipboard(page);
    const panel = page.getByRole('region', { name: 'Añadir ordenador', exact: true });
    await step(page, 'invitación inválida y válida', async () => {
      await openConfig(page, 'computadoras');
      await panel.getByRole('button', { name: 'Añadir ordenador', exact: true }).click();
      const form = page.getByRole('form', { name: 'Invitar ordenador', exact: true });
      await form.getByLabel('Identificador del ordenador').fill('Ordenador Inválido');
      await form.getByLabel('Nombre del ordenador').fill(inviteName);
      const malformed = await validity(form.getByLabel('Identificador del ordenador'));
      expect(malformed.valid).toBe(false);
      expect(malformed.message).not.toBe('');
      await form.getByRole('button', { name: 'Cancelar', exact: true }).click();
      expect(await panel.getByRole('form', { name: 'Invitar ordenador', exact: true }).count()).toBe(0);

      errors.expectHttpError('/v3/console/fleet/hosts/enrollments', 403);
      const outside = await apiStatus(page, 'POST', '/v3/console/fleet/hosts/enrollments', { host_id: `fuera${run}`, display_name: inviteName });
      expect(outside.status, outside.text).toBe(403);

      await panel.getByRole('button', { name: 'Añadir ordenador', exact: true }).click();
      await form.getByLabel('Identificador del ordenador').fill(inviteSuffix);
      await form.getByLabel('Nombre del ordenador').fill(inviteName);
      await form.getByRole('button', { name: 'Crear invitación', exact: true }).click();
      const invitation = panel.locator('textarea');
      await invitation.waitFor({ timeout: 20_000 });
      const receipt = JSON.parse(await invitation.inputValue()) as { enrollment_id?: string; host_id?: string };
      expect(receipt.host_id).toBe(inviteHostId());
      expect(await panel.getByLabel('Comando de enrolamiento').innerText()).toBe(`cauce hosts enroll --gateway ${base()} --invitation-stdin`);
      await panel.getByRole('button', { name: 'Copiar invitación', exact: true }).click();
      await panel.getByText('Invitación copiada.', { exact: true }).waitFor({ timeout: 10_000 });
      expect(await page.evaluate(async () => navigator.clipboard.readText())).toContain(inviteHostId());
      await shot(page, 'invitacion-1440');
      await panel.getByRole('button', { name: 'Cerrar invitación', exact: true }).click();
      await panel.getByText('Invitación cerrada. Relee la lista para comprobar si ya se usó, caducó o se canceló.', { exact: true }).waitFor({ timeout: 15_000 });
      await panel.getByRole('button', { name: 'Releer invitaciones', exact: true }).click();
      await panel.getByRole('button', { name: `Cancelar invitación de ${inviteName}`, exact: true }).waitFor({ timeout: 20_000 });

      await panel.getByRole('button', { name: 'Añadir ordenador', exact: true }).click();
      await form.getByLabel('Identificador del ordenador').fill(inviteSuffix);
      await form.getByLabel('Nombre del ordenador').fill(inviteName);
      errors.expectHttpError('/v3/console/fleet/hosts/enrollments', 409);
      await form.getByRole('button', { name: 'Crear invitación', exact: true }).click();
      await form.getByRole('alert').filter({ hasText: 'Ese ordenador ya tiene una invitación pendiente.' }).waitFor({ timeout: 15_000 });
      await form.getByRole('button', { name: 'Cancelar', exact: true }).click();
      await panel.getByRole('button', { name: `Cancelar invitación de ${inviteName}`, exact: true }).click();
      await panel.getByText('Invitación cancelada.', { exact: true }).waitFor({ timeout: 15_000 });
      const stored = await pool().query<{ state: string }>('SELECT state FROM fleet_host_enrollments WHERE id=$1', [receipt.enrollment_id]);
      expect(stored.rows[0]?.state).toBe('revoked');
    });
  }, 180_000);

  it('la plataforma registra la computadora y el interruptor persiste en PostgreSQL', async () => {
    const page = ownerPage();
    const granted = await active().database.adminPool.query(
      'INSERT INTO platform_admins(human_id) SELECT id FROM console_users WHERE email=$1', [owner.email]);
    expect(granted.rowCount).toBe(1);
    await step(page, 'alta y habilitación', async () => {
      await openConfig(page, 'computadoras');
      await expect.poll(async () => page.getByRole('button', { name: 'Registrar computadora', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
      await page.getByRole('button', { name: 'Registrar computadora', exact: true }).click();
      const form = page.getByRole('form', { name: 'Registrar computadora', exact: true });
      await form.getByRole('textbox', { name: /identificador/iu }).fill('Ordenador Inválido');
      await form.getByRole('textbox', { name: 'Nombre visible', exact: true }).fill(visibleName);
      await form.getByRole('button', { name: 'Guardar', exact: true }).click();
      await form.getByRole('alert').filter({ hasText: 'Revisa el identificador' }).waitFor({ timeout: 15_000 });
      expect(await hostRow()).toEqual([]);
      await form.getByRole('button', { name: 'Cancelar', exact: true }).click();

      await page.getByRole('button', { name: 'Registrar computadora', exact: true }).click();
      await form.getByRole('textbox', { name: /identificador/iu }).fill(hostId);
      await form.getByRole('textbox', { name: 'Nombre visible', exact: true }).fill(visibleName);
      await form.getByRole('textbox', { name: 'Notas', exact: true }).fill('notas iniciales');
      await form.getByRole('button', { name: 'Guardar', exact: true }).click();
      const card = page.getByRole('article', { name: visibleName, exact: true });
      await card.waitFor({ timeout: 20_000 });
      await card.getByText('Pendiente: el ejecutor no está listo; ejecuta cauce hosts setup en esta computadora', { exact: true }).waitFor({ timeout: 15_000 });
      expect(await fleetCount(page, 'Registradas')).toBe(1);
      await card.getByText('Habilitada', { exact: true }).click();
      await expect.poll(async () => (await hostRow())[0]?.enabled, { timeout: 20_000 }).toBe(false);
      await expect.poll(async () => fleetCount(page, 'Deshabilitadas'), { timeout: 15_000 }).toBe(1);
      await card.getByText('Habilitada', { exact: true }).click();
      await expect.poll(async () => (await hostRow())[0]?.enabled, { timeout: 20_000 }).toBe(true);
      await shot(page, 'computadora-registrada-1440');
    });
    expect(await hostRow()).toEqual([expect.objectContaining({ display_name: visibleName, notes: 'notas iniciales', enabled: true, version: '3' })]);
  }, 180_000);

  it('un conflicto de versión conserva el borrador y permite reintentar o descartar', async () => {
    const page = ownerPage();
    const other = await freshPage('owner-second');
    await login(other, base(), owner);
    await step(page, 'descartar y reintentar', async () => {
      await openConfig(page, 'computadoras');
      await openConfig(other, 'computadoras');
      const card = page.getByRole('article', { name: visibleName, exact: true });
      await card.getByRole('button', { name: 'Editar', exact: true }).click();
      const form = page.getByRole('form', { name: `Editar ${hostId}`, exact: true });
      await form.getByRole('textbox', { name: 'Nombre visible', exact: true }).fill(`Nombre ajeno ${run}`);
      await other.getByRole('article', { name: visibleName, exact: true }).getByRole('button', { name: 'Editar', exact: true }).click();
      const otherForm = other.getByRole('form', { name: `Editar ${hostId}`, exact: true });
      await otherForm.getByRole('textbox', { name: 'Notas', exact: true }).fill('notas-b');
      await otherForm.getByRole('button', { name: 'Guardar', exact: true }).click();
      await other.getByRole('article', { name: visibleName, exact: true }).getByText('notas-b', { exact: false }).waitFor({ timeout: 20_000 }).catch(() => undefined);
      await expect.poll(async () => (await hostRow())[0]?.notes, { timeout: 20_000 }).toBe('notas-b');
      errors.expectHttpError(`/v3/console/fleet/hosts/${hostId}`, 409);
      await form.getByRole('button', { name: 'Guardar', exact: true }).click();
      const conflict = form.getByRole('group', { name: 'Conflicto de versión', exact: true });
      await conflict.waitFor({ timeout: 15_000 });
      await shot(page, 'computadora-conflicto-1440');
      await conflict.getByRole('button', { name: 'Descartar mis cambios', exact: true }).click();
      await expect.poll(async () => form.getByRole('textbox', { name: 'Nombre visible', exact: true }).inputValue(), { timeout: 15_000 }).toBe(visibleName);
      await form.getByRole('textbox', { name: 'Nombre visible', exact: true }).fill(`Nombre reintento ${run}`);
      await form.getByRole('textbox', { name: 'Notas', exact: true }).fill('notas-reintento');
      await other.getByRole('article', { name: visibleName, exact: true }).getByRole('button', { name: 'Editar', exact: true }).click();
      await otherForm.getByRole('textbox', { name: 'Nombre visible', exact: true }).fill(`Nombre pisado ${run}`);
      await otherForm.getByRole('button', { name: 'Guardar', exact: true }).click();
      await expect.poll(async () => (await hostRow())[0]?.display_name, { timeout: 20_000 }).toBe(`Nombre pisado ${run}`);
      errors.expectHttpError(`/v3/console/fleet/hosts/${hostId}`, 409);
      await form.getByRole('button', { name: 'Guardar', exact: true }).click();
      await form.getByRole('button', { name: 'Releer y reintentar con mis cambios', exact: true }).click();
      visibleName = `Nombre reintento ${run}`;
      await page.getByRole('article', { name: visibleName, exact: true }).waitFor({ timeout: 20_000 });
    });
    expect((await hostRow())[0]).toMatchObject({ display_name: visibleName, notes: 'notas-reintento' });
  }, 180_000);

  it('previsualiza, rechaza una ruta inválida y aplica los permisos del ordenador', async () => {
    const page = ownerPage();
    const panel = page.getByRole('region', { name: 'Permisos del ordenador', exact: true });
    await step(page, 'permisos', async () => {
      await openConfig(page, 'computadoras');
      await panel.getByRole('checkbox', { name: /^Montaje/u }).check();
      await panel.getByRole('textbox', { name: /Raíces de montaje/u }).fill('relativo');
      await panel.getByRole('button', { name: 'Vista previa', exact: true }).click();
      await panel.getByRole('alert').waitFor({ timeout: 20_000 });
      expect((await hostRow())[0]?.extensions_allowed).toEqual({ types: [], mount_roots: [], networks: [] });
      await panel.getByRole('textbox', { name: /Raíces de montaje/u }).fill('/datos/zz-canary-ord');
      await panel.getByRole('checkbox', { name: /^Docker/u }).check();
      await panel.getByRole('combobox', { name: /Acceso Docker permitido/u }).selectOption('read');
      await panel.getByRole('checkbox', { name: 'El daemon Docker es exclusivo de esta empresa', exact: true }).check();
      await panel.getByRole('textbox', { name: /Redes permitidas/u }).fill('zzcanary');
      await panel.getByRole('button', { name: 'Vista previa', exact: true }).click();
      await panel.getByRole('status').filter({ hasText: 'Vista previa aceptada' }).waitFor({ timeout: 20_000 });
      expect((await hostRow())[0]?.extensions_allowed).toEqual({ types: [], mount_roots: [], networks: [] });
      await panel.getByRole('button', { name: 'Aplicar permisos', exact: true }).click();
      await panel.getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor({ timeout: 20_000 });
      await panel.getByRole('checkbox', { name: /^GPU/u }).check();
      await panel.getByRole('button', { name: 'Descartar borrador', exact: true }).click();
      await expect.poll(async () => panel.getByRole('checkbox', { name: /^GPU/u }).evaluate((element) => element.checked), { timeout: 15_000 }).toBe(false);
      await shot(page, 'permisos-ordenador-1440');
    });
    expect((await hostRow())[0]?.extensions_allowed).toEqual({
      types: ['mount', 'docker'], mount_roots: ['/datos/zz-canary-ord'], networks: ['zzcanary'],
      docker_access: ['read'], docker_daemon_dedicated: true,
    });
  }, 180_000);

  it('despliega los agentes de más y otra empresa no ve ni toca el ordenador', async () => {
    const page = ownerPage();
    for (let index = 0; index < 7; index += 1) {
      const alias = `chip${String(index)}${run}`;
      await pool().query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,company_id,host_id)
        VALUES($1,$2,'fake',$2,true,$3,'stev',$4,$5,$6,$7)`,
      [hub, alias, `zz-canary-chip-${String(index)}-${run}`, active().directory, `${active().directory}/state`, owner.company.slug, hostId]);
    }
    await step(page, 'agentes y aislamiento', async () => {
      await openConfig(page, 'computadoras');
      const card = page.getByRole('article', { name: visibleName, exact: true });
      await card.getByRole('button', { name: '+1 más', exact: true }).click();
      await card.getByText(`chip6${run}`, { exact: true }).waitFor({ timeout: 15_000 });
      await card.getByRole('button', { name: 'Ver menos', exact: true }).click();
      expect(await fleetCount(page, 'Agentes')).toBe(7);
      expect(await fleetCount(page, 'Conectadas')).toBe(0);
      await card.getByText('Para eliminarla, quita antes sus agentes.', { exact: true }).waitFor({ timeout: 15_000 });
      expect(await card.getByRole('button', { name: 'Eliminar', exact: true }).count()).toBe(0);
      await shot(page, 'computadora-agentes-1440');
    });
    const foreign = await freshPage('foreign');
    await step(foreign, 'empresa ajena', async () => {
      await registerCompany(foreign, foreignPerson);
      await openConfig(foreign, 'computadoras');
      expect(await foreign.getByRole('button', { name: 'Registrar computadora', exact: true }).isDisabled()).toBe(true);
      expect(await foreign.getByText(visibleName, { exact: true }).count()).toBe(0);
      await foreign.getByText('Aún no hay invitaciones.', { exact: true }).waitFor({ timeout: 20_000 });
      const listed = await apiGet(foreign, '/v3/console/fleet/hosts');
      expect(listed.status).toBe(200);
      expect(JSON.stringify(listed.body)).not.toContain(hostId);
      errors.expectHttpError(`/v3/console/fleet/hosts/${hostId}`, 404);
      const patched = await apiStatus(foreign, 'PATCH', `/v3/console/fleet/hosts/${hostId}`, { expected_version: 1, display_name: 'zz-canary ajeno' });
      expect(patched.status, patched.text).toBe(404);
      errors.expectHttpError(`/v3/console/fleet/hosts/${hostId}`, 404);
      const removed = await apiStatus(foreign, 'DELETE', `/v3/console/fleet/hosts/${hostId}?expected_version=1`);
      expect(removed.status, removed.text).toBe(404);
      errors.expectHttpError('/v3/console/fleet/hosts', 403);
      const created = await apiStatus(foreign, 'POST', '/v3/console/fleet/hosts', { host_id: `zzajeno${run}`, display_name: 'Ajena', notes: '' });
      expect(created.status, created.text).toBe(403);
      await shot(foreign, 'computadoras-ajena-1440');
    });
    expect(await hostRow()).toHaveLength(1);
  }, 240_000);

  it('niega la baja mientras hay copias y, con el checkbox, borra la copia y el ordenador', async () => {
    const page = ownerPage();
    await pool().query('DELETE FROM agents WHERE host_id=$1 AND alias LIKE $2', [hostId, `chip%${run}`]);
    await pool().query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,company_id,host_id)
      VALUES($1,$2,'fake',$2,true,$3,'stev',$4,$5,$6,$7)`,
    [hub, backupAlias, `zz-canary-copia-${run}`, active().directory, `${active().directory}/copia`, owner.company.slug, hostId]);
    await pool().query('UPDATE agents SET host_id=NULL WHERE tenant_id=$1 AND alias=$2', [hub, backupAlias]);
    await pool().query(`INSERT INTO space_backups(company_id,tenant_id,alias,host_id,requested_by,idempotency_key,agent_snapshot,policy_sha256,status,error)
      VALUES($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7,'failed','EXPIRED')`,
    [owner.company.slug, hub, backupAlias, hostId, ownerId, `backup${run}ord`, policySha]);
    const version = (await hostRow())[0]?.version ?? '';
    await step(page, 'baja con copias', async () => {
      await openConfig(page, 'computadoras');
      const card = page.getByRole('article', { name: visibleName, exact: true });
      await card.getByRole('button', { name: 'Eliminar', exact: true }).click();
      const confirmation = page.getByRole('alertdialog');
      await shot(page, 'computadora-baja-1440');
      errors.expectHttpError(`/v3/console/fleet/hosts/${hostId}`, 409);
      const refused = tracked(page).waitForRequest((request) => request.method() === 'DELETE' && request.url().includes(hostId));
      await confirmation.getByRole('button', { name: 'Eliminar', exact: true }).click();
      expect((await refused).url()).not.toContain('delete_backups=true');
      await confirmation.getByText('La computadora tiene copias de espacio registradas', { exact: false }).waitFor({ timeout: 20_000 });
      expect(await hostRow()).toHaveLength(1);
      await confirmation.getByRole('checkbox', { name: /Eliminar también todas sus copias/u }).check();
      const accepted = tracked(page).waitForRequest((request) => request.method() === 'DELETE' && request.url().includes('delete_backups=true'));
      await confirmation.getByRole('button', { name: 'Eliminar', exact: true }).click();
      expect((await accepted).url()).toContain(`expected_version=${version}`);
      await expect.poll(async () => page.getByRole('article', { name: visibleName, exact: true }).count(), { timeout: 20_000 }).toBe(0);
    });
    expect(await hostRow()).toEqual([]);
    expect((await pool().query('SELECT 1 FROM space_backups WHERE host_id=$1', [hostId])).rowCount).toBe(0);
  }, 180_000);

  it('el asistente crea el espacio y la alta rápida añade sala, membresía y permiso', async () => {
    const page = ownerPage();
    const wizard = page.getByRole('group', { name: 'Alta guiada', exact: true });
    await step(page, 'asistente', async () => {
      await openConfig(page, 'espacios');
      await page.getByRole('button', { name: 'Espacio completo, paso a paso', exact: true }).click();
      await wizard.getByLabel('Identificador del espacio', { exact: true }).fill('1malo');
      await wizard.getByText('El espacio debe empezar con letra', { exact: false }).waitFor({ timeout: 15_000 });
      expect(await wizard.getByRole('button', { name: 'Siguiente', exact: true }).isDisabled()).toBe(true);
      await wizard.getByLabel('Identificador del espacio', { exact: true }).fill(tenantId);
      await wizard.getByRole('textbox', { name: /Nombre visible/u }).fill(`Espacio ${run}`);
      await wizard.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await wizard.getByRole('button', { name: 'Atrás', exact: true }).click();
      await wizard.getByLabel('Identificador del espacio', { exact: true }).waitFor({ timeout: 15_000 });
      await wizard.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await wizard.getByLabel('Identificador de la sala', { exact: true }).fill(roomId);
      await wizard.getByRole('textbox', { name: /Nombre visible/u }).fill(`Sala ${run}`);
      await wizard.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await wizard.getByLabel('Identificador', { exact: true }).fill(memberAlias);
      await wizard.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await shot(page, 'espacios-asistente-1440');
      await page.setViewportSize({ width: 390, height: 844 });
      await shot(page, 'espacios-asistente-390');
      await page.setViewportSize({ width: 1440, height: 900 });
      for (const title of ['Espacio', 'Sala', 'Membresía']) {
        await wizard.getByRole('button', { name: 'Previsualizar paso', exact: true }).click();
        await wizard.getByRole('status').filter({ hasText: "Vista previa aceptada" }).waitFor({ timeout: 20_000 });
        await wizard.getByRole('button', { name: 'Aplicar paso', exact: true }).click();
        await wizard.getByRole('status').filter({ hasText: `${title} aplicado en revisión` }).waitFor({ timeout: 20_000 });
      }
      await wizard.getByText('Espacio completo: los 3 pasos quedaron aplicados.', { exact: true }).waitFor({ timeout: 15_000 });
    });
    expect((await pool().query('SELECT display_name,company_id,is_hub FROM tenants WHERE id=$1', [tenantId])).rows)
      .toEqual([{ display_name: `Espacio ${run}`, company_id: owner.company.slug, is_hub: false }]);
    expect((await pool().query('SELECT display_name FROM rooms WHERE tenant_id=$1 AND id=$2', [tenantId, roomId])).rows)
      .toEqual([{ display_name: `Sala ${run}` }]);
    expect((await pool().query('SELECT role FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias=$3', [tenantId, roomId, memberAlias])).rows)
      .toEqual([{ role: 'agent' }]);

    const alta = page.getByRole('group', { name: 'Alta rápida', exact: true });
    await step(page, 'alta rápida', async () => {
      await wizard.getByRole('button', { name: 'Empezar de nuevo', exact: true }).click();
      await wizard.getByRole('checkbox', { name: /Crear el espacio/u }).uncheck();
      await wizard.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await wizard.getByRole('checkbox', { name: /Crear la sala/u }).uncheck();
      await wizard.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await wizard.getByRole('checkbox', { name: /Crear la membresía/u }).uncheck();
      await wizard.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await wizard.getByText('El plan quedó vacío: vuelve a los pasos e incluye al menos un recurso.', { exact: true }).waitFor({ timeout: 15_000 });
      expect(await wizard.getByRole('button', { name: 'Previsualizar paso', exact: true }).isDisabled()).toBe(true);
      await page.getByRole('button', { name: 'Un solo recurso', exact: true }).click();
      await alta.getByLabel('Recurso a crear', { exact: true }).selectOption('room');
      await alta.getByLabel('Espacio', { exact: true }).fill('1-inválido');
      await alta.getByText('El espacio debe empezar con letra', { exact: false }).waitFor({ timeout: 15_000 });
      expect(await alta.getByRole('button', { name: 'Crear', exact: true }).isDisabled()).toBe(true);
      await alta.getByLabel('Espacio', { exact: true }).fill(tenantId);
      await alta.getByLabel('Sala', { exact: true }).fill(extraRoomId);
      await alta.getByLabel('Nombre', { exact: true }).fill(`Sala suelta ${run}`);
      await alta.getByRole('button', { name: 'Previsualizar el alta', exact: true }).click();
      await alta.getByRole('status').filter({ hasText: 'Vista previa aceptada' }).waitFor({ timeout: 20_000 });
      expect((await pool().query('SELECT 1 FROM rooms WHERE tenant_id=$1 AND id=$2', [tenantId, extraRoomId])).rowCount).toBe(0);
      await alta.getByRole('button', { name: 'Crear', exact: true }).click();
      await alta.getByRole('status').filter({ hasText: 'creado en la revisión' }).waitFor({ timeout: 20_000 });

      await alta.getByLabel('Recurso a crear', { exact: true }).selectOption('membership');
      await alta.getByText('No crea el agente: si todavía no está en Agentes', { exact: false }).waitFor({ timeout: 15_000 });
      await alta.getByLabel('Espacio', { exact: true }).fill(tenantId);
      await alta.getByLabel('Sala', { exact: true }).fill(roomId);
      await alta.getByLabel('Identificador', { exact: true }).fill(otherAlias);
      await alta.getByRole('button', { name: 'Previsualizar el alta', exact: true }).click();
      await alta.getByRole('status').filter({ hasText: 'Vista previa aceptada' }).waitFor({ timeout: 20_000 });
      await alta.getByRole('button', { name: 'Crear', exact: true }).click();
      await alta.getByRole('status').filter({ hasText: 'creado en la revisión' }).waitFor({ timeout: 20_000 });

      await alta.getByLabel('Recurso a crear', { exact: true }).selectOption('acl_edge');
      await alta.getByLabel('Desde el espacio', { exact: true }).fill(tenantId);
      await alta.getByLabel('Hacia el espacio', { exact: true }).fill(tenantId);
      await alta.getByText('Un permiso de un espacio hacia sí mismo está prohibido', { exact: false }).waitFor({ timeout: 15_000 });
      expect(await alta.getByRole('button', { name: 'Crear', exact: true }).isDisabled()).toBe(true);
      await alta.getByLabel('Hacia el espacio', { exact: true }).fill(hub);
      await alta.getByRole('checkbox', { name: 'Puede mandar mensajes', exact: true }).check();
      await alta.getByRole('button', { name: 'Previsualizar el alta', exact: true }).click();
      await alta.getByRole('status').filter({ hasText: 'Vista previa aceptada' }).waitFor({ timeout: 20_000 });
      expect((await pool().query('SELECT 1 FROM acl_edges WHERE from_tenant=$1 AND to_tenant=$2', [tenantId, hub])).rowCount).toBe(0);
      await alta.getByRole('button', { name: 'Crear', exact: true }).click();
      await alta.getByRole('status').filter({ hasText: 'creado en la revisión' }).waitFor({ timeout: 20_000 });
      await shot(page, 'espacios-alta-1440');
    });
    expect((await pool().query('SELECT display_name FROM rooms WHERE tenant_id=$1 AND id=$2', [tenantId, extraRoomId])).rows)
      .toEqual([{ display_name: `Sala suelta ${run}` }]);
    expect((await pool().query('SELECT role FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias=$3', [tenantId, roomId, otherAlias])).rows)
      .toEqual([{ role: 'agent' }]);
    expect((await pool().query('SELECT allow_route,allow_read,allow_control FROM acl_edges WHERE from_tenant=$1 AND to_tenant=$2', [tenantId, hub])).rows)
      .toEqual([{ allow_route: true, allow_read: false, allow_control: false }]);
  }, 240_000);

  it('no quedan errores inesperados del navegador', () => {
    errors.assertClean();
  });
});
