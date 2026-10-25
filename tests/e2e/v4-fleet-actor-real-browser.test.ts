import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiGet, bodySnippet, type V4Locator } from './v4-console-real-browser.helpers.js';
import { cancelRun, type CancelFixture } from './v4-fleet-cancel.helpers.js';
import { startResumeFixture } from './v4-fleet-resume.helpers.js';

const evidenceDirectory = join(process.cwd(), '.delegados/v4/recibos/f4-flota-server2-1025/actor', cancelRun);
const alias = `actor${cancelRun}`;
const runtime = `actor-${cancelRun}`;
const personName = 'Persona V4 CANCEL';
let fixture: CancelFixture | undefined;
const evidence: Record<string, unknown> = {};
const active = () => { if (!fixture) throw new Error('actor fixture absent'); return fixture; };
interface ActorOperation { id: string; status: string; actor: { alias: string; actor_subject?: string; display_name?: string } }

async function capture(name: string, focus?: V4Locator): Promise<void> {
  const { page } = active();
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await focus?.evaluate(element => { element.scrollIntoView({ block: 'center' }); });
      await page.screenshot({ path: join(evidenceDirectory, `${name}-${String(viewport.width)}.png`) });
    }
  } finally { await page.setViewportSize({ width: 1440, height: 900 }); }
}
async function clickEnabled(locator: V4Locator): Promise<void> {
  await expect.poll(() => locator.isDisabled(), { timeout: 30_000 }).toBe(false);
  await locator.click();
}
async function operations(): Promise<ActorOperation[]> {
  const { page, tenantId } = active();
  const result = await apiGet(page, `/v3/console/fleet/operations?resource=agent&tenant_id=${encodeURIComponent(tenantId)}&alias=${alias}`);
  expect(result.status).toBe(200);
  return result.body.operations as ActorOperation[];
}

beforeAll(async () => {
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  fixture = await startResumeFixture();
}, 900_000);
afterAll(async () => {
  try {
    if (fixture) evidence.browserErrors = fixture.errors.unexpected;
    await writeFile(join(evidenceDirectory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  } finally { await fixture?.close(); }
}, 300_000);

describe('atribución humana de operaciones de flota', () => {
  it('muestra a la persona autora en la tarjeta, historial y detalle tras encolar desde Chromium', async () => {
    const { page, baseUrl, computer, tenantId, hostId, accountId, room } = active();
    try {
      await page.goto(`${baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Añadir agente' });
      await dialog.getByText('Solo preparar, sin desplegar', { exact: true }).click();
      const create = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
      await create.getByLabel('Espacio de trabajo operativo').selectOption(tenantId);
      await create.getByLabel('Alias operativo').fill(alias);
      await create.getByLabel('Nombre visible operativo').fill(`Atribución ${cancelRun}`);
      await create.getByLabel('Clave física de ejecución').fill(runtime);
      await create.getByRole('checkbox', { name: new RegExp(`· "${room}"$`, 'u') }).check();
      await create.getByLabel('Grupo primario').selectOption(room);
      await create.getByLabel('Host operativo').locator(`option[value="${hostId}"]`).waitFor({ state: 'attached', timeout: 30_000 });
      await create.getByLabel('Host operativo').selectOption(hostId);
      await create.getByLabel('Plantilla de ejecución').selectOption('0');
      await create.getByLabel('Cuenta principal de ejecución').selectOption(accountId);
      await clickEnabled(create.getByRole('button', { name: 'Previsualizar operación', exact: true }));
      await clickEnabled(create.getByRole('button', { name: 'Confirmar operación', exact: true }));
      let operation: ActorOperation | undefined;
      await expect.poll(async () => {
        operation = (await operations())[0];
        return operation?.status;
      }, { timeout: 180_000, interval: 1_000 }).toBe('succeeded');
      if (!operation) throw new Error('actor operation absent');
      const stored = (await computer.pool.query<{ same_person: boolean; display_name: string; alias: string }>(
        `SELECT event.metadata->>'actor_subject'='console:'||person.id::text AS same_person,
          person.display_name,operation.actor_alias AS alias
         FROM fleet_operations operation JOIN fleet_operation_events event ON event.operation_id=operation.id AND event.event='queued'
         JOIN console_users person ON person.tenant_id=operation.actor_tenant AND person.alias=operation.actor_alias
         WHERE operation.id=$1`, [operation.id])).rows[0];
      expect(stored).toMatchObject({ same_person: true, display_name: personName });
      evidence.author = stored;
      evidence.operation = operation;
      await capture('created');
      await page.goto(`${baseUrl}/config?seccion=agentes&agente=${encodeURIComponent(`${tenantId}/${alias}`)}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('tab', { name: 'Ejecución', exact: true }).click();
      await page.getByText('Historial de operaciones', { exact: true }).click();
      await page.getByText('Terminadas (1)', { exact: true }).click();
      await page.getByRole('button', { name: `Ver detalle de Preparar a ${alias}`, exact: true }).click();
      const card = page.getByRole('region', { name: 'Operación de flota', exact: true });
      await card.waitFor({ timeout: 30_000 });
      await card.evaluate(element => { element.scrollIntoView({ block: 'start' }); });
      evidence.cardText = await card.innerText();
      await capture('card', card.getByText(new RegExp(`por ${personName}`, 'u')));
      expect(await card.innerText()).toContain(`por ${personName}`);
      expect(await card.innerText()).not.toContain(`por ${operation.actor.alias} ·`);
      expect(operation.actor.display_name).toBe(personName);
      await card.getByText('Detalles técnicos', { exact: true }).click();
      expect(await card.innerText()).toContain(`Actor: ${personName}`);
      if (operation.actor.actor_subject) expect(await card.innerText()).not.toContain(operation.actor.actor_subject);
      await capture('detail', card.getByText(new RegExp(`Actor: ${personName}`, 'u')));
      await page.goto(`${baseUrl}/config?seccion=avanzado`, { waitUntil: 'domcontentloaded' });
      const recent = page.getByRole('region', { name: 'Operaciones de flota recientes', exact: true });
      await page.getByText('Terminadas (1)', { exact: true }).click();
      await expect.poll(() => recent.innerText(), { timeout: 30_000 }).toContain(`por ${personName}`);
      await capture('recent', recent.getByText(new RegExp(`por ${personName}`, 'u')));
      expect(active().errors.unexpected).toEqual([]);
    } catch (error) {
      evidence.failure = error instanceof Error ? error.message : String(error);
      evidence.page = await bodySnippet(page);
      await capture('failure');
      throw error;
    }
  }, 900_000);
});
