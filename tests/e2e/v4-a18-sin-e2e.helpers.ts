import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { ackEnvelope, terminalAck } from '../../packages/store/test/helpers/consumer.js';
import { CauceRepository } from '@cauce/store';
import { startRealPtyFixture, type RealPtyFixture } from './real-pty-agent.fixtures.js';
import { asV4Page, type V4Page } from './v4-console-real-browser.helpers.js';

const execute = promisify(execFile);
export const OWNER = 'e2e-a18-sin-e2e-1025';
export const PREFIX = `zz-canary-${OWNER}`;
export const RECEIPTS = join(process.cwd(), '.delegados/v4/recibos', OWNER);
export const DESKTOP = { width: 1440, height: 900 };
export const PHONE = { width: 390, height: 844 };

export interface MeasuredRuntime {
  fixture: RealPtyFixture;
  repository: CauceRepository;
  replacementName: string;
  replacementId: string;
  close(): Promise<void>;
}

interface BrowserRequest {
  method(): string;
  url(): string;
  headers(): Record<string, string>;
  postData(): string | null;
}

interface DetailRoute {
  request(): BrowserRequest;
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
  fulfill(options: { status?: number; contentType?: string; body?: string }): Promise<void>;
}

interface RoutedPage extends V4Page {
  route(url: string, handler: (route: DetailRoute) => Promise<void>): Promise<void>;
}

