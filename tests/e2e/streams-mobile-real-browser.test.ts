import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRealPtyFixture, type RealPtyFixture } from './real-pty-agent.fixtures.js';
import { decodeTerminalSubject } from '../../services/gateway/src/terminal/authority-continuity.js';
const execute = promisify(execFile);
const artifactDirectory = process.env.CAUCE_E2E_ARTIFACT_DIR;
let fixture: RealPtyFixture | undefined;
interface ContainerEvidence {
  readonly id: string;
  readonly name: string;
  readonly mounts: unknown;
  readonly binds: unknown;
  readonly networks: Record<string, { NetworkID?: string }>;
  readonly ports: unknown;
  readonly networkMode: string;
  readonly owner: string;
}
beforeAll(async () => {
  fixture = await startRealPtyFixture();
}, 10 * 60_000);
async function inspectContainer(reference: string): Promise<ContainerEvidence> {
  const format = '{{.Id}}|{{.Name}}|{{json .Mounts}}|{{json .HostConfig.Binds}}|{{json .NetworkSettings.Networks}}|{{json .NetworkSettings.Ports}}|{{.HostConfig.NetworkMode}}|{{index .Config.Labels "cauce.e2e.owner"}}';
  const { stdout } = await execute('docker', ['inspect', '--format', format, reference], { timeout: 15_000, maxBuffer: 64 * 1024 });
  const [id, name, mounts, binds, networks, ports, networkMode, owner] = stdout.trim().split('|');
  if (!id || !name || mounts === undefined || binds === undefined || networks === undefined || ports === undefined || networkMode === undefined) {
    throw new Error('owned container inspection omitted required resource fields');
  }
  return {
    id,
    name,
    mounts: JSON.parse(mounts) as unknown,
    binds: JSON.parse(binds) as unknown,
    networks: JSON.parse(networks) as Record<string, { NetworkID?: string }>,
    ports: JSON.parse(ports) as unknown,
    networkMode,
    owner: owner ?? '',
  };
}

async function assertContainerAbsent(id: string): Promise<void> {
  try {
    await execute('docker', ['inspect', '--format', '{{.Id}}', id], { timeout: 15_000, maxBuffer: 4 * 1024 });
  } catch (error) {
    if (error instanceof Error && /No such (?:object|container)/iu.test(error.message)) return;
    throw new Error('could not verify owned container removal');
  }
  throw new Error(`owned container remains after fixture cleanup: ${id}`);
}

async function assertNetworkAbsent(id: string): Promise<void> {
  try {
    await execute('docker', ['network', 'inspect', '--format', '{{.Id}}', id], { timeout: 15_000, maxBuffer: 4 * 1024 });
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error
      ? String(error.stderr)
      : error instanceof Error ? error.message : String(error);
    if (stderr.includes(`network ${id} not found`) || stderr.includes(`no such network: ${id}`)) return;
    throw new Error('could not verify owned browser network removal');
  }
  throw new Error(`owned browser network remains after fixture cleanup: ${id}`);
}

afterAll(async () => {
  if (!fixture) return;
  const active = fixture;
  const containerIds = [active.database.container.getId(), active.agentContainerId, active.browserContainer];
  const inspections: PromiseSettledResult<ContainerEvidence>[] = await Promise.allSettled(containerIds.map(inspectContainer));
  const inspectionErrors: unknown[] = [];
  const containers: ContainerEvidence[] = [];
  const containerVerificationReferences: string[] = [];
  for (let index = 0; index < inspections.length; index += 1) {
    const result = inspections[index];
    const reference = containerIds[index];
    if (result?.status === 'rejected') {
      inspectionErrors.push(result.reason);
      if (reference !== undefined) containerVerificationReferences.push(reference);
    } else if (result?.status === 'fulfilled') {
      containers.push(result.value);
      containerVerificationReferences.push(result.value.id);
    }
  }
  const browserNetworks = inspections[2]?.status === 'fulfilled'
    ? Object.entries(inspections[2].value.networks)
      .filter(([name]) => name.startsWith('cauce-ui-network-'))
      .map(([, value]) => value.NetworkID)
      .filter((id): id is string => Boolean(id))
    : [];
  process.stdout.write(`terminal-browser-resources-before ${JSON.stringify({
    containers, inspectionFailures: inspectionErrors.map(() => 'container inspection failed'), ownedBrowserNetworks: browserNetworks,
  })}\n`);

  const cleanupErrors = [...inspectionErrors];
  try {
    await active.close();
  } catch (error) {
    cleanupErrors.push(error);
  }

  const containerChecks: PromiseSettledResult<void>[] = await Promise.allSettled(
    containerVerificationReferences.map(async (id) => assertContainerAbsent(id)),
  );
  for (const result of containerChecks) {
    if (result.status === 'rejected') cleanupErrors.push(result.reason);
  }
  const networkChecks: PromiseSettledResult<void>[] = await Promise.allSettled(
    browserNetworks.map(async (id) => assertNetworkAbsent(id)),
  );
  for (const result of networkChecks) {
    if (result.status === 'rejected') cleanupErrors.push(result.reason);
  }
  process.stdout.write(`terminal-browser-resources-after ${JSON.stringify({
    containersAbsent: containerVerificationReferences, browserNetworksAbsent: browserNetworks,
    failedContainerChecks: containerChecks.filter((result) => result.status === 'rejected').length,
    failedNetworkChecks: networkChecks.filter((result) => result.status === 'rejected').length,
  })}\n`);
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'terminal browser fixture cleanup failed');
});

