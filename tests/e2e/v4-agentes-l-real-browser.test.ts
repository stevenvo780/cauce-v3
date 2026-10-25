import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { apiGet, bodySnippet, type V4Locator } from './v4-console-real-browser.helpers.js';
import { coverageCapture, coverageEnabled, coverageEnqueue, coverageOperations, startCoverageFixture,
  type CoverageFixture, type CoverageOperation } from './v4-agentes-l-helpers.js';

let fixture: CoverageFixture | undefined;
let alias = '', runtime = '', container = '', second = '', emptyTenant = '';
let roomChanges = 0;
const evidence: Record<string, unknown> = { mocks: false };
const active = () => { if (!fixture) throw new Error('lifecycle coverage fixture absent'); return fixture; };
const done: string[] = [];

async function record(ids: string[], label: string, details: unknown): Promise<void> {
  await coverageCapture(active(), label);
  evidence[label] = { ids, details };
  done.push(...ids);
  console.info('LIFECYCLE_COVERED', ids.join(','), label, JSON.stringify(details));
}
async function openPanel(target = alias): Promise<V4Locator> {
  const { page, baseUrl, tenantId } = active();
  await page.goto(`${baseUrl}/config?seccion=agentes&agente=${encodeURIComponent(`${tenantId}/${target}`)}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Ejecución', exact: true }).click();
  const panel = page.getByRole('region', { name: `Operación de ${tenantId}/${target}`, exact: true });
  await panel.waitFor({ timeout: 30_000 });
  return panel;
}
async function preview(panel: V4Locator): Promise<void> {
  const button = panel.getByRole('button', { name: 'Previsualizar operación', exact: true });
  await coverageEnabled(button); await button.click();
}
async function requestDetails(panel: V4Locator): Promise<Record<string, unknown>> {
  const summary = panel.getByText('Detalles técnicos de la solicitud', { exact: true });
  await summary.click();
  const value = await summary.locator('..').locator('pre').innerText();
  await summary.click();
  return JSON.parse(value) as Record<string, unknown>;
}
async function durable(): Promise<Record<string, unknown> | undefined> {
  return (await active().computer.pool.query(`SELECT tenant_id,alias,display_name,runtime_key,harness_id,host_id,runtime_mode,
    container_name,runtime_user,systemd_user,home_directory,state_directory,primary_account_id,primary_room_id,model_id,reasoning_effort,lifecycle_state
    FROM agents WHERE tenant_id=$1 AND alias=$2`, [active().tenantId, alias])).rows[0] as Record<string, unknown> | undefined;
}
async function changeRoom(): Promise<void> {
  const { page, tenantId } = active();
  const result = await page.evaluate(async ({ tenant, room, label }) => {
    const session = await (await fetch('/v3/auth/session', { credentials: 'include' })).json() as { csrf_token: string };
    const snapshot = await (await fetch('/v3/console/config', { credentials: 'include' })).json() as { revision: number };
    const response = await fetch('/v3/console/config/changes', { method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrf_token },
      body: JSON.stringify({ dry_run: false, expected_revision: snapshot.revision,
        mutation: { resource: 'room', action: 'update', tenant_id: tenant, id: room, value: { display_name: label } } }) });
    return { status: response.status, body: await response.json() as unknown };
  }, { tenant: tenantId, room: second, label: `Grupo actualizado en paralelo ${String(++roomChanges)}` });
  expect(result.status, JSON.stringify(result)).toBe(201);
  evidence.concurrent_change = result;
}

beforeAll(async () => {
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  fixture = await startCoverageFixture('l', { extraSourceFiles: ['packages/store/src/device-authorization.ts',
    'packages/store/src/device-authorization-authority.ts', 'services/gateway/src/device-authorization.ts'] });
  alias = `lifecycle${fixture.run}`; runtime = `lifecycle-${fixture.run}`;
  second = `zz-grupo-${fixture.run}`; emptyTenant = `zz-vacio-${fixture.run}`;
  await fixture.computer.pool.query('INSERT INTO rooms(id,tenant_id,display_name) VALUES($1,$2,$3)', [second, fixture.tenantId, 'Grupo secundario']);
  await fixture.computer.pool.query('INSERT INTO tenants(id,company_id,display_name) VALUES($1,$2,$3)', [emptyTenant, fixture.companyId, 'Espacio vacío']);
}, 900_000);
afterAll(async () => {
  if (!fixture) return;
  try {
    evidence.covered_interactions = [...new Set(done)].sort();
    evidence.operations = await coverageOperations(fixture, alias).catch(() => []);
    evidence.browser_errors = fixture.errors.unexpected;
    evidence.journal = (await fixture.computer.onComputer(['journalctl', '--user', '--no-pager', '-n', '100'])).stdout;
    await writeFile(join(fixture.receipts, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  } finally { await fixture.close(); }
}, 300_000);

describe('cobertura del panel operativo con PostgreSQL y runtime reales', () => {
  it('recorre identidad, membresías, plantillas, validaciones y CAS antes de crear el runtime', async () => {
    const { page, baseUrl, tenantId, room, hostId, accountId, computer } = active();
    try {
      await page.goto(`${baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Añadir agente' });
      await dialog.getByText('Solo preparar, sin desplegar', { exact: true }).click();
      const panel = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
      await panel.getByLabel('Espacio de trabajo operativo').selectOption(tenantId);
      await panel.getByRole('checkbox', { name: new RegExp(`· "${room}"$`, 'u') }).check();
      await panel.getByLabel('Espacio de trabajo operativo').selectOption(emptyTenant);
      await panel.getByText('No hay grupos publicados para este espacio de trabajo.', { exact: true }).waitFor();
      expect(await panel.getByLabel('Grupo primario').locator('option').count()).toBe(1);
      await panel.getByLabel('Espacio de trabajo operativo').selectOption(tenantId);
      expect(await panel.getByRole('checkbox', { name: new RegExp(`· "${room}"$`, 'u') }).evaluate(element => element.checked)).toBe(false);
      await record(['L14'], '01-espacio-vacio-y-limpieza', { emptyTenant, membershipsCleared: true });

      await panel.getByLabel('Alias operativo').fill(alias);
      await panel.getByLabel('Nombre visible operativo').fill(`Ciclo L ${active().run}`);
      await panel.getByLabel('Clave física de ejecución').fill(`inicial-${active().run}`);
      await panel.getByLabel('Arnés operativo').selectOption('codex');
      for (const id of [room, second]) await panel.getByRole('checkbox', { name: new RegExp(`· "${id}"$`, 'u') }).check();
      await panel.getByLabel(`Rol en "${second}"`).selectOption('operator');
      await panel.getByLabel('Grupo primario').selectOption(room);
      const enablePrimary = panel.getByRole('checkbox', { name: `Habilitar membresía "${room}"`, exact: true });
      await enablePrimary.uncheck();
      await panel.getByRole('note').filter({ hasText: 'su grupo principal' }).waitFor();
      await panel.getByLabel('Grupo primario').selectOption(second);
      await panel.getByLabel('Grupo primario').selectOption(room);
      expect(await enablePrimary.evaluate(element => element.checked)).toBe(true);
      await panel.getByLabel('Host operativo').locator(`option[value="${hostId}"]`).waitFor({ state: 'attached', timeout: 30_000 });
      await panel.getByLabel('Host operativo').selectOption(hostId);
      await panel.getByLabel('Plantilla de ejecución').selectOption('0');
      expect(await panel.getByLabel('Cuenta principal de ejecución').inputValue()).toBe(accountId);
      const oldState = await panel.getByLabel('Directorio de estado operativo').inputValue();
      await panel.getByLabel('Clave física de ejecución').fill(runtime);
      container = await panel.getByLabel('Contenedor operativo').inputValue();
      expect(container).toBe(`${active().prefix}-${runtime}`);
      expect(await panel.getByLabel('Directorio de estado operativo').inputValue()).toBe(`/home/cauce/.cauce/${runtime}`);
      expect(await panel.getByLabel('Contenedor operativo').evaluate(element => element.readOnly)).toBe(true);
      expect(await panel.getByLabel('Directorio de estado operativo').evaluate(element => element.readOnly)).toBe(true);
      expect(oldState.endsWith(`inicial-${active().run}`)).toBe(true);
      expect(await panel.getByLabel('Modo de ejecución').locator('option[value="native"]').evaluate(element => element.disabled)).toBe(true);
      await panel.getByLabel('Modo de ejecución').selectOption('container');
      await panel.getByLabel('Usuario operativo').selectOption('');
      await preview(panel);
      await panel.getByRole('alert').filter({ hasText: 'no está permitido en el host' }).waitFor();
      await panel.getByLabel('Usuario operativo').selectOption('cauce');
      await panel.getByLabel('Usuario de supervisión systemd').selectOption('');
      await panel.getByLabel('Usuario de supervisión systemd').selectOption('cauce');
      await panel.getByLabel('Directorio personal operativo').fill('/no-autorizado');
      await preview(panel);
      await panel.getByRole('alert').filter({ hasText: 'Los directorios deben coincidir' }).waitFor();
      await panel.getByLabel('Directorio personal operativo').fill('/home/cauce');
      await panel.getByLabel('Cuenta principal de ejecución').selectOption('');
      expect(await panel.getByLabel('Directorio de estado operativo').evaluate(element => element.readOnly)).toBe(false);
      await panel.getByLabel('Directorio de estado operativo').fill(`/home/cauce/.cauce/${runtime}`);
      await preview(panel);
      await panel.getByRole('alert').filter({ hasText: 'Selecciona una cuenta principal publicada' }).waitFor();
      await panel.getByLabel('Cuenta principal de ejecución').selectOption(accountId);
      await panel.getByLabel('Modelo operativo').fill('gpt-5.5');
      for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', '']) {
        await panel.getByLabel('Esfuerzo de razonamiento').selectOption(effort);
        expect(await panel.getByLabel('Esfuerzo de razonamiento').inputValue()).toBe(effort);
      }
      await panel.getByLabel('Esfuerzo de razonamiento').selectOption('high');
      await record(['L08', 'L09', 'L12', 'L13', 'L16', 'L19', 'L20', 'L21', 'L22'], '02-campos-y-plantilla', { container, automaticAccount: accountId });

      await enablePrimary.uncheck();
      active().errors.expectHttpError('/v3/console/fleet/operations/preview', 409);
      await preview(panel);
      const jump = panel.getByRole('alert').getByRole('button');
      await jump.waitFor({ timeout: 30_000 }); await jump.click();
      expect(await enablePrimary.evaluate(element => element === document.activeElement)).toBe(true);
      await enablePrimary.check();
      await record(['L29'], '03-error-grupo-primario-y-foco', { enabled: false, focused: true });

      const before = await apiGet(page, '/v3/console/config');
      await changeRoom();
      active().errors.expectHttpError('/v3/console/fleet/operations/preview', 409);
      await preview(panel);
      await coverageEnabled(panel.getByRole('button', { name: 'Confirmar operación', exact: true }));
      const first = await requestDetails(panel);
      expect(first.expected_revision).toBeGreaterThan(Number(before.body.revision));
      expect(first.target).toEqual({ resource: 'agent', tenant_id: tenantId, alias });
      expect(await panel.getByLabel('Alias operativo').inputValue()).toBe(alias);
      await record(['L28', 'L30'], '04-cas-relectura-y-solicitud', first);
      await panel.getByLabel('Nombre visible operativo').fill(`Ciclo L ${active().run} confirmado`);
      expect(await panel.getByRole('button', { name: 'Confirmar operación', exact: true }).isDisabled()).toBe(true);
      expect(await computer.pool.query<{ id: string }>('SELECT id FROM fleet_operations WHERE request->\'target\'->>\'alias\'=$1', [alias]).then(result => result.rows)).toEqual([]);
      const created = await coverageEnqueue(active(), panel, alias, 'create');
      const stored = await durable();
      const memberships = (await computer.pool.query('SELECT room_id,role,enabled FROM memberships WHERE tenant_id=$1 AND alias=$2 ORDER BY room_id', [tenantId, alias])).rows;
      expect(stored).toMatchObject({ tenant_id: tenantId, alias, display_name: `Ciclo L ${active().run} confirmado`, runtime_key: runtime,
        harness_id: 'codex', host_id: hostId, runtime_mode: 'container', container_name: container, runtime_user: 'cauce',
        systemd_user: 'cauce', home_directory: '/home/cauce', state_directory: `/home/cauce/.cauce/${runtime}`,
        primary_account_id: accountId, primary_room_id: room, model_id: 'gpt-5.5', reasoning_effort: 'high' });
      expect(memberships).toEqual(expect.arrayContaining([{ room_id: second, role: 'operator', enabled: true }, { room_id: room, role: 'agent', enabled: true }]));
      expect(await docker(['inspect', '--format', '{{.State.Running}}', container])).toBe('true');
      await record(['L07', 'L11', 'L26'], '05-creado-y-persistido', { operation: created, agent: stored, memberships });
    } catch (error) { await failure(error); throw error; }
  }, 900_000);

  it('muestra identidad inmutable, historial plegado y relee recibo e inventario sin perder el borrador', async () => {
    const { page, computer, tenantId } = active();
    try {
      const panel = await openPanel();
      expect(await panel.getByLabel('Espacio de trabajo operativo').isDisabled()).toBe(true);
      expect(await panel.getByLabel('Alias operativo').isDisabled()).toBe(true);
      expect(await panel.getByLabel('Clave física de ejecución').isDisabled()).toBe(true);
      const options = await panel.getByLabel('¿Qué quieres hacer?').evaluate(element => Array.from((element as unknown as HTMLSelectElement).options).map(option => option.value));
      expect(options.sort()).toEqual(['update', 'start', 'stop', 'retire', 'restore', 'purge'].sort());
      const history = panel.getByText('Historial de operaciones', { exact: true }); await history.click();
      const finished = panel.getByText('Terminadas (1)', { exact: true });
      expect(await finished.locator('..').evaluate(element => (element as unknown as HTMLDetailsElement).open)).toBe(false);
      await finished.click();
      await panel.getByRole('button', { name: new RegExp('Ver detalle de Preparar', 'u') }).click();
      const operation = (await coverageOperations(active(), alias))[0];
      expect(operation).toBeDefined();
      const card = panel.getByRole('region', { name: 'Operación de flota', exact: true });
      await card.getByText('Detalles técnicos', { exact: true }).click();
      expect(await card.innerText()).toContain(operation?.id);
      const reads: { status: number; body: unknown }[] = [];
      page.on('response', (raw: unknown) => {
        const response = raw as { url(): string; status(): number; json(): Promise<unknown> };
        if (new URL(response.url()).pathname === `/v3/console/fleet/operations/${operation?.id ?? ''}`) {
          void response.json().then(body => reads.push({ status: response.status(), body }));
        }
      });
      await panel.getByRole('button', { name: 'Releer operación', exact: true }).click();
      await expect.poll(() => reads.length, { timeout: 30_000 }).toBe(1);
      expect(reads[0]).toMatchObject({ status: 200, body: { id: operation?.id, version: operation?.version, status: 'succeeded' } });
      const durableOperation = (await computer.pool.query<{ id: string; version: number; status: string }>('SELECT id,version::int AS version,status FROM fleet_operations WHERE id=$1', [operation?.id])).rows[0];
      expect(durableOperation).toEqual({ id: operation?.id, version: operation?.version, status: 'succeeded' });
      await record(['L31', 'L34'], '06-historial-y-relectura', { operation: durableOperation, reads, finishedCollapsedInitially: true });
      await panel.getByLabel('Nombre visible operativo').fill('Borrador conservado tras cambio de inventario');
      await preview(panel);
      await coverageEnabled(panel.getByRole('button', { name: 'Confirmar operación', exact: true }));
      await changeRoom();
      await panel.getByRole('button', { name: 'Releer inventario', exact: true }).click();
      await panel.getByRole('note').filter({ hasText: 'El borrador se conserva' }).waitFor({ timeout: 30_000 });
      expect(await panel.getByLabel('Nombre visible operativo').inputValue()).toBe('Borrador conservado tras cambio de inventario');
      expect(await panel.getByRole('button', { name: 'Confirmar operación', exact: true }).isDisabled()).toBe(true);
      expect(await card.innerText()).toContain(operation?.id);
      const stored = await durable();
      expect(stored?.display_name).toBe(`Ciclo L ${active().run} confirmado`);
      expect((await computer.pool.query('SELECT alias FROM agents WHERE tenant_id=$1 AND alias=$2', [tenantId, alias])).rows).toHaveLength(1);
      await record(['L04'], '07-inventario-preserva-borrador', { stored, receipt: operation?.id });
      const stopped = await simple(panel, 'stop');
      const started = await simple(panel, 'start');
      expect(await docker(['inspect', '--format', '{{.State.Running}}', container])).toBe('true');
      await record([], '08-stop-start-fisico', { stopped, started });
      active().errors.assertClean();
    } catch (error) { await failure(error); throw error; }
  }, 900_000);

  it('bloquea otra vista previa mientras hay operación pendiente y cancela desde su recibo', async () => {
    const { page, computer, unit } = active();
    try {
      const panel = await openPanel();
      expect((await computer.onComputer(['systemctl', '--user', 'stop', unit])).code).toBe(0);
      await panel.getByLabel('¿Qué quieres hacer?').selectOption('stop');
      const queued = await coverageEnqueue(active(), panel, alias, 'stop', ['queued']);
      expect(await panel.getByRole('button', { name: 'Previsualizar operación', exact: true }).isDisabled()).toBe(true);
      expect(await panel.getByLabel('¿Qué quieres hacer?').isDisabled()).toBe(true);
      const card = panel.getByRole('region', { name: 'Operación de flota', exact: true });
      await card.getByRole('button', { name: 'Cancelar', exact: true }).click();
      expect((await computer.onComputer(['systemctl', '--user', 'start', unit])).code).toBe(0);
      let cancelled: CoverageOperation | undefined;
      await expect.poll(async () => {
        cancelled = (await coverageOperations(active(), alias)).find(row => row.id === queued.id);
        return cancelled?.status;
      }, { timeout: 180_000, interval: 1000 }).toBe('cancelled');
      await panel.getByRole('button', { name: 'Releer operación', exact: true }).click();
      await card.getByText('Cancelada', { exact: true }).waitFor({ timeout: 30_000 });
      expect(await docker(['inspect', '--format', '{{.State.Running}}', container])).toBe('true');
      const events = (await computer.pool.query('SELECT event,metadata FROM fleet_operation_events WHERE operation_id=$1 ORDER BY id', [queued.id])).rows as unknown[];
      await record(['L27'], '09-pendiente-bloquea-y-cancelada', { queued, cancelled, events });
      const history = panel.getByText('Historial de operaciones', { exact: true }); await history.click();
      expect(await history.locator('..').innerText()).toContain('Terminadas');
      expect(await page.getByRole('button', { name: 'Previsualizar operación', exact: true }).isDisabled()).toBe(false);
    } catch (error) { await failure(error); throw error; }
  }, 600_000);

  it('abre y cierra el panel no embebido desde el resultado del alta y ofrece solo create al borrador', async () => {
    const { page, baseUrl, tenantId, hostId, computer } = active();
    const draftAlias = `borrador${active().run}`;
    try {
      await page.goto(`${baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Añadir agente' });
      await dialog.getByLabel('Espacio de trabajo', { exact: true }).selectOption(tenantId);
      await dialog.getByLabel('Alias', { exact: true }).fill(draftAlias);
      await dialog.getByLabel('Nombre visible', { exact: true }).fill(`Borrador L ${active().run}`);
      await dialog.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await dialog.getByLabel('Computadora (opcional)').selectOption(hostId);
      await dialog.getByLabel('Tipo de agente (opcional)').selectOption('codex');
      await dialog.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await dialog.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await dialog.getByRole('button', { name: 'Previsualizar alta', exact: true }).click();
      const create = dialog.getByRole('button', { name: 'Crear registro', exact: true }); await coverageEnabled(create); await create.click();
      const trigger = dialog.getByRole('button', { name: 'Preparar en la computadora', exact: true });
      await trigger.waitFor({ timeout: 30_000 });
      expect(await trigger.evaluate(element => element.getAttribute('aria-expanded'))).toBe('false');
      await trigger.click();
      const embedded = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true }); await embedded.waitFor();
      await embedded.getByRole('button', { name: 'Cerrar operaciones', exact: true }).click();
      expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true);
      expect(await embedded.count()).toBe(0);
      await trigger.click(); await embedded.waitFor(); await trigger.click();
      expect(await embedded.count()).toBe(0);
      await record(['L01'], '10-trigger-cierre-y-foco', { draftAlias, closeAndToggle: true });
      await dialog.getByRole('button', { name: 'Terminar', exact: true }).click();
      const panel = await openPanel(draftAlias);
      const options = await panel.getByLabel('¿Qué quieres hacer?').evaluate(element => Array.from((element as unknown as HTMLSelectElement).options).map(option => option.value));
      expect(options).toEqual(['create']);
      await panel.getByText('Historial de operaciones', { exact: true }).click();
      await panel.getByText('Todavía no hay operaciones para este agente.', { exact: true }).waitFor();
      expect((await computer.pool.query<{ runtime_key: string | null; lifecycle_state: string }>('SELECT runtime_key,lifecycle_state FROM agents WHERE tenant_id=$1 AND alias=$2', [tenantId, draftAlias])).rows[0])
        .toEqual({ runtime_key: null, lifecycle_state: 'draft' });
      await record(['L05'], '11-selector-borrador-e-historial-vacio', { options, activeOptions: ['update', 'start', 'stop', 'retire', 'restore', 'purge'] });
      active().errors.assertClean();
    } catch (error) { await failure(error); throw error; }
  }, 600_000);
});

async function simple(panel: V4Locator, kind: string): Promise<CoverageOperation> {
  await panel.getByLabel('¿Qué quieres hacer?').selectOption(kind);
  const result = await coverageEnqueue(active(), panel, alias, kind);
  await panel.getByRole('button', { name: 'Releer operación', exact: true }).click();
  const card = panel.getByRole('region', { name: 'Operación de flota', exact: true });
  const technical = card.getByText('Detalles técnicos', { exact: true });
  if (!await technical.locator('..').evaluate(element => (element as unknown as HTMLDetailsElement).open)) await technical.click();
  await expect.poll(async () => (await card.innerText()).includes(result.id), { timeout: 30_000 }).toBe(true);
  return result;
}
async function failure(error: unknown): Promise<void> {
  evidence.failure = error instanceof Error ? error.stack : String(error);
  evidence.failure_page = await bodySnippet(active().page);
  console.info('LIFECYCLE_FAILURE', evidence.failure_page);
  await coverageCapture(active(), 'failure');
}
