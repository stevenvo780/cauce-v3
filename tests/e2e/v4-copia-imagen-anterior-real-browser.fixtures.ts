import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { browserDocker, browserExec } from './browser-owned-lifecycle.js';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import { asV4Page, fillRegistration, openRegistration, syntheticPerson, type V4Page } from './v4-console-real-browser.helpers.js';
import { registerSpaceBackupHostRoutes } from '../../services/gateway/src/fleet/space-backup.routes.js';
import { SpaceBackupHost } from '../../services/gateway/src/fleet/space-backup.host.js';
import { SignedHostChannel } from '../../services/gateway/src/fleet/signed-source.js';

export const owner = 'b1-copia-imagen-1025';
export const runId = randomUUID();
export const evidence = join(process.cwd(), '.delegados/v4/recibos', owner, runId);
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export type BackupHarness = 'openclaw' | 'grok';
export interface AgentBinding {
  company_id: string; tenant_id: string; alias: string; runtime_key: string; host_id: string; harness_id: string;
  runtime_mode: string; container_name: string; runtime_user: string; home_directory: string; state_directory: string; systemd_user: string;
}
export interface Observation { id: string; image: string; configured_image: string; started_at: string; running: boolean; pids_limit: number; release_mount: string }
export interface PreparedImageBackup {
  agent: AgentBinding; policy_file: string; policy_sha256: string; approved_image: string;
  before: Observation; source_files: Record<string, string>;
  previous_policy_sha256: string; project_root: string; runtime_release: string; release_source: Record<string, string>;
}