async function provisionReader(active: RealPtyFixture): Promise<{ email: string; password: string }> {
  const suffix = randomBytes(6).toString('hex');
  const email = `pty-reader-${suffix}@cauce.test`;
  const password = randomBytes(24).toString('base64url');
  try {
    const result = await execute(join(process.cwd(), 'node_modules/.bin/tsx'), [
      'services/gateway/src/console-user-cli.ts', '--email', email, '--name', 'Real PTY E2E reader',
      '--role', 'reader', '--tenant', active.tenant, '--alias', active.operatorAlias,
    ], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        NODE_ENV: 'test',
        DATABASE_URL: active.database.url,
        CAUCE_CONSOLE_USER_PASSWORD: password,
      },
      timeout: 20_000,
      maxBuffer: 64 * 1024,
    });
    if (!result.stdout.includes('cuenta guardada') || result.stdout.includes(password)) {
      throw new Error('reader provisioning did not confirm safely');
    }
  } catch {
    throw new Error('could not provision the synthetic reader in the owned PostgreSQL fixture');
  }
  return { email, password };
}

async function login(
  active: RealPtyFixture,
  page: Awaited<ReturnType<RealPtyFixture['browserPage']>>,
  email: string,
  password: string,
): Promise<void> {
  const response = await page.goto(active.baseUrl, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Contraseña').fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).locator('a[href="/messages"], a[href^="/messages/"]').waitFor({ state: 'visible', timeout: 20_000 });
}

async function openOwnTerminal(active: RealPtyFixture, page: Awaited<ReturnType<RealPtyFixture['browserPage']>>): Promise<void> {
  await page.goto(new URL(`/terminal/${encodeURIComponent(active.tenant)}/${encodeURIComponent(active.targetAlias)}`, active.baseUrl).toString(), { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Terminal de agentes' }).waitFor({ timeout: 20_000 });
}

async function waitForOwnTarget(active: RealPtyFixture, page: Awaited<ReturnType<RealPtyFixture['browserPage']>>): Promise<void> {
  const cookie = (await page.context().cookies(active.baseUrl)).find((item) => item.name === '__Host-cauce_session');
  if (!cookie || !cookie.httpOnly || !cookie.secure) throw new Error('authenticated UI omitted its secure session cookie');
  await active.waitForTarget(`${cookie.name}=${cookie.value}`);
}

async function waitForPtyButton(
  page: Awaited<ReturnType<RealPtyFixture['browserPage']>>,
  enabled: boolean,
): Promise<boolean> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent.trim() === 'Terminal')?.disabled);
    if (state !== undefined && state === !enabled) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function isBrowserRequestLike(value: unknown): value is { url(): string; method(): string } {
  return value !== null && typeof value === 'object'
    && 'url' in value && typeof value.url === 'function'
    && 'method' in value && typeof value.method === 'function';
}

async function expectNoViewportOverflow(page: Awaited<ReturnType<RealPtyFixture['browserPage']>>, width: number): Promise<void> {
  const measurement = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const main = document.querySelector('main');
    return {
      viewport: window.innerWidth,
      documentWidth: root.scrollWidth,
      bodyWidth: body.scrollWidth,
      mainRight: main?.getBoundingClientRect().right ?? Number.NaN,
    };
  });
  expect(measurement.viewport).toBe(width);
  expect(measurement.documentWidth, JSON.stringify(measurement)).toBeLessThanOrEqual(width + 1);
  expect(measurement.bodyWidth, JSON.stringify(measurement)).toBeLessThanOrEqual(width + 1);
  expect(measurement.mainRight, JSON.stringify(measurement)).toBeLessThanOrEqual(width + 1);
}

