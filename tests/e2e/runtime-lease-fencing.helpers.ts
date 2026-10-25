import { execFile } from 'node:child_process';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { applyMigrations, applyMigrationsThrough, createPool, type DatabasePool } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { HashedMtlsIdentityFileProvider, MtlsAuthProvider } from '../../services/gateway/src/auth.js';
import { WebSocketConsumerConnector } from '../../packages/adapter-sdk/src/sdk/websocket-transport.js';
import type { ConsumerConnection, ServerFrame } from '../../packages/adapter-sdk/src/sdk/types.js';
import { arrancarPostgresDePrueba, COMANDO_POSTGRES_DE_PRUEBA, saludDePostgresDePrueba } from '../helpers/contenedor-de-prueba.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';

export const FENCING_OWNER = 't1-cercado-1025';
export const FENCING_RECEIPTS = join(process.cwd(), '.delegados/v4/recibos', FENCING_OWNER);
const execute = promisify(execFile);
type Certificate = ReturnType<typeof createSelfSignedCert>;
export interface RuntimeLeaseFixture {
  pool: DatabasePool;
  app: Awaited<ReturnType<typeof buildGateway>>;
  worker: string;
  moving: string;
  remoteAddresses: string[];
  connect(alias: string): Promise<RuntimeLeaseConsumer>;
  connectRemote(alias: string): Promise<{ ipAddress: string; next(event: string): Promise<Record<string, unknown>> }>;
  publish(alias: string, marker: string): Promise<{ status: number; body: unknown }>;
  close(): Promise<void>;
}
export interface RuntimeLeaseConsumer {
  connection: ConsumerConnection;
  instance: string;
  next(type: ServerFrame['type']): Promise<ServerFrame>;
}

