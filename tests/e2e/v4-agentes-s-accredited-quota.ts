import { execFile } from 'node:child_process';
import { chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import type { startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import { startAgentQuotaDocker, type QuotaAgentPlacement } from './v4-cuotas-agent-real-browser.fixtures.js';
import { apiGet, type IgnoredConsoleRule, type V4Locator, type V4Page } from './v4-console-real-browser.helpers.js';

type Fixture = Awaited<ReturnType<typeof startConsoleFunctionalFixture>>;
export type AccreditedQuota = Awaited<ReturnType<typeof startAgentQuotaDocker>>;
interface Coverage {
  fixture: Fixture; runtime: AccreditedQuota; page: V4Page;
  capture(label: string, focus: V4Locator): Promise<void>;
  record(id: string, evidence: unknown): void;
}
interface Route {
  continue(): Promise<void>; abort(errorCode: string): Promise<void>;
}
interface Routing {
  route(path: string, handler: (route: Route) => Promise<void>): Promise<void>;
  unroute(path: string): Promise<void>;
}
const execute = promisify(execFile);
let unavailablePath = '';
export const accreditedQuotaTransportRule: IgnoredConsoleRule = {
  id: 'owned-agent-quota-transport-aborted', reason: 'the physical quota scenario aborts its own Chromium request',
  matches: (text, url) => unavailablePath !== '' && url.endsWith(unavailablePath) && text.includes('net::ERR_FAILED'),
};
const agentPath = (agent: QuotaAgentPlacement) => `/v3/console/agents/${agent.tenant_id}/${agent.alias}/quota`;
const routing = (page: V4Page) => page as unknown as Routing;
function firstAgent(context: Coverage): QuotaAgentPlacement {
  const agent = context.runtime.agents[0];
  if (!agent) throw new Error('accredited quota agent is missing');
  return agent;
}
async function openPhysical(context: Coverage, agent = firstAgent(context)): Promise<V4Locator> {
  await context.runtime.announce();
  await context.page.goto(`${context.fixture.baseUrl}/config?seccion=agentes&agente=${encodeURIComponent(`${agent.tenant_id}/${agent.alias}`)}`,
    { waitUntil: 'domcontentloaded' });
  const reader = context.page.getByRole('dialog').getByRole('region', { name: `Cuota de ${agent.alias}`, exact: true });
  await reader.waitFor({ timeout: 20_000 });
  return reader;
}
async function physicalEvidence(agent: QuotaAgentPlacement) {
  const inspection = await execute('docker', ['inspect', '--format',
    '{{json .Id}} {{json .State.Running}} {{json .Image}} {{json .Config.User}} {{json .Mounts}}', agent.container_name], { timeout: 30_000 });
  const program = 'import hashlib,json,os,pathlib;'
    + 'p=pathlib.Path("/nonexistent/.codex/fixture.json");d=json.loads(p.read_text());'
    + 'r=pathlib.Path("/usr/local/bin/fake-quota-reader");'
    + 'print(json.dumps({"uid":os.getuid(),"home":os.environ["HOME"],"profile_mode":oct(p.stat().st_mode&511),'
    + '"profile_sha256":hashlib.sha256(p.read_bytes()).hexdigest(),"reader_sha256":hashlib.sha256(r.read_bytes()).hexdigest(),'
    + '"mode":d.get("mode","normal"),"error_code":d.get("error_code"),'
    + '"windows":[{"key":w["clave"],"remaining":w["restante_pct"],"minutes":w["windowMinutes"]} for w in d["ventanas"]]}))';
  const profile = await execute('docker', ['exec', '--user', 'nobody', agent.container_name,
    '/usr/local/bin/python3.12', '-I', '-B', '-c', program], { timeout: 30_000 });
  const evidence = JSON.parse(profile.stdout) as { uid: number; home: string; profile_mode: string; windows: unknown[] };
  expect(evidence).toMatchObject({ uid: 65534, home: '/nonexistent', profile_mode: '0o600',
    windows: [{ key: '5h', remaining: 75, minutes: 300 }] });
  return { container: agent.container_name, inspection: inspection.stdout.trim(), profile: evidence };
}
async function storedReading(context: Coverage, agent: QuotaAgentPlacement) {
  const pool = context.fixture.database.pool;
  const operations = (await pool.query(`SELECT id,status,error_code,claim_epoch::int,worker_id,receipt,result
    FROM agent_quota_operations WHERE tenant_id=$1 AND alias=$2 ORDER BY created_at`, [agent.tenant_id, agent.alias])).rows;
  const observations = (await pool.query(`SELECT status,reader_available,captured_at,account_id,sample
    FROM agent_quota_observations WHERE tenant_id=$1 AND alias=$2`, [agent.tenant_id, agent.alias])).rows;
  const windows = (await pool.query(`SELECT account_id,provider,window_key,window_minutes,status,
    remaining_percent::float8,captured_at FROM quota_window_state WHERE account_id IN
    (SELECT account_id FROM agent_quota_observations WHERE tenant_id=$1 AND alias=$2) ORDER BY window_key`,
  [agent.tenant_id, agent.alias])).rows;
  return { operations, observations, windows };
}
async function enqueue(context: Coverage, reader: V4Locator, agent: QuotaAgentPlacement) {
  await expect.poll(() => reader.getByRole('button', { name: 'Consultar cuota', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
  await reader.getByRole('button', { name: 'Consultar cuota', exact: true }).click();
  await reader.getByText('La consulta sigue pendiente; la ficha relee el resultado del ordenador.', { exact: true }).waitFor({ timeout: 15_000 });
  const reading = await apiGet(context.page, agentPath(agent));
  expect(reading.body).toMatchObject({ status: 'pending', operation: { status: 'pending' } });
  return reading.body;
}
async function reread(reader: V4Locator, text: string) {
  await reader.getByRole('button', { name: 'Releer cuota', exact: true }).click();
  await reader.getByText(text, { exact: true }).waitFor({ timeout: 20_000 });
}

export async function verifyAccreditedQuota(context: Coverage): Promise<void> {
  const agent = firstAgent(context);
  const path = agentPath(agent);
  const routePath = `**${path}`;
  let release: () => void = () => undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  const continuations: Promise<void>[] = [];
  await routing(context.page).route(routePath, route => {
    const continuation = held.then(() => route.continue());
    continuations.push(continuation);
    return continuation;
  });
  let reader: V4Locator;
  try {
    reader = await openPhysical(context, agent);
    await reader.getByText('Leyendo la cuota del agente…', { exact: true }).waitFor();
    await context.capture('S06-accredited-initial-loading', reader);
  } finally {
    release();
    try { await Promise.all(continuations); }
    finally { await routing(context.page).unroute(routePath); }
  }
  const unknown = await apiGet(context.page, path);
  expect(unknown.body).toMatchObject({ status: 'unknown', can_query: true, reader_available: true, sample: null, operation: null });
  await reader.getByText('Todavía no hay una medición persistida.', { exact: true }).waitFor();
  await context.capture('S06-accredited-unknown', reader);
  const pending = await enqueue(context, reader, agent);
  await context.capture('S06-accredited-pending', reader);
  expect(await context.runtime.executor.runOnce()).toBe(true);
  await reread(reader, 'Último saldo medido: 75%.');
  await reader.getByText('5 h: 75% medido', { exact: true }).waitFor();
  await reader.getByText('Reinicio no informado.', { exact: true }).waitFor();
  const result = await apiGet(context.page, path);
  expect(result.body).toMatchObject({ status: 'ok', operation: { status: 'done' },
    sample: { ok: true, effective_remaining_percent: 75, windows: [{ window_key: '5h', remaining_percent: 75, window_minutes: 300 }] } });
  const stored = await storedReading(context, agent);
  expect(stored.operations).toMatchObject([{ status: 'done', claim_epoch: 1,
    receipt: { status: 'measured', harness: 'codex', container_name: agent.container_name } }]);
  expect(stored.observations).toEqual([expect.objectContaining({ status: 'ok', reader_available: true,
    sample: result.body.sample })]);
  expect(stored.windows).toMatchObject([{ provider: 'codex', window_key: '5h', window_minutes: 300, status: 'ok', remaining_percent: 75 }]);
  await context.capture('S06-accredited-measured', reader);
  context.record('S06-accredited-measured', { pending, result: result.body, stored, physical: await physicalEvidence(agent) });

  unavailablePath = path;
  await routing(context.page).route(routePath, async route => { await route.abort('failed'); });
  try {
    await reread(reader, 'No se pudo leer la cuota. Relee antes de consultar.');
    expect(await reader.getByRole('button', { name: 'Consultar cuota', exact: true }).isDisabled()).toBe(true);
    await context.capture('S06-accredited-transport-failure', reader);
    expect(await storedReading(context, agent)).toEqual(stored);
  } finally { await routing(context.page).unroute(routePath); unavailablePath = ''; }
  await reread(reader, 'Último saldo medido: 75%.');
  await context.runtime.setReaderMode(agent, 'token_expired');
  try {
    await enqueue(context, reader, agent);
    expect(await context.runtime.executor.runOnce()).toBe(true);
    await reread(reader, 'Sesión caducada: autenticar de nuevo');
    await reader.getByText('Saldo no acreditado en la última medición.', { exact: true }).waitFor();
    expect(await reader.getByText('Último saldo medido: 75%.', { exact: true }).count()).toBe(0);
    expect((await apiGet(context.page, path)).body).toMatchObject({ status: 'error', operation: { status: 'done' }, sample: { ok: false, note: 'token_expired' } });
    expect((await storedReading(context, agent)).observations).toMatchObject([{ status: 'error', sample: { ok: false, note: 'token_expired' } }]);
    await context.capture('S06-accredited-provider-error', reader);
    context.record('S06-accredited', { complete: true, source: 'real Docker, signed host channel and executor with a synthetic provider reader',
      states: ['loading', 'unknown', 'pending', 'ok', 'transport_error', 'error'],
      stored: await storedReading(context, agent), physical: await physicalEvidence(agent) });
  } finally { await context.runtime.setReaderMode(agent, 'normal'); }
}

export async function verifyAccreditedQuotaExecution(context: Coverage): Promise<void> {
  const agent = firstAgent(context);
  const reader = await openPhysical(context, agent);
  await enqueue(context, reader, agent);
  const release = context.runtime.holdExecution();
  const executing = context.runtime.executor.runOnce();
  try {
    await expect.poll(async () => (await apiGet(context.page, agentPath(agent))).body.status, { timeout: 15_000 }).toBe('running');
    await reread(reader, 'Consultando en el ordenador');
    expect(await reader.getByRole('button', { name: 'Consultar cuota', exact: true }).isDisabled()).toBe(true);
    await context.capture('S06-accredited-running', reader);
  } finally { release(); expect(await executing).toBe(true); }
  await reread(reader, 'Último saldo medido: 75%.');
  const before = await storedReading(context, agent);
  await context.runtime.docker(['stop', '--time', '1', agent.container_name]);
  try {
    await enqueue(context, reader, agent);
    expect(await context.runtime.executor.runOnce()).toBe(true);
    await reread(reader, 'La operación falló');
    await reader.getByText('Detalles técnicos', { exact: true }).click();
    await reader.getByText('RUNTIME_UNAVAILABLE', { exact: true }).waitFor();
    const result = await apiGet(context.page, agentPath(agent));
    expect(result.body).toMatchObject({ status: 'failed', operation: { status: 'failed', error_code: 'RUNTIME_UNAVAILABLE' } });
    const stored = await storedReading(context, agent);
    expect(stored.observations).toEqual(before.observations);
    expect(stored.operations.at(-1)).toMatchObject({ status: 'failed', error_code: 'RUNTIME_UNAVAILABLE', claim_epoch: 1 });
    const stopped = await execute('docker', ['inspect', '--format', '{{.State.Running}}', agent.container_name], { timeout: 30_000 });
    expect(stopped.stdout.trim()).toBe('false');
    await context.capture('S06-accredited-runtime-failed', reader);
    context.record('S06-accredited-execution-failed', { stored, result: result.body, containerRunning: false });
  } finally { await context.runtime.docker(['start', agent.container_name]); }
  await enqueue(context, reader, agent);
  expect(await context.runtime.executor.runOnce()).toBe(true);
  await reread(reader, 'Último saldo medido: 75%.');
  context.record('S06-accredited-execution', { complete: true, states: ['running', 'failed', 'recovered'],
    stored: await storedReading(context, agent), physical: await physicalEvidence(agent) });
}

export async function secureStatusArtifacts(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await secureStatusArtifacts(path);
    else await chmod(path, 0o600);
  }
}

export async function maskedStatusScreenshot(page: V4Page, path: string, timeout = 30_000): Promise<void> {
  const target = page as unknown as { screenshot(options: { path: string; timeout: number; mask: V4Locator[] }): Promise<Buffer> };
  await target.screenshot({ path, timeout, mask: [page.locator('input[type="password"],input[type="email"]')] });
  await chmod(path, 0o600);
}

export async function closeAccreditedQuota(runtime: AccreditedQuota, record: Coverage['record']): Promise<void> {
  const names = runtime.agents.map(agent => agent.container_name);
  await runtime.close();
  const containers = (await execute('docker', ['ps', '-aq', '--filter', 'name=zz-canary-agent-quota-'], { timeout: 30_000 })).stdout.trim().split('\n');
  const volumes = (await execute('docker', ['volume', 'ls', '-q'], { timeout: 30_000 })).stdout.trim().split('\n');
  for (const name of names) {
    const owned = await execute('docker', ['ps', '-aq', '--filter', `name=^/${name}$`], { timeout: 30_000 });
    expect(owned.stdout.trim()).toBe('');
    expect(volumes).not.toContain(`${name}-state`);
    expect(volumes).not.toContain(`${name}-provider-profiles`);
  }
  record('S06-accredited-cleanup', { names, containersRemoved: true, volumesRemoved: true, otherQuotaContainers: containers.filter(Boolean).length });
}
