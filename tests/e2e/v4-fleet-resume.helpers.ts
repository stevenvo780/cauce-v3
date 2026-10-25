import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CauceRepository } from '@cauce/store';
import { expect } from 'vitest';
import { buildGateway } from '../../services/gateway/src/app.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { SignedFleetAuthorityClient } from '../../services/gateway/src/fleet/authority/signed-client.js';
import { HostCapabilityRegistry } from '../../services/gateway/src/fleet/host-channel.capabilities.js';
import { cancelRun, startCancelFixture, type CancelFixture } from './v4-fleet-cancel.helpers.js';
import { apiGet, type V4Page } from './v4-console-real-browser.helpers.js';

export const resumeReceipts = join(process.cwd(), '.delegados/v4/recibos/f4-flota-server2-1025/resume', cancelRun);
export interface ResumeFixture extends CancelFixture {
  unit: string;
  configuredGateway: Awaited<ReturnType<typeof buildGateway>>;
}

export async function startResumeFixture(): Promise<ResumeFixture> {
  await mkdir(resumeReceipts, { recursive: true, mode: 0o700 });
  const fixture = await startCancelFixture({ extraSourceFiles: ['packages/store/src/repository/fleet-operation-recovery.ts',
    'packages/store/src/device-authorization.ts', 'packages/store/src/device-authorization-authority.ts',
    'services/gateway/src/device-authorization.ts', 'ops/cli/fleet_executor_probe_cache.py',
    'ops/cli/fleet_provider_capability_probe.py', 'ops/cli/fleet_executor_terminal.py'] });
  let gateway: Awaited<ReturnType<typeof buildGateway>> | undefined;
  try {
    const { computer } = fixture;
    const company = (await computer.pool.query<{ company_id: string }>('SELECT company_id FROM tenants WHERE id=$1', [fixture.tenantId])).rows[0]?.company_id;
    if (!company) throw new Error('resume company absent');
    const dynamic = await new HostCapabilityRegistry(computer.pool).fleet(company);
    const placement = dynamic.placements.find(row => row.host_id === fixture.hostId);
    if (!placement) throw new Error('enrolled placement absent');
    await computer.pool.query("INSERT INTO fleet_hosts(host_id,company_id,display_name) VALUES('server',$1,'Servidor estático canario')", [company]);
    await fixture.page.goto('about:blank', { waitUntil: 'domcontentloaded' });
    await computer.app.close();
    const uid = process.geteuid?.() ?? 0;
    const api = join(dirname(computer.installRoot), 'resume-api.json');
    await writeFile(api, JSON.stringify({ version: 1, controller_host: 'server', hosts: [
      { host_id: 'server', socket_path: join(dirname(computer.installRoot), 'server.sock') },
    ] }), { mode: 0o600 });
    const previousApi = process.env.CAUCE_FLEET_API_CONFIG_FILE;
    const previousController = process.env.CAUCE_FLEET_CONTROLLER_HOST;
    process.env.CAUCE_FLEET_API_CONFIG_FILE = api;
    process.env.CAUCE_FLEET_CONTROLLER_HOST = 'server';
    try {
      gateway = await buildGateway({ pool: computer.pool, repository: new CauceRepository(computer.pool), logger: false,
        consoleOrigins: [fixture.baseUrl], hostSetup: computer.packager,
        signedFleetAuthorityClient: new SignedFleetAuthorityClient(join(dirname(computer.installRoot), 'authority/signed.sock'), { ownerUid: uid, peerUid: uid }),
        authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(computer.pool), signingKey: Buffer.alloc(32, 61) }),
        fleetCapability: { ...dynamic, placements: [{ ...placement, host_id: 'server' }] } });
    } finally {
      if (previousApi === undefined) delete process.env.CAUCE_FLEET_API_CONFIG_FILE;
      else process.env.CAUCE_FLEET_API_CONFIG_FILE = previousApi;
      if (previousController === undefined) delete process.env.CAUCE_FLEET_CONTROLLER_HOST;
      else process.env.CAUCE_FLEET_CONTROLLER_HOST = previousController;
    }
    await gateway.listen({ host: '127.0.0.1', port: Number(new URL(computer.gatewayUrl).port) });
    const configuredGateway = gateway;
    await fixture.page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' });
    await fixture.page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    return { ...fixture, configuredGateway, unit: `cauce-v3-host-executor-zz-cancel-${cancelRun}-${fixture.hostId}.service`,
      close: async () => { await configuredGateway.close(); await fixture.close(); } };
  } catch (error) { await gateway?.close(); await fixture.close(); throw error; }
}

export async function resumeCapture(page: V4Page, name: string): Promise<void> {
  const original = page.viewportSize();
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.screenshot({ path: join(resumeReceipts, `${name}-${String(viewport.width)}x${String(viewport.height)}.png`) });
    }
  } finally { if (original) await page.setViewportSize(original); }
}

export async function hostCapability(fixture: ResumeFixture): Promise<string[]> {
  const response = await apiGet(fixture.page, '/v3/console/fleet/capability');
  expect(response.status).toBe(200);
  return (response.body.placements as { host_id: string }[]).map(row => row.host_id);
}
