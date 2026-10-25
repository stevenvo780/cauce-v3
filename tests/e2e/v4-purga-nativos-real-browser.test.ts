import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerInventory } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { apiGet, bodySnippet, BrowserErrorLog, HERMETIC_INSTANCE_RULES, type V4Locator } from './v4-console-real-browser.helpers.js';
import {
  nativeCommand, nativeFixture, OWNER, RECEIPTS, seedNative,
  type NativeFixture, type NativeManifest, type NativeObservation,
} from './v4-purga-nativos-real-browser.fixtures.js';

interface Operation {
  id: string; kind: string; status: string; version: number; error: unknown;
  steps: { name: string; status: string; evidence?: { native_decommissioned?: boolean; removed?: { type: string; name: string }[] } }[];
}
const run = randomUUID().replaceAll('-', '').slice(0, 8);
const alias = `purga${run}`;
const key = `zz-canary-native-${run}`;
const foreignAlias = `ajeno${run}`;
const foreignKey = `zz-canary-foreign-${run}`;
const errors = new BrowserErrorLog(HERMETIC_INSTANCE_RULES);
const evidence: Record<string, unknown> = { run, owner: OWNER, receipts: RECEIPTS, environment: 'docker-lab user systemd' };
let fixture: NativeFixture | undefined;
let managed: NativeManifest | undefined;
let foreign: NativeManifest | undefined;
let retry: NativeManifest | undefined;
let chain: NativeManifest | undefined;
let foreignBefore: NativeObservation | undefined;
const retryAlias = `reintento${run}`;
const chainAlias = `cadena${run}`;

function active(): NativeFixture { if (!fixture) throw new Error('native fixture absent'); return fixture; }
function canary(): NativeManifest { if (!managed) throw new Error('native manifest absent'); return managed; }

async function enabled(control: V4Locator): Promise<void> {
  const deadline = Date.now() + 40_000;
  while (await control.isDisabled()) {
    if (Date.now() > deadline) throw new Error(`control stayed disabled: ${await bodySnippet(active().page)}`);
    await active().page.waitForTimeout(200);
  }
}