export async function startImageBackupFixture() {
  if (process.env.CAUCE_TEST_DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') throw new Error('isolated real services are required');
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(tmpdir(), `zz-canary-${owner}-`));
  await chmod(directory, 0o755);
  const storage = join(directory, 'copies');
  process.env.CAUCE_SPACE_BACKUP_DIRECTORY = storage;
  process.env.CAUCE_PROJECT_ROOT = process.cwd();
  let consoleFixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>>;
  try { consoleFixture = await startConsoleFunctionalFixture(); }
  finally { delete process.env.CAUCE_SPACE_BACKUP_DIRECTORY; delete process.env.CAUCE_PROJECT_ROOT; }
  const host = Fastify();
  registerSpaceBackupHostRoutes(host, consoleFixture.database.pool, { directory: storage, projectRoot: process.cwd() });
  await host.listen({ host: '127.0.0.1', port: 0 });
  const images: { tag: string; id: string }[] = [];
  const targets: { directory: string; closed: boolean }[] = [];

  async function driver<T>(action: string, packet: Record<string, unknown>): Promise<T> {
    const request = join(directory, `request-${randomUUID()}.json`);
    await writeFile(request, JSON.stringify(packet), { mode: 0o600 });
    try {
      const result = await browserExec('/usr/bin/python3', ['-B', 'tests/e2e/v4-copia-imagen-anterior-real-browser.driver.py', action, request],
        { timeout: 120_000, maxBuffer: 1024 * 1024 });
      return JSON.parse(result.stdout) as T;
    } finally { await rm(request, { force: true }); }
  }

  async function buildImages(): Promise<void> {
    for (const revision of ['old', 'current']) {
      const file = join(directory, `Dockerfile.${revision}`);
      const tag = `zz-canary-${owner}-${runId.slice(0, 8)}:${revision}`;
      await writeFile(file, `FROM python:3.12-slim\nLABEL cauce.e2e.owner="${owner}" revision="${revision}"\n`, { mode: 0o600 });
      await browserDocker(['build', '-q', '-t', tag, '-f', file, directory], { timeout: 180_000 });
      const id = (await browserDocker(['image', 'inspect', '--format', '{{.Id}}', tag])).stdout.trim();
      images.push({ tag, id });
    }
    if (images[0]?.id === images[1]?.id) throw new Error('approved images must differ physically');
  }

  async function prepareTarget(harness: BackupHarness) {
    const short = randomUUID().slice(0, 8);
    const person = syntheticPerson(`backup-${harness}`, short);
    person.company.slug = `zz-canary-${harness}-${short}`;
    const page = asV4Page(await newTrustedPage(consoleFixture, { width: 1440, height: 900 }));
    const form = await openRegistration(page, consoleFixture.baseUrl);
    await fillRegistration(form, person);
    await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    const pool = consoleFixture.database.pool;
    const identity = (await pool.query<{ id: string; tenant_id: string }>('SELECT id::text,tenant_id FROM console_users WHERE email=$1', [person.email])).rows[0];
    if (!identity) throw new Error('registered owner identity is absent');
    const work = join(directory, `${harness}-${short}`);
    await mkdir(work, { mode: 0o755 });
    const tracked = { directory: work, closed: false };
    targets.push(tracked);
    const oldImage = images[0]?.id;
    const newImage = images[1]?.id;
    if (!oldImage || !newImage) throw new Error('approved images are absent');
    const prepared = await driver<PreparedImageBackup>('prepare', { directory: work, company_id: person.company.slug,
      tenant_id: identity.tenant_id, alias: `zz${harness}${short}`, runtime_key: `b1-${harness}-${short}`,
      host_id: `zz-canary-${harness}-${short}`, harness_id: harness, container_name: `zz-canary-${owner}-${harness}-${short}`,
      old_image: oldImage, new_image: newImage });
    const agent = prepared.agent;
    await pool.query('INSERT INTO fleet_hosts(host_id,company_id,display_name) VALUES($1,$2,$3)', [agent.host_id, person.company.slug, 'Ordenador canario de copia con imagen anterior']);
    await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,company_id,host_id,runtime_key,runtime_mode,
      container_name,runtime_user,home_directory,state_directory,systemd_user)
      VALUES($1,$2,$3,$2,false,$4,$5,$6,'container',$7,$8,$9,$10,$11)`,
    [agent.tenant_id, agent.alias, harness, agent.company_id, agent.host_id, agent.runtime_key, agent.container_name,
      agent.runtime_user, agent.home_directory, agent.state_directory, agent.systemd_user]);
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')", [agent.tenant_id, agent.alias]);
    const keys = generateKeyPairSync('ed25519');
    const enrollment = (await pool.query<{ id: string }>(`INSERT INTO fleet_host_enrollments(company_id,host_id,display_name,
      invited_by,token_hash,nonce,expires_at,state,enrolled_at) VALUES($1,$2,'Ordenador canario',$3,$4,$5,
      now()+interval '1 day','enrolled',now()) RETURNING id::text`,
    [agent.company_id, agent.host_id, identity.id, randomBytes(32).toString('hex'), randomBytes(32).toString('hex')])).rows[0];
    if (!enrollment) throw new Error('host enrollment is absent');
    const publicDer = keys.publicKey.export({ type: 'spki', format: 'der' });
    const capabilities = { resource: 'host', action: 'capabilities', schemaVersion: 1, executor_version: 'b1-copy-image-canary',
      policy_sha256: prepared.policy_sha256, fleet_executor: true, quota_executor: false, quota_providers: [], quota_provider_actions: {},
      templates: [{ template_id: `zz-canary-${harness}`, provider: harness, harness_id: harness, runtime_user: agent.runtime_user,
        mode: 'container', home_directory: agent.home_directory, state_root: '/tmp/cauce-state', container_prefix: `zz-canary-${owner}-` }] };
    await pool.query(`INSERT INTO fleet_host_identities(host_id,company_id,enrollment_id,public_key,key_fingerprint,
      capabilities,capabilities_seen_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,now())`,
    [agent.host_id, agent.company_id, enrollment.id, publicDer.toString('base64'), sha256(publicDer), JSON.stringify(capabilities)]);
    const address = host.server.address();
    if (!address || typeof address === 'string') throw new Error('signed host address is absent');
    const privateIdentity = join(work, 'host-identity');
    await mkdir(privateIdentity, { mode: 0o700 });
    await writeFile(join(privateIdentity, 'identity.json'), JSON.stringify({ enrollment_id: enrollment.id,
      company_id: agent.company_id, host_id: agent.host_id, gateway: `http://127.0.0.1:${String(address.port)}`,
      state: 'enrolled', key_fingerprint: sha256(publicDer), executor_ready: true }), { mode: 0o600 });
    await writeFile(join(privateIdentity, 'private.pem'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const worker = new SpaceBackupHost(await SignedHostChannel.load(privateIdentity),
      { python: '/usr/bin/python3', projectRoot: prepared.project_root, policyFile: prepared.policy_file });
    const record = { ...prepared, harness, directory: work };
    await writeFile(join(evidence, `${harness}-${short}-binding.json`), JSON.stringify(record, null, 2));
    return { ...record, page, worker,
      refresh: async () => { await pool.query('UPDATE fleet_host_identities SET capabilities_seen_at=now() WHERE host_id=$1', [agent.host_id]); },
      observe: () => driver<{ observed: Observation; source_files: Record<string, string> }>('observe', { directory: work }),
      fault: () => driver('fault', { directory: work }), recover: () => driver('recover', { directory: work }),
      close: async () => {
        const result = await driver('cleanup', { directory: work });
        tracked.closed = true;
        await writeFile(join(evidence, `${harness}-${short}-cleanup.json`), JSON.stringify(result, null, 2));
        await page.context().close();
      } };
  }

  async function close(): Promise<void> {
    const failures: unknown[] = [];
    for (const target of targets.filter(item => !item.closed)) {
      try { await driver('cleanup', { directory: target.directory }); }
      catch (error) { failures.push(error); }
    }
    for (const image of images) {
      try {
        const actual = (await browserDocker(['image', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}}', image.tag])).stdout.trim();
        if (actual !== `${image.id} ${owner}`) throw new Error('owned image identity changed');
        await browserDocker(['image', 'rm', image.tag]);
      } catch (error) { failures.push(error); }
    }
    try { await host.close(); } catch (error) { failures.push(error); }
    try { await consoleFixture.close(); } catch (error) { failures.push(error); }
    if (!failures.length) await rm(directory, { recursive: true, force: true });
    await writeFile(join(evidence, 'cleanup.json'), JSON.stringify({ directory, images, unresolved: failures.length }, null, 2));
    if (failures.length) throw new AggregateError(failures, 'owned image backup fixture cleanup failed');
  }

  try { await buildImages(); }
  catch (error) { await close(); throw error; }
  const sourcePaths = ['tests/e2e/v4-copia-imagen-anterior-real-browser.test.ts',
    'tests/e2e/v4-copia-imagen-anterior-real-browser.fixtures.ts', 'tests/e2e/v4-copia-imagen-anterior-real-browser.driver.py'];
  const source = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, sha256(await readFile(path))] as const)));
  await writeFile(join(evidence, 'manifest.json'), JSON.stringify({ run_id: runId, directory: evidence, source, images,
    database_container: consoleFixture.database.container.getId(), browser_container: consoleFixture.browserContainer,
    adapter_started: false, provider_inference_requested: false }, null, 2));
  process.stdout.write(`image-backup-artifacts ${JSON.stringify({ run_id: runId, directory: evidence, images })}\n`);
  return { consoleFixture, directory, storage, prepareTarget, close };
}

export type ImageBackupFixture = Awaited<ReturnType<typeof startImageBackupFixture>>;
export type ImageBackupTarget = Awaited<ReturnType<ImageBackupFixture['prepareTarget']>>;
export type DownloadPage = V4Page & { waitForEvent(event: 'download', options: { timeout: number }): Promise<{ path(): Promise<string | null> }> };