function append(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString('utf8')}`.slice(-16 * 1024);
}

async function docker(args: string[]): Promise<string> {
  return (await execute('docker', args, { timeout: 120_000, maxBuffer: 1024 * 1024 })).stdout.trim();
}

async function dockerInput(args: string[], input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`docker fixture input failed (${String(code)} ${String(signal)}): ${stderr || stdout}`));
    });
    child.stdin.end(input);
  });
}

export function assertRouted(page: V4Page): asserts page is RoutedPage {
  if (!('route' in page)) throw new Error('the browser page does not expose route');
}

export function detailIdOf(url: string, method: string): string | undefined {
  if (method !== 'GET') return undefined;
  return /^\/v3\/console\/messages\/([^/]+)$/u.exec(new URL(url).pathname)?.[1];
}

interface ScrollTarget { evaluate(pageFunction: (element: Element) => void): Promise<void> }

export async function capture(page: V4Page, name: string, focus?: ScrollTarget): Promise<void> {
  await mkdir(RECEIPTS, { recursive: true });
  const current = page.viewportSize();
  for (const viewport of [DESKTOP, PHONE]) {
    await page.setViewportSize(viewport);
    // Re-scroll after the viewport change. Start hides the control under the sticky profile header.
    if (focus) await focus.evaluate((element) => { element.scrollIntoView({ block: 'center' }); });
    await page.screenshot({ path: join(RECEIPTS, `${name}-${String(viewport.width)}.png`), fullPage: false });
  }
  if (current) await page.setViewportSize(current);
}

export async function openSession(fixture: RealPtyFixture, path: string): Promise<V4Page> {
  const page = asV4Page(await fixture.browserPage(DESKTOP));
  await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Correo', { exact: true }).fill(fixture.operatorEmail);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.operatorPassword);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 20_000 });
  await page.goto(`${fixture.baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function waitOnline(fixture: RealPtyFixture): Promise<void> {
  const session = await fixture.login();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fixture.request('/v3/console/terminal/targets', {
      headers: { cookie: session.cookie, accept: 'application/json' },
    });
    if (response.status === 200) {
      const body = JSON.parse(response.body) as { items?: { tenant_id?: string; alias?: string; modes?: string[]; pty_state?: string; authorized?: boolean }[] };
      if (body.items?.some((item) => item.tenant_id === fixture.tenant && item.alias === fixture.targetAlias
        && item.modes?.includes('shell') && item.pty_state === 'online' && item.authorized === true)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`measured replacement agent did not become authorized and online: ${fixture.agentLog()}`);
}

async function replaceRuntime(fixture: RealPtyFixture, run: string): Promise<{ name: string; id: string; agent: ChildProcess }> {
  const imageIdentity = (await docker([
    'image', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}}', fixture.agentImage,
  ])).split(/\s+/u);
  expect(imageIdentity).toEqual([fixture.agentImageId, OWNER]);
  const originalIdentity = (await docker([
    'inspect', '--format', '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}}', fixture.agentContainer,
  ])).split(/\s+/u);
  expect(originalIdentity).toEqual([fixture.agentContainerId, OWNER]);
  await docker(['rm', '--force', fixture.agentContainer]);

  const name = `${PREFIX}-runtime-${run.slice(0, 8)}`;
  const existing = await execute('docker', ['inspect', '--format', '{{.Id}}', name], { timeout: 5_000, maxBuffer: 16 * 1024 })
    .then((result) => result.stdout.trim()).catch(() => undefined);
  expect(existing).toBeUndefined();
  await docker([
    'run', '--detach', '--name', name,
    '--label', `cauce.e2e.owner=${OWNER}`,
    '--label', `cauce.e2e.run=${run}`,
    '--network', 'host', '--user', 'node', '--read-only', '--memory', '256m', '--cpus', '1', '--pids-limit', '64',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
    '--entrypoint', 'sh', fixture.agentImage, '-lc', 'sleep 600',
  ]);
  const identity = (await docker([
    'inspect', '--format', '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}} {{index .Config.Labels "cauce.e2e.run"}} {{.Config.User}}', name,
  ])).split(/\s+/u);
  const replacementId = identity[0];
  expect(identity).toEqual([expect.any(String), OWNER, run, 'node']);
  if (!replacementId) throw new Error('replacement runtime container ID missing');
  await docker(['exec', '--user', 'node', name, 'sh', '-lc', 'mkdir -p /tmp/.codex && chmod 700 /tmp/.codex']);
  const journalDirectory = `/tmp/.codex/pty-governance-journal/${replacementId}`;
  await docker(['exec', '--user', 'node', name, 'mkdir', '-p', journalDirectory]);
  await docker(['exec', '--user', 'node', name, 'chmod', '700', journalDirectory]);
  const bundle = JSON.parse(await readFile(join(fixture.directory, 'agent-bundle.json'), 'utf8')) as Record<string, unknown>;
  expect(bundle.tenant_id).toBe(fixture.tenant);
  expect(bundle.alias).toBe(fixture.targetAlias);
  const measuredBundle = {
    ...bundle,
    container_id: replacementId,
    generation: `g${randomBytes(10).toString('hex')}`,
    home: '/tmp',
    harness: 'codex',
    governance_journal_dir: journalDirectory,
    runtime_facts: { codex_home: '/tmp/.codex' },
  };
  await dockerInput(['exec', '-i', '--user', 'node', name, 'sh', '-lc', 'umask 077; cat > /tmp/pty-bundle.json'], JSON.stringify(measuredBundle));
  const changed = await fixture.database.pool.query<{ harness_id: string; container_name: string; home_directory: string }>(
    `UPDATE agents SET harness_id='codex',container_name=$3,home_directory='/tmp',runtime_user='node'
      WHERE tenant_id=$1 AND alias=$2 RETURNING harness_id,container_name,home_directory`,
    [fixture.tenant, fixture.targetAlias, replacementId],
  );
  expect(changed.rows).toEqual([{ harness_id: 'codex', container_name: replacementId, home_directory: '/tmp' }]);
  const agent = spawn('docker', [
    'exec', '--user', 'node', '--env', 'HOME=/tmp', '--env', 'PYTHONPATH=/opt/cauce-pty-agent',
    name, 'python3', '-m', 'cauce_pty_agent', '--bundle', '/tmp/pty-bundle.json',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { name, id: replacementId, agent };
}

export async function startMeasuredRuntime(run: string): Promise<MeasuredRuntime> {
  const fixture = await startRealPtyFixture({ governanceRelay: true, owner: OWNER, resourcePrefix: PREFIX });
  const replacement = await replaceRuntime(fixture, run);
  await waitOnline(fixture);
  let runtimeLog = '';
  replacement.agent.stdout?.on('data', (chunk: Buffer) => { runtimeLog = append(runtimeLog, chunk); });
  replacement.agent.stderr?.on('data', (chunk: Buffer) => { runtimeLog = append(runtimeLog, chunk); });
  return {
    fixture,
    repository: new CauceRepository(fixture.database.pool),
    replacementName: replacement.name,
    replacementId: replacement.id,
    async close() {
      const errors: Error[] = [];
      if (replacement.agent.exitCode === null && replacement.agent.signalCode === null) {
        replacement.agent.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { replacement.agent.kill('SIGKILL'); resolve(); }, 2_500);
          replacement.agent.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
      try {
        const identity = (await docker([
          'inspect', '--format', '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}} {{index .Config.Labels "cauce.e2e.run"}}', replacement.name,
        ])).split(/\s+/u);
        expect(identity).toEqual([replacement.id, OWNER, run]);
        await docker(['rm', '--force', replacement.name]);
      } catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
      try { await fixture.close(); }
      catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
      if (runtimeLog.length > 0 && errors.length > 0) errors.push(new Error(runtimeLog.slice(-500)));
      if (errors.length > 0) throw new AggregateError(errors, 'a18 measured runtime cleanup incomplete');
    },
  };
}

export async function ackCanonicalReply(runtime: MeasuredRuntime, messageId: string, reply: string): Promise<string> {
  const instanceId = `a18-consumer-${messageId.slice(0, 8)}`;
  const lease = await runtime.repository.acquireLease(runtime.fixture.tenant, runtime.fixture.targetAlias, instanceId, [], 60_000, { takeover: true });
  if (!lease.acquired || lease.epoch === undefined || lease.connection_token === undefined) {
    throw new Error('real store could not acquire the recipient lease');
  }
  const deliveries = await runtime.repository.claimDeliveries(
    runtime.fixture.tenant, runtime.fixture.targetAlias, instanceId, lease.epoch, 10, 30_000, 3, {}, lease.connection_token,
  );
  const delivery = deliveries.find((candidate) => candidate.message_id === messageId);
  if (!delivery) throw new Error('real store lease did not claim the browser-published delivery');
  const target = { instanceId, epoch: lease.epoch };
  const started = await runtime.repository.ackDelivery(
    delivery.delivery_id, runtime.fixture.tenant, runtime.fixture.targetAlias,
    ackEnvelope(delivery, target, { progress: 'fixture agent started' }, { status: 'started', execution_started: true, retryable: false }),
  );
  expect(started).toMatchObject({ applied: true, status: 'started' });
  const done = await runtime.repository.ackDelivery(
    delivery.delivery_id, runtime.fixture.tenant, runtime.fixture.targetAlias,
    terminalAck(delivery, target, { reply }),
  );
  expect(done).toMatchObject({ applied: true, status: 'done' });
  return delivery.delivery_id;
}

export async function messageRow(runtime: MeasuredRuntime, text: string): Promise<{ message_id: string; count: string }> {
  const deadline = Date.now() + 20_000;
  let found = '0';
  while (Date.now() < deadline) {
    const result = await runtime.fixture.database.pool.query<{ message_id: string; count: string }>(
      `SELECT min(m.id::text) AS message_id, count(*)::text AS count
         FROM messages m WHERE m.tenant_id=$1 AND m.actor_alias=$2 AND m.body->>'text'=$3`,
      [runtime.fixture.tenant, runtime.fixture.operatorAlias, text],
    );
    const row = result.rows[0];
    if (row?.message_id && row.count === '1') return row;
    found = row?.count ?? '0';
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`expected one durable root; found ${found}`);
}

export function skillFile(runtime: MeasuredRuntime, id: string): Promise<string> {
  return docker(['exec', '--user', 'node', runtime.replacementName, 'cat', `/tmp/.codex/skills/${id}/SKILL.md`]);
}

export async function countRows(runtime: MeasuredRuntime, sql: string, values: string[]): Promise<string> {
  const result = await runtime.fixture.database.pool.query<{ count: string }>(sql, values);
  return result.rows[0]?.count ?? '0';
}

