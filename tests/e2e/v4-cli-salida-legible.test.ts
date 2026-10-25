import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPUTER_RUNTIME, docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { startFleetCliFixture, type FleetCliFixture } from './v4-cli-flota-dinamica.host.js';
import { FLEET_CLI_PROVIDER_FIXTURE } from './v4-cli-flota-dinamica.runtime.js';
import { apiGet } from './v4-console-real-browser.helpers.js';
import { assertHumanOutput, expectedInventory, installLegibleCli, jsonResult, LEGIBLE_OWNER, privateReceipt,
  type LegibleInventory, type LegibleOperation } from './v4-cli-salida-legible.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 10);
const alias = `legible${run}`;
const runtimeKey = `readable-${run}`;
const marker = `READABLE-${run}`;
const receipts = join(process.cwd(), '.delegados/v4/recibos', LEGIBLE_OWNER, run);
let fixture: FleetCliFixture | undefined;
let installed: Awaited<ReturnType<typeof installLegibleCli>> | undefined;
const active = () => { if (!fixture) throw new Error('readable CLI enrolled fleet is unavailable'); return fixture; };
const cli = () => { if (!installed) throw new Error('readable installed CLI is unavailable'); return installed; };
const connection = () => ['--gateway', active().baseUrl, '--origin', active().baseUrl,
  '--ca-file', active().caFile, '--session-file', cli().sessionFile];
const inventory = async () => jsonResult(await cli().run(['spaces', 'list', '--json',
  '--tenant', active().tenantId, '--alias', alias, ...connection()])) as LegibleInventory;

function parameters() {
  const current = active();
  return { runtime_key: runtimeKey, harness_id: 'codex', display_name: 'Agente CLI legible', primary_room_id: current.room,
    primary_account_id: current.accountId, memberships: [{ room_id: current.room, role: 'agent' }],
    placement: { host_id: current.hostId, mode: 'container', container_name: `${current.prefix}-${runtimeKey}`,
      runtime_user: COMPUTER_RUNTIME.user, systemd_user: COMPUTER_RUNTIME.user, home_directory: COMPUTER_RUNTIME.home,
      state_directory: `${COMPUTER_RUNTIME.stateRoot}/${runtimeKey}` } };
}

async function preview(command: 'create' | 'edit' | 'retire', value?: unknown): Promise<string[]> {
  const snapshot = await inventory();
  const input = join(active().directory, `readable-${command}.json`);
  if (value !== undefined) await writeFile(input, JSON.stringify(value), { mode: 0o600 });
  const args = ['spaces', command, '--tenant', active().tenantId, '--alias', alias,
    '--expected-revision', String(snapshot.revision), '--idempotency-key', `readable-${run}-${command}`,
    ...connection(), ...(value === undefined ? [] : ['--input', input])];
  const before = await active().computer.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM fleet_operations');
  const human = assertHumanOutput(await cli().run(args), active(), runtimeKey);
  expect(human).toContain('Previsualización'); expect(human).toContain(alias); expect(human).toContain('--apply');
  const json = jsonResult(await cli().run([...args, '--json'])) as
    { state: string; preview: { can_apply: boolean; kind: string; target: unknown } };
  expect(json).toMatchObject({ state: 'preview', preview: { can_apply: true,
    kind: command === 'edit' ? 'update' : command,
    target: { resource: 'agent', tenant_id: active().tenantId, alias } } });
  const request = { kind: command === 'edit' ? 'update' : command,
    target: { resource: 'agent', tenant_id: active().tenantId, alias }, expected_revision: snapshot.revision,
    idempotency_key: `readable-${run}-${command}`, parameters: value ?? {} };
  const expected = await active().page.evaluate(async body => {
    const session = await (await fetch('/v3/auth/session', { credentials: 'same-origin' })).json() as { csrf_token: string };
    const response = await fetch('/v3/console/fleet/operations/preview', { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrf_token }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as unknown };
  }, request);
  expect(expected.status).toBe(200); expect(json).toEqual({ state: 'preview', preview: expected.body });
  const after = await active().computer.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM fleet_operations');
  expect(after.rows).toEqual(before.rows);
  await privateReceipt(receipts, `preview-${command}`, { human, json_contract_matches_real_preview: true,
    no_operation_enqueued: true, apply_requested: false });
  return args;
}

async function waitOperation(id: string): Promise<LegibleOperation> {
  let final: LegibleOperation | undefined;
  await expect.poll(async () => {
    const row = (await active().computer.pool.query<LegibleOperation>(
      'SELECT id,kind,status,error FROM fleet_operations WHERE id=$1', [id])).rows[0];
    if (row && ['succeeded', 'failed', 'cancelled', 'awaiting_auth'].includes(row.status)) final = row;
    return final?.status;
  }, { timeout: 240_000, interval: 300 }).toBeDefined();
  if (!final) throw new Error('the readable CLI create operation did not finish');
  await privateReceipt(receipts, 'create-operation', final);
  expect(final.status, `physical create: ${final.error?.code ?? final.status}`).toBe('succeeded');
  return final;
}

async function assertReleased(): Promise<void> {
  await expect.poll(async () => (await active().computer.pool.query<{ sessions: number; holds: number }>(`SELECT
    (SELECT count(*)::int FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2 AND closed_at IS NULL AND revoked_at IS NULL) AS sessions,
    (SELECT count(*)::int FROM terminal_control_holds WHERE tenant_id=$1 AND alias=$2 AND released_at IS NULL) AS holds`,
  [active().tenantId, alias])).rows[0], { timeout: 15_000 }).toEqual({ sessions: 0, holds: 0 });
}

