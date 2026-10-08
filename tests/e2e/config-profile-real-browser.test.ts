import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRealPtyFixture, type RealPtyFixture } from './real-pty-agent.fixtures.js';
import { observeUiBootstrap } from './ui-bootstrap-diagnostics.js';

const execute = promisify(execFile);
const OWNER = 'config-profile-real-browser';
const RUN_ID = randomUUID();
let fixture: RealPtyFixture | undefined;
let replacementContainer: { name: string; id: string } | undefined;
let runtimeAgent: ChildProcess | undefined;
let runtimeLog = '';

function append(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString('utf8')}`.slice(-16 * 1024);
}

interface AuthResponseEvidence {
  status: number;
  authenticated: boolean | null;
  login_mode: 'password' | 'redirect' | 'missing-or-unknown';
  error: 'none' | 'unauthorized' | 'forbidden' | 'reason-present' | 'other-error' | 'no-response';
}

function authEvidence(status: number, body: unknown): AuthResponseEvidence {
  const value = body !== null && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const loginMode = value.login_mode === 'password' || value.login_mode === 'redirect'
    ? value.login_mode
    : 'missing-or-unknown';
  const error = value.error === 'unauthorized' || value.error === 'forbidden'
    ? value.error
    : typeof value.error === 'string'
      ? 'other-error'
      : typeof value.reason === 'string'
        ? 'reason-present'
        : status >= 400 ? 'other-error' : 'none';
  return {
    status,
    authenticated: typeof value.authenticated === 'boolean' ? value.authenticated : null,
    login_mode: loginMode,
    error,
  };
}

function noAuthResponse(): AuthResponseEvidence {
  return { status: 0, authenticated: null, login_mode: 'missing-or-unknown', error: 'no-response' };
}

async function authEvidenceBefore(
  evidence: Promise<AuthResponseEvidence>,
  deadline: number,
): Promise<AuthResponseEvidence> {
  const remaining = Math.max(0, deadline - Date.now());
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      evidence,
      new Promise<AuthResponseEvidence>((resolve) => {
        timeout = setTimeout(() => { resolve(noAuthResponse()); }, remaining);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function safeVisibleBody(raw: string, email: string, password: string): string {
  return raw
    .replaceAll(email, '[correo]')
    .replaceAll(password, '[redactado]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[correo]')
    .replace(/\b(?:eyJ[A-Za-z0-9_-]{12,}|[A-Fa-f0-9]{32,})\b/gu, '[redactado]')
    .slice(0, 1_200);
}

function safePagePath(pageUrl: string): string {
  try {
    const url = new URL(pageUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[url no disponible]';
  }
}

async function docker(args: string[], timeout = 30_000): Promise<string> {
  const result = await execute('docker', args, { timeout, maxBuffer: 128 * 1024 });
  return result.stdout.trim();
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

async function waitForMeasuredTarget(active: RealPtyFixture, cookie: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await active.request('/v3/console/terminal/targets', {
      headers: { cookie, accept: 'application/json' },
    });
    if (response.status === 200) {
      const body = JSON.parse(response.body) as {
        items?: { tenant_id?: string; alias?: string; modes?: string[]; pty_state?: string; authorized?: boolean }[];
      };
      if (body.items?.some((item) => item.tenant_id === active.tenant && item.alias === active.targetAlias
        && item.modes?.includes('shell') && item.pty_state === 'online' && item.authorized === true)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`measured replacement agent did not become authorized and online: ${runtimeLog}`);
}

async function configureMeasuredCodexRuntime(active: RealPtyFixture): Promise<void> {
  const imageIdentity = (await docker([
    'image', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}}', active.agentImage,
  ])).split(/\s+/u);
  expect(imageIdentity).toEqual([active.agentImageId, 'real-pty-agent']);

  const originalIdentity = (await docker([
    'inspect', '--format', '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}}', active.agentContainer,
  ])).split(/\s+/u);
  expect(originalIdentity).toEqual([active.agentContainerId, 'real-pty-agent']);
  await docker(['rm', '--force', active.agentContainer]);

  const name = `cauce-profile-e2e-${RUN_ID}`;
  const existing = await execute('docker', ['inspect', '--format', '{{.Id}}', name], { timeout: 5_000, maxBuffer: 16 * 1024 })
    .then((result) => result.stdout.trim()).catch(() => undefined);
  expect(existing).toBeUndefined();
  await docker([
    'run', '--detach', '--name', name,
    '--label', `cauce.e2e.owner=${OWNER}`,
    '--label', `cauce.e2e.run=${RUN_ID}`,
    '--network', 'host', '--user', 'node', '--read-only', '--memory', '256m', '--cpus', '1', '--pids-limit', '64',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
    '--entrypoint', 'sh', active.agentImage, '-lc', 'sleep 600',
  ]);
  const identity = (await docker([
    'inspect', '--format', '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}} {{index .Config.Labels "cauce.e2e.run"}} {{.Config.User}}', name,
  ])).split(/\s+/u);
  const replacementId = identity[0];
  expect(identity).toEqual([expect.any(String), OWNER, RUN_ID, 'node']);
  if (!replacementId) throw new Error('replacement runtime container ID missing');
  replacementContainer = { name, id: replacementId };

  await docker(['exec', '--user', 'node', name, 'sh', '-lc', 'mkdir -p /tmp/.codex && chmod 700 /tmp/.codex']);
  const journalDirectory = `/tmp/.codex/pty-governance-journal/${replacementId}`;
  await docker(['exec', '--user', 'node', name, 'mkdir', '-p', journalDirectory]);
  await docker(['exec', '--user', 'node', name, 'chmod', '700', journalDirectory]);
  expect(await docker(['exec', '--user', 'node', name, 'stat', '-c', '%u:%g:%a', journalDirectory])).toBe('1000:1000:700');
  const bundle = JSON.parse(await readFile(join(active.directory, 'agent-bundle.json'), 'utf8')) as Record<string, unknown>;
  expect(bundle.tenant_id).toBe(active.tenant);
  expect(bundle.alias).toBe(active.targetAlias);
  const measuredBundle = {
    ...bundle,
    container_id: replacementId,
    generation: `g${randomBytes(10).toString('hex')}`,
    home: '/tmp',
    harness: 'codex',
    governance_journal_dir: journalDirectory,
    runtime_facts: { codex_home: '/tmp/.codex' },
  };
  await dockerInput([
    'exec', '-i', '--user', 'node', name, 'sh', '-lc', 'umask 077; cat > /tmp/pty-bundle.json',
  ], JSON.stringify(measuredBundle));
  expect(await docker(['exec', '--user', 'node', name, 'stat', '-c', '%u:%g:%a', '/tmp/.codex'])).toBe('1000:1000:700');

  const changed = await active.database.pool.query<{ harness_id: string; container_name: string; home_directory: string }>(
    `UPDATE agents SET harness_id='codex',container_name=$3,home_directory='/tmp',runtime_user='node'
      WHERE tenant_id=$1 AND alias=$2 RETURNING harness_id,container_name,home_directory`,
    [active.tenant, active.targetAlias, replacementId],
  );
  expect(changed.rows).toEqual([{ harness_id: 'codex', container_name: replacementId, home_directory: '/tmp' }]);

  runtimeAgent = spawn('docker', [
    'exec', '--user', 'node', '--env', 'HOME=/tmp', '--env', 'PYTHONPATH=/opt/cauce-pty-agent',
    name, 'python3', '-m', 'cauce_pty_agent', '--bundle', '/tmp/pty-bundle.json',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  runtimeAgent.stdout?.on('data', (chunk: Buffer) => { runtimeLog = append(runtimeLog, chunk); });
  runtimeAgent.stderr?.on('data', (chunk: Buffer) => { runtimeLog = append(runtimeLog, chunk); });
  process.stdout.write(`Config profile fixture resources: run=${RUN_ID} pg=${active.database.container.getId()} browser=${active.browserContainer} image=${active.agentImageId} originalAgent=${active.agentContainerId} replacementAgent=${replacementId}\n`);
}

beforeAll(async () => {
  fixture = await startRealPtyFixture({ governanceRelay: true });
  await configureMeasuredCodexRuntime(fixture);
}, 10 * 60_000);

afterAll(async () => {
  const errors: Error[] = [];
  if (runtimeAgent?.exitCode === null && runtimeAgent.signalCode === null) {
    runtimeAgent.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { runtimeAgent?.kill('SIGKILL'); resolve(); }, 2_500);
      runtimeAgent?.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  if (replacementContainer) {
    try {
      const identity = (await docker([
        'inspect', '--format', '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}} {{index .Config.Labels "cauce.e2e.run"}}', replacementContainer.name,
      ])).split(/\s+/u);
      expect(identity).toEqual([replacementContainer.id, OWNER, RUN_ID]);
      await docker(['rm', '--force', replacementContainer.name]);
      await expect(docker(['inspect', '--format', '{{.Id}}', replacementContainer.name])).rejects.toThrow();
      process.stdout.write(`Config profile fixture cleanup: run=${RUN_ID} replacementAgent=${replacementContainer.id} removed=true\n`);
    } catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
  }
  try { await fixture?.close(); }
  catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
  if (errors.length > 0) throw new AggregateError(errors, 'config profile fixture cleanup incomplete');
});

describe('perfil canónico desde configuración móvil y runtime Python medido', () => {
  it('guarda por PUT real, persiste revisión y fichero en tmpfs y deja adopción de sesión sin acreditar', async () => {
    if (!fixture || !replacementContainer) throw new Error('config profile fixture not initialized');
    const active = fixture;
    const session = await active.login();
    await waitForMeasuredTarget(active, session.cookie);
    const profilePath = `/v3/console/tenants/${encodeURIComponent(active.tenant)}/agents/${encodeURIComponent(active.targetAlias)}/perfil`;
    const initialResponse = await active.request(profilePath, { headers: { cookie: session.cookie, accept: 'application/json' } });
    expect(initialResponse.status, initialResponse.body).toBe(200);
    const initial = JSON.parse(initialResponse.body) as { harness: string; exists: boolean; ficheros: { nombre: string; path?: string }[] };
    expect(initial).toMatchObject({ harness: 'codex', exists: false });
    expect(initial.ficheros).toEqual([expect.objectContaining({ nombre: 'AGENTS.md' })]);

    const page = await active.browserPage({ width: 360, height: 800 });
    observeUiBootstrap(page);
    let resolveAuthEvidence: ((evidence: AuthResponseEvidence) => void) | undefined;
    const authEvidencePromise = new Promise<AuthResponseEvidence>((resolve) => { resolveAuthEvidence = resolve; });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => {
      const value = error !== null && typeof error === 'object' ? error as { name?: unknown } : {};
      pageErrors.push(typeof value.name === 'string' ? value.name.slice(0, 80) : 'Error');
    });
    page.on('response', (response) => {
      if (resolveAuthEvidence === undefined) return;
      let responseUrl: URL;
      try { responseUrl = new URL(response.url()); }
      catch { return; }
      if (responseUrl.pathname !== '/v3/auth/session' || response.request().method() !== 'GET') return;
      const complete = resolveAuthEvidence;
      resolveAuthEvidence = undefined;
      const readable = response as unknown as { status(): number; json(): Promise<unknown> };
      void readable.json().then((body) => {
        complete(authEvidence(readable.status(), body));
      }).catch(() => {
        complete(authEvidence(readable.status(), null));
      });
    });
    const entry = await page.goto(active.baseUrl, { waitUntil: 'domcontentloaded' });
    expect(entry?.status()).toBe(200);
    const authDeadline = Date.now() + 15_000;
    try {
      await page.getByLabel('Correo').waitFor({ timeout: 15_000 });
    } catch (error) {
      const auth = await authEvidenceBefore(authEvidencePromise, authDeadline);
      const visibleBody = safeVisibleBody(
        await page.locator('body').innerText().catch(() => '[body no disponible]'),
        active.operatorEmail,
        active.operatorPassword,
      );
      const artifactDirectory = process.env.CAUCE_E2E_ARTIFACT_DIR;
      if (artifactDirectory) {
        await mkdir(artifactDirectory, { recursive: true });
        await page.screenshot({ path: join(artifactDirectory, 'config-profile-360-auth-timeout.png') });
      }
      throw new Error(
        `password form timeout; auth=${JSON.stringify(auth)}; page=${safePagePath(page.url())}; ` +
        `visibleBody=${JSON.stringify(visibleBody)}; pageErrors=${JSON.stringify(pageErrors.slice(0, 5))}`,
        { cause: error },
      );
    }
    const initialAuth = await authEvidenceBefore(authEvidencePromise, authDeadline);
    expect(initialAuth).toEqual({
      status: 200, authenticated: false, login_mode: 'password', error: 'none',
    });
    await page.getByLabel('Correo').fill(active.operatorEmail);
    await page.getByLabel('Contraseña').fill(active.operatorPassword);
    await page.getByRole('button', { name: 'Iniciar sesión' }).click();
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).locator('a[href="/messages"], a[href^="/messages/"]').waitFor({ state: 'visible', timeout: 20_000 });
    const cookies = await page.context().cookies(active.baseUrl);
    const browserCookie = cookies.find((item) => item.name === '__Host-cauce_session');
    expect(browserCookie?.httpOnly).toBe(true);
    expect(browserCookie?.secure).toBe(true);
    if (!browserCookie) throw new Error('authenticated browser omitted its secure operator session');

    await page.getByRole('button', { name: 'Más', exact: true }).click();
    const menu = page.getByRole('dialog', { name: 'Gestión', exact: true });
    await menu.waitFor({ state: 'visible', timeout: 10_000 });
    await menu.getByRole('link', { name: 'Ajustes' }).click();
    await page.getByRole('heading', { name: 'Ajustes' }).waitFor({ timeout: 20_000 });
    const artifactDirectory = process.env.CAUCE_E2E_ARTIFACT_DIR;
    await page.getByRole('tab', { name: 'Agentes', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Buscar agente o grupo' }).fill(active.targetAlias);
    const openContext = page.getByRole('link', { name: `Perfil y contexto de ${active.tenant}/${active.targetAlias}` });
    try {
      await openContext.waitFor({ state: 'visible', timeout: 20_000 });
    } catch (error) {
      const body = (await page.locator('body').innerText()).slice(0, 4_000);
      if (artifactDirectory) await page.screenshot({ path: join(artifactDirectory, 'config-profile-360-inventory.png') });
      throw new Error(`target context action missing; page=${body}`, { cause: error });
    }
    await openContext.click();
    await page.getByLabel('Responsabilidades', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });

    if (artifactDirectory) {
      await mkdir(artifactDirectory, { recursive: true });
      await page.screenshot({ path: join(artifactDirectory, 'config-profile-360-editor.png') });
    }
    const marker = `E2E-${randomUUID()}`;
    const responseStatuses: number[] = [];
    const responseBodies: string[] = [];
    page.on('response', (response) => {
      if (response.url().endsWith(profilePath) && response.request().method() === 'PUT') {
        responseStatuses.push(response.status());
        const readable = response as typeof response & { text(): Promise<string> };
        void readable.text().then((body) => { responseBodies.push(body); }).catch(() => { responseBodies.push('response body unavailable'); });
      }
    });
    await page.getByLabel('Responsabilidades', { exact: true }).fill(marker);
    await page.getByLabel('Motivo de este cambio de perfil', { exact: true })
      .fill('Verificar persistencia real del perfil canónico en una sesión local aislada.');
    await page.getByRole('button', { name: 'Guardar y aplicar perfil' }).click();
    try {
      await page.getByText(/Desired y ficheros del runtime quedaron actualizados/u).waitFor({ timeout: 30_000 });
    } catch (error) {
      const alert = await page.getByRole('alert').innerText().catch(() => 'sin alerta visible');
      throw new Error(`profile PUT feedback timeout; statuses=${responseStatuses.join(',')}; body=${responseBodies.join(' | ')}; alert=${alert}`, { cause: error });
    }
    expect(responseStatuses).toContain(202);
    await page.getByText('Adopción no acreditada', { exact: true }).waitFor({ timeout: 10_000 });

    const persisted = await active.database.pool.query<{
      purpose: string | null; responsibilities: string[]; revision: string; applied_revision: string | null;
    }>(`SELECT purpose,responsibilities,revision::text AS revision,applied_revision::text AS applied_revision
          FROM agent_profiles WHERE tenant_id=$1 AND alias=$2`, [active.tenant, active.targetAlias]);
    expect(persisted.rows).toEqual([{
      purpose: null, responsibilities: [marker], revision: '1', applied_revision: null,
    }]);
    const revisions = await active.database.pool.query<{
      revision: string; operation: string; responsibilities: string[]; actor_tenant: string; actor_alias: string;
    }>(`SELECT revision::text AS revision,operation,responsibilities,actor_tenant,actor_alias
          FROM agent_profile_revisions WHERE tenant_id=$1 AND alias=$2 ORDER BY id DESC LIMIT 1`,
      [active.tenant, active.targetAlias]);
    expect(revisions.rows).toEqual([{
      revision: '1', operation: 'insert', responsibilities: [marker],
      actor_tenant: null, actor_alias: null,
    }]);
    const audit = await active.database.pool.query<{ action: string; decision: string; tenant_id: string; actor_alias: string }>(
      `SELECT action,decision,tenant_id,actor_alias FROM audit_events
        WHERE action='agent_profile.write' AND tenant_id=$1 AND actor_alias=$2 ORDER BY created_at DESC LIMIT 1`,
      [active.tenant, active.operatorAlias],
    );
    expect(audit.rows).toEqual([{
      action: 'agent_profile.write', decision: 'allow', tenant_id: active.tenant, actor_alias: active.operatorAlias,
    }]);

    const file = await docker(['exec', '--user', 'node', replacementContainer.name, 'cat', '/tmp/.codex/AGENTS.md']);
    expect(file).toContain(marker);
    expect(file).toContain('## Rol, responsabilidades y restricciones');
    expect(file).toContain('Responsabilidades:');
    const fileSha = (await docker(['exec', '--user', 'node', replacementContainer.name, 'sha256sum', '/tmp/.codex/AGENTS.md'])).split(/\s+/u)[0];
    const fileBytesOutput = await docker(['exec', '--user', 'node', replacementContainer.name, 'wc', '-c', '/tmp/.codex/AGENTS.md']);
    const fileBytes = Number(fileBytesOutput.split(/\s+/u)[0]);
    expect(fileSha).toMatch(/^[a-f0-9]{64}$/u);
    expect(Number.isSafeInteger(fileBytes)).toBe(true);
    const readback = await active.request(profilePath, { headers: { cookie: session.cookie, accept: 'application/json' } });
    expect(readback.status, readback.body).toBe(200);
    const profile = JSON.parse(readback.body) as {
      runtime_state: string; exists: boolean; revision: number; applied_revision: number | null;
      runtime_verification: { state: string; generation: string; documents: { path: string; expected_sha: string; expected_bytes: number }[] };
      runtime_adoption: unknown;
    };
    expect(profile).toMatchObject({ runtime_state: 'pending_session_refresh', exists: true, revision: 1, applied_revision: null, runtime_adoption: null });
    expect(profile.runtime_verification.state).toBe('current');
    const document = profile.runtime_verification.documents[0];
    if (!document) throw new Error('runtime verification omitted AGENTS.md');
    expect(profile.runtime_verification.documents).toEqual([{
      path: '/tmp/.codex/AGENTS.md',
      expected_sha: fileSha,
      expected_bytes: fileBytes,
      observed_sha: fileSha,
      observed_bytes: fileBytes,
      name: 'AGENTS.md',
      current: true,
    }]);
    expect(document.expected_sha).toBe(fileSha);
    expect(document.expected_bytes).toBe(fileBytes);
    process.stdout.write(`Config mobile profile E2E: target=${active.tenant}/${active.targetAlias} revision=${String(profile.revision)} HTTP=${responseStatuses.join(',')} file_sha=${document.expected_sha} bytes=${String(document.expected_bytes)} adoption=${profile.runtime_state}\n`);
  }, 180_000);
});
