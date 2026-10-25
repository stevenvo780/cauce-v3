import { dirname } from 'node:path';
import { expect } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { cancelOperations, type CancelOperation } from './v4-fleet-cancel.helpers.js';
import { bodySnippet, type V4Locator } from './v4-console-real-browser.helpers.js';
import { cancelDeployCapture, cancelDeployPrefix, cancelDeployRun, type CancelDeployFixture } from './v4-fleet-cancel-deploy.helpers.js';
import { deployCancelRelease, replaceBoundBundle } from './v4-fleet-cancel-deploy.release.js';
import { materializeDisabledCancelDeploy, observeAdmittedCancelDeploy } from './v4-fleet-cancel-deploy.materialize.js';

export interface CancelDeployActor {
  fixture: CancelDeployFixture; alias: string; runtime: string; container: string;
}
export interface CancelDeployObservation {
  id: string; image: string; running: boolean; release: string; volumes: string[];
  bundleDigest: string | null; pid: number | null; starttime: number | null; adapterAlive: boolean; credentialGeneration: string | null; normalProcesses: number;
}
export async function waitCancelDeployEnabled(locator: V4Locator): Promise<void> {
  await expect.poll(() => locator.isDisabled(), { timeout: 30_000 }).toBe(false);
}

export async function waitCancelDeployOperation(actor: CancelDeployActor, kind: string, statuses: readonly string[],
  known: ReadonlySet<string> = new Set()): Promise<CancelOperation> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const current = (await cancelOperations(actor.fixture, actor.alias)).find(row => row.kind === kind && !known.has(row.id));
    if (current && statuses.includes(current.status)) return current;
    if (current?.status === 'failed') throw new Error(`fleet ${kind} failed: ${JSON.stringify(current)}`);
    if (current?.status === 'cancelling') {
      const journal = (await actor.fixture.computer.onComputer(['journalctl', '--user', '-u', actor.fixture.unit, '--no-pager', '-n', '40'])).stdout;
      if (journal.includes(`operation_id=${current.id}`) && journal.includes('step=compensate exit=')) {
        throw new Error(`fleet cancellation compensation failed: ${journal}`);
      }
    }
    await actor.fixture.page.waitForTimeout(1_000);
  }
  throw new Error(`${kind} never reached ${statuses.join(', ')}: ${await bodySnippet(actor.fixture.page)}`);
}

export async function enqueueCancelDeploy(actor: CancelDeployActor, panel: V4Locator, kind: string, statuses = ['succeeded']): Promise<CancelOperation> {
  const known = new Set((await cancelOperations(actor.fixture, actor.alias)).map(row => row.id));
  const preview = panel.getByRole('button', { name: 'Previsualizar operación', exact: true });
  await waitCancelDeployEnabled(preview); await preview.click();
  const confirm = panel.getByRole('button', { name: 'Confirmar operación', exact: true });
  await waitCancelDeployEnabled(confirm); await confirm.click();
  return waitCancelDeployOperation(actor, kind, statuses, known);
}