async function capture(name: string, focus?: V4Locator): Promise<void> {
  const { page } = active();
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    if (focus) await focus.evaluate(element => { element.scrollIntoView({ block: 'start' }); });
    await page.screenshot({ path: join(RECEIPTS, `${name}-${viewport.name}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function history(target: string): Promise<Operation[]> {
  const { page, tenant } = active();
  const response = await apiGet(page, `/v3/console/fleet/operations?resource=agent&tenant_id=${encodeURIComponent(tenant)}&alias=${target}`);
  expect(response.status).toBe(200);
  return response.body.operations as Operation[];
}

async function openPurge(target: string): Promise<V4Locator> {
  const { page, baseUrl, tenant } = active();
  await page.goto(`${baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
  const purge = page.getByRole('button', { name: `Eliminar definitivamente ${tenant}/${target}`, exact: true });
  await purge.waitFor({ timeout: 30_000 }); await enabled(purge); await purge.click();
  const panel = page.getByRole('region', { name: `Operación de ${tenant}/${target}`, exact: true });
  await panel.waitFor({ timeout: 30_000 });
  return panel;
}

async function submitOperation(panel: V4Locator, target: string, kind = 'purge'): Promise<Operation> {
  const known = new Set((await history(target)).map(operation => operation.id));
  const confirm = panel.getByRole('button', { name: 'Confirmar operación', exact: true });
  await enabled(confirm); await confirm.click();
  return finishOperation(target, operation => !known.has(operation.id) && operation.kind === kind);
}

async function finishOperation(target: string, matches: (operation: Operation) => boolean): Promise<Operation> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const result = (await history(target)).find(matches);
    if (result && ['succeeded', 'failed', 'cancelled'].includes(result.status)) return result;
    await active().page.waitForTimeout(500);
  }
  throw new Error(`purge did not finish: ${JSON.stringify(await history(target))}`);
}

beforeAll(async () => {
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('native purge requires real services');
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.DOCKER_HOST !== 'unix:///var/run/docker.sock') {
    throw new Error('Run native purge with scripts/e2e-lab.sh inside docker-lab');
  }
  await mkdir(RECEIPTS, { recursive: true });
  fixture = await nativeFixture(run); errors.watch(fixture.page, 'native-purge');
  managed = await seedNative(fixture, alias, key);
  foreign = await seedNative(fixture, foreignAlias, foreignKey, true);
  retry = await seedNative(fixture, retryAlias, `zz-canary-retry-${run}`);
  chain = await seedNative(fixture, chainAlias, `zz-canary-chain-${run}`, false, false);
  const restarted = await fixture.computer.onComputer(['systemctl', '--user', 'restart', `cauce-v3-host-executor-${fixture.company}-${fixture.host}.service`]);
  if (restarted.code !== 0) throw new Error(`executor restart failed: ${restarted.stderr}`);
  expect(managed).toMatchObject({ active: 'active', enabled: 'enabled' });
  expect(foreign).toMatchObject({ active: 'active', enabled: 'enabled' });
  evidence.managed_before = await nativeCommand<NativeObservation>(fixture, 'observe', JSON.stringify(managed));
  foreignBefore = await nativeCommand<NativeObservation>(fixture, 'observe', JSON.stringify(foreign));
  evidence.foreign_before = foreignBefore;
}, 900_000);

afterAll(async () => {
  try {
    if (fixture) {
      const prefix = fixture.computer.prefix;
      try {
        evidence.last_page = await bodySnippet(fixture.page);
        await capture('native-purge-last-page');
      } finally {
        await fixture.close();
        evidence.cleanup = await dockerInventory(prefix);
        expect(evidence.cleanup).toEqual({ containers: '', volumes: '', images: '' });
      }
    }
  } finally {
    await writeFile(join(RECEIPTS, 'native-systemd-evidence.json'), JSON.stringify(evidence, null, 2));
    console.info('NATIVE_PURGE_EVIDENCE', JSON.stringify(evidence));
  }
}, 300_000);

describe('purga de nativos administrados desde Chromium con systemd real', () => {
  it('previsualiza sin tocar archivos, confirma alias y elimina unidad, configuración y residuos', async () => {
    const current = active(); const manifest = canary();
    await current.page.setViewportSize({ width: 390, height: 844 });
    let panel = await openPurge(alias);
    let preview = panel.getByRole('button', { name: 'Previsualizar operación', exact: true });
    expect(await preview.isDisabled()).toBe(true);
    expect(await panel.getByRole('button', { name: 'Confirmar operación', exact: true }).isDisabled()).toBe(true);
    expect(await panel.getByRole('link', { name: 'Descargar copia', exact: true }).evaluate(element => element.getAttribute('href')))
      .toBe(`/messages/${encodeURIComponent(current.tenant)}/${alias}?view=context`);
    await capture('native-purge-alias-validation', panel.getByLabel('Escribe el alias'));
    await current.page.getByRole('dialog', { name: `Eliminar agente ${current.tenant}/${alias}`, exact: true })
      .getByRole('button', { name: 'Cerrar', exact: true }).first().click();
    expect(await history(alias)).toEqual([]);
    panel = await openPurge(alias);
    preview = panel.getByRole('button', { name: 'Previsualizar operación', exact: true });
    expect(await panel.getByLabel('Escribe el alias').inputValue()).toBe('');
    await panel.getByLabel('Escribe el alias').fill(`${alias}-incorrecto`);
    expect(await preview.isDisabled()).toBe(true);
    await panel.getByLabel('Escribe el alias').fill(alias);
    await enabled(preview); await preview.click();
    const plan = panel.getByRole('region', { name: 'Recursos físicos del plan', exact: true });
    await plan.waitFor({ timeout: 30_000 });
    expect(await plan.innerText()).toContain(manifest.state);
    expect(await plan.innerText()).toContain(manifest.unit);
    const beforeConfirm = await nativeCommand<NativeObservation>(current, 'observe', JSON.stringify(manifest));
    expect(beforeConfirm.properties.ActiveState).toBe('active');
    expect(Object.values(beforeConfirm.paths).every(Boolean)).toBe(true);
    evidence.preview_no_changes = beforeConfirm;
    await capture('native-purge-preview', plan);
    await panel.getByLabel('Escribe el alias').fill(`${alias}-cambio`);
    expect(await panel.getByRole('button', { name: 'Confirmar operación', exact: true }).isDisabled()).toBe(true);
    await panel.getByLabel('Escribe el alias').fill(alias);
    expect(await panel.getByRole('button', { name: 'Confirmar operación', exact: true }).isDisabled()).toBe(true);
    await enabled(preview); await preview.click();
    const operation = await submitOperation(panel, alias);
    evidence.operation = operation;
    expect(operation.status, JSON.stringify(operation)).toBe('succeeded');
    expect(operation.steps.every(step => step.status === 'succeeded')).toBe(true);
    const removal = operation.steps.find(step => step.name === 'purge')?.evidence;
    expect(removal?.native_decommissioned).toBe(true);
    const removed = removal?.removed ?? [];
    expect(removed).toContainEqual({ type: 'unit', name: manifest.unit });
    for (const filename of manifest.files) expect(removed).toContainEqual({ type: 'file', name: filename });
    for (const directory of [manifest.state, manifest.control, join(manifest.home, '.config/systemd/user', `${manifest.unit}.d`)]) {
      expect(removed).toContainEqual({ type: 'directory', name: directory });
    }
    expect(removed).toContainEqual({ type: 'file',
      name: join(manifest.home, '.config/systemd/user/default.target.wants', manifest.unit) });
    const after = await nativeCommand<NativeObservation>(current, 'observe', JSON.stringify(manifest));
    evidence.managed_after = after;
    expect(after.properties).toMatchObject({ LoadState: 'not-found', ActiveState: 'inactive', FragmentPath: '' });
    expect(Object.values(after.paths).every(value => !value)).toBe(true);
    expect(after.enabled_link).toBe(false);
    expect(after.adoption_policy_preserved).toBe(true);
    const result = current.page.getByRole('region', { name: 'Resultado de la purga', exact: true });
    await result.waitFor({ timeout: 30_000 });
    const list = result.getByRole('list', { name: 'Recursos físicos borrados', exact: true });
    expect(await list.innerText()).toContain(manifest.unit);
    for (const filename of manifest.files) expect(await list.innerText()).toContain(filename);
    expect(await result.innerText()).toContain('Desmantelamiento de la unidad nativa administrada comprobado.');
    await capture('native-purge-result', result);
    await panel.getByRole('button', { name: 'Releer operación', exact: true }).click();
    await result.waitFor({ timeout: 30_000 });
    await panel.getByText('Historial de operaciones', { exact: true }).click();
    await panel.getByText('Terminadas (1)', { exact: true }).click();
    await panel.getByRole('button', { name: `Ver detalle de Eliminar definitivamente a ${alias}`, exact: true }).click();
    expect(await result.innerText()).toContain(manifest.unit);
    await capture('native-purge-history', result);
    const durable = (await current.computer.pool.query<{ status: string }>('SELECT status FROM fleet_operations WHERE id=$1', [operation.id])).rows[0];
    expect(durable?.status).toBe('succeeded');
    await current.page.getByRole('dialog', { name: `Eliminar agente ${current.tenant}/${alias}`, exact: true })
      .getByRole('button', { name: 'Cerrar', exact: true }).first().click();
    await current.page.getByRole('dialog', { name: `Eliminar agente ${current.tenant}/${alias}`, exact: true }).waitFor({ state: 'hidden' });
    expect(await current.page.getByRole('dialog').count()).toBe(0);
    await current.page.getByRole('button', { name: `Eliminar definitivamente ${current.tenant}/${alias}`, exact: true }).waitFor({ state: 'hidden' });
    await capture('native-purge-inventory-after-close');
    errors.assertClean();
  }, 300_000);

  it('rechaza una unidad ajena y conserva su proceso, habilitación y archivos', async () => {
    if (!foreign) throw new Error('foreign canary absent');
    const panel = await openPurge(foreignAlias);
    await panel.getByLabel('Escribe el alias').fill(foreignAlias);
    const preview = panel.getByRole('button', { name: 'Previsualizar operación', exact: true });
    await enabled(preview); await preview.click();
    const operation = await submitOperation(panel, foreignAlias);
    expect(operation.status, JSON.stringify(operation)).toBe('failed');
    const after = await nativeCommand<NativeObservation>(active(), 'observe', JSON.stringify(foreign));
    expect(after.properties).toMatchObject({ LoadState: 'loaded', ActiveState: 'active', UnitFileState: 'enabled' });
    expect(Object.values(after.paths).every(Boolean)).toBe(true);
    expect(after.properties.MainPID).toBe(foreignBefore?.properties.MainPID);
    expect(after.file_hashes).toEqual(foreignBefore?.file_hashes);
    evidence.foreign_refused = { operation, after };
    const displayed = panel.getByRole('region', { name: 'Operación de flota', exact: true });
    await displayed.getByRole('alert').waitFor({ timeout: 30_000 });
    await capture('native-purge-foreign-refused', displayed);
    errors.assertClean();
  }, 300_000);

  it('rechaza archivos modificados y reintenta la misma operación tras restaurar la configuración aprobada', async () => {
    if (!retry) throw new Error('retry canary absent');
    const current = active();
    const panel = await openPurge(retryAlias);
    await panel.getByLabel('Escribe el alias').fill(retryAlias);
    const preview = panel.getByRole('button', { name: 'Previsualizar operación', exact: true });
    await enabled(preview); await preview.click();
    const before = await nativeCommand<NativeObservation>(current, 'observe', JSON.stringify(retry));
    evidence.drift_observation = await nativeCommand<NativeObservation>(current, 'drift', JSON.stringify(retry));
    const failed = await submitOperation(panel, retryAlias);
    expect(failed.status, JSON.stringify(failed)).toBe('failed');
    const refused = await nativeCommand<NativeObservation>(current, 'observe', JSON.stringify(retry));
    expect(refused.properties.ActiveState).toBe('active');
    expect(refused.properties.MainPID).toBe(before.properties.MainPID);
    expect(Object.values(refused.paths).every(Boolean)).toBe(true);
    await capture('native-purge-drift-refused', panel.getByRole('region', { name: 'Operación de flota', exact: true }));
    const restored = await nativeCommand<NativeObservation>(current, 'restore', JSON.stringify(retry));
    expect(restored.file_hashes).toEqual(before.file_hashes);
    const reattempt = panel.getByRole('button', { name: 'Reintentar', exact: true });
    await reattempt.waitFor({ timeout: 30_000 }); await enabled(reattempt); await reattempt.click();
    const succeeded = await finishOperation(retryAlias, operation => operation.id === failed.id && operation.version > failed.version);
    expect(succeeded.status, JSON.stringify(succeeded)).toBe('succeeded');
    const after = await nativeCommand<NativeObservation>(current, 'observe', JSON.stringify(retry));
    expect(after.properties.LoadState).toBe('not-found');
    expect(Object.values(after.paths).every(value => !value)).toBe(true);
    expect(after.enabled_link).toBe(false);
    evidence.retry = { failed, succeeded, before, refused, after };
    await current.page.getByRole('region', { name: 'Resultado de la purga', exact: true }).waitFor({ timeout: 30_000 });
    await capture('native-purge-retried', current.page.getByRole('region', { name: 'Resultado de la purga', exact: true }));
    errors.assertClean();
  }, 300_000);

  it('retira desde la web y reanuda una purga interrumpida conservando cada ruta borrada y el destino de un enlace ajeno', async () => {
    if (!chain) throw new Error('chain canary absent');
    const current = active();
    await current.page.goto(`${current.baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
    await current.page.getByRole('button', { name: `Abrir agente ${current.tenant}/${chainAlias}`, exact: true }).click();
    await current.page.getByRole('button', { name: `Eliminar agente ${current.tenant}/${chainAlias}`, exact: true }).click();
    let panel = current.page.getByRole('region', { name: `Operación de ${current.tenant}/${chainAlias}`, exact: true });
    let preview = panel.getByRole('button', { name: 'Previsualizar operación', exact: true });
    await enabled(preview); await preview.click();
    const retired = await submitOperation(panel, chainAlias, 'retire');
    expect(retired.status, JSON.stringify(retired)).toBe('succeeded');
    const stopped = await nativeCommand<NativeObservation>(current, 'observe', JSON.stringify(chain));
    expect(stopped.properties.ActiveState).toBe('inactive');
    expect(Object.values(stopped.paths).every(Boolean)).toBe(true);
    await capture('native-retired', panel);
    panel = await openPurge(chainAlias);
    await panel.getByLabel('Escribe el alias').fill(chainAlias);
    preview = panel.getByRole('button', { name: 'Previsualizar operación', exact: true });
    await enabled(preview); await preview.click();
    const obstruction = await nativeCommand<{ view: string; symlink: boolean; target_preserved: boolean }>(current, 'obstruct', JSON.stringify(chain));
    expect(obstruction.symlink).toBe(true);
    const failed = await submitOperation(panel, chainAlias);
    expect(failed.status, JSON.stringify(failed)).toBe('failed');
    expect(failed.steps.find(step => step.name === 'purge')?.status).toBe('failed');
    const partial = await nativeCommand<NativeObservation>(current, 'observe', JSON.stringify(chain));
    expect(Object.values(partial.paths).every(value => !value)).toBe(true);
    await panel.getByRole('region', { name: 'Resultado de la purga', exact: true }).waitFor({ timeout: 30_000 });
    await capture('native-purge-interrupted', panel.getByRole('region', { name: 'Resultado de la purga', exact: true }));
    const released = await nativeCommand<{ target_preserved: boolean }>(current, 'release', JSON.stringify(chain));
    expect(released.target_preserved).toBe(true);
    const reattempt = panel.getByRole('button', { name: 'Reintentar', exact: true });
    await reattempt.waitFor({ timeout: 30_000 }); await enabled(reattempt); await reattempt.click();
    const succeeded = await finishOperation(chainAlias, operation => operation.id === failed.id && operation.version > failed.version);
    expect(succeeded.status, JSON.stringify(succeeded)).toBe('succeeded');
    const removed = succeeded.steps.find(step => step.name === 'purge')?.evidence?.removed ?? [];
    for (const directory of [chain.state, chain.control, obstruction.view]) {
      expect(removed.filter(resource => resource.type === 'directory' && resource.name === directory)).toHaveLength(1);
    }
    evidence.interrupted = { retired, failed, succeeded, partial, obstruction, released };
    await current.page.getByRole('region', { name: 'Resultado de la purga', exact: true }).waitFor({ timeout: 30_000 });
    await capture('native-purge-resumed', current.page.getByRole('region', { name: 'Resultado de la purga', exact: true }));
    errors.assertClean();
  }, 300_000);
});
