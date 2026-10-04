import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRealPtyFixture, type RealPtyFixture } from './real-pty-agent.fixtures.js';

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
  await page.getByRole('link', { name: /Conversaciones/u }).waitFor({ state: 'visible', timeout: 20_000 });
}

async function openTerminalFromMenu(page: Awaited<ReturnType<RealPtyFixture['browserPage']>>): Promise<void> {
  await page.getByRole('button', { name: 'Herramientas' }).click();
  const tools = page.getByRole('region', { name: 'Herramientas de Cauce' });
  await tools.getByRole('link', { name: 'Terminal de agentes' }).click();
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
      .find((button) => button.textContent.trim() === 'PTY')?.disabled);
    if (state !== undefined && state === !enabled) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
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
  it('mantiene el shell disponible al operador y niega al lector el mismo destino sin crear sesiones', async () => {
    if (!fixture) throw new Error('real PTY fixture not initialized');
    const active = fixture;
    const reader = await provisionReader(active);
    const initialSessions = await active.database.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2',
      [active.tenant, active.targetAlias],
    );
    const initialAudit = await active.database.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_events WHERE action LIKE 'terminal.session.%'",
    );

    const operatorPage = await active.browserPage({ width: 1440, height: 900 });
    await login(active, operatorPage, active.operatorEmail, active.operatorPassword);
    await openTerminalFromMenu(operatorPage);
    await waitForOwnTarget(active, operatorPage);
    await operatorPage.getByText('CONCEDIDO', { exact: true }).waitFor({ state: 'visible', timeout: 25_000 });
    await operatorPage.getByRole('button', { name: new RegExp(`Abrir sesión con ${active.targetAlias}`, 'u') }).click();
    const operatorPty = operatorPage.getByRole('button', { name: 'PTY', exact: true });
    await operatorPty.waitFor({ state: 'visible', timeout: 25_000 });
    expect(await waitForPtyButton(operatorPage, true)).toBe(true);
    await expectNoViewportOverflow(operatorPage, 1440);
    if (artifactDirectory) {
      await mkdir(artifactDirectory, { recursive: true });
      await operatorPage.screenshot({ path: join(artifactDirectory, 'terminal-operator-1440.png') });
    }

    const readerPage = await active.browserPage({ width: 360, height: 800 });
    const readerSessionRequests: string[] = [];
    readerPage.on('response', (response) => {
      if (response.request().method() === 'POST' && response.url().endsWith('/v3/console/terminal/sessions')) {
        readerSessionRequests.push(response.url());
      }
    });
    await login(active, readerPage, reader.email, reader.password);
    await readerPage.getByRole('button', { name: 'Herramientas' }).click();
    const readerTools = readerPage.getByRole('region', { name: 'Herramientas de Cauce' });
    const terminalLink = readerTools.getByRole('link', { name: 'Terminal de agentes' });
    await terminalLink.waitFor({ state: 'visible', timeout: 10_000 });
    const linkState = await readerPage.evaluate(() => {
      const link = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href="/terminal"]'))
        .find((candidate) => candidate.getAttribute('aria-label') === 'Terminal de agentes');
      return { disabled: link?.getAttribute('aria-disabled'), title: link?.getAttribute('title') };
    });
    expect(linkState.disabled).toBe('true');
    expect(linkState.title).toMatch(/no tiene permiso de control/u);
    await readerPage.goto(new URL('/terminal', active.baseUrl).toString(), { waitUntil: 'domcontentloaded' });
    await readerPage.getByRole('heading', { name: 'Terminal de agentes' }).waitFor({ timeout: 20_000 });
    await readerPage.getByText('DENEGADO', { exact: true }).waitFor({ state: 'visible', timeout: 25_000 });
    await readerPage.getByRole('button', { name: new RegExp(`Abrir sesión con ${active.targetAlias}`, 'u') }).click();
    const readerPty = readerPage.getByRole('button', { name: 'PTY', exact: true });
    await readerPty.waitFor({ state: 'visible', timeout: 25_000 });
    expect(await waitForPtyButton(readerPage, false)).toBe(true);
    const ptyDisabled = await readerPage.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent.trim() === 'PTY')?.disabled);
    expect(ptyDisabled).toBe(true);
    await expectNoViewportOverflow(readerPage, 360);
    if (artifactDirectory) {
      await readerPage.screenshot({ path: join(artifactDirectory, 'terminal-reader-360.png') });
    }

    expect(readerSessionRequests).toEqual([]);
    const finalSessions = await active.database.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2',
      [active.tenant, active.targetAlias],
    );
    const finalAudit = await active.database.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_events WHERE action LIKE 'terminal.session.%'",
    );
    expect(finalSessions.rows[0]?.count).toBe(initialSessions.rows[0]?.count);
    expect(finalAudit.rows[0]?.count).toBe(initialAudit.rows[0]?.count);
    process.stdout.write(`terminal-browser-rbac viewport=1440/360 operator=allowed reader=denied sessionRows=${String(finalSessions.rows[0]?.count)} auditRows=${String(finalAudit.rows[0]?.count)} browser=${active.browserContainer}\n`);
  }, 180_000);
});