export async function openCancelDeployPanel(actor: CancelDeployActor): Promise<V4Locator> {
  const { page, baseUrl, tenantId } = actor.fixture;
  await page.goto(`${baseUrl}/config?seccion=agentes&agente=${encodeURIComponent(`${tenantId}/${actor.alias}`)}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Ejecución', exact: true }).click();
  return page.getByRole('region', { name: `Operación de ${tenantId}/${actor.alias}`, exact: true });
}

export async function createCancelDeployActor(fixture: CancelDeployFixture, suffix: string): Promise<{
  actor: CancelDeployActor; operation: CancelOperation; observed: CancelDeployObservation;
}> {
  const { page, baseUrl, tenantId, hostId, accountId, room } = fixture;
  const alias = `deploy${cancelDeployRun}${suffix}`, runtime = `deploy-${cancelDeployRun}${suffix}`;
  await page.goto(`${baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Añadir agente' });
  await dialog.getByText('Solo preparar, sin desplegar', { exact: true }).click();
  const create = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
  await create.getByLabel('Espacio de trabajo operativo').selectOption(tenantId);
  await create.getByLabel('Alias operativo').fill(alias);
  await create.getByLabel('Nombre visible operativo').fill(`Despliegue ${cancelDeployRun}${suffix}`);
  await create.getByLabel('Clave física de ejecución').fill(runtime);
  await create.getByRole('checkbox', { name: new RegExp(`· "${room}"$`, 'u') }).check();
  await create.getByLabel('Grupo primario').selectOption(room);
  await create.getByLabel('Host operativo').locator(`option[value="${hostId}"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await create.getByLabel('Host operativo').selectOption(hostId);
  await create.getByLabel('Plantilla de ejecución').selectOption('0');
  await create.getByLabel('Cuenta principal de ejecución').selectOption(accountId);
  const container = await create.getByLabel('Contenedor operativo').inputValue();
  expect(container).toBe(`${cancelDeployPrefix}-${runtime}`);
  const actor = { fixture, alias, runtime, container };
  const operation = await enqueueCancelDeploy(actor, create, 'create');
  return { actor, operation, observed: await observeCancelDeployActor(actor) };
}

export async function observeCancelDeployActor(actor: CancelDeployActor): Promise<CancelDeployObservation> {
  const inspected = JSON.parse(await docker(['inspect', '--format', '{{json .}}', actor.container])) as {
    Id: string; Image: string; State: { Running: boolean }; Mounts: { Type: string; Source: string; Destination: string; Name?: string }[];
  };
  const helper = inspected.Mounts.find(row => row.Destination === '/cauce/lifecycle');
  if (!helper?.Source.endsWith('/ops/container-runtime')) throw new Error('the agent has no verified release mount');
  const script = `import json,os,pathlib,sys
runtime=sys.argv[1];control=pathlib.Path('/run/cauce-fleet')/runtime/'cauce-v3-adapter.json'
metadata=json.loads(control.read_text()) if control.exists() else None
alive=False
if metadata:
 assert metadata['alias']==runtime
 try:
  raw=pathlib.Path('/proc',str(metadata['pid']),'stat').read_text().rsplit(')',1)[1].split()
  alive=raw[0]!='Z' and int(raw[19])==metadata['starttime']
 except FileNotFoundError:pass
normal=0
for entry in pathlib.Path('/proc').iterdir():
 if not entry.name.isdigit():continue
 try:
  stat=entry.joinpath('stat').read_text().rsplit(')',1)[1].split()
  values=dict(item.split(b'=',1) for item in entry.joinpath('environ').read_bytes().split(b'\\0') if b'=' in item)
  if stat[0]!='Z' and values.get(b'CAUCE_RUNTIME_KEY')==runtime.encode() and values.get(b'CAUCE_BOOTSTRAP')==b'0':normal+=1
 except (OSError,ValueError):pass
credential=pathlib.Path('/run/cauce-credentials')/runtime/'normal/inventory/desired-fleet.json'
print(json.dumps({'bundleDigest':metadata['bundleDigest'] if metadata else None,'pid':metadata['pid'] if metadata else None,
 'starttime':metadata['starttime'] if metadata else None,
 'adapterAlive':alive,'normalProcesses':normal,'credentialGeneration':json.loads(credential.read_text())['generation'] if credential.exists() else None}))
`;
  const raw = JSON.parse(await docker(['exec', '--user', '0', actor.container, 'python3', '-I', '-B', '-c', script, actor.runtime])) as
    Pick<CancelDeployObservation, 'bundleDigest' | 'pid' | 'starttime' | 'adapterAlive' | 'credentialGeneration' | 'normalProcesses'>;
  return { id: inspected.Id, image: inspected.Image, running: inspected.State.Running,
    release: dirname(dirname(helper.Source)), volumes: inspected.Mounts.filter(row => row.Type === 'volume').map(row => row.Name ?? '').sort(), ...raw };
}

export async function controlCancelDeployFromBrowser(actor: CancelDeployActor, failed: CancelOperation,
  action: 'cancel' | 'resume'): Promise<unknown> {
  const panel = await openCancelDeployPanel(actor);
  const reread = panel.getByRole('button', { name: 'Releer operación', exact: true });
  await waitCancelDeployEnabled(reread); await reread.click();
  const card = actor.fixture.page.getByRole('region', { name: 'Operación de flota', exact: true }).filter({ hasText: failed.id });
  await card.getByText('Detalles técnicos', { exact: true }).click();
  await card.getByText(`ID: ${failed.id} · Versión: ${String(failed.version)}`, { exact: true }).waitFor({ timeout: 30_000 });
  const path = `/v3/console/fleet/operations/${failed.id}/${action}`;
  const replies: { status: number; request: unknown; response: unknown }[] = [];
  actor.fixture.page.on('response', (raw: unknown) => {
    const response = raw as { url(): string; status(): number; json(): Promise<unknown>; request(): { postDataJSON(): unknown } };
    if (new URL(response.url()).pathname === path) {
      const request = response.request().postDataJSON();
      void response.json().then(body => replies.push({ status: response.status(), request, response: body }),
        () => replies.push({ status: response.status(), request, response: { error: 'non_json_response' } }));
    }
  });
  await card.getByRole('button', { name: action === 'cancel' ? 'Cancelar' : 'Reintentar', exact: true }).click();
  await expect.poll(() => replies.length, { timeout: 30_000 }).toBe(1);
  expect(replies[0]).toMatchObject({ status: 200, request: { expected_version: failed.version } });
  return replies[0];
}

export async function runCancelDeployScenario(fixture: CancelDeployFixture, scenario: 'same-path' | 'old-release',
  evidence: Record<string, unknown>, assertLive: (actor: CancelDeployActor, phase: string) => Promise<void>): Promise<void> {
  const suffix = scenario === 'same-path' ? 'p' : 'r';
  const created = await createCancelDeployActor(fixture, suffix);
  const { actor, observed: before } = created;
  evidence.created = created.operation; evidence.before = before;
  expect(before.adapterAlive).toBe(true); expect(before.credentialGeneration).not.toBeNull();
  await assertLive(actor, `${scenario}-initial`);
  const panel = await openCancelDeployPanel(actor);
  await panel.getByLabel('¿Qué quieres hacer?').selectOption('update');
  await panel.getByLabel('Nombre visible operativo').fill(`Despliegue ${scenario} pendiente`);
  await docker(['pause', actor.container]);
  let failed: CancelOperation;
  try { failed = await enqueueCancelDeploy(actor, panel, 'update', ['failed']); }
  finally { await docker(['unpause', actor.container]); }
  expect(failed.steps.find(step => step.name === 'stop')?.status).toBe('failed');
  evidence.failed = failed;
  await cancelDeployCapture(fixture.page, `${scenario}-failed-stop`);
  const deployment = await deployCancelRelease(fixture, fixture.setup, `${scenario}-bundle`, { image: before.image, newImage: false });
  evidence.deployment = deployment;
  expect(deployment.signer).toBe(fixture.setup.signerFingerprint);
  if (scenario === 'same-path') evidence.samePath = await replaceBoundBundle(fixture, deployment, before.release, actor.container);
  const afterDeployment = await observeCancelDeployActor(actor);
  evidence.afterDeployment = afterDeployment;
  expect(afterDeployment.id).toBe(before.id); expect(afterDeployment.image).toBe(before.image);
  expect(afterDeployment.bundleDigest).toBe(before.bundleDigest);
  expect(afterDeployment.bundleDigest).not.toBe(deployment.bundleDigest);
  evidence.materializedDisabled = await materializeDisabledCancelDeploy(fixture.computer, fixture.tenantId, actor.alias,
    actor.runtime, deployment.release);
  evidence.cancelHttp = await controlCancelDeployFromBrowser(actor, failed, 'cancel');
  const cancelled = await waitCancelDeployOperation(actor, 'update', ['cancelled']);
  expect(cancelled.id).toBe(failed.id);
  const restored = await observeCancelDeployActor(actor);
  evidence.cancelled = { operation: cancelled, observed: restored };
  expect(restored.running).toBe(true); expect(restored.image).toBe(before.image);
  expect(restored.volumes).toEqual(before.volumes);
  expect(restored.credentialGeneration).toBe(before.credentialGeneration);
  expect(restored.adapterAlive).toBe(false); expect(restored.normalProcesses).toBe(0);
  const disabled = (await fixture.computer.pool.query<{ enabled: boolean; lifecycle_state: string }>(
    'SELECT enabled,lifecycle_state FROM agents WHERE tenant_id=$1 AND alias=$2', [fixture.tenantId, actor.alias])).rows;
  evidence.disabledAfterCancel = disabled;
  expect(disabled).toEqual([{ enabled: false, lifecycle_state: 'failed' }]);
  await cancelDeployCapture(fixture.page, `${scenario}-cancelled`);
  const start = await openCancelDeployPanel(actor);
  await start.getByLabel('¿Qué quieres hacer?').selectOption('start');
  evidence.started = await enqueueCancelDeploy(actor, start, 'start');
  evidence.materializedAdmitted = await observeAdmittedCancelDeploy(fixture.computer, deployment.release, actor.runtime);
  await assertLive(actor, `${scenario}-started`);
  const image = await deployCancelRelease(fixture, fixture.setup, `${scenario}-image`, { image: restored.image, newImage: true, sourceStage: deployment.stage });
  evidence.imageDeployment = image;
  const update = await openCancelDeployPanel(actor);
  await update.getByLabel('¿Qué quieres hacer?').selectOption('update');
  await update.getByLabel('Nombre visible operativo').fill(`Despliegue ${scenario} actualizado`);
  const updated = await enqueueCancelDeploy(actor, update, 'update');
  const refreshed = await observeCancelDeployActor(actor);
  evidence.updated = { operation: updated, observed: refreshed };
  expect(refreshed.image).toBe(image.image); expect(refreshed.image).not.toBe(before.image);
  expect(refreshed.id).not.toBe(restored.id); expect(refreshed.volumes).toEqual(before.volumes);
  expect(refreshed.bundleDigest).toBe(image.bundleDigest); expect(refreshed.adapterAlive).toBe(true);
  await assertLive(actor, `${scenario}-updated`);
  await cancelDeployCapture(fixture.page, `${scenario}-updated`);
}
