import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { apiGet, bodySnippet, type V4Locator } from './v4-console-real-browser.helpers.js';
import { coverageCapture, coverageEnabled, coverageEnqueue, coverageOperations, startCoverageFixture,
  type CoverageFixture, type CoverageOperation } from './v4-agentes-l-helpers.js';

let fixture: CoverageFixture | undefined;
let alias = '', runtime = '', container = '';
let paused = false;
const evidence: Record<string, unknown> = { section: 'O', states: [] };
const active = () => { if (!fixture) throw new Error('operation coverage fixture absent'); return fixture; };
const card = () => active().page.getByRole('region', { name: 'Operación de flota', exact: true });

async function executor(action: 'start' | 'stop'): Promise<void> {
  const { computer, unit } = active();
  const result = await computer.onComputer(['systemctl', '--user', action, unit]);
  expect(result.code, result.stderr).toBe(0);
}
async function receipt(id: string, status: string): Promise<CoverageOperation> {
  let operation: CoverageOperation | undefined;
  await expect.poll(async () => {
    operation = (await coverageOperations(active(), alias)).find(row => row.id === id);
    return operation?.status;
  }, { timeout: 240_000, interval: 1000 }).toBe(status);
  if (!operation) throw new Error('operation receipt absent');
  return operation;
}
async function state(operation: CoverageOperation, label: string, capture: string): Promise<void> {
  await card().getByText(label, { exact: true }).waitFor({ timeout: 30_000 });
  const durable = (await active().computer.pool.query<{ status: string; version: string; steps: unknown }>(
    'SELECT status,version,steps FROM fleet_operations WHERE id=$1', [operation.id])).rows[0];
  expect(durable?.status).toBe(operation.status);
  (evidence.states as unknown[]).push({ id: operation.id, status: operation.status, durable });
  await coverageCapture(active(), capture);
}
async function prepare(): Promise<V4Locator> {
  const { page, baseUrl, tenantId, room, hostId, accountId } = active();
  await page.goto(`${baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Añadir agente' });
  await dialog.getByText('Solo preparar, sin desplegar', { exact: true }).click();
  const panel = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
  await panel.getByLabel('Espacio de trabajo operativo').selectOption(tenantId);
  await panel.getByLabel('Alias operativo').fill(alias);
  await panel.getByLabel('Nombre visible operativo').fill(`Operaciones ${active().run}`);
  await panel.getByLabel('Clave física de ejecución').fill(runtime);
  await panel.getByRole('checkbox', { name: new RegExp(`· "${room}"$`, 'u') }).check();
  await panel.getByLabel('Grupo primario').selectOption(room);
  await panel.getByLabel('Host operativo').locator(`option[value="${hostId}"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await panel.getByLabel('Host operativo').selectOption(hostId);
  await panel.getByLabel('Plantilla de ejecución').selectOption('0');
  await panel.getByLabel('Cuenta principal de ejecución').selectOption(accountId);
  return panel;
}
async function openExecution(): Promise<V4Locator> {
  const { page, baseUrl, tenantId } = active();
  await page.goto(`${baseUrl}/config?seccion=agentes&agente=${encodeURIComponent(`${tenantId}/${alias}`)}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Ejecución', exact: true }).click();
  return page.getByRole('region', { name: `Operación de ${tenantId}/${alias}`, exact: true });
}
async function processCount(): Promise<number> {
  return Number(await docker(['exec', '--user', 'cauce', container, 'python3', '-c',
    'import os,pathlib,sys;count=0\nfor pid in filter(str.isdigit,os.listdir("/proc")):\n'
    + ' try:\n  env=pathlib.Path("/proc",pid,"environ").read_bytes().split(bytes([0]));count+=bytes("CAUCE_RUNTIME_KEY="+sys.argv[1],"utf8") in env\n'
    + ' except OSError:pass\nprint(count)', runtime]));
}
async function inspectDetails(operation: CoverageOperation): Promise<void> {
  const region = card();
  await region.getByText('Detalles técnicos', { exact: true }).click();
  const durable = (await active().computer.pool.query<{ version: string; expected_revision: string; desired_revision: string | null;
    applied_revision: string | null; actor_tenant: string; actor_alias: string; actor_subject: string | null; actor_name: string | null;
    target: unknown; request_hash: string; error: { code: string; step?: string; retryable: boolean } | null }>(`SELECT
      operation.version,expected_revision,desired_revision,applied_revision,actor_tenant,actor_alias,target,request_hash,error,
      origin.metadata->>'actor_subject' AS actor_subject,human.display_name AS actor_name FROM fleet_operations operation
      JOIN LATERAL (SELECT metadata FROM fleet_operation_events WHERE operation_id=operation.id AND event='queued' ORDER BY id LIMIT 1) origin ON true
      LEFT JOIN console_users human ON 'console:' || human.id::text=(origin.metadata->>'actor_subject')
      WHERE operation.id=$1`, [operation.id])).rows[0];
  if (!durable) throw new Error('technical operation receipt absent');
  const response = await apiGet(active().page, `/v3/console/fleet/operations/${operation.id}`);
  expect(response.status).toBe(200);
  expect(response.body.target).toEqual(durable.target);
  const actor = response.body.actor as { tenant_id: string; alias: string; actor_subject?: string; display_name?: string };
  expect(actor).toMatchObject({ tenant_id: durable.actor_tenant, alias: durable.actor_alias });
  expect(actor.actor_subject ?? null).toBe(durable.actor_subject);
  const actorName = durable.actor_subject?.startsWith('console:') ? durable.actor_name ?? 'Persona de la consola' : durable.actor_alias;
  if (durable.actor_subject?.startsWith('console:') && durable.actor_name) expect(actor.display_name).toBe(durable.actor_name);
  const rendered = await region.innerText();
  for (const text of [`ID: ${operation.id}`, `Versión: ${durable.version}`, `Huella: ${durable.request_hash}`,
    `Revisión esperada: ${durable.expected_revision}`, `Revisión deseada: ${durable.desired_revision ?? 'Sin publicar'}`,
    `Revisión aplicada: ${durable.applied_revision ?? 'Sin acreditar'}`, `Objetivo: ${JSON.stringify(response.body.target)}`,
    `Actor: ${actorName}`]) expect(rendered).toContain(text);
  expect(durable.request_hash).toBe(operation.request_sha256);
  expect(Number(durable.version)).toBe(operation.version);
  if (durable.error) {
    expect(rendered).toContain(`Código: ${durable.error.code}`);
    expect(rendered).toContain(`Reintentable: ${durable.error.retryable ? 'sí' : 'no'}`);
    if (durable.error.step) expect(rendered).toContain(`Paso: ${durable.error.step}`);
  }
  const expected = operation.steps.map(step => ({ paso: step.name, estado: step.status, evidencia: step.evidence ?? null }));
  expect(JSON.parse(await region.locator('details pre').innerText()) as unknown).toEqual(expected);
  evidence.details = { operation_id: operation.id, durable, evidence_steps: expected };
  await coverageCapture(active(), 'o08-detalles-evidencias');
}
async function rejectAndRecoverRead(operation: CoverageOperation): Promise<void> {
  const { computer, page, errors } = active();
  await executor('stop');
  const lock = await computer.pool.connect();
  try {
    await lock.query('BEGIN');
    await lock.query('LOCK TABLE fleet_operations IN ACCESS EXCLUSIVE MODE');
    errors.expectHttpError(`/v3/console/fleet/operations/${operation.id}`, 500);
    await page.getByRole('button', { name: 'Releer operación', exact: true }).click();
    let pid: number | undefined;
    await expect.poll(async () => {
      pid = (await computer.pool.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%fleet_operations%'
          AND pid<>pg_backend_pid() ORDER BY query_start DESC LIMIT 1`)).rows[0]?.pid;
      return pid !== undefined;
    }, { timeout: 20_000 }).toBe(true);
    expect((await computer.pool.query<{ cancelled: boolean }>('SELECT pg_cancel_backend($1) AS cancelled', [pid])).rows[0]?.cancelled).toBe(true);
    await card().getByText('No pudimos confirmar la última lectura de esta operación. Pulsa «Releer operación» para actualizarla antes de seguir.', { exact: true }).waitFor({ timeout: 30_000 });
    for (const label of ['Reintentar', 'Cancelar']) expect(await card().getByRole('button', { name: label, exact: true }).isDisabled()).toBe(true);
    await coverageCapture(active(), 'o05-lectura-no-confirmada');
  } finally { await lock.query('ROLLBACK'); lock.release(); }
  await page.getByRole('button', { name: 'Releer operación', exact: true }).click();
  await coverageEnabled(card().getByRole('button', { name: 'Reintentar', exact: true }));
  expect((await receipt(operation.id, 'failed')).version).toBe(operation.version);
  await executor('start');
}

