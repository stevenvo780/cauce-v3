import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { apiGet, type V4Locator } from './v4-console-real-browser.helpers.js';
import { ptyFleetPrefix, ptyFleetReceipt, ptyFleetRun, type PtyFleetFixture } from './v4-pty-flota-dinamica.helpers.js';

export interface PtyFleetOperation {
  id: string; kind: string; status: string; version: number; error: unknown;
  steps: { name: string; status: string; evidence?: Record<string, unknown> }[];
}
interface PathObservation { uid: number; gid: number; mode: number; symlink: boolean }
export interface PtyFleetObservation {
  uid: number; gid: number; unit: string; active: { code: number; value: string }; enabled: { code: number; value: string };
  main_pid: number; process_alive: boolean; pki: PathObservation | null; env: PathObservation | null;
  dropin: PathObservation | null; wants: PathObservation | null; alias_unit: PathObservation | null;
  files: Record<string, PathObservation | null>; fingerprint: string | null; certificate_cn: string | null; certificate_runtime_key: string | null;
  sdk: { observation: 'running' | 'stopped' | 'absent'; container_id: string | null; normal_process_count: number;
    normal_processes: { pid: number; starttime: number }[]; metadata: { pid: number; starttime: number } | null;
    metadata_alive: boolean; metadata_matches: boolean };
  applied_generation: string | null; applied_contains_runtime: boolean;
}
export const ptyFleetAlias = 'pty' + ptyFleetRun;
export const ptyFleetRuntimeKey = 'pty-' + ptyFleetRun;

export async function ptyFleetOperations(fixture: PtyFleetFixture): Promise<PtyFleetOperation[]> {
  const result = await apiGet(fixture.page, '/v3/console/fleet/operations?resource=agent&tenant_id='
    + encodeURIComponent(fixture.tenantId) + '&alias=' + ptyFleetAlias);
  expect(result.status).toBe(200);
  return result.body.operations as PtyFleetOperation[];
}

async function enabled(locator: V4Locator): Promise<void> {
  await expect.poll(() => locator.isDisabled(), { timeout: 30_000 }).toBe(false);
}

export async function enqueuePtyFleet(fixture: PtyFleetFixture, panel: V4Locator, kind: string,
  expected: 'succeeded' | 'failed' = 'succeeded'): Promise<PtyFleetOperation> {
  const known = new Set((await ptyFleetOperations(fixture)).map(row => row.id));
  const preview = panel.getByRole('button', { name: 'Previsualizar operación', exact: true });
  await enabled(preview); await preview.click();
  const confirm = panel.getByRole('button', { name: 'Confirmar operación', exact: true });
  await enabled(confirm); await confirm.click();
  let result: PtyFleetOperation | undefined;
  await expect.poll(async () => {
    result = (await ptyFleetOperations(fixture)).find(row => row.kind === kind && !known.has(row.id));
    return ['succeeded', 'failed', 'cancelled', 'awaiting_auth'].includes(result?.status ?? '');
  }, { timeout: 180_000, interval: 300 }).toBe(true);
  if (!result) throw new Error('the terminal PTY operation has no durable identity');
  await ptyFleetReceipt('operation-' + kind + '-' + result.status, result);
  expect(result.status, 'the real fleet ' + kind + ' operation error: ' + JSON.stringify(result.error)).toBe(expected);
  if (expected === 'failed') {
    await fixture.page.getByRole('region', { name: 'Operación de flota', exact: true }).filter({ hasText: result.id })
      .getByText('Falló', { exact: true }).waitFor({ timeout: 30_000 });
  }
  if (expected === 'succeeded' && ['create', 'stop', 'start'].includes(kind)) {
    await fixture.page.getByRole('region', { name: 'Operación de flota', exact: true }).filter({ hasText: result.id })
      .getByText('Terminada', { exact: true }).waitFor({ timeout: 30_000 });
  }
  return result;
}