describe('terminal remoto real: RBAC de lector y geometría en escritorio/móvil', () => {
  it('permite al operador abrir una shell y niega al lector el mismo destino sin efectos durables nuevos', async () => {
    if (!fixture) throw new Error('real PTY fixture not initialized');
    const active = fixture;
    const reader = await provisionReader(active);
    const human = await active.database.pool.query<{ id: string }>(
      'SELECT id::text AS id FROM console_users WHERE email=$1', [active.operatorEmail]);
    expect(human.rows).toHaveLength(1);
    const readOperatorSession = (id?: string) => active.database.pool.query<{ id: string; reason: string; console_subject: string; revoked_at: Date | null; closed_at: Date | null }>(
      `SELECT id::text AS id, reason, console_subject, revoked_at, closed_at
         FROM terminal_sessions
        WHERE tenant_id=$1 AND alias=$2 AND ($3::uuid IS NULL OR id=$3::uuid)
        ORDER BY issued_at DESC
        LIMIT 1`,
      [active.tenant, active.targetAlias, id ?? null],
    );
    const verifyOperatorClosure = async (id: string) => {
      if (!id) throw new Error('opened terminal session id was not captured');
      let closed = await readOperatorSession(id);
      const deadline = Date.now() + 15_000;
      while ((!closed.rows[0]?.revoked_at || !closed.rows[0].closed_at) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        closed = await readOperatorSession(id);
      }
      expect(closed.rows[0]?.id).toBe(id);
      const row = closed.rows[0];
      if (!row) throw new Error('owned terminal row disappeared');
      expect(decodeTerminalSubject(row.console_subject)).toEqual({ kind: 'human', humanId: human.rows[0]?.id,
        actor: { tenantId: active.tenant, alias: active.operatorAlias } });
      expect(closed.rows[0]?.revoked_at).toBeInstanceOf(Date);
      expect(closed.rows[0]?.reason).toBe('');
      expect(closed.rows[0]?.closed_at).toBeInstanceOf(Date);
    };
    const operatorPage = await active.browserPage({ width: 1440, height: 900 });
    await login(active, operatorPage, active.operatorEmail, active.operatorPassword);
    await openOwnTerminal(active, operatorPage);
    await waitForOwnTarget(active, operatorPage);
    const operatorPty = operatorPage.getByRole('button', { name: 'Terminal', exact: true });
    await operatorPty.waitFor({ state: 'visible', timeout: 25_000 });
    expect(await waitForPtyButton(operatorPage, true)).toBe(true);
    await operatorPty.click();
    expect(await operatorPage.getByLabel('Motivo de la sesión').count()).toBe(0);
    await operatorPage.locator('[data-pty-shell][data-state="open"]').waitFor({ state: 'visible', timeout: 30_000 });
    const operatorPtyBar = operatorPage.getByLabel('Sesión PTY activa');
    await operatorPtyBar.waitFor({ state: 'visible', timeout: 25_000 });
    await expectNoViewportOverflow(operatorPage, 1440);
    if (artifactDirectory) {
      await mkdir(artifactDirectory, { recursive: true });
      await operatorPage.screenshot({ path: join(artifactDirectory, 'terminal-operator-1440.png') });
    }
    const operatorSessionId = (await readOperatorSession()).rows[0]?.id ?? '';
    await operatorPage.getByRole('navigation', { name: 'Navegación principal', exact: true }).locator('a[href="/messages"], a[href^="/messages/"]').click();
    await operatorPtyBar.waitFor({ state: 'hidden', timeout: 25_000 });
    await verifyOperatorClosure(operatorSessionId);

    const mobileOperatorPage = await active.browserPage({ width: 360, height: 800 });
    await login(active, mobileOperatorPage, active.operatorEmail, active.operatorPassword);
    await openOwnTerminal(active, mobileOperatorPage);
    await waitForOwnTarget(active, mobileOperatorPage);
    const mobilePty = mobileOperatorPage.getByRole('button', { name: 'Terminal', exact: true });
    await mobilePty.waitFor({ state: 'visible', timeout: 25_000 });
    expect(await waitForPtyButton(mobileOperatorPage, true)).toBe(true);
    await mobilePty.click();
    expect(await mobileOperatorPage.getByLabel('Motivo de la sesión').count()).toBe(0);
    await mobileOperatorPage.locator('[data-pty-shell][data-state="open"]').waitFor({ state: 'visible', timeout: 30_000 });
    await mobileOperatorPage.locator('.xterm-helper-textarea').waitFor({ state: 'visible', timeout: 15_000 });
    const mobileNonce = randomBytes(12).toString('hex');
    const mobileInput = mobileOperatorPage.locator('.xterm-helper-textarea');
    await mobileInput.type(`printf 'MOBILE-PTY:${mobileNonce}\\n'`);
    await mobileInput.press('Enter');
    const outputDeadline = Date.now() + 15_000;
    let terminalOutput = '';
    while (Date.now() < outputDeadline) {
      terminalOutput = await mobileOperatorPage.locator('.xterm-rows').innerText().catch(() => '');
      if (terminalOutput.split(`MOBILE-PTY:${mobileNonce}`).length - 1 >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(terminalOutput.split(`MOBILE-PTY:${mobileNonce}`).length - 1).toBeGreaterThanOrEqual(2);
    await expectNoViewportOverflow(mobileOperatorPage, 360);
    if (artifactDirectory) {
      await mkdir(artifactDirectory, { recursive: true });
      await mobileOperatorPage.screenshot({ path: join(artifactDirectory, 'terminal-operator-360.png') });
    }
    const mobilePtyBar = mobileOperatorPage.getByLabel('Sesión PTY activa');
    const mobileSessionId = (await readOperatorSession()).rows[0]?.id ?? '';
    await mobileOperatorPage.getByRole('navigation', { name: 'Navegación principal', exact: true }).locator('a[href="/messages"], a[href^="/messages/"]').click();
    await mobilePtyBar.waitFor({ state: 'hidden', timeout: 25_000 });
    await verifyOperatorClosure(mobileSessionId);

    const baselineSessions = await active.database.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2',
      [active.tenant, active.targetAlias],
    );
    const baselineAudit = await active.database.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_events WHERE action LIKE 'terminal.session.%'",
    );
    const readerPage = await active.browserPage({ width: 360, height: 800 });
    const readerSessionRequests: string[] = [];
    const readerSessionResponses: string[] = [];
    readerPage.on('request', (request) => {
      if (!isBrowserRequestLike(request)) return;
      const path = new URL(request.url()).pathname;
      if (request.method() === 'POST' && path === '/v3/console/terminal/sessions') {
        readerSessionRequests.push(path);
      }
    });
    readerPage.on('response', (response) => {
      if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/v3/console/terminal/sessions') {
        readerSessionResponses.push(response.url());
      }
    });
    await login(active, readerPage, reader.email, reader.password);
    await openOwnTerminal(active, readerPage);
    const readerPty = readerPage.getByRole('button', { name: 'Terminal', exact: true });
    await readerPty.waitFor({ state: 'visible', timeout: 25_000 });
    expect(await waitForPtyButton(readerPage, false)).toBe(true);
    const ptyDisabled = await readerPage.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent.trim() === 'Terminal')?.disabled);
    expect(ptyDisabled).toBe(true);
    const permissionReason = await readerPage.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent.trim() === 'Terminal')?.title);
    expect(permissionReason).toContain('Tu cuenta no tiene concedido el permiso de conectar a la terminal');
    await expectNoViewportOverflow(readerPage, 360);
    if (artifactDirectory) {
      await readerPage.screenshot({ path: join(artifactDirectory, 'terminal-reader-360.png') });
    }

    expect(readerSessionRequests).toEqual([]);
    expect(readerSessionResponses).toEqual([]);
    const finalSessions = await active.database.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2',
      [active.tenant, active.targetAlias],
    );
    const finalAudit = await active.database.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_events WHERE action LIKE 'terminal.session.%'",
    );
    expect(finalSessions.rows[0]?.count).toBe(baselineSessions.rows[0]?.count);
    expect(finalAudit.rows[0]?.count).toBe(baselineAudit.rows[0]?.count);
    process.stdout.write(`terminal-browser-rbac viewport=1440/360 operator=allowed reader=denied readerSessionPostRequests=${String(readerSessionRequests.length)} readerSessionPostResponses=${String(readerSessionResponses.length)} sessionRows=${String(finalSessions.rows[0]?.count)} auditRows=${String(finalAudit.rows[0]?.count)} browser=${active.browserContainer}\n`);
  }, 180_000);
});
