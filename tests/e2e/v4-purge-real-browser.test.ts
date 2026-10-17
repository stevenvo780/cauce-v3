import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage, startConsoleFunctionalFixture, type BrowserResponse } from './console-functional-browser.fixtures.js';
import {
  asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, openRegistration, syntheticPerson,
  type V4Page, type V4Person,
} from './v4-console-real-browser.helpers.js';

const python = 'python3';
const run = randomUUID().replaceAll('-', '').slice(0, 8);
const alias = `zzpurge${run}`;
const runtimeKey = `zz-canary-purge-${run}`;
const failKey = `zz-canary-fail-${run}`;
const foreignKey = `zz-canary-unrelated-${run}`;
const owner: V4Person = {
  ...syntheticPerson('purge', run),
  email: `zz-canary-purge-${run}@example.test`,
  name: `zz-canary-purge-${run}`,
  company: { name: `zz-canary-empresa-purge-${run}`, slug: `zz-canary-purge-${run}` },
};
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES]);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let page: V4Page | undefined;
let hub = '';
let work: string | undefined;
let worker: ChildProcess | undefined;
let foreignVolumeCreated = false;

function active() {
  if (!fixture) throw new Error('purge fixture is not initialized');
  return fixture;
}

function view() {
  if (!page) throw new Error('purge page is not initialized');
  return page;
}

function redact(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://redacted');
}

async function stopWorker(): Promise<void> {
  const child = worker;
  worker = undefined;
  if (child?.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function dockerText(args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 40_000 });
  expect(result.status, redact(result.stderr)).toBe(0);
  return result.stdout;
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  fixture = await startConsoleFunctionalFixture();
  page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 1000 }));
  errors.watch(page, 'purge-owner');
  const form = await openRegistration(page, active().baseUrl);
  await fillRegistration(form, owner);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  const row = await active().database.pool.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM console_users WHERE email=$1', [owner.email]);
  hub = row.rows[0]?.tenant_id ?? '';
  if (!/^hub-[a-f0-9]+$/u.test(hub)) throw new Error('purge company hub was not created');
}, 600_000);

afterAll(async () => {
  try {
    await stopWorker();
    if (work) {
      const cleaned = spawnSync(python, [join(process.cwd(), 'tests/e2e/v4-purge-docker.fixture.py'), 'cleanup', '--root', work],
        { encoding: 'utf8', timeout: 120_000 });
      expect(cleaned.status, redact(cleaned.stdout + cleaned.stderr)).toBe(0);
      await rm(work, { recursive: true, force: true });
    }
  } finally {
    try { if (foreignVolumeCreated) dockerText(['volume', 'rm', foreignKey]); }
    finally { await fixture?.close(); }
  }
}, 180_000);