export async function openPtyFleetPanel(fixture: PtyFleetFixture): Promise<V4Locator> {
  await fixture.page.goto(fixture.baseUrl + '/config?seccion=agentes&agente='
    + encodeURIComponent(fixture.tenantId + '/' + ptyFleetAlias), { waitUntil: 'domcontentloaded' });
  await fixture.page.getByRole('tab', { name: 'Ejecución', exact: true }).click();
  return fixture.page.getByRole('region', { name: 'Operación de ' + fixture.tenantId + '/' + ptyFleetAlias, exact: true });
}

export async function createPtyFleetAgent(fixture: PtyFleetFixture, expected: 'succeeded' | 'failed' = 'succeeded'): Promise<PtyFleetOperation> {
  await fixture.page.goto(fixture.baseUrl + '/config?seccion=agentes', { waitUntil: 'domcontentloaded' });
  await fixture.page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
  const dialog = fixture.page.getByRole('dialog', { name: 'Añadir agente' });
  await dialog.getByText('Solo preparar, sin desplegar', { exact: true }).click();
  const create = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
  await create.getByLabel('Espacio de trabajo operativo').selectOption(fixture.tenantId);
  await create.getByLabel('Alias operativo').fill(ptyFleetAlias);
  await create.getByLabel('Nombre visible operativo').fill('PTY automático ' + ptyFleetRun);
  await create.getByLabel('Clave física de ejecución').fill(ptyFleetRuntimeKey);
  await create.getByRole('checkbox', { name: new RegExp('· "' + fixture.room + '"$', 'u') }).check();
  await create.getByLabel('Grupo primario').selectOption(fixture.room);
  await create.getByLabel('Host operativo').locator('option[value="' + fixture.hostId + '"]').waitFor({ state: 'attached', timeout: 30_000 });
  await create.getByLabel('Host operativo').selectOption(fixture.hostId);
  await create.getByLabel('Plantilla de ejecución').selectOption('0');
  await create.getByLabel('Cuenta principal de ejecución').selectOption(fixture.accountId);
  expect(await create.getByLabel('Contenedor operativo').inputValue()).toBe(ptyFleetPrefix + '-' + ptyFleetRuntimeKey);
  return enqueuePtyFleet(fixture, create, 'create', expected);
}

export async function retryPtyFleet(fixture: PtyFleetFixture, failed: PtyFleetOperation): Promise<PtyFleetOperation> {
  const identity = async () => (await fixture.computer.pool.query<Record<string, unknown>>(
    'SELECT id,kind,target,request_hash,company_id,executor_host,expected_revision FROM fleet_operations WHERE id=$1', [failed.id])).rows;
  const before = await identity();
  expect(before).toHaveLength(1);
  const panel = await openPtyFleetPanel(fixture), reread = panel.getByRole('button', { name: 'Releer operación', exact: true });
  await enabled(reread); await reread.click();
  const card = fixture.page.getByRole('region', { name: 'Operación de flota', exact: true }).filter({ hasText: failed.id });
  await card.getByText('Detalles técnicos', { exact: true }).click();
  await card.getByText('ID: ' + failed.id + ' · Versión: ' + String(failed.version), { exact: true }).waitFor({ timeout: 30_000 });
  const replies: { status: number; request: unknown; response: unknown }[] = [];
  fixture.page.on('response', (raw: unknown) => {
    const response = raw as { url(): string; status(): number; json(): Promise<unknown>; request(): { postDataJSON(): unknown } };
    if (new URL(response.url()).pathname === '/v3/console/fleet/operations/' + failed.id + '/resume') {
      void response.json().then(body => replies.push({ status: response.status(), request: response.request().postDataJSON(), response: body }),
        () => replies.push({ status: response.status(), request: response.request().postDataJSON(), response: null }));
    }
  });
  const clock = await fixture.computer.onComputer(['date', '+%s.%N']).catch(() => undefined);
  fixture.retryDiagnostic = { operation_id: failed.id,
    since: clock?.code === 0 && /^\d+\.\d+$/u.test(clock.stdout.trim()) ? '@' + clock.stdout.trim() : null };
  await ptyFleetReceipt('before-retry-clock', fixture.retryDiagnostic);
  await card.getByRole('button', { name: 'Reintentar', exact: true }).click();
  await expect.poll(() => replies.length, { timeout: 30_000 }).toBe(1);
  expect(replies[0]).toMatchObject({ status: 200, request: { expected_version: failed.version }, response: { id: failed.id, status: 'queued' } });
  let result: PtyFleetOperation | undefined;
  await expect.poll(async () => {
    result = (await ptyFleetOperations(fixture)).find(row => row.id === failed.id);
    return ['succeeded', 'failed', 'cancelled', 'awaiting_auth'].includes(result?.status ?? '');
  }, { timeout: 180_000, interval: 300 }).toBe(true);
  if (!result) throw new Error('the resumed PTY operation has no durable identity');
  await ptyFleetReceipt('retried-create', { http: replies[0], operation: result, identity: before });
  expect(result.status, 'the resumed PTY operation error: ' + JSON.stringify(result.error)).toBe('succeeded');
  expect(result.version).toBeGreaterThan(failed.version); expect(await identity()).toEqual(before);
  expect((await ptyFleetOperations(fixture)).filter(row => row.kind === 'create').map(row => row.id)).toEqual([failed.id]);
  await card.getByText('Terminada', { exact: true }).waitFor({ timeout: 30_000 });
  return result;
}