beforeAll(async () => {
  fixture = await startCoverageFixture('oh', { extraSourceFiles: ['packages/store/src/device-authorization.ts',
    'packages/store/src/device-authorization-authority.ts', 'services/gateway/src/device-authorization.ts',
    'packages/store/src/repository/fleet-operation-recovery.ts', 'ops/cli/fleet_executor_probe_cache.py',
    'ops/cli/fleet_provider_capability_probe.py'] });
  alias = `ops${fixture.run}`; runtime = `ops-${fixture.run}`; container = `${fixture.prefix}-${runtime}`;
}, 900_000);
afterAll(async () => {
  if (!fixture) return;
  try {
    if (paused) await docker(['unpause', container]);
    evidence.operations = await coverageOperations(fixture, alias).catch(() => []);
    evidence.journal = (await fixture.computer.onComputer(['journalctl', '--user', '-u', fixture.unit, '--no-pager', '-n', '100'])).stdout;
    evidence.browser = { unexpected: fixture.errors.unexpected, trace: fixture.errors.trace };
    await writeFile(join(fixture.receipts, 'o-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  } finally { await fixture.close(); }
}, 300_000);

describe('estados y controles de operaciones con Chromium, PostgreSQL y ejecutor Docker reales', () => {
  it('O01 O02 O03 O04 O05 O08 muestra cola, progreso, fallo, reintento, conflicto y compensación durables', async () => {
    const { page, computer, tenantId } = active();
    try {
      const create = await prepare();
      await executor('stop');
      const queued = await coverageEnqueue(active(), create, alias, 'create', ['queued']);
      await state(queued, 'En cola', 'o01-queued');
      expect(await docker(['ps', '-a', '--format', '{{.Names}}', '--filter', `name=^/${container}$`])).toBe('');
      await executor('start');
      const created = await receipt(queued.id, 'succeeded');
      await state(created, 'Terminada', 'o01-succeeded');
      expect(await processCount()).toBeGreaterThan(0);
      await inspectDetails(created);
      const panel = await openExecution();
      await panel.getByLabel('¿Qué quieres hacer?').selectOption('update');
      await panel.getByLabel('Nombre visible operativo').fill(`Operaciones ${active().run} reintentada`);
      await docker(['pause', container]); paused = true;
      const running = await coverageEnqueue(active(), panel, alias, 'update', ['running']);
      await state(running, 'En curso', 'o01-running');
      const failed = await receipt(running.id, 'failed');
      await state(failed, 'Falló', 'o01-failed');
      expect(failed.steps.find(step => step.name === 'stop')?.status).toBe('failed');
      const done = failed.steps.filter(step => ['succeeded', 'compensated'].includes(step.status)).length;
      expect(done).toBeGreaterThan(0); expect(done).toBeLessThan(failed.steps.length);
      const progress = card().getByRole('progressbar');
      expect(await progress.evaluate(element => element.getAttribute('aria-valuenow'))).toBe(String(Math.round(done / failed.steps.length * 100)));
      expect(await progress.evaluate(element => element.getAttribute('aria-label'))).toBe(`Progreso: ${String(done)} de ${String(failed.steps.length)} pasos`);
      await inspectDetails(failed);
      await docker(['unpause', container]); paused = false;
      await rejectAndRecoverRead(failed);
      const retry = card().getByRole('button', { name: 'Reintentar', exact: true });
      await coverageEnabled(retry); await retry.click();
      const resumed = await receipt(failed.id, 'succeeded');
      expect(resumed.version).toBeGreaterThan(failed.version);
      expect((await computer.pool.query('SELECT 1 FROM fleet_operation_events WHERE operation_id=$1 AND event=\'resumed\'', [failed.id])).rowCount).toBe(1);
      expect(await processCount()).toBeGreaterThan(0);
      await state(resumed, 'Terminada', 'o03-retry-succeeded');
      const current = await openExecution();
      await current.getByLabel('¿Qué quieres hacer?').selectOption('update');
      await current.getByLabel('Nombre visible operativo').fill(`Operaciones ${active().run} cancelada`);
      await docker(['pause', container]); paused = true;
      const abandoned = await coverageEnqueue(active(), current, alias, 'update', ['failed']);
      await docker(['unpause', container]); paused = false;
      await page.getByRole('tab', { name: 'Ajustes', exact: true }).click();
      const registry = page.getByRole('region', { name: `Registro de ${tenantId}/${alias}`, exact: true });
      await registry.getByLabel('Nombre visible', { exact: true }).fill(`Operaciones ${active().run} concurrente`);
      await registry.getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
      const apply = registry.getByRole('button', { name: 'Aplicar cambio', exact: true });
      await coverageEnabled(apply); await apply.click();
      await expect.poll(async () => (await computer.pool.query<{ display_name: string }>('SELECT display_name FROM agents WHERE tenant_id=$1 AND alias=$2', [tenantId, alias])).rows[0]?.display_name)
        .toBe(`Operaciones ${active().run} concurrente`);
      await page.getByRole('tab', { name: 'Ejecución', exact: true }).click();
      active().errors.expectHttpError(`/v3/console/fleet/operations/${abandoned.id}/resume`, 409);
      const staleRetry = card().getByRole('button', { name: 'Reintentar', exact: true });
      await coverageEnabled(staleRetry); await staleRetry.click();
      await card().getByText('La configuración cambió desde que se lanzó; cancélala y vuelve a lanzarla.', { exact: true }).waitFor({ timeout: 30_000 });
      expect(await staleRetry.isDisabled()).toBe(true);
      expect((await receipt(abandoned.id, 'failed')).version).toBe(abandoned.version);
      await coverageCapture(active(), 'o05-stale-disabled');
      await executor('stop');
      await card().getByRole('button', { name: 'Cancelar', exact: true }).click();
      const cancelling = await receipt(abandoned.id, 'cancelling');
      await state(cancelling, 'Cancelando', 'o04-cancelling');
      expect(await card().getByRole('button', { name: 'Cancelar', exact: true }).count()).toBe(0);
      await executor('start');
      const cancelled = await receipt(abandoned.id, 'cancelled');
      await state(cancelled, 'Cancelada', 'o04-cancelled');
      expect(await docker(['inspect', '--format', '{{.State.Running}}', container])).toBe('true');
      expect(await processCount()).toBeGreaterThan(0);
      active().errors.assertClean();
    } catch (error) {
      evidence.failure = error instanceof Error ? error.message : String(error);
      evidence.page = await bodySnippet(page);
      await coverageCapture(active(), 'o-failure');
      throw error;
    }
  }, 900_000);
});
