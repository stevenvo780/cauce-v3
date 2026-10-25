import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { command, docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { startRealPtyFixture, type RealPtyFixture } from './real-pty-agent.fixtures.js';
import { apiGet, asV4Page, fillRegistration, openRegistration, syntheticPerson,
  type V4Page } from './v4-console-real-browser.helpers.js';

const OWNER = 'h6b-reiniciar-v4-1025';
const RUN = randomUUID().slice(0, 8);
const NATIVE = `conversation-canary-${RUN}`;
const EVIDENCE = join(process.cwd(), '.delegados/v4/recibos', OWNER, 'openclaw');
let fixture: RealPtyFixture | undefined;
let runtime: ChildProcess | undefined;
let runtimeLog = '';
const evidence: Record<string, unknown> = { run: RUN, environment: 'docker-lab', harness: 'openclaw' };

function active() { if (!fixture) throw new Error('OpenClaw fixture absent'); return fixture; }

async function capture(page: V4Page, name: string) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.screenshot({ path: join(EVIDENCE, `${name}-${String(viewport.width)}x${String(viewport.height)}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function configureOpenClaw() {
  const current = active();
  const terminate = `import os,signal
for name in os.listdir('/proc'):
 if not name.isdigit() or int(name)==os.getpid(): continue
 try:
  raw=open('/proc/'+name+'/cmdline','rb').read().split(bytes([0]))
  if b'cauce_pty_agent' in raw: os.kill(int(name),signal.SIGTERM)
 except (OSError,ProcessLookupError): pass
`;
  await docker(['exec', '--user', 'node', current.agentContainer, 'python3', '-c', terminate]);
  const original = JSON.parse(await readFile(join(current.directory, 'agent-bundle.json'), 'utf8')) as Record<string, unknown>;
  const bundle = { ...original, home: '/tmp', harness: 'openclaw', harness_command: null,
    generation: `g-${RUN}`, tmux_tui: null, governance_journal_dir: `/tmp/recovery-state/journal/${current.agentContainerId}`,
    runtime_facts: { openclaw_workspace: '/tmp/recovery-state' },
    openclaw_tui: { node: '/usr/bin/python3', entry: '/tmp/openclaw-fake.py', state_directory: '/tmp/recovery-state', history_limit: 200 } };
  const fake = `import json,os,signal,sys,time
native=sys.argv[sys.argv.index('--session')+1]
with open('/tmp/recovery-invocations.jsonl','a') as stream: stream.write(json.dumps({'pid':os.getpid(),'native_id':native,'argv':sys.argv[1:]})+chr(10))
signal.signal(signal.SIGINT,lambda *_:sys.exit(130))
print('OPENCLAW_READY:'+native,flush=True)
while True: time.sleep(1)
`;
  const provision = `import json,os,pathlib,sys
packet=json.loads(sys.stdin.read())
for name in ('/tmp/recovery-state',packet['bundle']['governance_journal_dir']):
 p=pathlib.Path(name);p.mkdir(parents=True,exist_ok=True,mode=448);p.chmod(448)
for name,text in {'/tmp/openclaw-bundle.json':json.dumps(packet['bundle']),'/tmp/openclaw-fake.py':packet['fake'],
 '/tmp/recovery-state/sessions.json':json.dumps({'version':1,'sessions':{packet['session_key']:{'native_id':packet['native_id'],'initialized':True}}})}.items():
 p=pathlib.Path(name);p.write_text(text);p.chmod(384)
`;
  const provisioned = await command('docker', ['exec', '-i', '--user', 'node', current.agentContainer, 'python3', '-c', provision],
    JSON.stringify({ bundle, fake, native_id: NATIVE, session_key: `openclaw:${current.targetAlias}:shared:${current.targetAlias}` }));
  expect(provisioned.code, provisioned.stderr).toBe(0);
  await current.database.pool.query(`UPDATE agents SET harness_id='openclaw',home_directory='/tmp',state_directory='/tmp/recovery-state'
    WHERE tenant_id=$1 AND alias=$2`, [current.tenant, current.targetAlias]);
  runtime = spawn('docker', ['exec', '--user', 'node', '--env', 'HOME=/tmp', '--env', 'PYTHONPATH=/opt/cauce-pty-agent',
    current.agentContainer, 'python3', '-m', 'cauce_pty_agent', '--bundle', '/tmp/openclaw-bundle.json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  runtime.stdout?.on('data', (chunk: Buffer) => { runtimeLog = (runtimeLog + chunk.toString()).slice(-16_384); });
  runtime.stderr?.on('data', (chunk: Buffer) => { runtimeLog = (runtimeLog + chunk.toString()).slice(-16_384); });
}

async function login(page: V4Page) {
  const current = active();
  await page.goto(current.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Correo', { exact: true }).fill(current.operatorEmail);
  await page.getByLabel('Contraseña', { exact: true }).fill(current.operatorPassword);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
}

async function invocations(): Promise<{ pid: number; native_id: string; argv: string[] }[]> {
  const result = await command('docker', ['exec', '--user', 'node', active().agentContainer, 'cat', '/tmp/recovery-invocations.jsonl']);
  if (result.code !== 0 && result.stderr.includes('No such file')) return [];
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { pid: number; native_id: string; argv: string[] });
}

let fixtureError: Error | undefined;

beforeAll(async () => {
  try {
    await mkdir(EVIDENCE, { recursive: true, mode: 0o700 });
    fixture = await startRealPtyFixture({ governanceRelay: true, tui: true, owner: OWNER,
      resourcePrefix: `zz-canary-${OWNER}-${RUN}`, modes: ['shell', 'harness', 'harness_rw'] });
    await fixture.database.pool.query(`INSERT INTO company_admins(company_id,human_id,role,source,granted_by)
      SELECT company_id,id,'owner','import',id FROM console_users WHERE email=$1
      ON CONFLICT (company_id,human_id) DO UPDATE SET role='owner'`, [fixture.operatorEmail]);
    await configureOpenClaw();
  } catch (error) {
    fixtureError = error instanceof Error ? error : new Error(String(error));
  }
}, 900_000);

afterAll(async () => {
  const failures: unknown[] = [];
  try { await fixture?.close(); } catch (error) { failures.push(error); }
  if (runtime?.exitCode === null && runtime.signalCode === null) runtime.kill('SIGTERM');
  evidence.runtime_log = runtimeLog;
  evidence.cleanup = failures.length === 0;
  await writeFile(join(EVIDENCE, 'durable-receipts.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  if (failures.length) throw new AggregateError(failures, 'OpenClaw E2E cleanup incomplete');
}, 300_000);

describe('OpenClaw recuperado por Chromium, gateway, relay, PostgreSQL y Docker reales', () => {
  it('reanuda el ID durable tras Ctrl+C, conserva el adaptador y audita; otra empresa recibe 403', async () => {
    if (fixtureError) throw fixtureError;
    const current = active();
    const page = asV4Page(await current.browserPage({ width: 1440, height: 900 }));
    const path = `/v3/console/tenants/${current.tenant}/agents/${current.targetAlias}/recovery`;
    try {
      await login(page);
      await expect.poll(async () => {
        const result = await apiGet(page, path);
        evidence.last_preview = { status: result.status, error: result.body.error, message: result.body.message };
        return result.status === 200 ? (result.body.session as { state?: string }).state : `HTTP ${String(result.status)}`;
      }, { timeout: 30_000 }).toBe('absent');
      await page.goto(`${current.baseUrl}/terminal/${current.tenant}/${current.targetAlias}?modo=tui`, { waitUntil: 'domcontentloaded' });
      const terminal = page.locator('.xterm-rows');
      await expect.poll(async () => terminal.innerText(), { timeout: 30_000 }).toContain(`OPENCLAW_READY:${NATIVE}`);
      const first = await invocations();
      expect(first).toHaveLength(1);
      const before = await apiGet(page, path);
      expect(before.body.session).toMatchObject({ state: 'present', resumable: true });
      evidence.before_interrupt = { identity: before.body.identity, invocations: first };
      await capture(page, '01-initial-tui');
      await page.getByRole('button', { name: 'Devolver el control', exact: true }).waitFor({ timeout: 20_000 });
      await page.locator('.xterm-helper-textarea').press('Control+c');
      await expect.poll(async () => {
        const result = await apiGet(page, path);
        return (result.body.session as { state?: string } | undefined)?.state;
      }, { timeout: 15_000 }).toBe('absent');
      const recovery = page.getByRole('region', { name: `Recuperación de ${current.targetAlias}`, exact: true });
      await recovery.getByRole('button', { name: 'Reiniciar agente', exact: true }).click();
      await recovery.getByRole('button', { name: 'Confirmar reinicio y reanudar', exact: true }).waitFor({ timeout: 15_000 });
      await capture(page, '02-preview-exact-conversation');
      await recovery.getByRole('button', { name: 'Confirmar reinicio y reanudar', exact: true }).click();
      await recovery.getByText(`Recreado: ${current.targetAlias} continúa la misma conversación.`, { exact: true }).waitFor({ timeout: 30_000 });
      await expect.poll(async () => terminal.innerText(), { timeout: 30_000 }).toContain(`OPENCLAW_READY:${NATIVE}`);
      const after = await apiGet(page, path);
      expect(after.body.identity).toEqual(before.body.identity);
      expect(after.body.session).toMatchObject({ state: 'present', resumable: true });
      const launches = await invocations();
      expect(launches).toHaveLength(2);
      expect(launches.every(value => value.native_id === NATIVE && value.argv.includes('--session'))).toBe(true);
      expect(launches[1]?.pid).not.toBe(launches[0]?.pid);
      const audits = (await current.database.pool.query<{ action: string; decision: string; state: string }>(
        `SELECT action,decision,metadata->>'state' AS state FROM audit_events
          WHERE action='agent_session.recover' AND metadata->>'target_alias'=$1 ORDER BY created_at,id`, [current.targetAlias])).rows;
      expect(audits).toEqual(expect.arrayContaining([expect.objectContaining({ decision: 'allow', state: 'recreated' })]));
      evidence.after_recovery = { identity: after.body.identity, invocations: launches, audits };
      await capture(page, '03-recovered-same-conversation');

      const other = asV4Page(await current.browserPage({ width: 1440, height: 900 }));
      const person = syntheticPerson('foreign-recovery', RUN);
      person.company = { name: `zz-canary-foreign-${RUN}`, slug: `zz-h6b-foreign-${RUN}` };
      const registration = await openRegistration(other, current.baseUrl);
      await fillRegistration(registration, person);
      await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      await other.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
      const denied = await apiGet(other, path);
      expect(denied).toMatchObject({ status: 403, body: { error: 'forbidden' } });
      const postDenied = await other.evaluate(async (argument) => {
        const auth = await fetch('/v3/auth/session', { credentials: 'include' }).then(response => response.json()) as { csrf_token: string };
        const response = await fetch(argument.path, { method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-csrf-token': auth.csrf_token },
          body: JSON.stringify({ identity: argument.identity, expected_fingerprint: argument.fingerprint, force: true }) });
        return { status: response.status, body: await response.json() as { error: string } };
      }, { path, identity: after.body.identity, fingerprint: (after.body.session as { fingerprint: string }).fingerprint });
      expect(postDenied).toMatchObject({ status: 403, body: { error: 'forbidden' } });
      expect(await invocations()).toHaveLength(2);
      evidence.foreign_company = { get: denied.status, post: postDenied.status, unchanged_launches: 2 };
      await other.goto(`${current.baseUrl}/terminal/${current.tenant}/${current.targetAlias}`, { waitUntil: 'domcontentloaded' });
      await capture(other, '05-foreign-company-denied');

      const tuiSession = await page.locator('[data-session-id]').evaluate(element => element.getAttribute('data-session-id'));
      await page.getByRole('group', { name: 'Vista de la sesión', exact: true }).getByRole('button', { name: 'Terminal', exact: true }).click();
      await expect.poll(() => new URL(page.url()).searchParams.get('modo'), { timeout: 15_000 }).not.toBe('tui');
      await expect.poll(() => page.locator('[data-session-id]').evaluate(element => element.getAttribute('data-session-id')),
        { timeout: 20_000 }).not.toBe(tuiSession);
      await page.locator('[data-pty-shell][data-state="open"]').waitFor({ timeout: 20_000 });
      const proof = `/tmp/zz-canary-recovery-shell-${RUN}`;
      await page.locator('.xterm-helper-textarea').type(`printf '%s' 'SHELL-RECOVERED-${RUN}' > ${proof}; cat ${proof}`);
      await page.locator('.xterm-helper-textarea').press('Enter');
      await expect.poll(async () => {
        const observed = await command('docker', ['exec', '--user', 'node', current.agentContainer, 'cat', proof]);
        return observed.code === 0 ? observed.stdout : '';
      }, { timeout: 15_000 }).toBe(`SHELL-RECOVERED-${RUN}`);
      const shellSession = await page.locator('[data-session-id]').evaluate(element => element.getAttribute('data-session-id'));
      const durableShell = (await current.database.pool.query<{ mode: string }>('SELECT mode FROM terminal_sessions WHERE id=$1', [shellSession])).rows[0];
      expect(durableShell?.mode).toBe('shell');
      evidence.shell_after_recovery = { mode: durableShell?.mode, physical_marker: `SHELL-RECOVERED-${RUN}` };
      await capture(page, '04-shell-after-recovery');
    } catch (error) {
      await capture(page, 'failure').catch(() => undefined);
      console.info('OPENCLAW_RECOVERY_FAILURE', { runtime_log: runtimeLog });
      throw error;
    }
  }, 240_000);
});