beforeAll(async () => {
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  installed = await installLegibleCli(receipts);
  fixture = await startFleetCliFixture({ candidateSource: installed.source });
  await privateReceipt(receipts, '01-fleet-precondition', { enrolled_host: fixture.hostId, tenant_id: fixture.tenantId,
    fixture_receipts: fixture.receipts, source_kind: 'working_tree_snapshot', immutable_release: false,
    provider_limit: FLEET_CLI_PROVIDER_FIXTURE });
}, 1_000_000);
afterAll(async () => {
  try { await fixture?.close(); }
  finally { await installed?.close(); }
}, 180_000);

describe.sequential('salida humana y JSON del CLI instalado con una flota enrolada real', () => {
  it('autentica al dueño con contraseña por stdin y sesión privada fuera del checkout', async () => {
    const login = jsonResult(await cli().run(['login', '--email', active().owner.email, '--password-stdin', ...connection()],
      { input: active().owner.password + '\n' })) as { authenticated: boolean; subject: string };
    expect(login).toMatchObject({ authenticated: true, subject: active().owner.email });
    expect((await stat(cli().home)).mode & 0o777).toBe(0o700);
    expect((await stat(cli().sessionFile)).mode & 0o777).toBe(0o600);
    const session = JSON.parse(await readFile(cli().sessionFile, 'utf8')) as { cookie: string; csrf_token: string };
    expect(session.cookie.length).toBeGreaterThan(0); expect(session.csrf_token.length).toBeGreaterThan(0);
    await privateReceipt(receipts, '02-login', { nominal_password_stdin: true, private_home: true, private_session: true });
  });

  it('previsualiza sin efecto y crea el agente físico mediante el JSON compatible', async () => {
    const args = await preview('create', parameters());
    const accepted = jsonResult(await cli().run([...args, '--apply', '--json'])) as { operation: LegibleOperation };
    const operation = await waitOperation(accepted.operation.id);
    const runtime = await active().runtimeFor(alias);
    const observed = JSON.parse(await docker(['inspect', '--format', '{{json .}}', runtime.id])) as
      { State: { Running: boolean }; Config: { Labels: Record<string, string> } };
    expect(observed.State.Running).toBe(true);
    expect(observed.Config.Labels).toMatchObject({ 'cauce.fleet.alias': alias, 'cauce.fleet.host': active().hostId });
    expect((await inventory()).agents).toEqual(expect.arrayContaining([expect.objectContaining({ alias, enabled: true,
      lifecycle_state: 'ready' })]));
    await privateReceipt(receipts, '03-physical-create', { operation, running: true, host_id: active().hostId,
      runtime_container: runtime.id, runtime_source: 'working_tree_snapshot' });
  }, 360_000);

  it('lista una tabla sin material interno, preserva todo el JSON y resume editar y retirar', async () => {
    const args = ['spaces', 'list', '--tenant', active().tenantId, '--alias', alias, ...connection()];
    const human = assertHumanOutput(await cli().run(args), active(), runtimeKey);
    for (const value of ['Alias', 'Nombre visible', 'Arnés', 'Ordenador', 'Modo', 'Ciclo de vida', 'Habilitado',
      'Última operación', alias, 'Agente CLI legible', 'codex', 'Contenedor', 'Listo', 'Completada', 'hace']) {
      expect(human).toContain(value);
    }
    const json = jsonResult(await cli().run([...args, '--json'])) as LegibleInventory;
    const config = await apiGet(active().page, '/v3/console/config');
    const query = new URLSearchParams({ resource: 'agent', tenant_id: active().tenantId, alias });
    const operations = await apiGet(active().page, `/v3/console/fleet/operations?${query.toString()}`);
    expect(config.status).toBe(200); expect(operations.status).toBe(200);
    expect(json).toEqual(expectedInventory(config.body, operations.body.operations, active().tenantId, alias));
    expect(JSON.stringify(json)).toContain(COMPUTER_RUNTIME.home);
    await privateReceipt(receipts, '04-table-and-json', { human, full_json_matches_real_inventory: true,
      json_includes_internal_paths: true, table_omits_internal_material: true });
    await preview('edit', { ...parameters(), display_name: 'Agente CLI revisado' });
    await preview('retire');
  }, 120_000);

  it('deduce el tenant único para estado, ver y entrada con escritura y desconexión limpias', async () => {
    await active().prepareTerminal(alias);
    const status = await cli().run([alias, 'estado', ...connection()]);
    expect(status.code, `estado exit ${String(status.code)}`).toBe(0);
    expect(status.stdout).toContain(alias);
    const view = await cli().run([alias, 'ver', ...connection()], { detachWhen: 'Terminal conectado', timeout: 60_000 });
    expect(view.code, `ver exit ${String(view.code)}`).toBe(0); await assertReleased();
    const attached = await cli().run([alias, ...connection()], { input: `REMEMBER ${marker}\r`,
      detachWhen: `STORED:${marker}`, timeout: 60_000 });
    expect(attached.code, `attach exit ${String(attached.code)}`).toBe(0);
    expect(attached.stdout + attached.stderr).toContain(`STORED:${marker}`);
    await assertReleased();
    expect((await active().probeTmux(alias)).clients).toBe(0);
    await privateReceipt(receipts, '05-terminal-without-tenant', { unique_alias_inferred: true, estado: true, view: true,
      writable_attach: true, marker_observed: true, sessions_released: true, controls_released: true,
      provider_limit: FLEET_CLI_PROVIDER_FIXTURE });
  }, 240_000);
});
