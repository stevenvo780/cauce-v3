import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';
import { FIXTURE_PROVIDER_IDENTITY, command, docker, dockerInventory, enrollComputer, startComputerHarness,
  type ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { HostSetupConfigSchema } from '../../services/gateway/src/fleet/host-setup.js';
import { startTrustedBrowser, type TrustedBrowser } from './console-functional-browser.fixtures.js';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
import { type CancelFixture } from './v4-fleet-cancel.helpers.js';
import { asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, openRegistration,
  PATTERN_DEFECT_RULE, syntheticPerson, type V4Page } from './v4-console-real-browser.helpers.js';
import { cancelDeployRuntime } from './v4-fleet-cancel-deploy.runtime.js';
import { installCancelDeploySetup, type CancelDeploySetup } from './v4-fleet-cancel-deploy.setup.js';

const consoleRequire = createRequire(join(process.cwd(), 'console/package.json'));
export const CANCEL_DEPLOY_OWNER = process.env.HOME?.match(/^\/tmp\/cauce-e2e-home-(f4f-hades-sin-fila-1025)-[0-9]+$/u)?.[1]
  ?? 'f4e-hades-1025';
export const cancelDeployRun = randomUUID().replaceAll('-', '').slice(0, 8);
export const cancelDeployPrefix = `zz-canary-${CANCEL_DEPLOY_OWNER}-${cancelDeployRun}`;
export const cancelDeployReceipts = join(process.cwd(), '.delegados/v4/recibos', CANCEL_DEPLOY_OWNER, cancelDeployRun);

export interface CancelDeployFixture extends CancelFixture {
  company: string;
  unit: string;
  setup: CancelDeploySetup;
  deploymentImages: Map<string, string>;
}

export async function startCancelDeployFixture(options: { runtimeBundle?: typeof cancelDeployRuntime; initialSharedTui?: boolean } = {}): Promise<CancelDeployFixture> {
  await mkdir(cancelDeployReceipts, { recursive: true, mode: 0o700 });
  if (process.env.DOCKER_HOST !== 'unix:///var/run/docker.sock' || process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1'
      || !process.env.HOME?.startsWith(`/tmp/cauce-e2e-home-${CANCEL_DEPLOY_OWNER}-`)) {
    throw new Error('fleet deployment E2E requires the isolated lab launcher');
  }
  const directory = await mkdtemp(join(tmpdir(), 'cauce-fleet-cancel-deploy-'));
  const pki = createSelfSignedCert({ directory });
  const ports = await reserveNamedLoopbackPorts(['frontend'] as const);
  await ports.releaseAll();
  const baseUrl = `https://localhost:${String(ports.ports.frontend)}`;
  let computer: ComputerHarness | undefined;
  let trusted: TrustedBrowser | undefined;
  let vite: { close(): Promise<void>; listen(): Promise<void> } | undefined;
  let page: V4Page | undefined;
  const deploymentImages = new Map<string, string>();
  const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE]);
  const close = async () => {
    const failures: unknown[] = [];
    for (const action of [async () => trusted?.close(), async () => vite?.close(), async () => {
      if (computer && deploymentImages.size) {
        const present = await dockerInventory(cancelDeployPrefix);
        for (const name of present.containers.split('\n').filter(name => name && name !== computer?.container)) await docker(['rm', '-f', name]);
        for (const [reference, expected] of deploymentImages) {
          const found = await command('docker', ['image', 'inspect', '--format', '{{.Id}}', reference]);
          if (found.code === 0) {
            expect(found.stdout.trim()).toBe(expected);
            await docker(['image', 'rm', reference]);
          } else if (!/no such image|not found/iu.test(found.stderr)) throw new Error(`deployment image cleanup inspection failed: ${found.stderr}`);
        }
      }
    }, async () => {
      if (computer) expect(await computer.close()).toEqual({ containers: '', volumes: '', images: '' });
    }, async () => rm(directory, { recursive: true, force: true })]) {
      try { await action(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'fleet deployment cleanup failed');
  };
  try {
    computer = await startComputerHarness({ prefix: cancelDeployPrefix, consoleOrigins: [baseUrl], workRoot: '/datos',
      resourceOwner: CANCEL_DEPLOY_OWNER, runtimeBundle: options.runtimeBundle ?? cancelDeployRuntime,
      extraSourceFiles: ['packages/store/src/repository/fleet-operation-recovery.ts', 'packages/protocol/src/context-retirement.ts', 'ops/cli/fleet_executor_probe_cache.py',
        'packages/store/src/context-retirement.ts', 'packages/store/src/context-git-retirement.ts', 'packages/store/src/context-version-reevaluation.ts',
        'packages/protocol/src/fleet-recovery.ts', 'services/gateway/src/fleet/recovery-host-command.ts',
        'services/gateway/src/fleet/agent-recovery-preflight.ts',
        'ops/cli/fleet_executor_container_tui.py',
        'ops/cli/fleet_provider_capability_probe.py', 'ops/cli/fleet_executor_terminal.py',
        'packages/store/src/device-authorization.ts', 'packages/store/src/device-authorization-authority.ts',
        'services/gateway/src/device-authorization.ts', 'services/gateway/src/fleet/space-backup.failure.ts',
        'ops/cli/fleet_executor_lifecycle.py', 'ops/cli/fleet_executor_replacement.py'] });
    vite = await (consoleRequire('vite') as { createServer(config: Record<string, unknown>): Promise<NonNullable<typeof vite>> }).createServer({
      configFile: join(process.cwd(), 'console/vite.config.ts'), root: join(process.cwd(), 'console'), envDir: directory,
      cacheDir: join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: ports.ports.frontend, strictPort: true, watch: null, hmr: false,
        https: { key: await readFile(pki.key_path), cert: await readFile(pki.cert_path) },
        proxy: { '/v3': { target: computer.gatewayUrl, changeOrigin: false, ws: true } } },
    });
    await vite.listen();
    trusted = await startTrustedBrowser(pki.cert_path, directory, [ports.ports.frontend, Number(new URL(computer.gatewayUrl).port)]);
    const context = await trusted.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
    page = asV4Page(await context.newPage());
    errors.watch(page, 'fleet-cancel-deploy-owner');
    const owner = { ...syntheticPerson('cancel-deploy', cancelDeployRun), email: `${cancelDeployPrefix}@example.test`,
      company: { name: `zz-canary-empresa-deploy-${cancelDeployRun}`, slug: `zz-deploy-${cancelDeployRun}` } };
    const form = await openRegistration(page, baseUrl);
    await fillRegistration(form, owner);
    await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    const hostId = `${owner.company.slug}-pc`;
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
    const installed = await installCancelDeploySetup(computer, baseUrl, owner.company.slug, hostId);
    computer = installed.computer;
    if (options.initialSharedTui !== undefined) {
      const current = installed.setup.approvedConfiguration();
      const bundle = current.policy.bundles.codex;
      if (!bundle) throw new Error('the initial signed policy lacks the Codex bundle');
      installed.setup.publish(HostSetupConfigSchema.parse({ ...current,
        policy: { ...current.policy, bundles: { ...current.policy.bundles, codex: { ...bundle, shared_tui: options.initialSharedTui } } },
      }));
    }
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    const login = await computer.app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: baseUrl },
      payload: { email: owner.email, password: owner.password } });
    expect(login.statusCode).toBe(200);
    const header = login.headers['set-cookie'];
    const cookie = (Array.isArray(header) ? header : header === undefined ? [] : [header]).map(value => value.split(';', 1)[0]).join('; ');
    const unit = await enrollComputer(computer, { cookie, origin: baseUrl, 'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token },
      owner.company.slug, hostId);
    const tenantId = (await computer.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [owner.email])).rows[0]?.tenant_id;
    if (!tenantId) throw new Error('fleet deployment company has no tenant');
    const room = (await computer.pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id', [tenantId])).rows[0]?.id;
    if (!room) throw new Error('fleet deployment company has no room');
    const accountId = `zz-deploy-${cancelDeployRun}`;
    await computer.pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
      VALUES($1,'codex',$2,$3,'env_path','CAUCE_FLEET_CANCEL_DEPLOY_PROFILE_PATH',true)`, [accountId, FIXTURE_PROVIDER_IDENTITY, tenantId]);
    return { computer, page, errors, baseUrl, tenantId, hostId, accountId, room, company: owner.company.slug, unit,
      setup: installed.setup, deploymentImages, close };
  } catch (error) {
    try {
      if (page) {
        await writeFile(join(cancelDeployReceipts, 'bootstrap-failure.json'), JSON.stringify({
          error: error instanceof Error ? error.message : String(error), page: await bodySnippet(page),
          browserErrors: errors.unexpected, browserTrace: errors.trace,
        }, null, 2) + '\n', { mode: 0o600 });
        await page.screenshot({ path: join(cancelDeployReceipts, 'bootstrap-failure.png') }).catch(() => undefined);
      }
    } finally { await close(); }
    throw error;
  }
}

export async function cancelDeployCapture(page: V4Page, name: string): Promise<void> {
  const original = page.viewportSize();
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.screenshot({ path: join(cancelDeployReceipts, `${name}-${String(viewport.width)}x${String(viewport.height)}.png`) });
    }
  } finally { if (original) await page.setViewportSize(original); }
}
