import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { redactExecutorStderr } from '../../services/gateway/src/fleet/host-stderr.js';
import { apiGet, type V4Locator } from './v4-console-real-browser.helpers.js';
import { accreditedReceipt, type AccreditedFixture } from './v4-agentes-settings-accredited.fixture.js';

export interface SettingsOperation {
  id: string; kind: string; status: string; version: number; error: unknown;
  steps: { name: string; status: string; evidence?: { removed?: { type: string; name: string }[] } }[];
}
export async function clickAccredited(button: V4Locator): Promise<void> {
  await expect.poll(() => button.isDisabled(), { timeout: 30_000 }).toBe(false);
  await button.click();
}
export async function settingsRuntimeProcesses(fixture: AccreditedFixture, alias: string): Promise<{
  metadata: boolean; pids: number[]; markerSha256: string | null;
}> {
  const agent = (await fixture.computer.pool.query<{ runtime_key: string; container_name: string; state_directory: string }>(
    'SELECT runtime_key,container_name,state_directory FROM agents WHERE tenant_id=$1 AND alias=$2', [fixture.tenant, alias])).rows[0];
  if (!agent) throw new Error('Runtime process placement unavailable');
  const container = JSON.parse(await docker(['inspect', '--format', '{{json .}}', agent.container_name])) as {
    Id: string; State: { StartedAt: string };
  };
  const generation = createHash('sha256').update(`${container.Id}\0${container.State.StartedAt}`).digest('hex');
  const observation = JSON.parse(await docker(['exec', '--user', '0', agent.container_name, 'python3', '-I', '-B', '-c',
    `import hashlib,json,os,pathlib,sys
runtime,state,generation=sys.argv[1:];pids=[]
for process in pathlib.Path('/proc').iterdir():
 if not process.name.isdigit() or int(process.name) in (1,os.getpid()): continue
 try:
  values=dict(entry.split(b'=',1) for entry in (process/'environ').read_bytes().split(b'\\0') if b'=' in entry)
  if values.get(b'CAUCE_RUNTIME_KEY',values.get(b'CAUCE_ALIAS'))==runtime.encode() and values.get(b'CAUCE_STATE_DIR')==state.encode() and values.get(b'CAUCE_CONTAINER_GENERATION')==generation.encode(): pids.append(int(process.name))
 except (FileNotFoundError,ProcessLookupError,PermissionError): pass
marker=pathlib.Path(state)/'space/projects/a2x-marker.txt'
print(json.dumps({'metadata':(pathlib.Path('/run/cauce-fleet')/runtime/'cauce-v3-adapter.json').exists(),
 'pids':sorted(pids),'markerSha256':hashlib.sha256(marker.read_bytes()).hexdigest() if marker.exists() else None}))
`, agent.runtime_key, agent.state_directory, generation])) as { metadata: boolean; pids: number[]; markerSha256: string | null };
  await accreditedReceipt(fixture, `${alias}-runtime-${observation.metadata ? 'active' : 'stopped'}`, { containerId: container.Id, generation, ...observation });
  return observation;
}
export async function settingsOperations(fixture: AccreditedFixture, alias: string): Promise<SettingsOperation[]> {
  const response = await apiGet(fixture.page, `/v3/console/fleet/operations?resource=agent&tenant_id=${fixture.tenant}&alias=${alias}`);
  expect(response.status).toBe(200);
  return response.body.operations as SettingsOperation[];
}
export async function waitSettingsOperation(fixture: AccreditedFixture, alias: string, id: string,
  status = 'succeeded', previousVersion = -1): Promise<SettingsOperation> {
  let operation: SettingsOperation | undefined;
  await expect.poll(async () => {
    operation = (await settingsOperations(fixture, alias)).find(row => row.id === id);
    return operation && operation.version > previousVersion && ['succeeded', 'failed', 'cancelled', 'awaiting_auth'].includes(operation.status);
  }, { timeout: 240_000, interval: 1_000 }).toBe(true);
  if (!operation) throw new Error('Accredited operation unavailable');
  await accreditedReceipt(fixture, `operation-${operation.id}`, operation);
  if (operation.status !== status) {
    const operationId = operation.id;
    const journal = await fixture.computer.onComputer(['timeout', '20s', 'journalctl', '--user', '-u',
      `cauce-v3-host-executor-${fixture.person.company.slug}-${fixture.host}.service`, '--no-pager', '-o', 'cat', '-n', '1000']);
    const failures = journal.stdout.split('\n').filter(line => line.includes(`operation_id=${operationId}`)
      && line.includes('fleet host command failed')).map(line => redactExecutorStderr(line));
    await accreditedReceipt(fixture, `diagnostic-${operation.id}`, { id: operation.id, journalExit: journal.code, failures });
    console.info('ACCREDITED_SETTINGS_OPERATION_FAILED', JSON.stringify({ id: operation.id, failures }));
  }
  expect(operation.status, JSON.stringify(operation)).toBe(status);
  return operation;
}
export async function enqueueSettingsOperation(fixture: AccreditedFixture, alias: string, panel: V4Locator,
  kind: string, status = 'succeeded'): Promise<SettingsOperation> {
  const known = new Set((await settingsOperations(fixture, alias)).map(row => row.id));
  await clickAccredited(panel.getByRole('button', { name: 'Previsualizar operación', exact: true }));
  await clickAccredited(panel.getByRole('button', { name: 'Confirmar operación', exact: true }));
  let id: string | undefined;
  await expect.poll(async () => {
    id = (await settingsOperations(fixture, alias)).find(row => !known.has(row.id) && row.kind === kind)?.id;
    return id;
  }, { timeout: 30_000 }).toBeTruthy();
  if (!id) throw new Error('Accredited operation was not enqueued');
  return waitSettingsOperation(fixture, alias, id, status);
}
export async function openSettingsAgents(fixture: AccreditedFixture): Promise<void> {
  await fixture.page.goto(`${fixture.baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
  await fixture.page.getByRole('heading', { name: 'Tus agentes', exact: true }).waitFor({ timeout: 30_000 });
}
export async function settingsCreatePanel(fixture: AccreditedFixture, alias: string, runtime: string): Promise<V4Locator> {
  const { page, tenant, host, account, room } = fixture;
  await openSettingsAgents(fixture);
  await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Añadir agente', exact: true });
  await dialog.getByText('Solo preparar, sin desplegar', { exact: true }).click();
  const panel = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
  await panel.getByRole('combobox', { name: 'Espacio de trabajo operativo', exact: true }).selectOption(tenant);
  await panel.getByLabel('Alias operativo', { exact: true }).fill(alias);
  await panel.getByLabel('Nombre visible operativo', { exact: true }).fill(alias);
  await panel.getByLabel('Clave física de ejecución', { exact: true }).fill(runtime);
  await panel.getByRole('checkbox', { name: new RegExp(`· "${room}"$`, 'u') }).check();
  await panel.getByRole('combobox', { name: 'Grupo primario', exact: true }).selectOption(room);
  await panel.getByRole('combobox', { name: 'Host operativo', exact: true }).locator(`option[value="${host}"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await panel.getByRole('combobox', { name: 'Host operativo', exact: true }).selectOption(host);
  await panel.getByRole('combobox', { name: 'Plantilla de ejecución', exact: true }).selectOption('0');
  await panel.getByRole('combobox', { name: 'Cuenta principal de ejecución', exact: true }).selectOption(account);
  return panel;
}
export async function createSettingsAgent(fixture: AccreditedFixture, alias: string, runtime: string): Promise<string> {
  const panel = await settingsCreatePanel(fixture, alias, runtime);
  await enqueueSettingsOperation(fixture, alias, panel, 'create');
  const container = `${fixture.prefix}-${runtime}`;
  expect(await docker(['inspect', '--format', '{{.State.Running}}', container])).toBe('true');
  return container;
}
export async function retiredSettingsPanel(fixture: AccreditedFixture, alias: string): Promise<V4Locator> {
  await openSettingsAgents(fixture);
  await fixture.page.getByRole('button', { name: `Restaurar o revisar ${fixture.tenant}/${alias}`, exact: true }).click();
  const sheet = fixture.page.getByRole('dialog').first();
  await sheet.getByRole('note').filter({ hasText: 'su historial se conserva' }).waitFor();
  return sheet.getByRole('region', { name: `Operación de ${fixture.tenant}/${alias}`, exact: true });
}
export async function purgeSettingsDialog(fixture: AccreditedFixture, alias: string): Promise<V4Locator> {
  await retiredSettingsPanel(fixture, alias);
  await fixture.page.getByRole('dialog').first().getByRole('button', { name: `Eliminar agente ${fixture.tenant}/${alias}`, exact: true }).click();
  const dialog = fixture.page.getByRole('dialog', { name: `Eliminar agente ${fixture.tenant}/${alias}`, exact: true });
  await dialog.getByRole('textbox', { name: `Escribe el alias ${alias} para confirmar`, exact: true }).fill(alias);
  return dialog;
}
