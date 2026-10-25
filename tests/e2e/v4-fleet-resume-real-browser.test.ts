import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import type { BrowserContext, ConnectedBrowser } from './console-functional-browser.fixtures.js';
import { cancelOperations, cancelPrefix, cancelRun, type CancelOperation } from './v4-fleet-cancel.helpers.js';
import { asV4Page, bodySnippet, fillRegistration, openRegistration, syntheticPerson, type V4Locator } from './v4-console-real-browser.helpers.js';
import { hostCapability, resumeCapture, resumeReceipts, startResumeFixture, type ResumeFixture } from './v4-fleet-resume.helpers.js';

const alias = `resume${cancelRun}`;
const runtime = `resume-${cancelRun}`;
let fixture: ResumeFixture | undefined;
let container = '';
let paused = false;
const evidence: Record<string, unknown> = { run: cancelRun, static_hosts: ['server'], coordinator_hosts: ['server'] };
const active = () => { if (!fixture) throw new Error('resume fixture absent'); return fixture; };
async function waitEnabled(locator: V4Locator): Promise<void> {
  await expect.poll(() => locator.isDisabled(), { timeout: 30_000 }).toBe(false);
}
async function operation(kind: string, status: string): Promise<CancelOperation> {
  let row: CancelOperation | undefined;
  await expect.poll(async () => {
    row = (await cancelOperations(active(), alias)).find(candidate => candidate.kind === kind);
    return row?.status;
  }, { timeout: 180_000, interval: 1_000 }).toBe(status);
  if (!row) throw new Error('resume operation absent');
  return row;
}
async function enqueue(panel: V4Locator, kind: string, status = 'succeeded'): Promise<CancelOperation> {
  const preview = panel.getByRole('button', { name: 'Previsualizar operación', exact: true });
  await waitEnabled(preview); await preview.click();
  const confirm = panel.getByRole('button', { name: 'Confirmar operación', exact: true });
  await waitEnabled(confirm); await confirm.click();
  return operation(kind, status);
}
async function durable(id: string) {
  return (await active().computer.pool.query<{ id: string; status: string; executor_host: string; company_id: string; actor_subject: string; request: unknown }>(
    `SELECT operation.id,operation.status,operation.executor_host,operation.company_id,operation.request,
      origin.metadata->>'actor_subject' AS actor_subject,origin.metadata->>'acting_company' AS acting_company
      FROM fleet_operations operation JOIN LATERAL
        (SELECT metadata FROM fleet_operation_events WHERE operation_id=operation.id AND event='queued' ORDER BY id LIMIT 1) origin ON true
      WHERE operation.id=$1`, [id])).rows[0];
}
beforeAll(async () => { fixture = await startResumeFixture(); }, 900_000);
afterAll(async () => {
  if (paused) await docker(['unpause', container]);
  if (fixture) {
    evidence.journal = (await fixture.computer.onComputer(['journalctl', '--user', '--no-pager', '-n', '90'])).stdout;
    evidence.operations = await cancelOperations(fixture, alias).catch(() => []);
    evidence.browser_errors = fixture.errors.unexpected;
  }
  await writeFile(join(resumeReceipts, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  await fixture?.close();
}, 300_000);

describe('reintento con autoridad de un ordenador inscrito', () => {
  it('conserva empresa, sujeto, solicitud y host dinámico; rechaza capacidad caducada y empresa ajena', async () => {
    const current = active(); const { page, baseUrl, tenantId, hostId, accountId, room, computer } = current;
    try {
      evidence.initial_capability = await hostCapability(current);
      expect(evidence.initial_capability).toEqual(expect.arrayContaining(['server', hostId]));
      await page.goto(`${baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Añadir agente' });
      await dialog.getByText('Solo preparar, sin desplegar', { exact: true }).click();
      const create = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
      await create.getByLabel('Espacio de trabajo operativo').selectOption(tenantId);
      await create.getByLabel('Alias operativo').fill(alias);
      await create.getByLabel('Nombre visible operativo').fill(`Reintento ${cancelRun}`);
      await create.getByLabel('Clave física de ejecución').fill(runtime);
      await create.getByRole('checkbox', { name: new RegExp(`· "${room}"$`, 'u') }).check();
      await create.getByLabel('Grupo primario').selectOption(room);
      await create.getByLabel('Host operativo').locator(`option[value="${hostId}"]`).waitFor({ state: 'attached', timeout: 30_000 });
      await create.getByLabel('Host operativo').selectOption(hostId);
      await create.getByLabel('Plantilla de ejecución').selectOption('0');
      await create.getByLabel('Cuenta principal de ejecución').selectOption(accountId);
      container = await create.getByLabel('Contenedor operativo').inputValue();
      expect(container).toBe(`${cancelPrefix}-${runtime}`);
      evidence.created = await enqueue(create, 'create');
      await page.goto(`${baseUrl}/config?seccion=agentes&agente=${encodeURIComponent(`${tenantId}/${alias}`)}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('tab', { name: 'Ejecución', exact: true }).click();
      const panel = page.getByRole('region', { name: `Operación de ${tenantId}/${alias}`, exact: true });
      await panel.getByLabel('¿Qué quieres hacer?').selectOption('update');
      await panel.getByLabel('Nombre visible operativo').fill(`Reintento ${cancelRun} pendiente`);
      await docker(['pause', container]); paused = true;
      const failed = await enqueue(panel, 'update', 'failed');
      await docker(['unpause', container]); paused = false;
      expect(failed.steps.find(step => step.name === 'stop')?.status).toBe('failed');
      const failedRecord = await durable(failed.id);
      evidence.failed = failedRecord;
      expect(failedRecord).toMatchObject({ executor_host: hostId, status: 'failed' });
      expect(failedRecord?.actor_subject).toMatch(/^console:/u);
      expect((await computer.onComputer(['systemctl', '--user', 'stop', current.unit])).code).toBe(0);
      const browser = (page.context() as BrowserContext & { browser(): ConnectedBrowser | null }).browser();
      if (!browser) throw new Error('resume browser absent');
      const foreignContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
      try {
        const foreignPage = asV4Page(await foreignContext.newPage());
        current.errors.watch(foreignPage, 'resume-foreign-company');
        const form = await openRegistration(foreignPage, baseUrl);
        await fillRegistration(form, syntheticPerson('resume-foreign', cancelRun));
        await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
        await foreignPage.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
        current.errors.expectHttpError(`/v3/console/fleet/operations/${failed.id}/resume`, 404);
        const rejected = await foreignPage.evaluate(async ({ id, version }) => {
          const session = await (await fetch('/v3/auth/session', { credentials: 'include' })).json() as { csrf_token: string };
          const response = await fetch(`/v3/console/fleet/operations/${id}/resume`, { method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrf_token }, body: JSON.stringify({ expected_version: version }) });
          return { status: response.status, body: await response.json() as unknown };
        }, { id: failed.id, version: failed.version });
        expect(rejected.status).toBe(404); evidence.foreign_rejection = rejected;
        expect(await durable(failed.id)).toEqual(evidence.failed);
        await resumeCapture(foreignPage, 'foreign-rejected');
      } finally { await foreignContext.close(); }
      await computer.pool.query("UPDATE fleet_host_identities SET capabilities_seen_at=now()-interval '121 seconds' WHERE host_id=$1", [hostId]);
      evidence.stale_capability = await hostCapability(current);
      expect(evidence.stale_capability).toEqual(['server']);
      const path = `/v3/console/fleet/operations/${failed.id}/resume`;
      const responses: { status: number; body: unknown }[] = [];
      page.on('response', (raw: unknown) => {
        const response = raw as { url(): string; status(): number; json(): Promise<unknown> };
        if (new URL(response.url()).pathname === path) void response.json().then(body => responses.push({ status: response.status(), body }));
      });
      const card = page.getByRole('region', { name: 'Operación de flota', exact: true }).filter({ hasText: failed.id });
      const retry = card.getByRole('button', { name: 'Reintentar', exact: true });
      current.errors.expectHttpError(path, 403);
      await waitEnabled(retry); await retry.click();
      await expect.poll(() => responses.length, { timeout: 30_000 }).toBe(1);
      expect(responses[0]).toMatchObject({ status: 403, body: { message: 'placement is outside the configured host authority' } });
      evidence.stale_rejection = responses[0];
      expect(await durable(failed.id)).toEqual(evidence.failed);
      await resumeCapture(page, 'stale-rejected');
      expect((await computer.onComputer(['systemctl', '--user', 'start', current.unit])).code).toBe(0);
      await expect.poll(async () => (await hostCapability(current)).includes(hostId), { timeout: 90_000 }).toBe(true);
      expect((await computer.onComputer(['systemctl', '--user', 'stop', current.unit])).code).toBe(0);
      const reread = panel.getByRole('button', { name: 'Releer operación', exact: true });
      await waitEnabled(reread); await reread.click();
      await waitEnabled(retry); await retry.click();
      await expect.poll(() => responses.length, { timeout: 30_000 }).toBe(2);
      expect(responses[1]).toMatchObject({ status: 200, body: { id: failed.id, status: 'queued' } });
      const resumed = await durable(failed.id);
      expect(resumed).toEqual({ ...(evidence.failed as object), status: 'queued' });
      evidence.resumed = resumed;
      await resumeCapture(page, 'fresh-retried');
      current.errors.assertClean();
    } catch (error) {
      evidence.failure = error instanceof Error ? error.message : String(error);
      evidence.page = await bodySnippet(page);
      await resumeCapture(page, 'failure');
      throw error;
    }
  }, 900_000);
});
