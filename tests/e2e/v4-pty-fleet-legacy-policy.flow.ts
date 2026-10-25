import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect } from 'vitest';
import { HarnessConsumptionEvidenceSchema } from '@cauce/protocol';
import { apiGet, type V4Locator } from './v4-console-real-browser.helpers.js';
import type { PtyFleetObservation, PtyFleetOperation } from './v4-pty-flota-dinamica.flow.js';
import { legacyPtyAlias, legacyPtyCapture, legacyPtyKey, legacyPtyPrefix, legacyPtyReceipt, type LegacyPtyFixture } from './v4-pty-fleet-legacy-policy.helpers.js';

export async function legacyPtyOperations(fixture: LegacyPtyFixture): Promise<PtyFleetOperation[]> {
  const response = await apiGet(fixture.page, '/v3/console/fleet/operations?resource=agent&tenant_id='
    + encodeURIComponent(fixture.tenantId) + '&alias=' + legacyPtyAlias);
  expect(response.status).toBe(200);
  return response.body.operations as PtyFleetOperation[];
}

async function enqueue(fixture: LegacyPtyFixture, panel: V4Locator, kind: string): Promise<PtyFleetOperation> {
  const known = new Set((await legacyPtyOperations(fixture)).map(row => row.id));
  for (const name of ['Previsualizar operación', 'Confirmar operación']) {
    const button = panel.getByRole('button', { name, exact: true });
    await expect.poll(() => button.isDisabled(), { timeout: 30_000 }).toBe(false);
    await button.click();
  }
  let operation: PtyFleetOperation | undefined;
  await expect.poll(async () => {
    operation = (await legacyPtyOperations(fixture)).find(row => row.kind === kind && !known.has(row.id));
    return ['succeeded', 'failed', 'cancelled', 'awaiting_auth'].includes(operation?.status ?? '');
  }, { timeout: 180_000, interval: 300 }).toBe(true);
  if (!operation) throw new Error('the legacy agent operation has no durable identity');
  await legacyPtyReceipt('operation-' + kind, operation);
  expect(operation.status, 'the legacy fleet operation failed: ' + JSON.stringify(operation.error)).toBe('succeeded');
  expect(operation.error).toBeNull();
  if (kind === 'create' || kind === 'start') {
    const admission = operation.steps.find(step => step.name === 'admission');
    expect(admission?.status).toBe('succeeded');
    expect(admission?.evidence?.terminal_verified).toBeUndefined();
  }
  return operation;
}

