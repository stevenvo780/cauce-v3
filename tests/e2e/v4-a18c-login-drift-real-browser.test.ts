import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { HarnessConsumptionEvidenceSchema } from '../../packages/protocol/src/harness-consumption.js';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { TMUX_SOCKET } from '../../packages/adapter-sdk/src/shared-session/types.js';
import { bodySnippet, type V4Locator } from './v4-console-real-browser.helpers.js';
import { capture, operations, OWNER, PREFIX, RECEIPTS, RUN, startA18cFixture,
  type A18cFixture, type A18cOperation } from './v4-a18c-login-drift.fixtures.js';

const ALIAS = 'drift' + RUN;
const KEY = 'drift-' + RUN;
const CONTAINER = PREFIX + '-' + KEY;
interface AuthSocket {
  on(event: 'framereceived', callback: (frame: { payload: string | Buffer }) => void): void;
  on(event: 'close', callback: () => void): void;
}
interface RuntimeObservation { id: string; image: string; labels: Record<string, string>; volumes: string[]; running: boolean }

async function observe(): Promise<RuntimeObservation> {
  const template = '{"id":{{json .Id}},"image":{{json .Image}},"labels":{{json .Config.Labels}},'
    + '"mounts":{{json .Mounts}},"running":{{json .State.Running}}}';
  const value = JSON.parse(await docker(['inspect', '--format', template, CONTAINER])) as {
    id: string; image: string; labels: Record<string, string>; mounts: { Type: string; Name?: string }[]; running: boolean;
  };
  const labels = Object.fromEntries(Object.entries(value.labels).filter(([name]) => name.startsWith('cauce.fleet.')));
  return { id: value.id, image: value.image, running: value.running, labels,
    volumes: value.mounts.filter(row => row.Type === 'volume').map(row => row.Name ?? '').sort() };
}
async function enabled(button: V4Locator): Promise<void> {
  await expect.poll(() => button.isDisabled(), { timeout: 30_000 }).toBe(false);
}
async function waitOperation(fixture: A18cFixture, id: string, status: string, drift = false): Promise<A18cOperation> {
  let value: A18cOperation | undefined;
  await expect.poll(async () => {
    value = (await operations(fixture, ALIAS)).find(row => row.id === id);
    if (value?.status === 'failed' || value?.status === 'cancelled') throw new Error('owned operation stopped: ' + JSON.stringify(value));
    return value?.status === status && (!drift || value.error?.code === 'RUNTIME_DRIFT');
  }, { timeout: 240_000, interval: 1000 }).toBe(true);
  if (!value) throw new Error('owned operation disappeared');
  return value;
}
async function create(fixture: A18cFixture): Promise<A18cOperation> {
  const { page, baseUrl, tenant, room, host, account } = fixture;
  await page.goto(baseUrl + '/config?seccion=agentes', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Añadir agente' });
  await dialog.getByText('Solo preparar, sin desplegar', { exact: true }).click();
  const panel = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
  await panel.getByLabel('Espacio de trabajo operativo').selectOption(tenant);
  await panel.getByLabel('Alias operativo').fill(ALIAS);
  await panel.getByLabel('Nombre visible operativo').fill('Deriva A18c ' + RUN);
  await panel.getByLabel('Clave física de ejecución').fill(KEY);
  await panel.getByRole('checkbox', { name: new RegExp('· "' + room + '"$', 'u') }).check();
  await panel.getByLabel('Grupo primario').selectOption(room);
  await panel.getByLabel('Host operativo').locator('option[value="' + host + '"]').waitFor({ state: 'attached', timeout: 30_000 });
  await panel.getByLabel('Host operativo').selectOption(host);
  await panel.getByLabel('Plantilla de ejecución').selectOption('0');
  await panel.getByLabel('Cuenta principal de ejecución').selectOption(account);
  expect(await panel.getByLabel('Contenedor operativo').inputValue()).toBe(CONTAINER);
  const preview = panel.getByRole('button', { name: 'Previsualizar operación', exact: true });
  await enabled(preview); await preview.click();
  const confirm = panel.getByRole('button', { name: 'Confirmar operación', exact: true });
  await enabled(confirm); await confirm.click();
  let created: A18cOperation | undefined;
  await expect.poll(async () => {
    created = (await operations(fixture, ALIAS)).find(row => row.kind === 'create');
    return created?.id;
  }, { timeout: 30_000 }).toBeTruthy();
  if (!created) throw new Error('browser did not enqueue its create operation');
  return waitOperation(fixture, created.id, 'awaiting_auth');
}

async function durableNonce(fixture: A18cFixture): Promise<unknown> {
  const { computer, page, baseUrl, tenant } = fixture;
  const nonce = 'A18C_NONCE_' + randomUUID().replaceAll('-', '');
  const expected = 'A18C_REPLY:' + nonce;
  const lease = async () => (await computer.pool.query<{ instance_id: string; epoch: string; last_heartbeat_at: Date }>(
    'SELECT instance_id,epoch,last_heartbeat_at FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND lease_until>now()', [tenant, ALIAS])).rows[0];
  await expect.poll(async () => (await lease())?.instance_id, { timeout: 60_000 }).toBeTruthy();
  const initialLease = await lease();
  if (!initialLease) throw new Error('normal SDK consumer lease absent');
  await expect.poll(async () => (await lease())?.last_heartbeat_at.getTime() ?? 0, { timeout: 40_000 })
    .toBeGreaterThan(initialLease.last_heartbeat_at.getTime());
  await page.goto(baseUrl + '/messages/' + encodeURIComponent(tenant) + '/' + ALIAS, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Mensaje para ' + ALIAS, { exact: true }).fill(nonce);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  const deliveries = async () => (await computer.pool.query<{ id: string; status: string; reply: string | null; instance_id: string; epoch: string }>(
    "SELECT d.id,d.status,d.result->'output'->>'reply' AS reply,d.consumer_instance_id AS instance_id,d.consumer_epoch AS epoch FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE m.tenant_id=$1 AND m.body->>'text'=$2 AND d.recipient_alias=$3",
    [tenant, nonce, ALIAS])).rows;
  await expect.poll(async () => (await deliveries())[0]?.status, { timeout: 90_000, interval: 500 }).toBe('done');
  const rows = await deliveries();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.reply).toBe(expected);
  expect(rows[0]?.instance_id).toBe(initialLease.instance_id);
  expect(rows[0]?.epoch).toBe(initialLease.epoch);
  const acknowledgements = (await computer.pool.query<{ status: string; applied: boolean; renewal: boolean; witness: unknown }>(
    "SELECT status,applied,renewal,payload->'result'->'harness_consumption_v1' AS witness FROM delivery_acks WHERE delivery_id=$1 ORDER BY id", [rows[0]?.id])).rows;
  expect(acknowledgements.filter(row => row.applied && !row.renewal).map(row => row.status)).toEqual(['accepted', 'started', 'done']);
  const witness = HarnessConsumptionEvidenceSchema.parse(acknowledgements.find(row => row.applied && row.status === 'done')?.witness);
  expect(witness.harness_id).toBe('codex');
  expect(witness.native_session_id).toMatch(/^[a-f0-9-]{36}$/u);
  expect(witness.native_turn_id).toMatch(/^[a-f0-9-]{36}$/u);
  await page.getByText(expected, { exact: true }).waitFor({ timeout: 30_000 });
  const state = '/home/cauce/.cauce/' + KEY;
  const pane = await docker(['exec', '--user', 'cauce', '--env', 'TMUX_TMPDIR=' + state, CONTAINER,
    '/usr/bin/tmux', '-L', TMUX_SOCKET, 'capture-pane', '-p', '-S', '-120', '-t', 'cauce-' + KEY + ':agente']);
  expect(pane).toContain(expected);
  await capture(page, 'normal-sdk-response');
  return { nonce, delivery: rows[0], lease: initialLease, ack_order: ['accepted', 'started', 'done'], witness, physical_tui_nonce_seen: true };
}