describe('purga real de un contenedor desechable', () => {
  it('exige el alias, conserva confirm_alias y no deja contenedor ni volúmenes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-purge-e2e-'));
    work = directory;
    expect(dockerText(['volume', 'create', foreignKey]).trim()).toBe(foreignKey);
    foreignVolumeCreated = true;
    const prepared = spawnSync(python, [join(process.cwd(), 'tests/e2e/v4-purge-docker.fixture.py'), 'prepare',
      '--root', directory, '--tenant', hub, '--alias', alias, '--runtime-key', runtimeKey, '--fail-key', failKey],
    { encoding: 'utf8', timeout: 120_000 });
    expect(prepared.status, redact(`${prepared.stderr}\n${prepared.stdout}`)).toBe(0);
    const manifest = JSON.parse(prepared.stdout) as {
      policy: string; python: string; host_id: string; systemd_user: string; state_directory: string; fail_clean: boolean;
    };
    expect(manifest.fail_clean).toBe(true);
    expect(dockerText(['ps', '-aq', '--filter', `name=^/${failKey}`]).trim()).toBe('');
    const ownerRow = await active().database.pool.query<{ id: string }>(
      'SELECT id::text FROM console_users WHERE email=$1', [owner.email]);
    const ownerId = ownerRow.rows[0]?.id;
    if (!ownerId) throw new Error('purge owner was not stored');
    const publicKey = randomBytes(48).toString('base64');
    const enrollment = await active().database.pool.query<{ id: string }>(
      `INSERT INTO fleet_host_enrollments(company_id,host_id,display_name,invited_by,token_hash,nonce,expires_at,state,enrolled_at)
       VALUES($1,$2,'Ordenador de purga',$3,$4,$5,now()+interval '1 day','enrolled',now()) RETURNING id::text`,
      [owner.company.slug, manifest.host_id, ownerId, randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]);
    const enrollmentId = enrollment.rows[0]?.id;
    if (!enrollmentId) throw new Error('purge host enrollment was not created');
    await active().database.pool.query(
      'INSERT INTO fleet_hosts(host_id,company_id,display_name) VALUES($1,$2,$3) ON CONFLICT (host_id) DO NOTHING',
      [manifest.host_id, owner.company.slug, 'Ordenador de purga']);
    const capabilities = { resource: 'host', action: 'capabilities', schemaVersion: 1, executor_version: 'v4-e2e',
      policy_sha256: createHash('sha256').update(manifest.host_id).digest('hex'), fleet_executor: true, quota_executor: false,
      templates: [{ template_id: 'zz-canary-purge', mode: 'container', harness_id: 'codex', provider: 'codex',
        runtime_user: 'nobody', systemd_user: manifest.systemd_user, home_directory: '/nonexistent', state_root: '/tmp/cauce-state',
        container_prefix: 'zz-canary-' }], quota_providers: [], quota_provider_actions: {} };
    await active().database.pool.query(
      `INSERT INTO fleet_host_identities(host_id,company_id,enrollment_id,public_key,key_fingerprint,capabilities,capabilities_seen_at)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,now()+interval '1 day')`,
      [manifest.host_id, owner.company.slug, enrollmentId, publicKey, createHash('sha256').update(publicKey).digest('hex'), JSON.stringify(capabilities)]);
    await active().database.pool.query(
      `INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,lifecycle_state,retired_at,company_id,runtime_key,host_id,runtime_mode,
         container_name,runtime_user,home_directory,state_directory,systemd_user)
       VALUES($1,$2,'codex',$2,false,'retired',now(),$3,$4,$5,'container',$4,'nobody','/nonexistent',$6,$7)`,
      [hub, alias, owner.company.slug, runtimeKey, manifest.host_id, manifest.state_directory, manifest.systemd_user]);
    const current = view();
    await current.goto(`${active().baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
    const purge = current.getByRole('button', { name: `Eliminar definitivamente ${hub}/${alias}`, exact: true });
    await purge.waitFor({ timeout: 20_000 });
    const enabledAt = Date.now() + 20_000;
    while (await purge.isDisabled()) {
      if (Date.now() > enabledAt) throw new Error(`purge control stayed disabled: ${await bodySnippet(current)}`);
      await current.waitForTimeout(200);
    }
    await purge.click();
    const typed = current.getByLabel('Escribe el alias');
    const preview = current.getByRole('button', { name: 'Previsualizar operación', exact: true });
    expect(await preview.isDisabled()).toBe(true);
    await typed.fill(`${alias}-wrong`);
    expect(await preview.isDisabled()).toBe(true);
    await typed.fill(alias);
    await preview.click();
    const enqueue = current.getByRole('button', { name: 'Encolar operación', exact: true });
    const queuedAt = Date.now() + 20_000;
    while (await enqueue.isDisabled()) {
      if (Date.now() > queuedAt) {
        const panel = await typed.evaluate(element => element.closest('.agent-lifecycle-panel')?.textContent);
        throw new Error(`enqueue stayed disabled: ${panel ?? '<no panel>'}; errors=${errors.unexpected.join('; ')}`);
      }
      await current.waitForTimeout(200);
    }
    const enqueued = (current as V4Page & {
      waitForResponse: (predicate: (response: BrowserResponse) => boolean, options: { timeout: number }) => Promise<BrowserResponse>;
    }).waitForResponse(response => new URL(response.url()).pathname === '/v3/console/fleet/operations'
      && response.request().method() === 'POST', { timeout: 20_000 });
    await enqueue.click();
    expect((await enqueued).status()).toBe(202);
    const stored = await active().database.pool.query<{ id: string; confirm_alias: string | null; status: string }>(
      `SELECT id::text, request->'parameters'->>'confirm_alias' AS confirm_alias, status FROM fleet_operations
       WHERE request->'target'->>'alias'=$1 ORDER BY created_at DESC LIMIT 1`, [alias]);
    expect(stored.rows[0]?.confirm_alias).toBe(alias);
    const operationId = stored.rows[0]?.id ?? '';
    const databaseFile = join(directory, 'database-url');
    await writeFile(databaseFile, active().database.url, { mode: 0o600 });
    await chmod(databaseFile, 0o600);
    const entry = `import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'services/gateway/src/fleet/main.ts')).href)}).then(({runFleetHost}) => runFleetHost()).catch(error => { process.stderr.write(error instanceof Error ? error.stack ?? error.message : 'fleet host failed'); process.exitCode = 1; });`;
    const log: Buffer[] = [];
    worker = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', entry], {
      cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '',
        CAUCE_FLEET_PROJECT_ROOT: process.cwd(), CAUCE_FLEET_DATABASE_URL_FILE: databaseFile,
        CAUCE_FLEET_HOST: manifest.host_id, CAUCE_FLEET_WORKER_ID: `zzpurge${run}worker`,
        CAUCE_FLEET_PYTHON: manifest.python, CAUCE_FLEET_EXECUTABLE: join(process.cwd(), 'ops/cli/fleet-executor.py'),
        CAUCE_FLEET_POLICY_FILE: manifest.policy, CAUCE_FLEET_POLL_MS: '200', CAUCE_FLEET_LEASE_MS: '30000',
        CAUCE_FLEET_COMMAND_TIMEOUT_MS: '60000' },
    });
    worker.stderr?.on('data', (chunk: Buffer) => { log.push(chunk); });
    const deadline = Date.now() + 90_000;
    let status = stored.rows[0]?.status ?? '';
    let detail = '';
    while (Date.now() < deadline) {
      const polled = await active().database.pool.query<{ status: string; error: unknown }>(
        'SELECT status, error FROM fleet_operations WHERE id=$1', [operationId]);
      status = polled.rows[0]?.status ?? status;
      detail = JSON.stringify(polled.rows[0]?.error ?? {});
      const gone = dockerText(['ps', '-aq', '--filter', `name=^/${runtimeKey}`]).trim() === ''
        && !dockerText(['volume', 'ls', '--filter', `name=^${runtimeKey}-`, '--format', '{{.Name}}']).split('\n').some((name) => name.startsWith(`${runtimeKey}-`));
      if (status === 'succeeded' && gone) break;
      if (status === 'failed' || status === 'cancelled') break;
      await current.waitForTimeout(500);
    }
    await stopWorker();
    const owned = [runtimeKey, failKey];
    const names = dockerText(['ps', '-a', '--filter', `name=^/(${owned.join('|')})`, '--format', '{{.Names}}']).split('\n')
      .filter((name) => owned.some((key) => name === key || name.startsWith(`${key}-`)));
    const allVolumes = dockerText(['volume', 'ls', '--filter', `name=^(${[...owned, foreignKey].join('|')})`, '--format', '{{.Name}}']).split('\n');
    const volumes = allVolumes.filter((name) => owned.some((key) => name.startsWith(`${key}-`)));
    const workerLog = redact(Buffer.concat(log).toString('utf8').slice(-4000));
    const observed = JSON.stringify({ status, detail: redact(detail), names, volumes, worker: workerLog });
    expect(status, observed).toBe('succeeded');
    expect(names, observed).toEqual([]);
    expect(volumes, observed).toEqual([]);
    expect(allVolumes).toContain(foreignKey);
    const rows = join(directory, 'rows.json');
    await writeFile(rows, '[]', { mode: 0o600 });
    for (const key of owned) {
      const swept = spawnSync(manifest.python, [join(process.cwd(), 'ops/cli/fleet_orphan_sweep.py'), '--rows', rows,
        '--runtime-key-prefix', key, '--host-id', manifest.host_id], { encoding: 'utf8', timeout: 40_000 });
      expect(swept.status, redact(swept.stdout + swept.stderr)).toBe(0);
      const report = JSON.parse(swept.stdout) as { clean: boolean };
      expect(report.clean).toBe(true);
    }
    errors.assertClean();
    console.info('PURGE_DOCKER_RECEIPT ' + JSON.stringify({ operation_id: operationId, status, confirm_alias: alias,
      runtime_keys: owned, containers: names, volumes, foreign_volume: foreignKey, foreign_volume_preserved: true,
      failed_create_compensated: manifest.fail_clean }));
  }, 180_000);
});
