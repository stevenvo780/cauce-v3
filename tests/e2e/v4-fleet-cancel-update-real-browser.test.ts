import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { bodySnippet, type V4Locator } from './v4-console-real-browser.helpers.js';
import { cancelCapture, cancelOperations, cancelPrefix, cancelReceipts, cancelRun, startCancelFixture,
  type CancelFixture, type CancelOperation } from './v4-fleet-cancel.helpers.js';

const alias = `cancel${cancelRun}`;
const runtime = `cancel-${cancelRun}`;
let fixture: CancelFixture | undefined;
let container = '';
let paused = false;
const evidence: Record<string, unknown> = { run: cancelRun };
const active = () => { if (!fixture) throw new Error('cancellation fixture absent'); return fixture; };

async function waitEnabled(locator: V4Locator): Promise<void> {
  await expect.poll(() => locator.isDisabled(), { timeout: 30_000 }).toBe(false);
}
async function operation(kind: string, statuses: string[], known = new Set<string>()): Promise<CancelOperation> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const current = (await cancelOperations(active(), alias)).find(row => row.kind === kind && !known.has(row.id));
    if (current && statuses.includes(current.status)) return current;
    if (current?.status === 'cancelling') {
      const journal = (await active().computer.onComputer(['journalctl', '--user', '--no-pager', '-n', '30'])).stdout;
      if (journal.includes(`operation_id=${current.id}`) && journal.includes('step=compensate exit=')) {
        throw new Error(`cancellation compensation failed: ${journal}`);
      }
    }
    await active().page.waitForTimeout(1_000);
  }
  throw new Error(`${kind} never reached ${statuses.join(', ')}: ${await bodySnippet(active().page)}`);
}
async function enqueue(panel: V4Locator, kind: string, statuses = ['succeeded']): Promise<CancelOperation> {
  const known = new Set((await cancelOperations(active(), alias)).map(row => row.id));
  const preview = panel.getByRole('button', { name: 'Previsualizar operación', exact: true });
  await waitEnabled(preview); await preview.click();
  const confirm = panel.getByRole('button', { name: 'Confirmar operación', exact: true });
  await waitEnabled(confirm); await confirm.click();
  return operation(kind, statuses, known);
}
async function probe(): Promise<{ running: boolean; processes: number; credentialGeneration: string | null }> {
  const running = await docker(['inspect', '--format', '{{.State.Running}}', container]) === 'true';
  const result = await docker(['exec', '--user', 'cauce', container, 'python3', '-c',
    'import json,os,pathlib;key=os.sys.argv[1];found=[]\n'
    + 'for pid in filter(str.isdigit,os.listdir("/proc")):\n'
    + ' try:\n  raw=pathlib.Path("/proc",pid,"environ").read_bytes().split(b"\\0");env=dict(x.split(b"=",1) for x in raw if b"=" in x)\n'
    + '  if env.get(b"CAUCE_RUNTIME_KEY")==key.encode():found.append(pid)\n except OSError:pass\n'
    + 'p=pathlib.Path("/run/cauce-credentials")/key/"normal"/"inventory"/"desired-fleet.json"\n'
    + 'print(json.dumps({"processes":len(found),"credentialGeneration":json.loads(p.read_text())["generation"] if p.exists() else None}))', runtime]);
  return { running, ...JSON.parse(result) as { processes: number; credentialGeneration: string | null } };
}
beforeAll(async () => { fixture = await startCancelFixture(); }, 900_000);
afterAll(async () => {
  if (paused) await docker(['unpause', container]);
  if (fixture) {
    evidence.journal = (await fixture.computer.onComputer(['journalctl', '--user', '--no-pager', '-n', '150'])).stdout;
    evidence.operations = await cancelOperations(fixture, alias).catch(() => []);
    evidence.browser = { trace: fixture.errors.trace, unexpected: fixture.errors.unexpected };
  }
  await writeFile(join(cancelReceipts, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  await fixture?.close();
}, 300_000);

describe('cancelación física de una actualización fallida', () => {
  it('conserva la autoridad anterior y recupera el adaptador tras Cancelar desde Chromium', async () => {
    const { page, baseUrl, tenantId, hostId, accountId, room } = active();
    try {
      await page.goto(`${baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Añadir agente' });
      await dialog.getByText('Solo preparar, sin desplegar', { exact: true }).click();
      const create = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
      await create.getByLabel('Espacio de trabajo operativo').selectOption(tenantId);
      await create.getByLabel('Alias operativo').fill(alias);
      await create.getByLabel('Nombre visible operativo').fill(`Cancelación ${cancelRun}`);
      await create.getByLabel('Clave física de ejecución').fill(runtime);
      await create.getByRole('checkbox', { name: new RegExp(`· "${room}"$`, 'u') }).check();
      await create.getByLabel('Grupo primario').selectOption(room);
      await create.getByLabel('Host operativo').locator(`option[value="${hostId}"]`).waitFor({ state: 'attached', timeout: 30_000 });
      await create.getByLabel('Host operativo').selectOption(hostId);
      await create.getByLabel('Plantilla de ejecución').selectOption('0');
      await create.getByLabel('Cuenta principal de ejecución').selectOption(accountId);
      container = await create.getByLabel('Contenedor operativo').inputValue();
      expect(container).toBe(`${cancelPrefix}-${runtime}`);
      const created = await enqueue(create, 'create');
      const before = await probe();
      expect(before.running).toBe(true); expect(before.processes).toBeGreaterThan(0);
      expect(before.credentialGeneration).not.toBeNull();
      evidence.before = { created: created.id, ...before };
      await cancelCapture(page, 'before-update');
      await page.goto(`${baseUrl}/config?seccion=agentes&agente=${encodeURIComponent(`${tenantId}/${alias}`)}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('tab', { name: 'Ejecución', exact: true }).click();
      const panel = page.getByRole('region', { name: `Operación de ${tenantId}/${alias}`, exact: true });
      await panel.getByLabel('¿Qué quieres hacer?').selectOption('update');
      await panel.getByLabel('Nombre visible operativo').fill(`Cancelación ${cancelRun} pendiente`);
      await docker(['pause', container]); paused = true;
      const failed = await enqueue(panel, 'update', ['failed']);
      await docker(['unpause', container]); paused = false;
      expect(failed.steps.find(step => step.name === 'stop')?.status).toBe('failed');
      evidence.failed = failed;
      await cancelCapture(page, 'failed-stop');
      const card = page.getByRole('region', { name: 'Operación de flota', exact: true }).filter({ hasText: failed.id });
      await card.getByRole('button', { name: 'Cancelar', exact: true }).click();
      const cancelled = await operation('update', ['cancelled']);
      expect(cancelled.id).toBe(failed.id);
      const after = await probe();
      evidence.cancelled = { operation: cancelled, observed: after };
      expect(after.running).toBe(true); expect(after.processes).toBeGreaterThan(0);
      expect(after.credentialGeneration).toBe(before.credentialGeneration);
      await cancelCapture(page, 'cancelled');
      active().errors.assertClean();
    } catch (error) {
      evidence.failure = error instanceof Error ? error.message : String(error);
      evidence.page = await bodySnippet(page);
      await cancelCapture(page, 'failure');
      throw error;
    }
  }, 900_000);
});