export async function createLegacyPtyAgent(fixture: LegacyPtyFixture): Promise<PtyFleetOperation> {
  const { page } = fixture;
  await page.goto(fixture.baseUrl + '/config?seccion=agentes', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Añadir agente' });
  await dialog.getByText('Solo preparar, sin desplegar', { exact: true }).click();
  const create = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
  await create.getByLabel('Espacio de trabajo operativo').selectOption(fixture.tenantId);
  await create.getByLabel('Alias operativo').fill(legacyPtyAlias);
  await create.getByLabel('Nombre visible operativo').fill('Política PTY antigua');
  await create.getByLabel('Clave física de ejecución').fill(legacyPtyKey);
  await create.getByRole('checkbox', { name: new RegExp('· "' + fixture.room + '"$', 'u') }).check();
  await create.getByLabel('Grupo primario').selectOption(fixture.room);
  await create.getByLabel('Host operativo').locator('option[value="' + fixture.hostId + '"]').waitFor({ state: 'attached', timeout: 30_000 });
  await create.getByLabel('Host operativo').selectOption(fixture.hostId);
  await create.getByLabel('Plantilla de ejecución').selectOption('0');
  await create.getByLabel('Cuenta principal de ejecución').selectOption(fixture.accountId);
  expect(await create.getByLabel('Contenedor operativo').inputValue()).toBe(legacyPtyPrefix + '-' + legacyPtyKey);
  return enqueue(fixture, create, 'create');
}

export async function runLegacyPtyOperation(fixture: LegacyPtyFixture, kind: 'stop' | 'start'): Promise<PtyFleetOperation> {
  await fixture.page.goto(fixture.baseUrl + '/config?seccion=agentes&agente='
    + encodeURIComponent(fixture.tenantId + '/' + legacyPtyAlias), { waitUntil: 'domcontentloaded' });
  await fixture.page.getByRole('tab', { name: 'Ejecución', exact: true }).click();
  const panel = fixture.page.getByRole('region', { name: 'Operación de ' + fixture.tenantId + '/' + legacyPtyAlias, exact: true });
  await panel.getByLabel('¿Qué quieres hacer?').selectOption(kind);
  return enqueue(fixture, panel, kind);
}

export async function observeLegacyPty(fixture: LegacyPtyFixture): Promise<PtyFleetObservation> {
  const script = await readFile('tests/e2e/v4-pty-flota-dinamica.observe.py', 'utf8');
  const result = await fixture.computer.onComputer(['python3', '-I', '-B', '-c', script,
    legacyPtyAlias, legacyPtyKey, legacyPtyPrefix + '-' + legacyPtyKey, fixture.runtimeState]);
  expect(result.code, 'the legacy physical runtime could not be observed').toBe(0);
  return JSON.parse(result.stdout) as PtyFleetObservation;
}

export async function assertLegacyPtyAbsent(fixture: LegacyPtyFixture, phase: string): Promise<PtyFleetObservation> {
  const observed = await observeLegacyPty(fixture);
  expect(observed).toMatchObject({ main_pid: 0, process_alive: false, pki: null, env: null, dropin: null, wants: null, alias_unit: null,
    fingerprint: null, certificate_cn: null, certificate_runtime_key: null });
  expect(Object.values(observed.files).every(value => value === null)).toBe(true);
  expect(observed.active.code).not.toBe(0); expect(observed.enabled.code).not.toBe(0);
  const registry = JSON.parse(await readFile(fixture.registryFile, 'utf8')) as { agents: { tenant_id: string; alias: string }[] };
  expect(registry.agents.filter(row => row.tenant_id === fixture.tenantId && row.alias === legacyPtyAlias)).toHaveLength(0);
  const response = await apiGet(fixture.page, '/v3/console/terminal/targets');
  expect(response.status).toBe(200);
  const target = (response.body.items as { tenant_id: string; alias: string; modes: string[]; pty_state: string }[])
    .find(row => row.tenant_id === fixture.tenantId && row.alias === legacyPtyAlias);
  if (phase === 'stopped') expect(target).toBeUndefined();
  else expect(target).toMatchObject({ modes: ['shell'], pty_state: 'unknown' });
  await legacyPtyReceipt(phase + '-terminal-absent', { physical: observed, target: target ?? null, issuer_registry_entries: 0 });
  return observed;
}

export async function assertLegacyPtyTurn(fixture: LegacyPtyFixture, phase: string): Promise<void> {
  const { pool } = fixture.computer;
  const lease = async () => (await pool.query<{ instance_id: string; epoch: string; last_heartbeat_at: Date }>(
    'SELECT instance_id,epoch,last_heartbeat_at FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND lease_until>now()',
    [fixture.tenantId, legacyPtyAlias])).rows[0];
  await expect.poll(async () => (await lease())?.instance_id, { timeout: 45_000 }).toBeTruthy();
  const first = await lease();
  if (!first) throw new Error('the legacy agent did not acquire its real consumer lease');
  await expect.poll(async () => (await lease())?.last_heartbeat_at.getTime() ?? 0,
    { timeout: 35_000 }).toBeGreaterThan(first.last_heartbeat_at.getTime());
  const observedLease = await lease(), marker = 'FLEET-DEPLOY-DELIVERY-' + randomUUID();
  await fixture.page.goto(fixture.baseUrl + '/messages/' + encodeURIComponent(fixture.tenantId) + '/' + legacyPtyAlias,
    { waitUntil: 'domcontentloaded' });
  await fixture.page.getByLabel('Mensaje para ' + legacyPtyAlias, { exact: true }).fill(marker);
  await fixture.page.getByRole('button', { name: 'Enviar', exact: true }).click();
  const delivery = async () => (await pool.query<{ id: string; status: string; reply: string | null;
    instance_id: string; epoch: string; execution_started_at: Date | null }>(
    `SELECT d.id,d.status,d.result->'output'->>'reply' AS reply,d.consumer_instance_id AS instance_id,
      d.consumer_epoch AS epoch,d.execution_started_at FROM deliveries d JOIN messages m ON m.id=d.message_id
      WHERE m.tenant_id=$1 AND m.body->>'text'=$2 AND d.recipient_alias=$3`, [fixture.tenantId, marker, legacyPtyAlias])).rows;
  await expect.poll(async () => {
    const current = await delivery();
    return ['done', 'dead'].includes(current[0]?.status ?? '');
  }, { timeout: 60_000, interval: 500 }).toBe(true);
  const rows = await delivery();
  await legacyPtyReceipt(phase + '-delivery-status', rows);
  expect(rows[0]?.status).toBe('done');
  expect(rows).toHaveLength(1); expect(rows[0]?.execution_started_at).not.toBeNull();
  expect(rows[0]?.reply).toBe('DELIVERED:' + marker);
  expect(rows[0]?.instance_id).toBe(observedLease?.instance_id); expect(rows[0]?.epoch).toBe(observedLease?.epoch);
  const acks = (await pool.query<{ status: string; applied: boolean; renewal: boolean; instance_id: string; epoch: string; witness: unknown }>(
    `SELECT status,applied,renewal,instance_id,epoch,payload->'result'->'harness_consumption_v1' AS witness
      FROM delivery_acks WHERE delivery_id=$1 ORDER BY id`, [rows[0]?.id])).rows;
  const applied = acks.filter(row => row.applied);
  expect(applied.filter(row => !row.renewal).map(row => row.status)).toEqual(['accepted', 'started', 'done']);
  const ranks = applied.map(row => ['accepted', 'started', 'done'].indexOf(row.status));
  expect(ranks).toEqual([...ranks].sort());
  for (const ack of applied) {
    if (ack.renewal) expect(['accepted', 'started']).toContain(ack.status);
    expect(ack.instance_id).toBe(observedLease?.instance_id); expect(ack.epoch).toBe(observedLease?.epoch);
  }
  const native = HarnessConsumptionEvidenceSchema.parse(applied.find(row => row.status === 'done')?.witness);
  expect(native.harness_id).toBe('codex'); expect(native.native_session_id).toBeTruthy();
  await fixture.page.getByText('DELIVERED:' + marker, { exact: true }).waitFor({ timeout: 20_000 });
  await legacyPtyCapture(fixture.page, phase + '-durable-turn');
  await legacyPtyReceipt(phase + '-durable-turn', { marker, first, observed: observedLease, delivery: rows, acknowledgements: acks, native });
}

export async function legacyPtySdkDiagnostics(fixture: LegacyPtyFixture): Promise<unknown> {
  const row = (await fixture.computer.pool.query<{ state_directory: string }>(
    'SELECT state_directory FROM agents WHERE tenant_id=$1 AND alias=$2', [fixture.tenantId, legacyPtyAlias])).rows[0];
  if (!row) return { runtime_absent: true };
  const script = `import json,os,pathlib,stat,sys
try:
 fd=os.open(pathlib.Path(sys.argv[1])/'.cauce-adapter.log',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  info=os.fstat(fd);assert stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_nlink==1 and not info.st_mode&63
  os.lseek(fd,max(0,info.st_size-262144),os.SEEK_SET);raw=os.read(fd,262144).decode(errors='replace')
 finally:os.close(fd)
 codes=('ADAPTER_FATAL','AGENT_DISABLED','LEASE_CONFLICT','BOOTSTRAP_FAILED','consumer_placement_mismatch','lease_provenance_unavailable')
 print(json.dumps({'log_observed':True,'codes':[code for code in codes if code in raw]}))
except Exception as error:print(json.dumps({'observation_error':{'type':type(error).__name__,'errno':getattr(error,'errno',None)}}))`;
  const result = await fixture.computer.onComputer(['docker', 'exec', '--user', '0', legacyPtyPrefix + '-' + legacyPtyKey,
    'python3', '-I', '-B', '-c', script, row.state_directory]);
  return { exit_code: result.code, observation: result.stdout.trim() ? JSON.parse(result.stdout) as unknown : null };
}