export async function observePtyFleet(fixture: PtyFleetFixture): Promise<PtyFleetObservation> {
  const code = await readFile(join(process.cwd(), 'tests/e2e/v4-pty-flota-dinamica.observe.py'), 'utf8');
  const result = await fixture.computer.onComputer(['python3', '-I', '-B', '-c', code, ptyFleetAlias,
    ptyFleetRuntimeKey, ptyFleetPrefix + '-' + ptyFleetRuntimeKey, fixture.runtimeState, fixture.retryDiagnostic?.operation_id ?? '']);
  if (result.code !== 0) throw new Error('owned PTY observation failed: ' + result.stderr);
  return JSON.parse(result.stdout) as PtyFleetObservation;
}

export async function assertPtyFleetOnline(fixture: PtyFleetFixture, phase: string): Promise<PtyFleetObservation> {
  await expect.poll(() => fixture.registry.state(fixture.tenantId, ptyFleetAlias), { timeout: 60_000 }).toBe('online');
  const observed = await observePtyFleet(fixture);
  expect(observed.active).toEqual({ code: 0, value: 'active' });
  expect(observed.enabled).toEqual({ code: 0, value: 'enabled' });
  expect(observed.process_alive).toBe(true); expect(observed.main_pid).toBeGreaterThan(0);
  expect(observed.sdk.observation).toBe('running'); expect(observed.sdk.normal_process_count).toBe(1);
  expect(observed.sdk.metadata_alive).toBe(true); expect(observed.sdk.metadata_matches).toBe(true); expect(observed.sdk.metadata).not.toBeNull();
  expect(observed.sdk.normal_processes).toEqual([observed.sdk.metadata]);
  expect(observed.applied_contains_runtime).toBe(true);
  for (const entry of [observed.pki, observed.env, ...Object.values(observed.files)]) {
    expect(entry).not.toBeNull();
    expect(entry?.uid).toBe(observed.uid); expect(entry?.gid).toBe(observed.gid);
    expect(entry?.symlink).toBe(false); expect((entry?.mode ?? 0) & 0o077).toBe(0);
  }
  expect(observed.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  expect(observed.certificate_cn).toBe('subject=CN=pty-' + ptyFleetRuntimeKey);
  expect(observed.certificate_runtime_key).toBe(ptyFleetRuntimeKey);
  const registry = JSON.parse(await readFile(fixture.registryFile, 'utf8')) as
    { agents: { tenant_id: string; alias: string; fingerprint_sha256: string; runtime_key?: string; company_id?: string }[] };
  const identities = registry.agents.filter(row => row.tenant_id === fixture.tenantId && row.alias === ptyFleetAlias);
  expect(identities).toHaveLength(1);
  expect(identities[0]?.fingerprint_sha256.toLowerCase()).toBe(observed.fingerprint);
  const ownerId = (await fixture.computer.pool.query<{ id: string }>('SELECT id FROM console_users WHERE email=$1', [fixture.owner.email])).rows[0]?.id;
  expect(ownerId).toBeTruthy();
  const grants = await apiGet(fixture.page, '/v3/console/terminal/grants');
  expect(grants.status).toBe(200);
  const rows = grants.body.items as { tenant_id: string; alias: string; grantee_human_id: string;
    granted_by_human_id: string; modes: string[]; expired: boolean }[];
  expect(rows.filter(row => row.tenant_id === fixture.tenantId && row.alias === ptyFleetAlias
    && row.grantee_human_id === ownerId && row.granted_by_human_id === ownerId && !row.expired && row.modes.includes('shell'))).toHaveLength(1);
  const agent = (await fixture.computer.pool.query<{ company_id: string; runtime_key: string; host_id: string; enabled: boolean; lifecycle_state: string }>(
    'SELECT company_id,runtime_key,host_id,enabled,lifecycle_state FROM agents WHERE tenant_id=$1 AND alias=$2', [fixture.tenantId, ptyFleetAlias])).rows[0];
  expect(agent).toMatchObject({ company_id: fixture.owner.company.slug, runtime_key: ptyFleetRuntimeKey,
    host_id: fixture.hostId, enabled: true, lifecycle_state: 'ready' });
  await ptyFleetReceipt(phase + '-pty', { observed, agent, identity: identities[0] });
  return observed;
}

export async function purgePtyFleet(fixture: PtyFleetFixture, fingerprint: string): Promise<void> {
  let panel = await openPtyFleetPanel(fixture);
  await panel.getByLabel('¿Qué quieres hacer?').selectOption('retire');
  await enqueuePtyFleet(fixture, panel, 'retire');
  await fixture.page.goto(fixture.baseUrl + '/config?seccion=agentes', { waitUntil: 'domcontentloaded' });
  const remove = fixture.page.getByRole('button', { name: 'Eliminar definitivamente ' + fixture.tenantId + '/' + ptyFleetAlias, exact: true });
  await remove.waitFor({ timeout: 30_000 }); await enabled(remove); await remove.click();
  panel = fixture.page.getByRole('region', { name: 'Operación de ' + fixture.tenantId + '/' + ptyFleetAlias, exact: true });
  await panel.getByLabel('Escribe el alias', { exact: false }).fill(ptyFleetAlias);
  await enqueuePtyFleet(fixture, panel, 'purge');
  const observed = await observePtyFleet(fixture);
  expect(observed.active.value).not.toBe('active'); expect(observed.enabled.value).not.toBe('enabled');
  expect(observed.process_alive).toBe(false);
  expect(observed.sdk.observation).toBe('absent'); expect(observed.sdk.normal_process_count).toBe(0);
  for (const path of [observed.pki, observed.env, observed.dropin, observed.wants, observed.alias_unit, ...Object.values(observed.files)]) expect(path).toBeNull();
  const registry = JSON.parse(await readFile(fixture.registryFile, 'utf8')) as
    { agents: { fingerprint_sha256: string; tenant_id: string; alias: string }[] };
  expect(registry.agents.some(row => row.fingerprint_sha256.toLowerCase() === fingerprint)).toBe(false);
  expect(registry.agents.some(row => row.tenant_id === fixture.tenantId && row.alias === ptyFleetAlias)).toBe(false);
  const targets = await apiGet(fixture.page, '/v3/console/terminal/targets');
  expect(targets.status).toBe(200);
  expect(targets.body.items as { tenant_id: string; alias: string }[]).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ tenant_id: fixture.tenantId, alias: ptyFleetAlias }),
  ]));
  await ptyFleetReceipt('purged-pty', { observed, issuer_identity_absent: true });
}
