import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { apiGet, type V4Locator } from './v4-console-real-browser.helpers.js';
import { retiredRoomEvidence, retiredRoomReceipt, retiredRoomRun, startRetiredRoomFixture,
  type RetiredRoomFixture } from './v4-r8b-retired-room-membership.fixtures.js';

const alias = `zz-canary-r8b-${retiredRoomRun}`;
const room = `zz-canary-r8b-room-${retiredRoomRun}`;
const missingRoomError = 'Una membresía apunta a grupos ausentes del inventario.';
let fixture: RetiredRoomFixture | undefined;
const evidence: Record<string, unknown> = {};
interface Operation { id: string; kind: string; status: string; error: unknown }
interface Membership { tenant_id: string; alias: string; room_id: string; role: string; enabled: boolean; created_at: string }
interface Snapshot { agents: { tenant_id: string; alias: string; display_name: string }[]; rooms: { tenant_id: string; id: string }[];
  memberships: Membership[]; retired?: { rooms?: { tenant_id: string; id: string }[] } }

function active() { if (!fixture) throw new Error('Retired room fixture is absent'); return fixture; }
async function capture(name: string, focus?: V4Locator): Promise<void> {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await active().page.setViewportSize(viewport);
    if (focus) await focus.evaluate(element => { element.scrollIntoView({ block: 'center' }); });
    const path = join(retiredRoomEvidence, `${name}-${String(viewport.width)}.png`);
    const options = { path, fullPage: true, mask: [active().page.locator('input,textarea,pre,[role="log"],.xterm,[data-pty-shell]')] };
    await active().page.screenshot(options); await chmod(path, 0o600);
  }
  await active().page.setViewportSize({ width: 1440, height: 900 });
}
async function snapshot(): Promise<Snapshot> {
  const response = await apiGet(active().page, '/v3/console/config');
  expect(response.status).toBe(200);
  return response.body as unknown as Snapshot;
}
async function operations(): Promise<Operation[]> {
  const response = await apiGet(active().page, `/v3/console/fleet/operations?resource=agent&tenant_id=${active().tenant}&alias=${alias}`);
  expect(response.status).toBe(200);
  return (response.body.operations as Operation[]).map(row => {
    const error = row.error !== null && typeof row.error === 'object' ? row.error as Record<string, unknown> : {};
    const safe: Record<string, string | boolean> = {};
    for (const name of ['code', 'step', 'reason', 'retryable']) {
      const value = error[name];
      if (typeof value === 'string' || typeof value === 'boolean') safe[name] = value;
    }
    return { id: row.id, kind: row.kind, status: row.status, error: safe };
  });
}
async function clickEnabled(locator: V4Locator): Promise<void> {
  await locator.waitFor({ timeout: 30_000 });
  await expect.poll(() => locator.isDisabled(), { timeout: 30_000 }).toBe(false);
  await locator.click();
}
async function enqueue(form: V4Locator, kind: string): Promise<Operation> {
  const previous = new Set((await operations()).map(row => row.id));
  await clickEnabled(form.getByRole('button', { name: 'Previsualizar operación', exact: true }));
  await clickEnabled(form.getByRole('button', { name: 'Confirmar operación', exact: true }));
  let operation: Operation | undefined;
  await expect.poll(async () => {
    operation = (await operations()).find(row => row.kind === kind && !previous.has(row.id));
    return operation !== undefined && ['failed', 'cancelled', 'awaiting_auth', 'succeeded'].includes(operation.status);
  }, { timeout: 240_000, interval: 1_000 }).toBe(true);
  if (!operation) throw new Error('Completed fleet operation is absent');
  const completed = operation;
  await retiredRoomReceipt(`operation-${completed.id}`, completed);
  if (completed.status !== 'succeeded') await active().diagnoseOperation(completed.id, alias)
    .catch(() => retiredRoomReceipt(`diagnostic-${completed.id}`, { id: completed.id, status: 'unavailable' }));
  expect(completed.status, `Fleet ${kind} did not succeed`).toBe('succeeded');
  return completed;
}
async function updateForm(): Promise<V4Locator> {
  const { page, baseUrl, tenant } = active();
  await page.goto(`${baseUrl}/config?seccion=agentes&agente=${encodeURIComponent(`${tenant}/${alias}`)}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Ejecución', exact: true }).click();
  const panel = page.getByRole('region', { name: `Operación de ${tenant}/${alias}`, exact: true });
  await panel.getByRole('combobox', { name: '¿Qué quieres hacer?', exact: true }).selectOption('update');
  return panel;
}
async function membership(): Promise<Membership | undefined> {
  return (await snapshot()).memberships.find(row => row.tenant_id === active().tenant && row.alias === alias && row.room_id === room);
}

beforeAll(async () => { fixture = await startRetiredRoomFixture(); }, 900_000);
afterAll(async () => {
  try { await retiredRoomReceipt('effects', evidence); }
  finally { await fixture?.close(); }
}, 300_000);

it('actualiza el agente tras retirar una sala sin reactivar ni perder su membresía histórica', async () => {
  const { page, baseUrl, tenant, host, account, primaryRoom, computer } = active();
  try {
    await page.goto(`${baseUrl}/config?seccion=espacios`, { waitUntil: 'domcontentloaded' });
    const quick = page.getByRole('group', { name: 'Alta rápida', exact: true });
    await quick.getByRole('combobox', { name: 'Recurso a crear', exact: true }).selectOption('room');
    await quick.getByLabel('Espacio', { exact: true }).fill(tenant);
    await quick.getByLabel('Sala', { exact: true }).fill(room);
    await quick.getByLabel('Nombre', { exact: true }).fill(room);
    await clickEnabled(quick.getByRole('button', { name: 'Previsualizar el alta', exact: true }));
    await clickEnabled(quick.getByRole('button', { name: 'Crear', exact: true }));
    await expect.poll(async () => (await snapshot()).rooms.some(row => row.tenant_id === tenant && row.id === room)).toBe(true);
    evidence.room_created = true; await capture('01-room-created');

    await page.goto(`${baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Añadir agente', exact: true });
    await dialog.getByText('Solo preparar, sin desplegar', { exact: true }).click();
    const create = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
    await create.getByRole('combobox', { name: 'Espacio de trabajo operativo', exact: true }).selectOption(tenant);
    await create.getByLabel('Alias operativo', { exact: true }).fill(alias);
    await create.getByLabel('Nombre visible operativo', { exact: true }).fill(alias);
    await create.getByLabel('Clave física de ejecución', { exact: true }).fill(`r8b-${retiredRoomRun}`);
    await create.getByRole('checkbox', { name: new RegExp(`· "${primaryRoom}"$`, 'u') }).check();
    await create.getByRole('combobox', { name: 'Grupo primario', exact: true }).selectOption(primaryRoom);
    await create.getByRole('combobox', { name: 'Host operativo', exact: true }).selectOption(host);
    await create.getByRole('combobox', { name: 'Plantilla de ejecución', exact: true }).selectOption('0');
    await create.getByRole('combobox', { name: 'Cuenta principal de ejecución', exact: true }).selectOption(account);
    evidence.create_operation = await enqueue(create, 'create');

    let panel = await updateForm();
    const checkbox = () => panel.getByRole('checkbox', { name: new RegExp(`^Incluir .* · "${room}"$`, 'u') });
    await checkbox().check();
    evidence.add_operation = await enqueue(panel, 'update');
    const included = await membership(); expect(included?.enabled).toBe(true);
    evidence.membership_included = included; await capture('02-membership-added');

    panel = await updateForm();
    await panel.getByRole('checkbox', { name: `Habilitar membresía "${room}"`, exact: true }).uncheck();
    evidence.disable_operation = await enqueue(panel, 'update');
    const historical = await membership();
    expect(historical).toMatchObject({ role: included?.role, enabled: false, created_at: included?.created_at });
    evidence.membership_disabled = historical;

    await page.goto(`${baseUrl}/config?seccion=espacios`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: `Retirar sala/grupo ${tenant}/${room}`, exact: true }).click();
    const retire = page.getByRole('form', { name: 'Retirar sala/grupo', exact: true });
    await clickEnabled(retire.getByRole('button', { name: 'Previsualizar cambio', exact: true }));
    await clickEnabled(retire.getByRole('button', { name: 'Confirmar retiro', exact: true }));
    await expect.poll(async () => (await snapshot()).retired?.rooms?.some(row => row.id === room && row.tenant_id === tenant)).toBe(true);
    expect(await membership()).toMatchObject({ role: historical?.role, enabled: false, created_at: historical?.created_at });
    evidence.room_retired_history_preserved = true; await capture('03-room-retired');

    panel = await updateForm();
    const preview = panel.getByRole('button', { name: 'Previsualizar operación', exact: true });
    const confirm = panel.getByRole('button', { name: 'Confirmar operación', exact: true });
    await panel.getByLabel('Nombre visible operativo', { exact: true }).fill(`${alias}-updated`);
    await clickEnabled(preview);
    await expect.poll(async () => (await panel.innerText()).includes(missingRoomError) || !(await confirm.isDisabled()),
      { timeout: 30_000 }).toBe(true);
    const blocked = await panel.innerText();
    evidence.retired_membership_error_visible = blocked.includes(missingRoomError);
    evidence.retired_membership_error = blocked.includes(missingRoomError) ? missingRoomError : null;
    await capture('04-update-after-room-retirement', blocked.includes(missingRoomError)
      ? panel.getByText(missingRoomError, { exact: true }) : confirm);
    expect(blocked).not.toContain(missingRoomError);
    expect(await confirm.isDisabled(), missingRoomError).toBe(false);
    evidence.final_operation = await enqueue(panel, 'update');
    expect((await snapshot()).agents.find(row => row.tenant_id === tenant && row.alias === alias)?.display_name).toBe(`${alias}-updated`);
    const persisted = (await computer.pool.query<{ role: string; enabled: boolean; created_at: Date }>(
      'SELECT role,enabled,created_at FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias=$3', [tenant, room, alias])).rows;
    expect(persisted).toHaveLength(1); expect(persisted[0]).toMatchObject({ role: historical?.role, enabled: false });
    expect(persisted[0]?.created_at.toISOString()).toBe(historical?.created_at);
    evidence.membership_after_update = persisted[0]; await capture('05-update-succeeded');
  } catch (error) {
    const failed = await operations().catch(() => []);
    evidence.operations_at_failure = failed;
    for (const operation of failed.filter(row => row.status === 'failed')) {
      await active().diagnoseOperation(operation.id, alias).catch(() => undefined);
    }
    await capture('failure').catch(() => undefined);
    await retiredRoomReceipt('effects', evidence);
    throw error;
  }
}, 900_000);
