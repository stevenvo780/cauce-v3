import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import type { FleetOperationPreview } from '@cauce/protocol';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { maintainConsoleUser } from '../../services/gateway/src/console-user-maintenance.js';
import { apiGet, asV4Page, login, syntheticPerson, type V4Locator } from './v4-console-real-browser.helpers.js';
import { prepareSpaceBackupForDownload, verifySpaceBackupDownload } from './v4-agentes-settings-accredited-download.js';
import { accreditedCapture, accreditedReceipt, startAccreditedFixture, type AccreditedFixture } from './v4-agentes-settings-accredited.fixture.js';
import { clickAccredited, createSettingsAgent, enqueueSettingsOperation, openSettingsAgents, purgeSettingsDialog,
  retiredSettingsPanel, settingsCreatePanel, settingsRuntimeProcesses, waitSettingsOperation, type SettingsOperation } from './v4-agentes-settings-accredited.operations.js';

interface PreviewResponse { url(): string; status(): number; request(): { method(): string }; json(): Promise<unknown> }

async function stored(fixture: AccreditedFixture, alias: string): Promise<Record<string, unknown> | undefined> {
  return (await fixture.computer.pool.query(`SELECT lifecycle_state,enabled,retired_at,purged_at,container_name,state_directory,
    primary_account_id FROM agents WHERE tenant_id=$1 AND alias=$2`, [fixture.tenant, alias])).rows[0] as Record<string, unknown> | undefined;
}
async function retire(fixture: AccreditedFixture, alias: string): Promise<SettingsOperation> {
  const { page, tenant } = fixture;
  await openSettingsAgents(fixture);
  await page.getByLabel('Buscar agente o grupo', { exact: true }).fill(alias);
  await page.getByRole('button', { name: `Acciones de ${tenant}/${alias}`, exact: true }).click();
  const menu = page.getByRole('menuitem', { name: 'Retirar agente', exact: true });
  await expect.poll(() => menu.evaluate(element => element.getAttribute('aria-disabled'))).not.toBe('true');
  await menu.click();
  const panel = page.getByRole('region', { name: `Operación de ${tenant}/${alias}`, exact: true });
  expect(await panel.getByRole('combobox', { name: '¿Qué quieres hacer?', exact: true }).inputValue()).toBe('retire');
  await accreditedCapture(fixture, 'T07-menu-retirar-permitido');
  const result = await enqueueSettingsOperation(fixture, alias, panel, 'retire');
  expect(await stored(fixture, alias)).toMatchObject({ lifecycle_state: 'retired', enabled: false });
  fixture.retiredContextTargets.add(alias);
  return result;
}
async function verifyUnsupportedNativeProbe(fixture: AccreditedFixture, alias: string): Promise<void> {
  const probe = fixture.computer.app.sondaDeDocumentos;
  expect(probe?.instalada).toBe(false);
  expect(await probe?.actual().factsFor(fixture.tenant, alias)).toBeUndefined();
  expect(typeof probe?.actual().nativeAdmin).toBe('undefined');
  const path = `/v3/console/tenants/${fixture.tenant}/agents/${alias}/native/skill`;
  fixture.errors.expectHttpError(path, 501);
  const response = await apiGet(fixture.page, path);
  expect(response.status).toBe(501);
  expect(response.body).toEqual({ error: 'unsupported', message: 'Este arnés no publica edición nativa para este tipo o esta cuenta.' });
  fixture.unsupportedNativeTargets.add(alias);
  await accreditedReceipt(fixture, 'native-capability', { alias, probeInstalled: false, factsAvailable: false, response });
}
async function readerRetireDenied(fixture: AccreditedFixture, alias: string): Promise<void> {
  const person = { ...syntheticPerson('a2xs-reader', fixture.run), email: `${fixture.prefix}-reader@example.invalid` };
  const readerAlias = `${fixture.prefix}-reader`;
  await fixture.computer.pool.query('INSERT INTO agents(tenant_id,alias,enabled,company_id) VALUES($1,$2,false,$3)',
    [fixture.tenant, readerAlias, fixture.person.company.slug]);
  await fixture.computer.pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'agent')",
    [fixture.tenant, fixture.room, readerAlias]);
  await maintainConsoleUser(fixture.computer.pool, { email: person.email, name: 'Lector acreditado', role: 'reader',
    tenant: fixture.tenant, alias: readerAlias, updateOnly: false, activate: true }, await hashPassword(person.password));
  const context = await fixture.trusted.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
  try {
    const page = asV4Page(await context.newPage());
    await login(page, fixture.baseUrl, person);
    await page.goto(`${fixture.baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Buscar agente o grupo', { exact: true }).fill(alias);
    await page.getByRole('button', { name: `Acciones de ${fixture.tenant}/${alias}`, exact: true }).click();
    const menu = page.getByRole('menuitem', { name: 'Retirar agente', exact: true });
    await expect.poll(() => menu.evaluate(element => element.getAttribute('aria-disabled'))).toBe('true');
    const reason = await menu.evaluate(element => element.title);
    expect(reason).toMatch(/permiso/iu);
    await accreditedCapture({ ...fixture, page }, 'T07-lector-sin-permiso');
    const before = await stored(fixture, alias);
    const denied = await page.evaluate(async target => {
      const session = await (await fetch('/v3/auth/session', { credentials: 'include' })).json() as { csrf_token: string };
      const response = await fetch('/v3/console/fleet/operations/preview', { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrf_token },
        body: JSON.stringify({ kind: 'retire', target, parameters: {}, expected_revision: 0, idempotency_key: 'reader-denied-settings' }) });
      return response.status;
    }, { resource: 'agent', tenant_id: fixture.tenant, alias });
    expect(denied).toBe(403);
    expect(await stored(fixture, alias)).toEqual(before);
    await accreditedReceipt(fixture, 'T07-reader', { alias, menuDisabled: true, reason, httpStatus: denied, unchanged: true });
  } finally { await context.close(); }
}
async function seedHistory(fixture: AccreditedFixture, alias: string): Promise<string> {
  await fixture.computer.pool.query(`INSERT INTO agent_profiles(tenant_id,alias,role_summary) VALUES($1,$2,'Perfil testigo de purga')
    ON CONFLICT(tenant_id,alias) DO UPDATE SET role_summary=EXCLUDED.role_summary`, [fixture.tenant, alias]);
  const message = (await fixture.computer.pool.query<{ id: string }>(`INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
    VALUES(gen_random_uuid(),$1,$2,$3,$4,'{"type":"text","text":"Historial testigo acreditado"}','interactive') RETURNING id`,
  [fixture.prefix, fixture.tenant, fixture.room, alias])).rows[0]?.id;
  if (!message) throw new Error('Accredited historical message unavailable');
  return message;
}
async function purgePreview(fixture: AccreditedFixture, alias: string, dialog: V4Locator, message: string): Promise<void> {
  const { computer, tenant } = fixture;
  await computer.pool.query(`INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,status) VALUES($1,$2,$3,'pending')`, [message, tenant, alias]);
  await clickAccredited(dialog.getByRole('button', { name: 'Previsualizar operación', exact: true }));
  await dialog.getByRole('region', { name: 'Qué bloquea la purga', exact: true })
    .getByText('Queda entregas (1). Resuelve esta dependencia y vuelve a previsualizar.', { exact: true }).waitFor();
  expect(await dialog.getByRole('button', { name: 'Confirmar operación', exact: true }).isDisabled()).toBe(true);
  expect((await computer.pool.query('SELECT status FROM deliveries WHERE message_id=$1 AND recipient_tenant=$2 AND recipient_alias=$3',
    [message, tenant, alias])).rows).toEqual([{ status: 'pending' }]);
  await accreditedCapture(fixture, 'R05-dependencia-entrega-activa', dialog.getByRole('region', { name: 'Qué bloquea la purga', exact: true }));
  await computer.pool.query("UPDATE deliveries SET status='done' WHERE message_id=$1 AND recipient_tenant=$2 AND recipient_alias=$3", [message, tenant, alias]);
  const responsePage = fixture.page as typeof fixture.page & {
    waitForResponse(predicate: (response: PreviewResponse) => boolean): Promise<PreviewResponse>;
  };
  const pending = responsePage.waitForResponse(response => new URL(response.url()).pathname === '/v3/console/fleet/operations/preview'
    && response.request().method() === 'POST' && response.status() === 200);
  await clickAccredited(dialog.getByRole('button', { name: 'Previsualizar operación', exact: true }));
  const planned = await (await pending).json() as FleetOperationPreview;
  const preview = dialog.getByRole('region', { name: 'Previsualización operativa', exact: true });
  const agentContainer = String((await stored(fixture, alias))?.container_name);
  const resources = [agentContainer, `${agentContainer}-state`, `${agentContainer}-provider-profiles`];
  await preview.getByText(`Se borrará: contenedor ${resources[0] ?? ''}, volumen ${resources[1] ?? ''}, volumen ${resources[2] ?? ''}.`, { exact: true }).waitFor();
  await preview.getByText(/Se borra:.*perfil/iu).waitFor();
  await preview.getByText(/Se conserva como historial:.*mensajes/iu).waitFor();
  const keptText = await preview.getByText(/^Se conserva como historial:/u).innerText();
  for (const label of ['mensajes (1)', 'entregas (1)', 'membresías en grupos (1)', 'historial del equipo (1)']) expect(keptText).toContain(label);
  for (const table of ['messages', 'deliveries', 'memberships', 'fleet_runtime_identities']) {
    expect(planned.dependencies.find(entry => entry.type === `purge.preserve.${table}`))
      .toMatchObject({ blocking: false, identity: { kind: '1 rows' } });
  }
  await preview.getByRole('note').filter({ hasText: 'su alias seguirá reservado' }).waitFor();
  await accreditedReceipt(fixture, 'R05-preview', { planned, keptText });
  await accreditedCapture(fixture, 'R05-plan-recursos-historial-reserva', preview);
  await clickAccredited(dialog.getByRole('button', { name: 'Confirmar operación', exact: true }));
}
async function assertAliasReserved(fixture: AccreditedFixture, alias: string): Promise<void> {
  const identities = await fixture.computer.pool.query('SELECT runtime_key FROM fleet_runtime_identities WHERE tenant_id=$1 AND alias=$2', [fixture.tenant, alias]);
  expect(identities.rowCount).toBe(1);
  const before = await stored(fixture, alias);
  const panel = await settingsCreatePanel(fixture, alias, `reuse-${fixture.run}`);
  fixture.errors.expectHttpError('/v3/console/fleet/operations/preview', 409);
  await clickAccredited(panel.getByRole('button', { name: 'Previsualizar operación', exact: true }));
  await panel.getByRole('alert').filter({ hasText: 'purged agent identity is permanent' }).waitFor();
  expect(await panel.getByRole('button', { name: 'Confirmar operación', exact: true }).isDisabled()).toBe(true);
  expect(await stored(fixture, alias)).toEqual(before);
  await accreditedCapture(fixture, 'R05-alias-reservado-recreacion-denegada');
  await accreditedReceipt(fixture, 'R05-alias-reserved', { alias, identities: identities.rows, recreateDenied: true });
}
async function failedResourcesPurge(fixture: AccreditedFixture): Promise<void> {
  const alias = `${fixture.prefix}-fail`, container = await createSettingsAgent(fixture, alias, `fail-${fixture.run}`);
  await retire(fixture, alias);
  const holder = `${fixture.prefix}-hold-volume`, stateVolume = `${container}-state`;
  await docker(['create', '--name', holder, '--label', 'cauce.e2e.owner=a2x-filas-ejecutor-acreditado-1025',
    '--mount', `type=volume,src=${stateVolume},dst=/owned-state,readonly`, fixture.computer.agentImage, '/bin/true']);
  try {
    const dialog = await purgeSettingsDialog(fixture, alias);
    const failed = await enqueueSettingsOperation(fixture, alias, dialog, 'purge', 'failed');
    await dialog.getByRole('region', { name: 'Resultado de la purga', exact: true })
      .getByText('La eliminación física falló: no se comprobó qué se borró.', { exact: true }).waitFor();
    expect(await docker(['volume', 'ls', '--filter', `name=^${stateVolume}$`, '--format', '{{.Name}}'])).toBe(stateVolume);
    expect((await stored(fixture, alias))?.purged_at).toBeNull();
    await accreditedCapture(fixture, 'R06-fallo-purga-volumen-en-uso', dialog.getByRole('region', { name: 'Resultado de la purga', exact: true }));
    await docker(['rm', holder]);
    await clickAccredited(dialog.getByRole('button', { name: 'Reintentar', exact: true }));
    const succeeded = await waitSettingsOperation(fixture, alias, failed.id, 'succeeded', failed.version);
    expect(succeeded.version).toBeGreaterThan(failed.version);
    expect(succeeded.steps.find(row => row.name === 'purge')?.evidence?.removed)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'volume', name: stateVolume })]));
    await accreditedReceipt(fixture, 'R06-failed-retried', { alias, container, failed, succeeded });
  } finally {
    if ((await docker(['ps', '-a', '--filter', `name=^/${holder}$`, '--format', '{{.Names}}'])) === holder) await docker(['rm', '-f', holder]);
  }
}
async function noResourcesPurge(fixture: AccreditedFixture): Promise<void> {
  const alias = `${fixture.prefix}-empty`, runtime = `empty-${fixture.run}`;
  const container = await createSettingsAgent(fixture, alias, runtime);
  await retire(fixture, alias);
  const mounts = JSON.parse(await docker(['inspect', '--format', '{{json .Mounts}}', container])) as { Type: string; Name?: string }[];
  await docker(['rm', '-f', container]);
  const volumes = mounts.filter(row => row.Type === 'volume').map(row => row.Name).filter((name): name is string => !!name);
  for (const volume of volumes) {
    if (!volume.startsWith(fixture.prefix)) throw new Error('Empty purge volume escapes ownership');
    await docker(['volume', 'rm', volume]);
  }
  const dialog = await purgeSettingsDialog(fixture, alias);
  const operation = await enqueueSettingsOperation(fixture, alias, dialog, 'purge');
  expect(operation.steps.find(row => row.name === 'purge')?.evidence?.removed).toEqual([]);
  await dialog.getByRole('region', { name: 'Resultado de la purga', exact: true }).getByText(/No borró contenedores ni volúmenes/u).waitFor();
  await accreditedCapture(fixture, 'R06-sin-recursos-borrados', dialog.getByRole('region', { name: 'Resultado de la purga', exact: true }));
  expect(await docker(['ps', '-a', '--filter', `name=^/${container}$`, '--format', '{{.Names}}'])).toBe('');
  const durable = await stored(fixture, alias);
  if (durable) expect(durable).toMatchObject({ enabled: false, lifecycle_state: 'retired', container_name: null });
  await accreditedReceipt(fixture, 'R06-empty', { alias, container, volumes, operation, durable: durable ?? null });
}

export async function verifyAccreditedSettingsLifecycle(): Promise<void> {
  const fixture = await startAccreditedFixture();
  const { computer, page, tenant, prefix, run } = fixture;
  const alias = `${prefix}-main`, runtime = `main-${run}`;
  const evidence: Record<string, unknown> = {};
  try {
    const container = await createSettingsAgent(fixture, alias, runtime);
    await readerRetireDenied(fixture, alias);
    await verifyUnsupportedNativeProbe(fixture, alias);
    const marker = Buffer.from(`Contenido recuperable ${run}\n`);
    const stateDirectory = String((await stored(fixture, alias))?.state_directory);
    await docker(['exec', '--user', 'cauce', container, 'python3', '-I', '-B', '-c',
      'import pathlib,sys; p=pathlib.Path(sys.argv[1])/"space/projects/a2x-marker.txt"; p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(bytes.fromhex(sys.argv[2])); p.chmod(0o600)',
      stateDirectory, marker.toString('hex')]);
    const message = await seedHistory(fixture, alias);
    evidence.preRetirementBackup = await prepareSpaceBackupForDownload({ page, tenant, alias,
      companyId: fixture.person.company.slug, evidenceDirectory: fixture.evidence });
    evidence.retire = await retire(fixture, alias);
    const stopped = await settingsRuntimeProcesses(fixture, alias);
    expect(stopped).toEqual({ metadata: false, pids: [], markerSha256: createHash('sha256').update(marker).digest('hex') });
    const panel = await retiredSettingsPanel(fixture, alias);
    await panel.getByRole('combobox', { name: '¿Qué quieres hacer?', exact: true }).selectOption('restore');
    evidence.restore = await enqueueSettingsOperation(fixture, alias, panel, 'restore');
    expect(await stored(fixture, alias)).toMatchObject({ enabled: true, retired_at: null });
    fixture.retiredContextTargets.delete(alias);
    expect(await docker(['inspect', '--format', '{{.State.Running}}', container])).toBe('true');
    const restored = await settingsRuntimeProcesses(fixture, alias);
    expect(restored.metadata).toBe(true); expect(restored.pids.length).toBeGreaterThan(0);
    expect(restored.markerSha256).toBe(stopped.markerSha256);
    expect((await computer.pool.query('SELECT id FROM messages WHERE id=$1 AND tenant_id=$2', [message, tenant])).rowCount).toBe(1);
    await accreditedCapture(fixture, 'F07-restaurado-historial-conservado');
    evidence.secondRetire = await retire(fixture, alias);
    let dialog = await purgeSettingsDialog(fixture, alias);
    evidence.download = await verifySpaceBackupDownload({ page, tenant, alias, companyId: fixture.person.company.slug, runtimeKey: runtime,
      browserContainerId: fixture.trusted.containerId, evidenceDirectory: fixture.evidence, storageDirectory: fixture.storage,
      expectedFile: { path: 'projects/a2x-marker.txt', bytes: marker.length, sha256: createHash('sha256').update(marker).digest('hex') } });
    expect((evidence.download as { backup: { id: string } }).backup.id).toBe(evidence.preRetirementBackup);
    dialog = await purgeSettingsDialog(fixture, alias);
    const stateVolume = `${container}-state`;
    const providerVolume = `${container}-provider-profiles`;
    const previous = (await settingsOperationIds(fixture, alias));
    await purgePreview(fixture, alias, dialog, message);
    let failureId: string | undefined;
    await expect.poll(async () => {
      const operations = (await apiGet(page, `/v3/console/fleet/operations?resource=agent&tenant_id=${tenant}&alias=${alias}`)).body.operations as SettingsOperation[];
      failureId = operations.find(row => row.kind === 'purge' && !previous.has(row.id))?.id;
      return failureId;
    }).toBeTruthy();
    if (!failureId) throw new Error('Failed physical purge unavailable');
    const success = await waitSettingsOperation(fixture, alias, failureId);
    evidence.succeededPurge = success;
    const removed = success.steps.find(row => row.name === 'purge')?.evidence?.removed ?? [];
    expect(removed).toEqual([{ type: 'container', name: container }, { type: 'volume', name: stateVolume }, { type: 'volume', name: providerVolume }]);
    const removedList = dialog.getByRole('region', { name: 'Resultado de la purga', exact: true }).getByRole('list', { name: 'Recursos físicos borrados', exact: true });
    await removedList.waitFor({ timeout: 30_000 });
    expect(await removedList.getByRole('listitem').count()).toBe(3);
    for (const resource of removed) await removedList.getByText(resource.name, { exact: true }).waitFor();
    expect(await docker(['ps', '-a', '--filter', `name=^/${container}$`, '--format', '{{.Names}}'])).toBe('');
    expect(await docker(['volume', 'ls', '--filter', `name=^${stateVolume}$`, '--format', '{{.Name}}'])).toBe('');
    expect(await docker(['volume', 'ls', '--filter', `name=^${providerVolume}$`, '--format', '{{.Name}}'])).toBe('');
    expect(await stored(fixture, alias)).toMatchObject({ lifecycle_state: 'retired', enabled: false, container_name: null });
    expect((await stored(fixture, alias))?.purged_at).toBeInstanceOf(Date);
    expect((await computer.pool.query('SELECT 1 FROM agent_profiles WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rowCount).toBe(0);
    expect((await computer.pool.query('SELECT id FROM messages WHERE id=$1 AND tenant_id=$2', [message, tenant])).rowCount).toBe(1);
    expect((await computer.pool.query('SELECT status FROM deliveries WHERE message_id=$1 AND recipient_tenant=$2 AND recipient_alias=$3', [message, tenant, alias])).rows).toEqual([{ status: 'done' }]);
    const historicalMembership = (await computer.pool.query<{ enabled: boolean; retired_at: Date | null }>(
      'SELECT enabled,retired_at FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias=$3', [tenant, fixture.room, alias])).rows[0];
    expect(historicalMembership?.enabled).toBe(false);
    expect(historicalMembership?.retired_at).toBeInstanceOf(Date);
    await accreditedCapture(fixture, 'R05-R06-purga-completada-historial', removedList);
    await assertAliasReserved(fixture, alias);
    await failedResourcesPurge(fixture);
    await noResourcesPurge(fixture);
    fixture.errors.assertClean();
    evidence.covered = ['T07', 'F07', 'R04', 'R05', 'R06'];
    console.info('ACCREDITED_SETTINGS_COVERED', JSON.stringify(evidence.covered));
  } catch (error) {
    evidence.failure = error instanceof Error ? error.stack : String(error);
    evidence.page = await page.locator('body').innerText().catch(() => 'unavailable');
    await accreditedCapture(fixture, 'failure').catch(() => undefined);
    throw error;
  } finally {
    evidence.browserErrors = fixture.errors.unexpected;
    evidence.ignoredConsoleRules = Object.fromEntries(fixture.errors.ignored);
    try { await accreditedReceipt(fixture, 'effects', evidence); }
    finally { await fixture.close(); }
  }
}

async function settingsOperationIds(fixture: AccreditedFixture, alias: string): Promise<Set<string>> {
  const response = await apiGet(fixture.page, `/v3/console/fleet/operations?resource=agent&tenant_id=${fixture.tenant}&alias=${alias}`);
  return new Set((response.body.operations as SettingsOperation[]).map(row => row.id));
}
