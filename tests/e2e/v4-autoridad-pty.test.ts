import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FleetOperationsRepository, companyRevision, withTransaction } from '@cauce/store';
import { expect, it } from 'vitest';
import { channelCompany, channelHost } from '../../services/gateway/src/fleet/host-channel.fixtures.js';
import { startTestDatabase } from '../helpers/postgres.js';

const execute = promisify(execFile);
const owner = 'h7d-autoridad-pty-1025';
const files = ['.delegados/v4/autoridad-pty.sh', '.delegados/v4/autoridad-pty-driver.py',
  'tests/e2e/v4-autoridad-pty.fixture.py', 'tests/e2e/v4-autoridad-pty.test.ts'];

async function readable(directory: string): Promise<void> {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) await readable(filename);
    else if (entry.isFile()) await chmod(filename, 0o644);
  }
}
async function ready(args: string[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await execute('docker', args); return; }
    catch (error) { if (attempt === 99) throw error; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
}
async function fixture(name: string, root: string, mode: string, input: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', name, 'python3', '-B', join(root, 'tests/e2e/v4-autoridad-pty.fixture.py'), mode, root],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) { reject(new Error(`fixture ${mode} exit=${String(code)}: ${err.slice(-7000)}`)); return; }
      try { resolve(JSON.parse(out) as Record<string, unknown>); } catch { reject(new Error('Fixture returned invalid JSON')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

it('installs the PTY authority, purges a fenced canary and reverts without restoring its identity', async () => {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.DOCKER_HOST !== 'unix:///var/run/docker.sock') {
    throw new Error('Run with scripts/e2e-lab.sh on docker-lab');
  }
  const suffix = randomUUID().slice(0, 8);
  const name = `zz-canary-${owner}-${suffix}`, gateway = `${name}-gateway`, image = `${name}:local`;
  const work = await mkdtemp('/datos/h7dpty-');
  const receipts = join(process.cwd(), '.delegados/v4/recibos', owner);
  await mkdir(receipts, { recursive: true });
  const revision = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
  const root = join(work, 'releases', revision);
  const socket = join(work, 'authority-socket');
  const database = await startTestDatabase();
  try {
    for (const relative of ['ops/cli', 'ops/scripts', 'ops/container-runtime', 'ops/pty-agent', 'ops/schemas', 'ops/systemd', 'ops/tests', 'packages/adapter-sdk/descriptors']) {
      await cp(join(process.cwd(), relative), join(root, relative), { recursive: true });
    }
    for (const file of files) {
      await mkdir(join(root, file, '..'), { recursive: true });
      await cp(join(process.cwd(), file), join(root, file));
    }
    await readable(work); await chmod(join(root, '.delegados/v4/autoridad-pty.sh'), 0o700);
    const hashes: Record<string, string> = {};
    for (const file of files) hashes[file] = createHash('sha256').update(await readFile(join(root, file))).digest('hex');
    await mkdir(socket, { mode: 0o755 });
    const entry = join(root, 'app/services/gateway/dist/fleet');
    await mkdir(join(entry, 'authority'), { recursive: true });
    for (const parent of ['app/packages', 'app/services/packages']) {
      await cp(join(process.cwd(), 'packages/adapter-sdk/descriptors'), join(root, parent, 'adapter-sdk/descriptors'), { recursive: true });
    }
    for (const part of ['main', 'authority/signed-main']) {
      await execute(join(process.cwd(), 'node_modules/.bin/esbuild'), [join(process.cwd(), `services/gateway/src/fleet/${part}.ts`),
        '--bundle', '--platform=node', '--format=esm', '--target=node22', '--external:pg-native', '--log-level=error',
        ...(part === 'authority/signed-main' ? ['--external:../main.js'] : []),
        `--outfile=${join(entry, `${part}.js`)}`, `--alias:@cauce/store=${join(process.cwd(), 'packages/store/src/index.ts')}`,
        `--alias:@cauce/protocol=${join(process.cwd(), 'packages/protocol/src/index.ts')}`,
        '--banner:js=import{createRequire as __cauceRequire}from"node:module";const require=__cauceRequire(import.meta.url);'],
      { env: { ...process.env, NODE_PATH: ['services/gateway', 'packages/store', 'packages/protocol', ''].map(part => join(process.cwd(), part, 'node_modules')).join(':') } });
    }
    const dockerfile = join(work, 'Dockerfile');
    await writeFile(dockerfile, 'FROM docker:29-cli AS docker\nFROM node:22-slim\nCOPY --from=docker /usr/local/bin/docker /usr/bin/docker\n'
      + 'RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-yaml systemd systemd-sysv dbus dbus-user-session openssl ca-certificates '
      + '&& find /var/lib/apt/lists -mindepth 1 -delete && useradd -m -u 1500 -s /bin/bash cauce\nSTOPSIGNAL SIGRTMIN+3\nCMD ["/sbin/init"]\n');
    await execute('docker', ['build', '--label', `cauce.e2e.owner=${owner}`, '-t', image, '-f', dockerfile, work], { timeout: 240_000 });
    await execute('docker', ['run', '-d', '--name', name, '--label', `cauce.e2e.owner=${owner}`, '--privileged', '--cgroupns=private',
      '--network', 'host', '--tmpfs', '/run', '--tmpfs', '/run/lock', '-v', `${work}:${work}`, '-v', '/var/run/docker.sock:/var/run/docker.sock', image]);
    await execute('docker', ['exec', name, 'chown', '-R', '0:0', work]);
    await execute('docker', ['run', '-d', '--name', gateway, '--label', `cauce.e2e.owner=${owner}`, '--user', '1000:1000', '--network', 'none',
      '--env', `CAUCE_FLEET_AUTHORITY_SOCKET=${socket}/authority.sock`, '-v', `${socket}:${socket}`, '--entrypoint', 'node', image,
      '-e', 'setInterval(()=>{},60000)']);
    await ready(['exec', name, 'test', '-S', '/run/dbus/system_bus_socket']);
    await execute('docker', ['exec', name, 'loginctl', 'enable-linger', 'cauce']);
    await ready(['exec', '--user', 'cauce', '--env', 'XDG_RUNTIME_DIR=/run/user/1500', '--env', 'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1500/bus',
      name, 'systemctl', '--user', 'is-system-running']);
    const company = await channelCompany(database.pool, `h7d-${suffix}`);
    const host = await channelHost(database.pool, company);
    const alias = `zz-canary-h7d-${suffix}`;
    const input = { tenant: company.hub.id, alias, host: host.host_id, database_url: database.url,
      socket_directory: socket, gateway_container: gateway };
    const initial = await fixture(name, root, 'setup', input);
    expect(initial.registry_count).toBe(4);
    const native = initial.native as { agent: { home_directory: string; state_directory: string }; record: string };
    await database.pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,lifecycle_state,retired_at,runtime_key,
      host_id,runtime_mode,container_name,runtime_user,home_directory,state_directory,systemd_user)
      VALUES($1,$2,'codex',false,'retired',now(),'physical-a',$3,'native',$4,'cauce',$5,$6,'cauce')`,
    [company.hub.id, alias, host.host_id, `host:${host.host_id}`, native.agent.home_directory, native.agent.state_directory]);
    const repo = new FleetOperationsRepository(database.pool, { controllerHost: host.host_id });
    const expected = await withTransaction(database.pool, client => companyRevision(client, company.company.id));
    await repo.enqueue(company.hub.id, 'owner', { kind: 'purge', target: { resource: 'agent', tenant_id: company.hub.id, alias },
      expected_revision: expected, idempotency_key: `h7d-purge-${suffix}`, parameters: { confirm_alias: alias } }, `console:${company.user.id}`);
    const claim = await repo.claim('h7d-worker', host.host_id, 300_000);
    if (!claim) throw new Error('Purge claim absent');
    const prepared = await repo.prepare(claim), slice = (await repo.hostSlices(claim))[0];
    if (!slice || prepared.operation.desired_revision === null) throw new Error('Purge host slice absent');
    const scope = { operation_id: claim.operation.id, host_id: host.host_id, scope_sha256: slice.target_sha256,
      prepared_revision: prepared.operation.desired_revision, worker_id: claim.worker_id, claim_token: claim.claim_token, claim_epoch: claim.epoch };
    const live = async (): Promise<void> => {
      const state = await database.pool.query<{ live: boolean }>(`SELECT worker_id=$2 AND claim_token=$3 AND epoch=$4
        AND lease_expires_at>clock_timestamp() AS live FROM fleet_operations WHERE id=$1`,
      [claim.operation.id, claim.worker_id, claim.claim_token, claim.epoch]);
      expect(state.rows[0]?.live).toBe(true);
    };
    await live();
    const receipt = join(work, 'authority-pty-receipt.json');
    const evidence = await fixture(name, root, 'exercise', { ...input, native, scope, receipt });
    await live();
    expect(evidence.simulation_unchanged).toBe(true); expect(evidence.authorities_after_apply).toBe(5);
    expect(evidence.authorities_after_revert).toBe(4); expect(evidence.allowlist_not_restored).toBe(true);
    expect(evidence.rollback_cas_rejected_before_writes).toBe(true);
    expect(evidence.failed_install_automatically_compensated).toBe(true);
    expect(evidence.canonical_cli_purge).toEqual({ cli_purge: true, runtime_removed: true, pty_removed: true });
    await execute('docker', ['exec', name, 'chown', `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`,
      receipt, join(work, 'authority-pty-failed-receipt.json')]);
    await cp(receipt, join(receipts, 'authority-pty-receipt.json'));
    await cp(join(work, 'authority-pty-failed-receipt.json'), join(receipts, 'authority-pty-failed-receipt.json'));
    const publicEvidence = { ...evidence, pg_claim_valid_before_and_after: true, hashes,
      purge_transport: 'socketfixture; real CLI and issuer; canonical signed enclave verified separately by installer --apply' };
    await writeFile(join(receipts, 'authority-pty-evidence.json'), JSON.stringify(publicEvidence, null, 2));
    console.info('AUTHORITY_PTY_EVIDENCE', JSON.stringify(publicEvidence));
  } finally {
    await execute('docker', ['exec', name, 'chown', '-R', `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`, work]).catch(() => undefined);
    await execute('docker', ['rm', '-f', gateway, name]).catch(() => undefined);
    await execute('docker', ['image', 'rm', image]).catch(() => undefined);
    await Promise.allSettled([...new Set([database.pool, database.adminPool])].map(pool => pool.end()));
    await database.container.stop();
    expect((await execute('docker', ['ps', '-aq', '--filter', `name=^/${name}(-gateway)?$`])).stdout.trim()).toBe('');
    await rm(work, { recursive: true, force: true });
  }
}, 600_000);