export async function fencingReceipt(name: string, value: unknown): Promise<void> {
  await mkdir(FENCING_RECEIPTS, { recursive: true, mode: 0o700 });
  await writeFile(join(FENCING_RECEIPTS, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function nextFrame(iterator: AsyncIterator<ServerFrame>, type: ServerFrame['type']): Promise<ServerFrame> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (async () => {
        for (;;) {
          const frame = await iterator.next();
          if (frame.done) throw new Error(`Consumer closed before ${type}`);
          if (frame.value.type === type) return frame.value;
          if (frame.value.type === 'error') throw new Error(`Unexpected gateway error: ${frame.value.code}`);
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error(`No ${type} within 10000ms`)); }, 10_000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function seedLegacyAgents(pool: DatabasePool, aliases: readonly string[], directory: string): Promise<void> {
  for (const alias of aliases) {
    await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,
        home_directory,state_directory,max_concurrent_deliveries)
      VALUES('Steven',$1,'codex',true,$2,'test',$3,$4,2)`,
    [alias, `zz-canary-${FENCING_OWNER}-${alias}`, directory, join(directory, alias)]);
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','grp.steven',$1,'agent')", [alias]);
  }
}

export async function startRuntimeLeaseFixture(): Promise<RuntimeLeaseFixture> {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('Runtime fencing E2E requires its own PostgreSQL container');
  const directory = await mkdtemp(join(tmpdir(), `zz-canary-${FENCING_OWNER}-`));
  const run = randomUUID().replaceAll('-', '').slice(0, 10);
  const worker = `leasevthree${run}`, moving = `leasemoving${run}`, publisher = `leasepublisher${run}`;
  const tls = createSelfSignedCert({ directory });
  const certificates = new Map<string, Certificate>([[publisher, tls], [worker, createSelfSignedCert({ directory })],
    [moving, createSelfSignedCert({ directory })]]);
  for (const material of certificates.values()) {
    await chmod(material.cert_path, 0o600);
    await chmod(material.key_path, 0o600);
  }
  const password = randomUUID();
  const connections: ConsumerConnection[] = [];
  const remoteContainers: StartedTestContainer[] = [];
  const remoteAddresses: string[] = [];
  let container: StartedTestContainer | undefined;
  let pool: DatabasePool | undefined;
  let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
  const close = async (): Promise<void> => {
    const failures: unknown[] = [];
    const consumers = await Promise.allSettled([
      ...remoteContainers.map(async remote => remote.stop()), ...connections.map(async connection => connection.close()),
    ]);
    for (const result of consumers) if (result.status === 'rejected') failures.push(result.reason);
    for (const cleanup of [async () => app?.close(), async () => pool?.end(), async () => container?.stop(),
      async () => rm(directory, { recursive: true, force: true })]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Runtime lease fixture cleanup failed');
  };
  try {
    container = await arrancarPostgresDePrueba(() => new GenericContainer('postgres:16-alpine')
      .withName(`zz-canary-${FENCING_OWNER}-postgres-${run}`).withLabels({ 'cauce.e2e.owner': FENCING_OWNER })
      .withCommand([...COMANDO_POSTGRES_DE_PRUEBA])
      .withEnvironment({ POSTGRES_DB: 'cauce_test', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: password })
      .withExposedPorts(5432).withHealthCheck(saludDePostgresDePrueba('cauce_test', 'cauce_test'))
      .withWaitStrategy(Wait.forHealthCheck()).start());
    pool = createPool(`postgresql://cauce_test:${encodeURIComponent(password)}@${container.getHost()}:${String(container.getMappedPort(5432))}/cauce_test`);
    await applyMigrationsThrough(pool, '047_agent_preferences.sql');
    await seedLegacyAgents(pool, [worker, moving, publisher], directory);
    await applyMigrations(pool);
    await pool.query(`INSERT INTO fleet_hosts(host_id,display_name,company_id)
      SELECT host_id,host_id,tenant.company_id FROM tenants tenant CROSS JOIN unnest(ARRAY['server','server2','targethost']) host_id
      WHERE tenant.id='Steven' ON CONFLICT(host_id) DO NOTHING`);
    await pool.query("UPDATE agents SET host_id='server2' WHERE tenant_id='Steven' AND alias=ANY($1::text[])", [[worker, moving]]);
    const registry = join(directory, 'identities.json');
    await writeFile(registry, JSON.stringify({ version: 1, identities: [...certificates].map(([alias, material]) => ({
      certificate_sha256: new X509Certificate(material.cert).fingerprint256.replaceAll(':', '').toLowerCase(),
      expires_at: new Date(Date.now() + 600_000).toISOString(), principal: { tenant_id: 'Steven', alias,
        session_id: `legacy:${alias}`, channel: 'adapter', roles: ['adapter'], permissions: ['route', 'read'] },
    })) }), { mode: 0o600 });
    const authProvider = new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(registry));
    const serverCert = join(directory, 'gateway.crt'), serverCsr = join(directory, 'gateway.csr'), extension = join(directory, 'gateway.ext');
    await writeFile(extension, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:gateway,DNS:localhost,IP:127.0.0.1\n', { mode: 0o600 });
    await execute('openssl', ['req', '-new', '-key', tls.key_path, '-out', serverCsr, '-subj', '/CN=gateway']);
    await execute('openssl', ['x509', '-req', '-in', serverCsr, '-CA', tls.cert_path, '-CAkey', tls.key_path,
      '-set_serial', '101', '-days', '1', '-extfile', extension, '-out', serverCert]);
    app = await buildGateway({ pool, authProvider, legacyRuntimeHostId: 'server', logger: false,
      leaseTtlMs: 30_000, outboxPollMs: 10,
      https: { cert: await readFile(serverCert), key: tls.key, ca: [...certificates.values()].map(material => material.cert),
        requestCert: true, rejectUnauthorized: true },
    });
    app.server.on('upgrade', upgrade => { if (upgrade.socket.remoteAddress) remoteAddresses.push(upgrade.socket.remoteAddress); });
    await app.listen({ host: '0.0.0.0', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('Gateway address unavailable');
    const origin = `https://127.0.0.1:${String(address.port)}`;
    await fencingReceipt('fixture', { authentication: authProvider.mode, transport: 'mutual-tls',
      controllerHost: 'server', legacyHost: 'server2', baselineCreatedBy: '048_ui_fleet_lifecycle',
      postgresContainer: container.getId(), worker, moving });
    return { pool, app, worker, moving, close, remoteAddresses,
      async connectRemote(alias) {
        const material = certificates.get(alias);
        if (!material) throw new Error('Unknown owned remote adapter');
        const recipe = await readFile(join(process.cwd(), 'tests/e2e/lab-runner/Dockerfile'));
        const image = `cauce-e2e-lab-runner:${createHash('sha256').update(recipe).digest('hex').slice(0, 12)}`;
        const remote = await new GenericContainer(image).withName(`zz-canary-${FENCING_OWNER}-adapter-${randomUUID().slice(0, 8)}`)
          .withHostname('zz-canary-server2').withLabels({ 'cauce.e2e.owner': FENCING_OWNER })
          .withUser(`${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`)
          .withExtraHosts([{ host: 'gateway', ipAddress: 'host-gateway' }])
          .withBindMounts([{ source: process.cwd(), target: process.cwd(), mode: 'ro' }, { source: directory, target: directory, mode: 'ro' }])
          .withWorkingDir(process.cwd()).withCommand(['node', '--import', 'tsx', 'tests/e2e/runtime-lease-fencing.driver.ts',
            `wss://gateway:${String(address.port)}/v3/ws`, alias, material.cert_path, material.key_path, tls.cert_path])
          .withWaitStrategy(Wait.forLogMessage('"event":"ready"')).start();
        remoteContainers.push(remote);
        const stream = await remote.logs();
        const events: Record<string, unknown>[] = [];
        const waiters = new Set<() => void>();
        let pending = '';
        stream.on('data', (chunk: Buffer) => {
          pending += chunk.toString('utf8');
          for (;;) {
            const newline = pending.indexOf('\n');
            if (newline < 0) break;
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            if (line.startsWith('{')) events.push(JSON.parse(line) as Record<string, unknown>);
          }
          for (const wake of waiters) wake();
        });
        return { ipAddress: remote.getIpAddress('bridge'), async next(event) {
          let timer: NodeJS.Timeout | undefined;
          let wake: (() => void) | undefined;
          try {
            return await new Promise<Record<string, unknown>>((resolve, reject) => {
              wake = () => {
                const found = events.find(candidate => candidate.event === event || candidate.event === 'failure');
                if (found?.event === 'failure') reject(new Error(`Remote adapter failed: ${String(found.error)}`));
                else if (found) { events.splice(events.indexOf(found), 1); resolve(found); }
              };
              waiters.add(wake); wake();
              timer = setTimeout(() => { reject(new Error(`No remote ${event} within 10000ms`)); }, 10_000);
            });
          } finally { clearTimeout(timer); if (wake) waiters.delete(wake); }
        } };
      },
      async connect(alias) {
        const material = certificates.get(alias);
        if (!material) throw new Error('Unknown owned adapter');
        const connection = await new WebSocketConsumerConnector(`${origin.replace('https:', 'wss:')}/v3/ws`, {
          environment: 'production', mutualTls: { certFile: material.cert_path, keyFile: material.key_path, caFile: tls.cert_path },
        }).connect(AbortSignal.timeout(10_000));
        connections.push(connection);
        const iterator = connection.frames()[Symbol.asyncIterator]();
        const instance = `lease-${randomUUID()}`;
        await connection.send({ type: 'hello', version: '3.0', tenant_id: 'Steven', alias,
          instance_id: instance, capabilities: ['messages.v3', 'acks.v3'] });
        return { connection, instance, next: type => nextFrame(iterator, type) };
      },
      async publish(alias, marker) {
        const body = JSON.stringify({ room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias }],
          body: { text: marker }, idempotency_key: randomUUID() });
        return new Promise((resolve, reject) => {
          const outgoing = request(`${origin}/v3/messages`, { method: 'POST', ca: tls.cert, cert: tls.cert, key: tls.key,
            rejectUnauthorized: true, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          }, response => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
            response.once('end', () => { resolve({ status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }); });
          });
          outgoing.once('error', reject);
          outgoing.setTimeout(10_000, () => outgoing.destroy(new Error('Owned publish timed out')));
          outgoing.end(body);
        });
      },
    };
  } catch (error) { await close(); throw error; }
}
