import assert from 'node:assert/strict';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { join } from 'node:path';
import { test } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { PublishResultSchema } from '@cauce/protocol';
import { applyMigrations, applyMigrationsThrough, createPool, type DatabasePool } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { HashedMtlsIdentityFileProvider, MtlsAuthProvider } from '../../services/gateway/src/auth.js';
import { arrancarPostgresDePrueba, COMANDO_POSTGRES_DE_PRUEBA, saludDePostgresDePrueba } from '../helpers/contenedor-de-prueba.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';
import { command, waitFor } from './v4-live-adapter-release.helpers.js';

const OWNER = 't3b-adaptadores-v3-astra-1025';
const RECEIPTS = join(process.cwd(), '.delegados/v4/recibos', OWNER, 'api');
const REF = '33b88409b018b70fff278e4fa9a777414983ad1d';
const BUNDLE = join(process.cwd(), '.delegados/v4/recibos', OWNER, 'systemd/bundle-33b88409');
const DIGEST = 'sha256:fa26b5dc2fb518ce3f06bc3eac3e21c87a90f5b1274505203888cb782782bfaa';
const CLI = '/tmp/zz-canary-t3b-claude-2.1.310';
interface Delivery { id: string; status: string; last_error: string | null; terminal_at: Date | null; attempt: number }
interface TranscriptEntry { type?: string; isApiErrorMessage?: boolean; message?: { stop_reason?: string } }

