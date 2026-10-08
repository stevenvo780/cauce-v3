import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../services/gateway/src/password.js';
import { maintainConsoleUser } from '../../services/gateway/src/console-user-maintenance.js';
import { browserDocker, browserErrorStderr } from './browser-owned-lifecycle.js';
import { isaTenant, newTrustedPage, startConsoleFunctionalFixture, type BrowserPage, type Locator } from './console-functional-browser.fixtures.js';

type Fixture = Awaited<ReturnType<typeof startConsoleFunctionalFixture>>;
type Form = Locator & { getByLabel(name: string, options?: { exact?: boolean }): Locator };
type Mutation = Record<string, unknown>;
interface NetworkChange { status: number; request: Record<string, unknown>; receipt: Record<string, unknown> }
interface User { email: string; password: string }
interface OwnedResources { postgres: string; browser: string; image: string; network: string; volumes: string[] }
let fixture: Fixture | undefined;
let evidence = '';
let resources: OwnedResources | undefined;
let operator: User | undefined;
let reader: User | undefined;
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const actor = `crudop${suffix}`;
const tenant = `Crud${suffix}`;
const room = `crud.${suffix}`;
const alias = `crudagent${suffix}`;
const ledger: NetworkChange[] = [];
const snapshots: number[] = [];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object receipt');
  return value as Record<string, unknown>;
}
function active(): Fixture { if (!fixture) throw new Error('owned fixture is unavailable'); return fixture; }
async function inspect(kind: 'container' | 'image' | 'network', id: string): Promise<Record<string, unknown>> {
  const command = kind === 'container' ? ['inspect'] : [kind, 'inspect'];
  return object(JSON.parse((await browserDocker([...command, '--format', '{{json .}}', id])).stdout));
}
async function owned(): Promise<OwnedResources> {
  const f = active(); const postgres = f.database.container.getId(); const browser = f.browserContainer;
  const pg = await inspect('container', postgres); const br = await inspect('container', browser);
  expect(object(object(pg.Config).Labels)['org.testcontainers']).toBe('true');
  expect(object(object(br.Config).Labels)['cauce.e2e.owner']).toBe('ui-functional');
  const networks = Object.values(object(object(br.NetworkSettings).Networks)).map(object);
  expect(networks).toHaveLength(1); const network = String(networks[0]?.NetworkID);
  const nw = await inspect('network', network); expect(nw.Internal).toBe(true);
  expect(object(nw.Labels)['cauce.e2e.owner']).toMatch(/^[0-9a-f-]{36}$/iu);
  const image = f.browserRuntime.imageId; expect(f.browserRuntime.owned).toBe(true);
  expect(object(object((await inspect('image', image)).Config).Labels)['cauce.e2e.owner']).toBe('ui-functional');
  const volumes = (pg.Mounts as unknown[]).map(object).filter(row => row.Type === 'volume').map(row => String(row.Name));
  expect(volumes).toHaveLength(1); return { postgres, browser, image, network, volumes };
}
async function absent(kind: 'container' | 'image' | 'network' | 'volume', id: string): Promise<void> {
  const command = kind === 'container' ? ['inspect'] : [kind, 'inspect'];
  try { await browserDocker([...command, id]); }
  catch (cause) {
    const reference = id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const missing = new RegExp(`^(?:Error response from daemon: |Error: )?(?:No such (?:object|container|image|network|volume): ${reference}|network ${reference} not found|get ${reference}: no such volume)$`, 'iu');
    let detail = cause;
    while (detail instanceof Error && detail.cause) detail = detail.cause;
    if (detail && typeof detail === 'object' && 'code' in detail && detail.code === 1 && missing.test(browserErrorStderr(cause).trim())) return;
    throw cause;
  }
  throw new Error(`owned ${kind} ${id} remains after cleanup`);
}
async function revision(): Promise<number> {
  return Number((await active().database.pool.query<{ revision: number }>('SELECT coalesce(max(id),0)::int AS revision FROM config_revisions')).rows[0]?.revision);
}
async function login(page: BrowserPage, user: User): Promise<void> {
  expect((await page.goto(active().baseUrl, { waitUntil: 'domcontentloaded' }))?.status()).toBe(200);
  await page.getByLabel('Correo').waitFor({ timeout: 20_000 });
  await page.getByLabel('Correo').fill(user.email); await page.getByLabel('Contraseña').fill(user.password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.getByRole('link', { name: /Conversaciones/u }).waitFor({ timeout: 20_000 });
  await page.goto(`${active().baseUrl}/config`, { waitUntil: 'domcontentloaded' });
}
function observe(page: BrowserPage) {
  let pending: ((value: NetworkChange) => void) | undefined;
  const changes: NetworkChange[] = [];
  page.on('response', value => {
    const response = value as typeof value & { json(): Promise<unknown> };
    const request = response.request() as { method(): string; postData(): string | null };
    const path = new URL(response.url()).pathname;
    if (path === '/v3/console/config' && response.request().method() === 'GET' && response.status() === 200) {
      void response.json().then(body => { snapshots.push(Number(object(body).revision)); });
    }
    if (path !== '/v3/console/config/changes' || response.request().method() !== 'POST') return;
    const accept = pending; pending = undefined;
    void response.json().then(body => {
      const change = { status: response.status(), request: object(JSON.parse(request.postData() ?? 'null')), receipt: object(body) };
      changes.push(change); accept?.(change);
    });
  });
  return { changes, click: async (button: Locator): Promise<NetworkChange> => {
    let timer: NodeJS.Timeout | undefined;
    const result = new Promise<NetworkChange>((resolve, reject) => {
      pending = resolve; timer = setTimeout(() => { pending = undefined; reject(new Error('UI mutation receipt absent')); }, 20_000);
    });
    try { await button.click(); return await result; } finally { clearTimeout(timer); pending = undefined; }
  } };
}
async function readRows(page: BrowserPage, collection: string): Promise<Record<string, unknown>[]> {
  const snapshot = await page.evaluate(async () => {
    const response = await fetch('/v3/console/config', { credentials: 'include' });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  });
  expect(snapshot.status).toBe(200); expect(snapshot.body.revision).toBe(await revision());
  return (snapshot.body[collection] as unknown[]).map(object);
}
async function assertRecord(page: BrowserPage, collection: 'tenants' | 'rooms' | 'memberships' | 'agents', expected: Record<string, unknown> | undefined): Promise<void> {
  const queries = {
    tenants: ['SELECT id,display_name,enabled,is_hub FROM tenants WHERE id=$1', [tenant]],
    rooms: ['SELECT tenant_id,id,display_name,enabled FROM rooms WHERE tenant_id=$1 AND id=$2', [tenant, room]],
    memberships: ['SELECT tenant_id,room_id,alias,role,enabled FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias=$3', [tenant, room, alias]],
    agents: ['SELECT tenant_id,alias,display_name,enabled,container_name,runtime_user,home_directory,state_directory,harness_id FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, alias]],
  } as const;
  const [sql, parameters] = queries[collection]; const durable = (await active().database.pool.query(sql, [...parameters])).rows;
  const remote = (await readRows(page, collection)).filter(row => collection === 'tenants' ? row.id === tenant
    : row.tenant_id === tenant && (collection === 'rooms' ? row.id === room : row.alias === alias && (collection !== 'memberships' || row.room_id === room)));
  if (!expected) { expect(durable).toEqual([]); expect(remote).toEqual([]); }
  else { expect(durable).toHaveLength(1); expect(durable[0]).toMatchObject(expected); expect(remote).toHaveLength(1); expect(remote[0]).toMatchObject(expected); }
}
async function apply(page: BrowserPage, observer: ReturnType<typeof observe>, scope: Locator, mutation: Mutation, previewLabel = 'Previsualizar cambio', applyLabel = 'Confirmar creación'): Promise<void> {
  const before = await revision(); const preview = await observer.click(scope.getByRole('button', { name: previewLabel, exact: true }));
  expect(preview.status).toBe(200); expect(preview.request).toMatchObject({ expected_revision: before, dry_run: true, mutation });
  expect(preview.receipt).toMatchObject({ revision: before, applied: false, dry_run: true, mutation }); expect(await revision()).toBe(before);
  const applied = await observer.click(scope.getByRole('button', { name: applyLabel, exact: true }));
  expect(applied.status).toBe(201); expect(applied.request).toMatchObject({ expected_revision: before, dry_run: false, mutation });
  expect(applied.receipt).toMatchObject({ applied: true, dry_run: false, mutation, rolled_back_revision_id: null });
  const next = Number(applied.receipt.revision); expect(Number.isSafeInteger(next)).toBe(true); expect(next).toBeGreaterThan(before);
  const durable = await active().database.pool.query('SELECT actor_tenant,actor_alias,operation,inverse_operation FROM config_revisions WHERE id=$1', [next]);
  expect(durable.rows).toHaveLength(1); expect(durable.rows[0]).toMatchObject({ actor_tenant: 'Steven', actor_alias: actor, operation: applied.request.mutation, inverse_operation: applied.receipt.inverse_mutation });
  const noticeScope = ['Crear registro', 'Confirmar eliminación del registro'].includes(applyLabel) ? page : scope;
  const message = applyLabel === 'Aplicar atómico' ? `Releído del servidor: las tablas de abajo están en la revisión ${String(next)}` : `Inventario releído en revisión ${String(next)}`;
  await noticeScope.getByRole('status').filter({ hasText: message }).waitFor({ timeout: 20_000 });
  expect(await revision()).toBe(next); ledger.push(applied);
}
async function advanced(page: BrowserPage): Promise<void> {
  await page.getByRole('button', { name: 'Administración avanzada', exact: true }).click();
  await page.getByRole('tab', { name: 'Espacios y miembros', exact: true }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
  await page.getByRole('button', { name: 'Actualizando…', exact: true }).waitFor({ state: 'hidden', timeout: 20_000 });
}
async function openForm(page: BrowserPage, button: string, title: string): Promise<Form> {
  await page.getByRole('button', { name: button, exact: true }).click();
  const form = page.getByRole('form', { name: title, exact: true }) as Form; await form.waitFor({ timeout: 20_000 }); return form;
}
async function rejectDependency(page: BrowserPage, observer: ReturnType<typeof observe>, resource: 'tenant' | 'room'): Promise<void> {
  const label = resource === 'tenant' ? 'espacio' : 'sala/grupo'; const identity = resource === 'tenant' ? tenant : `${tenant}/${room}`;
  const form = await openForm(page, `Eliminar ${label} ${identity}`, `Eliminar ${label}`); const before = await revision();
  const result = await observer.click(form.getByRole('button', { name: 'Previsualizar cambio', exact: true }));
  expect(result.status).toBe(409); expect(result.request.mutation).toMatchObject({ resource, action: 'delete' });
  await form.getByRole('alert').waitFor({ timeout: 20_000 }); expect(await revision()).toBe(before);
  const disabled = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>('form button')).find(button => button.textContent === 'Confirmar eliminación')?.disabled);
  expect(disabled).toBe(true); await form.getByRole('button', { name: 'Cancelar', exact: true }).click();
}

beforeAll(async () => {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.CAUCE_TEST_DATABASE_URL !== undefined || process.env.DATABASE_URL !== undefined
      || process.env.CAUCE_TEST_DOCKER_NETWORK !== undefined || process.env.CAUCE_TEST_DOCKER_NETWORK_OWNER !== undefined || process.env.VITE_USE_MOCKS === 'true'
      || process.env.CAUCE_UI_FUNCTIONAL_BROWSER_IMAGE !== undefined) throw new Error('CRUD E2E requires owned PostgreSQL/network/Chromium resources without external overrides or mocks');
  evidence = process.env.CAUCE_UI_CRUD_EVIDENCE_DIR ?? await mkdtemp(join(tmpdir(), 'cauce-ui-crud-'));
  if (!evidence.trim()) throw new Error('CRUD evidence directory is empty'); await mkdir(evidence, { recursive: true, mode: 0o700 }); await chmod(evidence, 0o700);
  fixture = await startConsoleFunctionalFixture(); resources = await owned();
  await active().database.pool.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2)', [`crudop.${suffix}`, 'Steven']);
  await active().database.pool.query("INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory) VALUES($1,$2,'fake',true,$3,'runner',$4,$5)", ['Steven', actor, `qa-${suffix}`, `/home/qa-${suffix}`, `/home/qa-${suffix}/.state`]);
  await active().database.pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'operator')", ['Steven', `crudop.${suffix}`, actor]);
  operator = { email: `crudop-${suffix}@cauce.test`, password: randomBytes(24).toString('base64url') };
  reader = { email: `crudreader-${suffix}@cauce.test`, password: randomBytes(24).toString('base64url') };
  await maintainConsoleUser(active().database.pool, { email: operator.email, name: 'CRUD operator', role: 'operator', tenant: 'Steven', alias: actor, updateOnly: false, activate: true }, await hashPassword(operator.password));
  await maintainConsoleUser(active().database.pool, { email: reader.email, name: 'CRUD reader', role: 'reader', tenant: isaTenant.tenant, alias: isaTenant.operator, updateOnly: false, activate: true }, await hashPassword(reader.password));
  await writeFile(join(evidence, 'resources-before.json'), JSON.stringify({ resources, browserRuntime: active().browserRuntime }, null, 2) + '\n', { mode: 0o600 });
}, 10 * 60_000);
afterAll(async () => {
  const errors: unknown[] = []; const f = fixture;
  if (f) { try { await f.close(); } catch (cause) { errors.push(cause); } fixture = undefined; }
  if (resources) {
    const ownedIds: ['container' | 'image' | 'network' | 'volume', string][] = [['container', resources.postgres], ['container', resources.browser], ['image', resources.image], ['network', resources.network], ...resources.volumes.map(id => ['volume', id] as ['volume', string])];
    const outcomes = await Promise.allSettled(ownedIds.map(([kind, id]) => absent(kind, id)));
    for (const outcome of outcomes) if (outcome.status === 'rejected') errors.push(outcome.reason);
    await writeFile(join(evidence, 'resources-after.json'), JSON.stringify({ resources, absenceChecks: outcomes.map((outcome, index) => ({ reference: ownedIds[index], status: outcome.status, ...(outcome.status === 'rejected' ? { error: browserErrorStderr(outcome.reason) } : {}) })) }, null, 2) + '\n', { mode: 0o600 });
  }
  if (errors.length) throw new AggregateError(errors, 'CRUD owned fixture cleanup incomplete');
}, 60_000);