it('login con deriva real recrea el contenedor y reanuda la misma operación desde la ficha', async () => {
  console.info('A18C_RUN', RUN);
  const fixture = await startA18cFixture();
  const evidence: Record<string, unknown> = { owner: OWNER, run: RUN, provider: 'owned interactive provider double',
    runtime: 'real SDK, executor, host channel, Chromium, signed setup and Docker', manual_operation_sql: false, direct_test_acks: false };
  let originalContainer: string | undefined;
  let installedRelease: string | undefined;
  let phase = 'create';
  const mark = (next: string) => { phase = next; console.info('A18C_PHASE', RUN, phase); };
  try {
    const { page, baseUrl, computer } = fixture;
    let terminal = '';
    const resumes: { id: string; status: number }[] = [];
    const authHttp: { path: string; status: number }[] = [];
    const sockets: { path: string; frames: number; closed: boolean }[] = [];
    evidence.authentication_http = authHttp;
    evidence.authentication_sockets = sockets;
    page.on('websocket', socket => {
      const path = new URL(socket.url()).pathname;
      if (!path.startsWith('/v3/console/provider-auth/sessions/')) return;
      const observed = { path, frames: 0, closed: false }; sockets.push(observed);
      (socket as unknown as AuthSocket).on('close', () => { observed.closed = true; });
      (socket as unknown as AuthSocket).on('framereceived', frame => {
        observed.frames += 1;
        terminal += Buffer.isBuffer(frame.payload) ? frame.payload.toString('utf8') : frame.payload;
      });
    });
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith('/v3/console/provider-auth/')) authHttp.push({ path, status: response.status() });
      const matched = /\/v3\/console\/fleet\/operations\/([^/]+)\/resume$/u.exec(path);
      if (matched?.[1]) resumes.push({ id: matched[1], status: response.status() });
    });
    const waiting = await create(fixture);
    expect(waiting.error?.code).not.toBe('RUNTIME_DRIFT');
    const before = await observe();
    originalContainer = before.id;
    expect(before.image).toBe(fixture.firstImage);
    expect(before.running).toBe(true);
    evidence.initial = { operation: waiting, container: before, portable_image: fixture.firstPortableImage };
    mark('signed deployment and real reconciliation');
    const deployment = await fixture.deploy();
    installedRelease = deployment.release;
    expect(deployment.image).not.toBe(before.image);
    expect(await observe()).toEqual(before);
    const drifted = await waitOperation(fixture, waiting.id, 'awaiting_auth', true);
    const reconciliation = (await computer.pool.query<{ event: string; fenced: boolean }>(
      "SELECT event,(metadata->'runtime_drift'->>'operation_id')=$1::text AS fenced FROM fleet_operation_events WHERE operation_id=$1::uuid AND metadata ? 'runtime_drift'", [waiting.id])).rows;
    expect(reconciliation.some(row => row.event === 'step_completed' && row.fenced)).toBe(true);
    evidence.drift = { operation: drifted, deployment, reconciliation, container_unchanged_before_login: await observe() };
    await page.goto(baseUrl + '/config?seccion=agentes&agente=' + encodeURIComponent(fixture.tenant + '/' + ALIAS), { waitUntil: 'domcontentloaded' });
    const sheet = page.getByRole('dialog', { name: 'Deriva A18c ' + RUN, exact: true });
    await sheet.waitFor({ timeout: 30_000 });
    const login = sheet.getByRole('button', { name: 'Iniciar sesión de ' + ALIAS, exact: true });
    await enabled(login);
    expect(await page.getByRole('button', { name: 'Recrear contenedor e iniciar sesión', exact: true }).count()).toBe(0);
    await capture(page, 'awaiting-auth-drift-login-enabled');
    mark('interactive login refresh');
    expect(await observe()).toEqual(before);
    await login.click();
    const dialog = page.getByRole('dialog', { name: /Iniciar sesión en GPT.*Codex/u });
    await dialog.getByLabel('Terminal privada de autenticación', { exact: true }).waitFor({ timeout: 90_000 });
    await expect.poll(async () => {
      const audit = (await computer.pool.query<{ status: string; error: string | null; reason: string | null }>(
        "SELECT metadata->'provider_auth_status'->>'status' AS status,metadata->'provider_auth_status'->>'error' AS error,metadata->'provider_auth_status'->>'reason' AS reason FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'provider_auth_status' ORDER BY id DESC LIMIT 1", [waiting.id])).rows[0];
      evidence.authentication_status = audit;
      if (audit?.status === 'failed') throw new Error('Owned provider login failed: ' + JSON.stringify(audit));
      return terminal;
    }, { timeout: 90_000 }).toContain('A18C: enter A18C-APPROVE');
    const replacement = await observe();
    expect(replacement.id).not.toBe(before.id);
    expect(replacement.image).toBe(deployment.image);
    expect(replacement.volumes).toEqual(before.volumes);
    expect(replacement.labels).toEqual(before.labels);
    expect(replacement.running).toBe(true);
    evidence.recreated = replacement;
    await capture(page, 'login-recreated-container');
    await dialog.locator('.xterm-helper-textarea').type('A18C-APPROVE');
    await dialog.locator('.xterm-helper-textarea').press('Enter');
    await expect.poll(() => terminal, { timeout: 30_000 }).toContain('A18C_LOGIN_APPROVED');
    const verify = dialog.getByRole('button', { name: 'Verificar conexión', exact: true });
    await enabled(verify); await verify.click();
    mark('same operation automatic resume');
    await dialog.getByText('Cuenta verificada y operación reanudada. El agente sigue preparándose; puedes cerrar esta ventana.', { exact: true })
      .waitFor({ timeout: 90_000 });
    expect(resumes).toEqual([{ id: waiting.id, status: 200 }]);
    await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
    const completed = await waitOperation(fixture, waiting.id, 'succeeded');
    expect(completed.steps.every(step => step.status === 'succeeded')).toBe(true);
    expect(completed.error).toBeNull();
    const history = await operations(fixture, ALIAS);
    expect(history.map(row => row.id)).toEqual([waiting.id]);
    const probes = (await computer.pool.query<{ phase: string; state: string; nonce_verified: boolean }>(
      "SELECT metadata->'bootstrap_probe'->'probe'->>'phase' AS phase,metadata->'bootstrap_probe'->>'state' AS state,metadata->'bootstrap_probe'->'proof'->>'reply'='CAUCE_BOOTSTRAP_'||(metadata->'bootstrap_probe'->'probe'->>'nonce') AS nonce_verified FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'bootstrap_probe'", [waiting.id])).rows;
    for (const name of ['bootstrap', 'normal']) expect(probes.some(row => row.phase === name && row.state === 'succeeded' && row.nonce_verified)).toBe(true);
    evidence.completed = { operation: completed, operation_ids: history.map(row => row.id), resumes, probes };
    await capture(page, 'same-operation-resumed');
    mark('normal durable SDK and TUI nonce');
    evidence.response = await durableNonce(fixture);
    fixture.errors.assertClean();
    const files = ['tests/e2e/v4-a18c-login-drift-real-browser.test.ts', 'tests/e2e/v4-a18c-login-drift.fixtures.ts',
      'tests/e2e/v4-a18c-provider.py', 'tests/e2e/v4-a18c-diagnostics.py'];
    evidence.hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
    evidence.result = 'PASS';
  } catch (error) {
    evidence.result = 'FAIL';
    evidence.phase = phase;
    evidence.error = error instanceof Error ? error.message : 'unknown failure';
    evidence.page = await bodySnippet(fixture.page);
    evidence.browser_errors = fixture.errors.unexpected;
    evidence.browser_trace = fixture.errors.trace;
    if (originalContainer && installedRelease) {
      try {
        const source = await readFile('tests/e2e/v4-a18c-diagnostics.py', 'utf8');
        const diagnostic = await fixture.computer.onComputer(['python3', '-I', '-B', '-c', source,
          join(fixture.computer.installRoot, fixture.company, fixture.host), installedRelease, KEY, ALIAS, fixture.tenant, originalContainer]);
        evidence.runtime_diagnostic_exit = diagnostic.code;
        await writeFile(join(RECEIPTS, 'runtime-diagnostic.json'), diagnostic.stdout, { mode: 0o600 });
      } catch (diagnosticError) {
        evidence.runtime_diagnostic_error_class = diagnosticError instanceof Error ? diagnosticError.name : 'unknown';
      }
    }
    const journal = await fixture.computer.onComputer(['journalctl', '--user', '-u', fixture.unit, '--no-pager', '-o', 'cat',
      '--grep=Agent provider authentication command=|provider auth helper failed:|fleet host command failed', '-n', '12']);
    evidence.host_failures = journal.stdout;
    await capture(fixture.page, 'failure').catch(() => undefined);
    throw error;
  } finally {
    await writeFile(join(RECEIPTS, 'roundtrip.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    await fixture.close();
  }
}, 1_200_000);
