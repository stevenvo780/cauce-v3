import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRealPtyFixture, type RealPtyFixture } from './real-pty-agent.fixtures.js';
import { observeUiBootstrap } from './ui-bootstrap-diagnostics.js';
import { apiGet, asV4Page, bodySnippet, type V4Page } from './v4-console-real-browser.helpers.js';

const execute = promisify(execFile);
const OWNER = 'e2e-a10-contextos-1025b';
const RUN_ID = randomUUID();
const ARTIFACTS = process.env.CAUCE_E2E_ARTIFACT_DIR
  ?? join(process.cwd(), '.delegados/v4/recibos/e2e-a10-contextos-1025b/profile');
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

async function screenshot(page: V4Page, name: string): Promise<void> {
  await mkdir(ARTIFACTS, { recursive: true });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.screenshot({ path: join(ARTIFACTS, `profile-${name}-${String(viewport.width)}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function openContext(): Promise<V4Page> {
  if (!fixture) throw new Error('measured profile fixture missing');
  const page = asV4Page(await fixture.browserPage({ width: 1440, height: 900 }));
  await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Correo', { exact: true }).fill(fixture.operatorEmail);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.operatorPassword);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 20_000 });
  await page.goto(`${fixture.baseUrl}/messages/${fixture.tenant}/${fixture.targetAlias}?view=context`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Responsabilidades', { exact: true }).waitFor({ timeout: 20_000 });
  return page;
}

async function openManual(page: V4Page): Promise<ReturnType<V4Page['getByLabel']>> {
  await page.getByRole('tab', { name: /^Ficheros/u }).click();
  const editor = page.getByLabel('Contenido de AGENTS.md (manual del sitio)', { exact: true });
  if (await editor.count() > 0 && await editor.isVisible()) return editor;
  await page.getByRole('button', { name: /AGENTS\.md \(manual del sitio\)/u }).click();
  await editor.waitFor({ timeout: 20_000 });
  return editor;
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
  expect(imageIdentity).toEqual([active.agentImageId, OWNER]);

  const originalIdentity = (await docker([
    'inspect', '--format', '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}}', active.agentContainer,
  ])).split(/\s+/u);
  expect(originalIdentity).toEqual([active.agentContainerId, OWNER]);
  await docker(['rm', '--force', active.agentContainer]);

  const name = `zz-canary-${OWNER}-${RUN_ID}`;
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
  fixture = await startRealPtyFixture({ governanceRelay: true, owner: OWNER, resourcePrefix: `zz-canary-${OWNER}` });
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

    const page = await active.browserPage({ width: 390, height: 844 });
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
      const artifactDirectory = ARTIFACTS;
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
    await page.getByRole('heading', { name: 'Ajustes', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    const artifactDirectory = ARTIFACTS;
    const section = page.getByRole('combobox', { name: 'Sección', exact: true });
    if (await section.count()) await section.selectOption('agentes');
    else await page.getByRole('tab', { name: 'Agentes', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Buscar agente o grupo' }).fill(active.targetAlias);
    await page.getByRole('button', { name: `Acciones de ${active.tenant}/${active.targetAlias}`, exact: true }).click();
    const openContext = page.getByRole('menuitem', { name: `Perfil y contexto de ${active.tenant}/${active.targetAlias}`, exact: true });
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
      await page.getByText(/La revisión deseada y los ficheros del runtime quedaron actualizados/u).waitFor({ timeout: 30_000 });
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
      actor_tenant: active.tenant, actor_alias: active.operatorAlias,
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
    await screenshot(asV4Page(page), 'saved');
    process.stdout.write(`Config mobile profile E2E: target=${active.tenant}/${active.targetAlias} revision=${String(profile.revision)} HTTP=${responseStatuses.join(',')} file_sha=${document.expected_sha} bytes=${String(document.expected_bytes)} adoption=${profile.runtime_state}\n`);
  }, 180_000);

  it('lee y guarda el manual real con conflicto CAS y muestra directiva, historial y recarga sin acreditar adopción', async () => {
    if (!fixture || !replacementContainer) throw new Error('measured runtime missing');
    const page = await openContext();
    const before = await apiGet(page, `/v3/console/tenants/${fixture.tenant}/agents/${fixture.targetAlias}/perfil`);
    const previousFields = before.body.perfil as Record<string, string | string[] | null>;
    const concurrent = await openContext();
    const editor = await openManual(page);
    const otherEditor = await openManual(concurrent);
    const initial = await editor.inputValue();
    expect(initial).toContain('Responsabilidades:');
    await page.getByRole('button', { name: /AGENTS\.md \(manual del sitio\)/u }).click();
    expect(await editor.count()).toBe(0);
    await openManual(page);
    expect(await editor.inputValue()).toBe(initial);
    await editor.fill(`${initial}\nBorrador que debe descartarse.\n`);
    await page.getByRole('button', { name: 'Descartar y releer', exact: true }).click();
    await expect.poll(() => editor.inputValue()).toBe(initial);
    const mine = `${initial}\nManual editado desde Chromium ${RUN_ID}.\n`;
    const theirs = `${initial}\nManual concurrente desde Chromium ${RUN_ID}.\n`;
    await editor.fill(mine);
    await otherEditor.fill(theirs);
    await concurrent.getByLabel('Motivo del guardado', { exact: true }).fill('Actualizar el manual desde otra pestaña para comprobar CAS.');
    await concurrent.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect.poll(() => docker(['exec', '--user', 'node', replacementContainer?.name ?? '', 'cat', '/tmp/.codex/AGENTS.md']))
      .toBe(theirs.trimEnd());
    await page.getByLabel('Motivo del guardado', { exact: true }).fill('Comprobar que el manual conserva el borrador frente a edición concurrente.');
    await page.getByRole('button', { name: 'Guardar', exact: true }).click();
    const conflict = page.getByRole('group', { name: 'Conflicto de versión', exact: true });
    await conflict.waitFor({ timeout: 20_000 });
    expect(await editor.inputValue()).toBe(mine);
    expect(await conflict.innerText()).toContain('Manual concurrente desde Chromium');
    await screenshot(page, 'manual-conflict');
    await conflict.getByRole('button', { name: 'Descartar mis cambios', exact: true }).click();
    await expect.poll(() => editor.inputValue()).toBe(theirs);
    const retry = `${theirs}Manual conservado al reintentar ${RUN_ID}.\n`;
    await editor.fill(retry);
    const freshConcurrent = await openManual(concurrent);
    await freshConcurrent.fill(`${theirs}Segunda edición concurrente ${RUN_ID}.\n`);
    await concurrent.getByLabel('Motivo del guardado', { exact: true }).fill('Avanzar la huella antes de reintentar el borrador local.');
    await concurrent.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect.poll(() => docker(['exec', '--user', 'node', replacementContainer?.name ?? '', 'cat', '/tmp/.codex/AGENTS.md']))
      .toContain('Segunda edición concurrente');
    await page.getByLabel('Motivo del guardado', { exact: true }).fill('Reaplicar explícitamente el borrador conservado sobre la huella más nueva.');
    await page.getByRole('button', { name: 'Guardar', exact: true }).click();
    await conflict.waitFor({ timeout: 20_000 });
    await conflict.getByRole('button', { name: 'Releer y reintentar con mis cambios', exact: true }).click();
    expect(await editor.inputValue()).toBe(retry);
    await page.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect.poll(() => docker(['exec', '--user', 'node', replacementContainer?.name ?? '', 'cat', '/tmp/.codex/AGENTS.md']))
      .toBe(retry.trimEnd());
    await page.getByText('Lo que esto todavía no hace', { exact: true }).click();
    await page.locator('details').filter({ hasText: 'Lo que esto todavía no hace' })
      .getByText(/compatibles se gestionan en Perfil/u).waitFor({ timeout: 10_000 });
    await screenshot(page, 'manual-read');
    const afterManual = await apiGet(page, `/v3/console/tenants/${fixture.tenant}/agents/${fixture.targetAlias}/perfil`);
    expect(afterManual.body.contaminacion).toMatchObject({ contaminated: false, findings: [] });

    await page.getByRole('tab', { name: 'Directiva', exact: true }).click();
    await page.getByRole('heading', { name: 'Capa 1 · Rol declarado', exact: true }).waitFor({ timeout: 20_000 });
    await page.getByText('Ver el contenido', { exact: true }).first().click();
    await page.getByRole('tabpanel', { name: 'Directiva', exact: true })
      .getByText(`Manual concurrente desde Chromium ${RUN_ID}.`, { exact: false }).waitFor({ timeout: 20_000 });
    await screenshot(page, 'directive');
    await page.getByRole('button', { name: 'Editar el manual en Ficheros', exact: true }).click();
    await page.getByRole('tab', { name: 'Directiva', exact: true }).click();
    await page.getByRole('button', { name: 'Editar los campos canónicos', exact: true }).click();
    const authored = {
      purpose: `Propósito público ${RUN_ID}.`, role_summary: `Perfil actualizado ${RUN_ID}.`,
      human_brief: 'Operador sintético: respuestas breves y verificables.',
      responsibilities: ['Verificar el contexto público.', 'Preservar las escrituras concurrentes.'],
      restrictions: ['No cambiar recursos ajenos.'], tools: ['Consola local de prueba.'],
      operating_rules: ['Releer los recibos antes de reintentar.'],
    };
    for (const [label, value] of [
      ['Identidad y propósito', authored.purpose], ['Rol declarado', authored.role_summary],
      ['Tu humano y cómo tratarlo', authored.human_brief], ['Responsabilidades', authored.responsibilities.join('\n')],
      ['Restricciones', authored.restrictions.join('\n')], ['Herramientas declaradas en el contexto', authored.tools.join('\n')],
      ['Instrucciones fijas de funcionamiento', authored.operating_rules.join('\n')],
    ] as const) await page.getByLabel(label, { exact: true }).fill(value);
    await page.getByLabel('Motivo de este cambio de perfil', { exact: true }).fill('Verificar diferencias y restauración del historial canónico.');
    await page.getByRole('button', { name: 'Guardar y aplicar perfil', exact: true }).click();
    await page.getByText(/La revisión deseada y los ficheros del runtime quedaron actualizados/u).waitFor({ timeout: 30_000 });
    const saved = await apiGet(page, `/v3/console/tenants/${fixture.tenant}/agents/${fixture.targetAlias}/perfil`);
    expect(saved.body).toMatchObject({ revision: 2, perfil: authored });
    const savedRow = await fixture.database.pool.query(
      'SELECT purpose,role_summary,human_brief,responsibilities,restrictions,tools,operating_rules FROM agent_profiles WHERE tenant_id=$1 AND alias=$2',
      [fixture.tenant, fixture.targetAlias]);
    expect(savedRow.rows).toEqual([authored]);
    await page.getByRole('tab', { name: 'Historial', exact: true }).click();
    await page.getByText('Cambio del perfil · revisión 2', { exact: true }).waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Ver qué cambió', exact: true }).first().click();
    const differences = page.getByRole('group', { name: 'Diferencias con la revisión 1', exact: true });
    await differences.waitFor({ timeout: 15_000 });
    expect(await differences.innerText()).toContain(authored.purpose);
    expect(await differences.innerText()).toContain(authored.role_summary);
    expect(await differences.innerText()).toContain(authored.human_brief);
    await screenshot(page, 'profile-history');
    await page.getByRole('button', { name: 'Restaurar esta revisión', exact: true }).nth(1).click();
    for (const [field, label] of [
      ['purpose', 'Identidad y propósito'], ['role_summary', 'Rol declarado'],
      ['human_brief', 'Tu humano y cómo tratarlo'], ['responsibilities', 'Responsabilidades'],
      ['restrictions', 'Restricciones'], ['tools', 'Herramientas declaradas en el contexto'],
      ['operating_rules', 'Instrucciones fijas de funcionamiento'],
    ] as const) {
      const value = previousFields[field];
      await expect.poll(() => page.getByLabel(label, { exact: true }).inputValue())
        .toBe(Array.isArray(value) ? value.join('\n') : value ?? '');
    }
    const unchanged = await fixture.database.pool.query<{ revision: string }>('SELECT revision::text FROM agent_profiles WHERE tenant_id=$1 AND alias=$2', [fixture.tenant, fixture.targetAlias]);
    expect(unchanged.rows).toEqual([{ revision: '2' }]);
    await page.getByRole('button', { name: 'Descartar borrador de perfil y releer', exact: true }).click();
    await page.getByLabel('Motivo de la recarga', { exact: true }).fill('Reescribir y medir el contexto sin reiniciar la conversación.');
    await page.getByRole('button', { name: 'Recargar contexto', exact: true }).click();
    await page.getByText(/Contexto reescrito en la revisión 2/u).waitFor({ timeout: 30_000 });
    await page.getByText('Adopción no acreditada', { exact: true }).waitFor({ timeout: 20_000 });
    await screenshot(page, 'context-reload');
    const profile = await apiGet(page, `/v3/console/tenants/${fixture.tenant}/agents/${fixture.targetAlias}/perfil`);
    expect(profile.body).toMatchObject({ revision: 2, applied_revision: null, runtime_state: 'pending_session_refresh' });
    expect(await docker(['exec', '--user', 'node', replacementContainer.name, 'cat', '/tmp/.codex/AGENTS.md']))
      .toContain(`Perfil actualizado ${RUN_ID}.`);
  }, 240_000);

  it('crea, reconoce y elimina una pieza nativa real y bloquea el reinicio sin autorización o capacidad acreditada', async () => {
    if (!fixture || !replacementContainer) throw new Error('measured runtime missing');
    const page = await openContext();
    await page.getByText('Piezas nativas · MCP, skills y subagentes', { exact: true }).click();
    await page.getByRole('button', { name: 'Leer inventario nativo', exact: true }).click();
    const native = page.getByRole('region', { name: 'Editor de piezas nativas', exact: true });
    await native.getByText(/Arnés: codex/u).waitFor({ timeout: 20_000 });
    const id = `zz-canary-${RUN_ID.slice(0, 8)}`;
    const content = `---\nname: ${id}\ndescription: Contexto sintético de navegador para verificar un archivo real.\n---\n\nInstrucciones públicas del canario ${RUN_ID}.\n`;
    await native.getByLabel('Nombre de pieza', { exact: true }).fill(id);
    await native.getByRole('button', { name: 'Leer o preparar pieza', exact: true }).click();
    const markdown = native.getByLabel('Contenido Markdown', { exact: true });
    await expect.poll(() => markdown.isDisabled(), { timeout: 20_000 }).toBe(false);
    await markdown.fill(content);
    await native.getByLabel('Motivo del cambio nativo', { exact: true }).fill('Crear una pieza sintética y verificar el archivo y su recibo durable.');
    await native.getByRole('button', { name: 'Guardar pieza nativa', exact: true }).click();
    try { await native.getByText('Guardado con respaldo privado y SHA verificado. Pendiente de recarga.', { exact: true }).waitFor({ timeout: 30_000 }); }
    catch (cause) { throw new Error(`native write failed: ${await bodySnippet(page)}`, { cause }); }
    expect(await docker(['exec', '--user', 'node', replacementContainer.name, 'cat', `/tmp/.codex/skills/${id}/SKILL.md`])).toBe(content.trimEnd());
    await native.getByRole('button', { name: 'Verificar reconocimiento del proveedor', exact: true }).click();
    await native.getByText(/pendiente de próxima sesión/u).waitFor({ timeout: 20_000 });
    expect(await native.getByRole('button', { name: 'Reiniciar este agente y verificar archivos', exact: true }).count()).toBe(0);
    await screenshot(page, 'native-saved');
    await native.getByLabel('Motivo del cambio nativo', { exact: true }).fill('Eliminar solo la pieza canario propia y comprobar ausencia.');
    await native.getByRole('button', { name: 'Borrar pieza nativa', exact: true }).click();
    await native.getByRole('button', { name: 'Cancelar borrado', exact: true }).click();
    expect(await docker(['exec', '--user', 'node', replacementContainer.name, 'test', '-f', `/tmp/.codex/skills/${id}/SKILL.md`])).toBe('');
    await native.getByRole('button', { name: 'Borrar pieza nativa', exact: true }).click();
    await native.getByRole('button', { name: 'Confirmar borrado de pieza', exact: true }).click();
    await native.getByText('Pieza borrada y ausencia verificada. Pendiente de recarga.', { exact: true }).waitFor({ timeout: 30_000 });
    expect(await docker(['exec', '--user', 'node', replacementContainer.name, 'test', '!', '-f', `/tmp/.codex/skills/${id}/SKILL.md`])).toBe('');
    await screenshot(page, 'native-deleted');

    await page.goto(`${fixture.baseUrl}/terminal/${fixture.tenant}/${fixture.targetAlias}`, { waitUntil: 'domcontentloaded' });
    const recovery = page.getByRole('region', { name: `Recuperación de ${fixture.targetAlias}`, exact: true });
    await recovery.getByRole('button', { name: 'Reiniciar agente', exact: true }).click();
    await recovery.getByRole('alert').waitFor({ timeout: 20_000 });
    const inspection = await apiGet(page, `/v3/console/tenants/${fixture.tenant}/agents/${fixture.targetAlias}/recovery`);
    expect([403, 501]).toContain(inspection.status);
    expect(inspection.body.error).toBe(inspection.status === 403 ? 'forbidden' : 'unsupported');
    expect(await recovery.innerText()).toContain(inspection.body.message);
    expect(await recovery.getByRole('button', { name: 'Confirmar reinicio y reanudar', exact: true }).count()).toBe(0);
    await screenshot(page, 'recovery-blocked');
    expect(await recovery.getByRole('button', { name: 'Cancelar', exact: true }).count()).toBe(0);
    expect(await docker(['inspect', '--format', '{{.Id}}', replacementContainer.name])).toBe(replacementContainer.id);
    process.stdout.write(`Config profile recovery blocked: HTTP=${String(inspection.status)} error=${String(inspection.body.error)} same_container=true\n`);
  }, 180_000);

  it('valida límites, conserva borradores, bloquea el perfil por manual pendiente y resuelve ambas salidas de su CAS real', async () => {
    if (!fixture || !replacementContainer) throw new Error('measured runtime missing');
    const page = await openContext();
    const concurrent = await openContext();
    const path = `/v3/console/tenants/${fixture.tenant}/agents/${fixture.targetAlias}/perfil`;
    const initial = await apiGet(page, path);
    const limits = initial.body.limites as { purpose: number; role_summary: number; items: number; item: number; total: number };
    const purpose = page.getByLabel('Identidad y propósito', { exact: true });
    const save = page.getByRole('button', { name: 'Guardar y aplicar perfil', exact: true });
    if (await page.getByLabel('Motivo de este cambio de perfil', { exact: true }).isDisabled()) {
      await screenshot(page, 'profile-uneditable');
      throw new Error(`profile is not editable: ${JSON.stringify({ runtime_state: initial.body.runtime_state,
        contaminacion: initial.body.contaminacion, runtime_reason: initial.body.runtime_reason })} ${await bodySnippet(page)}`);
    }
    await page.getByLabel('Motivo de este cambio de perfil', { exact: true }).fill('Validar límites sin persistir el texto inválido.');
    await purpose.fill('x'.repeat(limits.total + 1));
    await page.getByText(/El perfil entero:.*unidades/u).waitFor({ timeout: 10_000 });
    expect(await save.isDisabled()).toBe(true);
    await purpose.fill('x'.repeat(limits.purpose + 1));
    expect(await save.isDisabled()).toBe(true);
    await purpose.fill('Propósito válido para comprobar límites.');
    await page.getByLabel('Responsabilidades', { exact: true }).fill(Array.from({ length: limits.items + 1 }, (_, i) => `Entrada ${String(i)}`).join('\n'));
    expect(await save.isDisabled()).toBe(true);
    await page.getByLabel('Responsabilidades', { exact: true }).fill('x'.repeat(limits.item + 1));
    expect(await save.isDisabled()).toBe(true);
    await page.getByLabel('Responsabilidades', { exact: true }).fill('Entrada válida para aislar el límite de rol.');
    await page.getByLabel('Rol declarado', { exact: true }).fill('x'.repeat(limits.role_summary + 1));
    expect(await save.isDisabled()).toBe(true);
    await page.getByLabel('Rol declarado', { exact: true }).fill('😀'.repeat(601));
    await page.getByText(/601 puntos de código · 1202 unidades UTF-16/u).waitFor({ timeout: 10_000 });
    await page.getByText(/Son 601 caracteres, que la base acepta, pero 1202 unidades UTF-16/u).waitFor({ timeout: 10_000 });
    await screenshot(page, 'profile-limits');
    expect((await apiGet(page, path)).body.revision).toBe(initial.body.revision);
    await page.getByRole('button', { name: 'Descartar borrador de perfil y releer', exact: true }).click();
    await expect.poll(() => purpose.inputValue()).toBe((initial.body.perfil as { purpose: string | null }).purpose ?? '');

    const mine = `Borrador preservado ${RUN_ID}.`;
    await purpose.fill(mine);
    let reloadWarnings = 0;
    page.on('dialog', (value) => {
      const dialog = value as { type(): string; dismiss(): Promise<void> };
      if (dialog.type() === 'beforeunload') reloadWarnings += 1;
      void dialog.dismiss();
    });
    await page.evaluate(() => { window.location.reload(); });
    await expect.poll(() => reloadWarnings).toBe(1);
    expect(await purpose.inputValue()).toBe(mine);
    await page.getByRole('link', { name: 'Volver a la conversación', exact: true }).click();
    const actions = page.getByRole('button', { name: `Acciones de ${fixture.targetAlias}`, exact: true });
    await actions.nth((await actions.count()) - 1).click();
    await page.getByRole('menuitem', { name: 'Perfil y contexto', exact: true }).click();
    await expect.poll(() => purpose.inputValue()).toBe(mine);
    await page.getByText('Vista previa de los ficheros del arnés', { exact: true }).click();
    const preview = page.locator('details').filter({ hasText: 'Vista previa de los ficheros del arnés' });
    await preview.getByRole('tab', { name: 'AGENTS.md', exact: true }).click();
    expect(await preview.locator('pre').innerText()).not.toContain(mine);
    const manual = await openManual(page);
    const original = await manual.inputValue();
    await manual.fill(`${original}\nManual pendiente ${RUN_ID}.\n`);
    await page.getByRole('tab', { name: /^Perfil/u }).click();
    await page.getByText(/Hay un borrador manual pendiente/u).waitFor({ timeout: 10_000 });
    expect(await purpose.inputValue()).toBe(mine);
    expect(await save.isDisabled()).toBe(true);
    await screenshot(page, 'manual-blocks-profile');
    await page.getByRole('tab', { name: /^Ficheros/u }).click();
    await page.getByRole('button', { name: 'Descartar y releer', exact: true }).click();
    await page.getByRole('tab', { name: /^Perfil/u }).click();
    await page.getByRole('button', { name: 'Actualizar estado del contexto', exact: true }).click();
    expect(await purpose.inputValue()).toBe(mine);

    const otherPurpose = concurrent.getByLabel('Identidad y propósito', { exact: true });
    const otherSave = concurrent.getByRole('button', { name: 'Guardar y aplicar perfil', exact: true });
    await otherPurpose.fill(`Perfil concurrente ${RUN_ID}.`);
    await concurrent.getByLabel('Motivo de este cambio de perfil', { exact: true }).fill('Guardar el perfil de otra pestaña antes del borrador conservado.');
    await otherSave.click();
    await concurrent.getByText(/La revisión deseada y los ficheros del runtime quedaron actualizados/u).waitFor({ timeout: 30_000 });
    await page.getByLabel('Motivo de este cambio de perfil', { exact: true }).fill('Comprobar que el CAS impide perder un perfil guardado desde otra pestaña.');
    await save.click();
    const conflict = page.getByRole('group', { name: 'Conflicto de versión', exact: true });
    await conflict.waitFor({ timeout: 20_000 });
    expect(await purpose.inputValue()).toBe(mine);
    await screenshot(page, 'profile-cas');
    await conflict.getByRole('button', { name: 'Descartar mis cambios', exact: true }).click();
    await expect.poll(() => purpose.inputValue()).toBe(`Perfil concurrente ${RUN_ID}.`);
    await purpose.fill(mine);
    await otherPurpose.fill(`Segunda revisión concurrente ${RUN_ID}.`);
    await concurrent.getByLabel('Motivo de este cambio de perfil', { exact: true }).fill('Crear una segunda revisión para comprobar la salida de reintento.');
    await otherSave.click();
    await expect.poll(async () => (await apiGet(concurrent, path)).body.revision).toBe(Number(initial.body.revision) + 2);
    await page.getByLabel('Motivo de este cambio de perfil', { exact: true }).fill('Reaplicar el borrador tras revisar el conflicto explícito.');
    await save.click();
    await conflict.waitFor({ timeout: 20_000 });
    await conflict.getByRole('button', { name: 'Releer y reintentar con mis cambios', exact: true }).click();
    await save.click();
    await expect.poll(async () => (await apiGet(page, path)).body.revision).toBe(Number(initial.body.revision) + 3);
    expect((await apiGet(page, path)).body.perfil).toMatchObject({ purpose: mine });
    expect(await docker(['exec', '--user', 'node', replacementContainer.name, 'cat', '/tmp/.codex/AGENTS.md'])).toContain(mine);
    await screenshot(page, 'profile-retry');
  }, 240_000);

  it('distingue un manual ausente, vacío y recortado sin permitir reemplazar el prefijo', async () => {
    if (!fixture || !replacementContainer) throw new Error('measured runtime missing');
    const page = await openContext();
    const container = replacementContainer.name;
    const path = '/tmp/.codex/AGENTS.md';
    const original = (await execute('docker', ['exec', '--user', 'node', container, 'cat', path])).stdout;
    const originalSha = await docker(['exec', '--user', 'node', container, 'sha256sum', path]);
    const profilePath = `/v3/console/tenants/${fixture.tenant}/agents/${fixture.targetAlias}/perfil`;
    const revision = (await apiGet(page, profilePath)).body.revision;
    try {
      await docker(['exec', '--user', 'node', container, 'rm', path]);
      let editor = await openManual(page);
      await page.getByText(/Este fichero todavía no existe. Si guardas, se crea/u).waitFor({ timeout: 20_000 });
      expect(await editor.inputValue()).toBe('');
      await screenshot(page, 'manual-absent');
      await dockerInput(['exec', '-i', '--user', 'node', container, 'sh', '-lc', 'cat > /tmp/.codex/AGENTS.md'], '');
      await page.getByRole('button', { name: 'Descartar y releer', exact: true }).click();
      await expect.poll(() => page.getByText(/Este fichero todavía no existe. Si guardas, se crea/u).count()).toBe(0);
      editor = page.getByLabel('Contenido de AGENTS.md (manual del sitio)', { exact: true });
      expect(await editor.inputValue()).toBe('');
      expect(await docker(['exec', '--user', 'node', container, 'wc', '-c', path])).toMatch(/^0\s/u);
      await screenshot(page, 'manual-empty');
      await dockerInput(['exec', '-i', '--user', 'node', container, 'sh', '-lc', 'cat > /tmp/.codex/AGENTS.md'], 'x'.repeat(256 * 1024 + 1));
      await page.getByRole('button', { name: 'Descartar y releer', exact: true }).click();
      await page.getByText(/Esta lectura está recortada/u).waitFor({ timeout: 20_000 });
      expect(await editor.evaluate(element => element.readOnly)).toBe(true);
      expect(await page.getByRole('button', { name: 'Guardar', exact: true }).isDisabled()).toBe(true);
      expect((await editor.inputValue()).length).toBe(256 * 1024);
      expect(await docker(['exec', '--user', 'node', container, 'wc', '-c', path])).toMatch(/^262145\s/u);
      await screenshot(page, 'manual-truncated');
      const external = `${original}\nEdición exterior sin autorizar ${RUN_ID}.\n`;
      await dockerInput(['exec', '-i', '--user', 'node', container, 'sh', '-lc', 'cat > /tmp/.codex/AGENTS.md'], external);
      await page.getByRole('button', { name: 'Descartar y releer', exact: true }).click();
      await expect.poll(() => editor.inputValue()).toBe(external);
      await editor.fill(`${external}No debe escribirse este intento.\n`);
      await page.getByLabel('Motivo del guardado', { exact: true }).fill('Comprobar que una edición exterior no queda acreditada por un guardado posterior.');
      await page.getByRole('button', { name: 'Guardar', exact: true }).click();
      await page.getByRole('group', { name: 'Conflicto de versión', exact: true }).waitFor({ timeout: 20_000 });
      expect((await execute('docker', ['exec', '--user', 'node', container, 'cat', path])).stdout).toBe(external);
      expect((await apiGet(page, profilePath)).body.contaminacion).toMatchObject({ contaminated: true });
      await screenshot(page, 'manual-external-blocked');
    } finally {
      await dockerInput(['exec', '-i', '--user', 'node', container, 'sh', '-lc', 'cat > /tmp/.codex/AGENTS.md'], original);
      expect(await docker(['exec', '--user', 'node', container, 'sha256sum', path])).toBe(originalSha);
      await page.getByRole('button', { name: 'Descartar y releer', exact: true }).click();
      await expect.poll(() => page.getByLabel('Contenido de AGENTS.md (manual del sitio)', { exact: true }).inputValue()).toBe(original);
      expect((await apiGet(page, profilePath)).body.revision).toBe(revision);
    }
  }, 180_000);
});