test.runIf(existsSync(CLI) && existsSync(join(BUNDLE, '.release-sha')))(
  'a real Claude TUI receiving an immediate local HTTP 400 fails the V3 delivery promptly', async () => {
  assert.match(process.env.HOME ?? '', /^\/tmp\/cauce-e2e-home-/u, 'Run with scripts/e2e-lab.sh');
  await mkdir(RECEIPTS, { recursive: true });
  const run = randomUUID().slice(0, 8), alias = `zz-canary-t3b-${run}`, publisher = `zz-canary-t3b-pub-${run}`;
  const directory = await mkdtemp('/tmp/zz-canary-t3b-api-'), home = join(directory, 'home');
  const runtimeName = `zz-canary-t3b-api-${run}`, databaseName = `${runtimeName}-pg`;
  const tls = createSelfSignedCert({ directory }), workerTls = createSelfSignedCert({ directory });
  for (const path of [tls.cert_path, tls.key_path, workerTls.cert_path, workerTls.key_path]) await chmod(path, 0o600);
  const providerRequests: { path: string; status: number; atMs: number; responseMs: number }[] = [];
  const provider = createServer((incoming, outgoing) => {
    const atMs = Date.now();
    const result = { path: new URL(incoming.url ?? '/', 'http://localhost').pathname, status: 400, atMs, responseMs: 0 };
    incoming.resume();
    outgoing.writeHead(400, { 'content-type': 'application/json', 'request-id': `zz-canary-${run}` });
    outgoing.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'T3B_CONTROLLED_PROVIDER_REJECTED' } }));
    result.responseMs = Date.now() - atMs; providerRequests.push(result);
  });
  let runtime: StartedTestContainer | undefined, database: StartedTestContainer | undefined;
  let pool: DatabasePool | undefined, app: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let publishedId: string | undefined, deliveryId: string | undefined;
  const record = async (name: string, value: unknown) => writeFile(join(RECEIPTS, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const cleanupFailures: unknown[] = [];
  try {
    assert.equal((await readFile(join(BUNDLE, '.release-sha'), 'utf8')).trim(), REF);
    const digest = (await command('python3', [join(process.cwd(), 'ops/container-runtime/cauce-container-runtime.py'), 'bundle-digest', BUNDLE])).stdout.trim();
    assert.equal(digest, DIGEST);
    for (const path of [home, join(home, '.local/bin'), join(home, '.claude'), join(home, 'projects'), join(home, '.cauce')]) await mkdir(path, { recursive: true, mode: 0o700 });
    await writeFile(join(home, '.bash_profile'), 'export PATH="$HOME/.local/bin:$PATH"\n', { mode: 0o600 });
    await new Promise<void>(resolve => { provider.listen(0, '127.0.0.1', resolve); });
    const providerAddress = provider.address(); assert.ok(providerAddress && typeof providerAddress !== 'string');
    await writeFile(join(home, '.local/bin/claude'), `#!/bin/sh\nexport ANTHROPIC_API_KEY=zz-canary-not-a-real-key\nexport ANTHROPIC_BASE_URL=http://127.0.0.1:${String(providerAddress.port)}\nexport DISABLE_AUTOUPDATER=1\nexport CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\nexport DISABLE_TELEMETRY=1\nexec /usr/local/bin/claude-native "$@"\n`, { mode: 0o700 });
    const configuration = { hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true, theme: 'dark', customApiKeyResponses: { approved: ['zz-canary-not-a-real-key'.slice(-20)], rejected: [] },
      projects: { '/home/node/projects': { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } };
    for (const path of ['.claude.json', '.claude/.claude.json']) await writeFile(join(home, path), JSON.stringify(configuration), { mode: 0o600 });
    const password = randomUUID();
    database = await arrancarPostgresDePrueba(() => new GenericContainer('postgres:16-alpine').withName(databaseName)
      .withLabels({ 'cauce.e2e.owner': OWNER }).withCommand([...COMANDO_POSTGRES_DE_PRUEBA])
      .withEnvironment({ POSTGRES_DB: 'cauce_test', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: password })
      .withExposedPorts(5432).withHealthCheck(saludDePostgresDePrueba('cauce_test', 'cauce_test')).withWaitStrategy(Wait.forHealthCheck()).start());
    pool = createPool(`postgresql://cauce_test:${encodeURIComponent(password)}@${database.getHost()}:${String(database.getMappedPort(5432))}/cauce_test`);
    await applyMigrationsThrough(pool, '047_agent_preferences.sql');
    for (const target of [alias, publisher]) {
      await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory)
        VALUES('Steven',$1,'claude',true,$2,'node','/home/node','/home/node/.cauce')`, [target, runtimeName]);
      await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','grp.steven',$1,'agent')", [target]);
    }
    await applyMigrations(pool);
    const identities = join(directory, 'identities.json');
    await writeFile(identities, JSON.stringify({ version: 1, identities: [[alias, workerTls], [publisher, tls]].map(([target, material]) => {
      assert.ok(typeof target === 'string' && typeof material === 'object');
      return { certificate_sha256: new X509Certificate(material.cert).fingerprint256.replaceAll(':', '').toLowerCase(),
        expires_at: new Date(Date.now() + 900_000).toISOString(), principal: { tenant_id: 'Steven', alias: target,
          session_id: `canary:${run}`, channel: 'adapter', roles: ['adapter'], permissions: ['route', 'read'] } };
    }) }), { mode: 0o600 });
    app = await buildGateway({ pool, logger: false, outboxPollMs: 10, leaseTtlMs: 10_000,
      authProvider: new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(identities)),
      https: { cert: tls.cert, key: tls.key, ca: [tls.cert, workerTls.cert], requestCert: true, rejectUnauthorized: true } });
    await app.listen({ host: '0.0.0.0', port: 0 });
    const address = app.server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `https://127.0.0.1:${String(address.port)}`;
    const http = async (path: string, payload?: unknown) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const body = payload === undefined ? undefined : JSON.stringify(payload);
      const outgoing = request(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', ca: tls.cert, cert: tls.cert, key: tls.key,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }) }, incoming => {
        let result = ''; incoming.setEncoding('utf8'); incoming.on('data', (chunk: string) => { result += chunk; });
        incoming.once('error', reject); incoming.once('end', () => { resolve({ status: incoming.statusCode ?? 0, body: result }); });
      }); outgoing.once('error', reject); outgoing.end(body);
    });
    const recipe = await readFile(join(process.cwd(), 'tests/e2e/lab-runner/Dockerfile'));
    runtime = await new GenericContainer(`cauce-e2e-lab-runner:${createHash('sha256').update(recipe).digest('hex').slice(0, 12)}`)
      .withName(runtimeName).withLabels({ 'cauce.e2e.owner': OWNER }).withUser('0').withNetworkMode('host')
      .withBindMounts([{ source: home, target: '/home/node', mode: 'rw' }, { source: directory, target: '/fixture', mode: 'ro' },
        { source: BUNDLE, target: '/release', mode: 'ro' }, { source: CLI, target: '/usr/local/bin/claude-native', mode: 'ro' }]).withWorkingDir('/home/node/projects')
      .withCommand(['sleep', 'infinity']).withWaitStrategy(Wait.forSuccessfulCommand('id node')).start();
    const version = (await command('docker', ['exec', '--user', '1000', '-e', 'HOME=/home/node', runtimeName, '/home/node/.local/bin/claude', '--version'])).stdout.trim();
    const variables = { HOME: '/home/node', PATH: '/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'xterm-256color',
      CAUCE_ENVIRONMENT: 'production', CAUCE_TENANT: 'Steven', CAUCE_ROOM: 'grp.steven', CAUCE_ALIAS: alias, CAUCE_RUNTIME_KEY: alias,
      CAUCE_INSTANCE_ID: `canary-${run}`, CAUCE_STATE_DIR: '/home/node/.cauce', CAUCE_RELAY_URL: `${origin.replace('https:', 'wss:')}/v3/ws`,
      CAUCE_TLS_CERT_FILE: `/fixture/${workerTls.cert_path.split('/').slice(-2).join('/')}`, CAUCE_TLS_KEY_FILE: `/fixture/${workerTls.key_path.split('/').slice(-2).join('/')}`,
      CAUCE_TLS_CA_FILE: `/fixture/${tls.cert_path.split('/').slice(-2).join('/')}`, CAUCE_SHARED_SESSION: '1', CAUCE_SHARED_SESSION_WORKSPACE: '/home/node/projects', CAUCE_SEMBRAR_PERFIL: '1' };
    await command('docker', ['exec', '--detach', '--user', '1000', ...Object.entries(variables).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      runtimeName, 'sh', '-c', 'exec node /release/packages/adapter-sdk/dist/src/bin/claude.js > /home/node/adapter.log 2>&1']);
    const activePool = pool;
    await waitFor(async () => (await activePool.query("SELECT 1 FROM connection_leases WHERE tenant_id='Steven' AND alias=$1 AND lease_until>now()", [alias])).rowCount ? true : undefined);
    const startedAt = Date.now();
    const response = await http('/v3/messages', { room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias }],
      body: { text: 'Owned T3B immediate provider rejection canary' }, idempotency_key: randomUUID() });
    assert.equal(response.status, 202, response.body);
    const published = PublishResultSchema.parse(JSON.parse(response.body));
    publishedId = published.message_id; deliveryId = published.delivery_ids[0]; assert.ok(deliveryId);
    await waitFor(async () => providerRequests.some(item => item.path === '/v1/messages') ? true : undefined);
    const failed = await waitFor(async () => {
      const row = (await activePool.query<Delivery>('SELECT id,status,last_error,terminal_at,attempt FROM deliveries WHERE id=$1', [deliveryId])).rows[0];
      return row && ['dead', 'failed', 'done'].includes(row.status) ? row : undefined;
    }, 310_000);
    const terminalObservedAt = Date.now(), elapsedMs = terminalObservedAt - startedAt;
    const acknowledgments = (await pool.query<{ status: string; applied: boolean; error_code: string | null; retryable: boolean | null }>(
      "SELECT status,applied,payload->>'error_code' AS error_code,(payload->>'retryable')::boolean AS retryable FROM delivery_acks WHERE delivery_id=$1 ORDER BY id", [deliveryId])).rows;
    const detail = await http(`/v3/console/messages/${publishedId}`), queues = await http('/v3/console/queues');
    assert.equal(detail.status, 200); assert.equal(queues.status, 200);
    const consoleText = detail.body + queues.body;
    await record('result', { result: 'OBSERVED', alias, release: { ref: REF, digest }, cli: { version, realExecutable: true },
      provider: { localControlledHttp: true, commercialApi: false, requests: providerRequests }, elapsedMs,
      fromProviderResponseMs: providerRequests[0] ? terminalObservedAt - providerRequests[0].atMs : null,
      delivery: failed, acknowledgments, console: { surface: 'canonical HTTP, mTLS canary publisher; no human browser',
        detail: JSON.parse(detail.body) as unknown, queues: JSON.parse(queues.body) as unknown } });
    assert.equal(failed.status, 'dead');
    assert.match(failed.last_error ?? '', /terminal API error/u);
    assert.equal(acknowledgments.at(-1)?.retryable, false);
    assert.ok(providerRequests.some(item => item.path === '/v1/messages' && item.status === 400));
    assert.ok(elapsedMs < 15_000, `Immediate provider failure took ${String(elapsedMs)}ms`);
    assert.match(consoleText, /terminal API error/u);
    assert.doesNotMatch(consoleText, /T3B_CONTROLLED_PROVIDER_REJECTED|Harness timed out|180 min/u);
  } finally {
    const settleCleanup = async (steps: readonly (readonly [string, () => Promise<unknown>])[]) => {
      const failures: { stage: string; error: unknown }[] = [];
      for (const [stage, operation] of steps) {
        try { await operation(); } catch (error) { failures.push({ stage, error }); }
      }
      return failures;
    };
    let remaining: string | undefined, temporaryDirectoryRemoved = false;
    const failures = await settleCleanup([
      ['diagnostics', async () => {
        if (!runtime) return;
        const log = await readFile(join(home, 'adapter.log'), 'utf8').catch(() => 'unavailable');
        await writeFile(join(RECEIPTS, 'adapter.log'), log, { mode: 0o600 });
        const pane = await command('docker', ['exec', '--user', '1000', '-e', 'HOME=/home/node', runtimeName,
          'tmux', '-L', 'cauce', 'capture-pane', '-p', '-t', `cauce-${alias}:agente`, '-S', '-80']).then(value => value.stdout, () => 'unavailable');
        await writeFile(join(RECEIPTS, 'tui.txt'), pane, { mode: 0o600 });
        const files = await readdir(join(home, '.claude/projects'), { recursive: true }).catch(() => []);
        const transcript = await Promise.all(files.filter(path => path.endsWith('.jsonl')).map(async path => {
          const text = await readFile(join(home, '.claude/projects', path), 'utf8');
          return text.trim().split('\n').filter(Boolean).map(line => {
            const entry = JSON.parse(line) as TranscriptEntry;
            return { type: entry.type, isApiErrorMessage: entry.isApiErrorMessage === true, stopReason: entry.message?.stop_reason };
          });
        }));
        await record('diagnostics', { publishedId, deliveryId, providerRequests, transcript });
      }],
      ['runtime', async () => runtime?.stop()],
      ['gateway', async () => app?.close()],
      ['pool', async () => pool?.end()],
      ['database', async () => database?.stop()],
      ['provider', async () => {
        if (provider.listening) await new Promise<void>((resolve, reject) => {
          provider.close(error => { if (error) reject(error); else resolve(); });
        });
      }],
      ['directory', async () => { await rm(directory, { recursive: true, force: true }); temporaryDirectoryRemoved = true; }],
      ['verification', async () => {
        remaining = (await command('docker', ['ps', '-aq', '--filter', `name=^/${runtimeName}(-pg)?$`])).stdout.trim();
        assert.equal(remaining, '');
      }],
    ]);
    failures.push(...await settleCleanup([['receipt', async () => record('cleanup', {
      result: failures.length ? 'FAIL' : 'PASS', runtimeRemoved: remaining === '', databaseRemoved: remaining === '', temporaryDirectoryRemoved,
      failures: failures.map(({ stage, error }) => ({ stage, kind: error instanceof Error ? error.name : 'unknown' })),
    })]]));
    cleanupFailures.push(...failures.map(({ error }) => error));
  }
  if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'Owned API fixture teardown failed');
}, 480_000);