describe('CRUD UI durable con Chromium, PasswordAuth y PostgreSQL', () => {
  it('crea, relee, edita y elimina espacio, grupo, membresía y registro sin runtime; rechaza dependencias', async () => {
    if (!operator) throw new Error('hub identity unavailable'); const page = await newTrustedPage(active(), { width: 1440, height: 1000 });
    const errors: string[] = []; page.on('pageerror', error => { errors.push(String(error)); }); const observer = observe(page);
    await login(page, operator); await advanced(page);
    let form = await openForm(page, 'Crear espacio', 'Crear espacio'); await form.getByLabel('Id del espacio').fill(tenant); await form.getByLabel('Nombre visible').fill('CRUD equipo');
    await apply(page, observer, form, { resource: 'tenant', action: 'create', id: tenant, value: { display_name: 'CRUD equipo', is_hub: false, enabled: true } });
    await assertRecord(page, 'tenants', { id: tenant, display_name: 'CRUD equipo' }); await form.getByRole('button', { name: 'Cancelar', exact: true }).click();
    form = await openForm(page, `Editar espacio ${tenant}`, 'Editar espacio'); await form.getByLabel('Nombre visible').fill('CRUD equipo editado');
    await apply(page, observer, form, { resource: 'tenant', action: 'update', id: tenant, value: { display_name: 'CRUD equipo editado' } }, undefined, 'Confirmar edición');
    await assertRecord(page, 'tenants', { display_name: 'CRUD equipo editado' }); await form.getByRole('button', { name: 'Cancelar', exact: true }).click();
    form = await openForm(page, 'Crear sala/grupo', 'Crear sala/grupo'); await form.getByLabel('Espacio', { exact: true }).fill(tenant); await form.getByLabel('Id de la sala/grupo').fill(room); await form.getByLabel('Nombre visible').fill('CRUD grupo');
    await apply(page, observer, form, { resource: 'room', action: 'create', tenant_id: tenant, id: room, value: { display_name: 'CRUD grupo', enabled: true } });
    await assertRecord(page, 'rooms', { display_name: 'CRUD grupo' }); await form.getByRole('button', { name: 'Cancelar', exact: true }).click();
    form = await openForm(page, `Editar sala/grupo ${tenant}/${room}`, 'Editar sala/grupo'); await form.getByLabel('Nombre visible').fill('CRUD grupo editado');
    await apply(page, observer, form, { resource: 'room', action: 'update', tenant_id: tenant, id: room, value: { display_name: 'CRUD grupo editado' } }, undefined, 'Confirmar edición');
    await assertRecord(page, 'rooms', { display_name: 'CRUD grupo editado' }); await form.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await rejectDependency(page, observer, 'tenant'); await assertRecord(page, 'tenants', { display_name: 'CRUD equipo editado' });
    await page.getByRole('button', { name: 'Volver a agentes y contexto', exact: true }).click();
    await page.getByRole('button', { name: 'Añadir agente', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Añadir agente', exact: true }) as Form;
    await dialog.getByLabel('Espacio de trabajo').selectOption(tenant); await dialog.getByLabel('Alias', { exact: true }).fill(alias); await dialog.getByLabel('Nombre visible').fill('CRUD agente');
    await apply(page, observer, dialog, { resource: 'agent', action: 'create', tenant_id: tenant, alias, value: { display_name: 'CRUD agente', enabled: false, max_concurrent_deliveries: 2 } }, 'Previsualizar alta', 'Crear registro');
    const emptyRuntime = { enabled: false, container_name: null, runtime_user: null, home_directory: null, state_directory: null, harness_id: null };
    await assertRecord(page, 'agents', { display_name: 'CRUD agente', ...emptyRuntime });
    await page.getByLabel('Buscar agente o grupo').fill(alias); await page.getByRole('button', { name: `Editar registro de ${tenant}/${alias}`, exact: true }).click();
    await page.getByLabel('Nombre visible', { exact: true }).fill('CRUD agente editado');
    await apply(page, observer, page.locator('.agent-registry-editor'), { resource: 'agent', action: 'update', tenant_id: tenant, alias, value: { display_name: 'CRUD agente editado' } }, 'Previsualizar cambio', 'Aplicar cambio');
    await assertRecord(page, 'agents', { display_name: 'CRUD agente editado', ...emptyRuntime }); await advanced(page);
    form = await openForm(page, 'Crear membresía', 'Crear membresía'); await form.getByLabel('Espacio', { exact: true }).fill(tenant); await form.getByLabel('Sala/grupo', { exact: true }).fill(room); await form.getByLabel('Alias del agente').fill(alias);
    await apply(page, observer, form, { resource: 'membership', action: 'create', tenant_id: tenant, room_id: room, alias, value: { role: 'agent', enabled: true } });
    await assertRecord(page, 'memberships', { role: 'agent', enabled: true }); await form.getByRole('button', { name: 'Cancelar', exact: true }).click();
    form = await openForm(page, `Editar membresía ${tenant}/${room}/${alias}`, 'Editar membresía'); await form.getByLabel('Habilitado', { exact: true }).selectOption('false');
    await apply(page, observer, form, { resource: 'membership', action: 'update', tenant_id: tenant, room_id: room, alias, value: { enabled: false } }, undefined, 'Confirmar edición');
    await assertRecord(page, 'memberships', { role: 'agent', enabled: false }); await form.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await rejectDependency(page, observer, 'room'); await assertRecord(page, 'rooms', { display_name: 'CRUD grupo editado' });
    await page.getByRole('button', { name: 'Volver a agentes y contexto', exact: true }).click();
    await page.getByLabel('Buscar agente o grupo').fill(alias);
    await page.getByRole('button', { name: `Editar registro de ${tenant}/${alias}`, exact: true }).click();
    await page.getByRole('button', { name: 'Eliminar registro', exact: true }).click();
    const deleteBefore = await revision();
    const dependencyDenial = await observer.click(page.getByRole('button', { name: 'Previsualizar eliminación', exact: true }));
    expect(dependencyDenial.status).toBe(409); expect(dependencyDenial.request.mutation).toEqual({ resource: 'agent', action: 'delete', tenant_id: tenant, alias });
    await page.getByRole('alert').waitFor({ timeout: 20_000 }); expect(await revision()).toBe(deleteBefore);
    expect(await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Confirmar eliminación del registro')?.disabled)).toBe(true);
    await assertRecord(page, 'agents', { display_name: 'CRUD agente editado', ...emptyRuntime }); await assertRecord(page, 'memberships', { role: 'agent', enabled: false });
    await writeFile(join(evidence, 'agent-delete-dependency-409.json'), JSON.stringify({ ...dependencyDenial, revisionBefore: deleteBefore, revisionAfter: await revision(), writes: 0 }, null, 2) + '\n', { mode: 0o600 });
    await page.getByRole('button', { name: 'Cancelar eliminación', exact: true }).click(); await advanced(page);
    form = await openForm(page, `Eliminar membresía ${tenant}/${room}/${alias}`, 'Eliminar membresía');
    await apply(page, observer, form, { resource: 'membership', action: 'delete', tenant_id: tenant, room_id: room, alias }, undefined, 'Confirmar eliminación');
    await assertRecord(page, 'memberships', undefined); await form.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await page.getByRole('button', { name: 'Volver a agentes y contexto', exact: true }).click();
    await page.getByLabel('Buscar agente o grupo').fill(alias);
    await page.getByRole('button', { name: `Editar registro de ${tenant}/${alias}`, exact: true }).click();
    await page.getByRole('button', { name: 'Eliminar registro', exact: true }).click();
    form = page.getByRole('form', { name: `Eliminar registro de ${tenant}/${alias}`, exact: true }) as Form;
    await apply(page, observer, form, { resource: 'agent', action: 'delete', tenant_id: tenant, alias }, 'Previsualizar eliminación', 'Confirmar eliminación del registro');
    await assertRecord(page, 'agents', undefined); await advanced(page);
    form = await openForm(page, `Eliminar sala/grupo ${tenant}/${room}`, 'Eliminar sala/grupo');
    await apply(page, observer, form, { resource: 'room', action: 'delete', tenant_id: tenant, id: room }, undefined, 'Confirmar eliminación'); await assertRecord(page, 'rooms', undefined); await form.getByRole('button', { name: 'Cancelar', exact: true }).click();
    form = await openForm(page, `Eliminar espacio ${tenant}`, 'Eliminar espacio'); await apply(page, observer, form, { resource: 'tenant', action: 'delete', id: tenant }, undefined, 'Confirmar eliminación'); await assertRecord(page, 'tenants', undefined);
    expect(ledger).toHaveLength(12); expect(new Set(ledger.map(row => row.receipt.revision)).size).toBe(12);
    expect(errors).toEqual([]); expect(active().adapters).toEqual([]); expect(snapshots).toEqual(expect.arrayContaining(ledger.map(row => Number(row.receipt.revision))));
    const runtime = await active().database.pool.query<{ leases: string; operations: string }>('SELECT (SELECT count(*) FROM connection_leases WHERE tenant_id=$1) AS leases,(SELECT count(*) FROM fleet_operations WHERE target->>\'tenant_id\'=$1) AS operations', [tenant]);
    expect(runtime.rows[0]).toEqual({ leases: '0', operations: '0' });
    await page.screenshot({ path: join(evidence, 'crud-complete-1440.png'), fullPage: true }); await writeFile(join(evidence, 'durable-ui-receipts.json'), JSON.stringify({ ledger, snapshots, runtime: runtime.rows[0], provider_login_verified: false }, null, 2) + '\n', { mode: 0o600 });
  }, 120_000);
  it('rechaza el alta del registro desde el operador no-hub sin crear agente ni revisión', async () => {
    const page = await newTrustedPage(active(), { width: 360, height: 900 }); const observer = observe(page); await login(page, isaTenant);
    await page.getByRole('button', { name: 'Añadir agente', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Añadir agente', exact: true }) as Form;
    const forbidden = `denied${suffix}`; await dialog.getByLabel('Espacio de trabajo').selectOption(isaTenant.tenant); await dialog.getByLabel('Alias', { exact: true }).fill(forbidden); await dialog.getByLabel('Nombre visible').fill('Alta rechazada');
    const before = await revision(); const denied = await observer.click(dialog.getByRole('button', { name: 'Previsualizar alta', exact: true })); expect(denied.status).toBe(403);
    await dialog.getByRole('alert').waitFor({ timeout: 20_000 }); expect(await revision()).toBe(before);
    expect((await active().database.pool.query('SELECT alias FROM agents WHERE tenant_id=$1 AND alias=$2', [isaTenant.tenant, forbidden])).rows).toEqual([]);
    await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click(); await advanced(page);
    expect(await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Crear espacio')?.disabled)).toBe(true);
    await page.screenshot({ path: join(evidence, 'non-hub-denial-360.png'), fullPage: true });
  });
  it('mantiene controles visibles bloqueados para reader y ninguna escritura UI', async () => {
    if (!reader) throw new Error('reader identity unavailable'); const page = await newTrustedPage(active(), { width: 360, height: 900 }); const observer = observe(page); await login(page, reader); const before = await revision(); await advanced(page);
    await page.getByRole('button', { name: 'Crear espacio', exact: true }).waitFor({ timeout: 20_000 });
    const states = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter(button => /^Crear (?:espacio|sala\/grupo|membresía)$/u.test(button.textContent)).map(button => ({ label: button.textContent, disabled: button.disabled })));
    expect(states).toHaveLength(3); expect(states.every(button => button.disabled)).toBe(true);
    const permissions = await page.evaluate(async () => { const response = await fetch('/v3/console/access', { credentials: 'include' }); return await response.json() as { permissions?: string[] }; });
    expect(permissions.permissions).not.toContain('config.write'); expect(observer.changes).toEqual([]); expect(await revision()).toBe(before);
    await page.screenshot({ path: join(evidence, 'reader-controls-360.png'), fullPage: true });
  });
});
