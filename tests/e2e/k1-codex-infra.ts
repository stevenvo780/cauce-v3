import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { applyMigrations, createPool, type DatabasePool } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import { arrancarPostgresDePrueba, COMANDO_POSTGRES_DE_PRUEBA, saludDePostgresDePrueba } from '../helpers/contenedor-de-prueba.js';
import { K1_OWNER, K1_PREFIX, K1_RUN, k1Receipt, type startK1CodexRuntime } from './k1-codex-runtime.js';

type Runtime = Awaited<ReturnType<typeof startK1CodexRuntime>>;
interface CommandPins { command: string; sha256: string; files: Record<string, string> }

export async function startK1Gateway() {
  const alias = `k1${K1_RUN.replaceAll('-', '').slice(0, 12)}`;
  const sender = `${alias}sender`;
  const password = randomUUID();
  let database: StartedTestContainer | undefined;
  let pool: DatabasePool | undefined;
  let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
  const close = async () => {
    try { await app?.close(); }
    finally { try { await pool?.end(); } finally { await database?.stop(); } }
  };
  try {
    database = await arrancarPostgresDePrueba(() => new GenericContainer('postgres:16-alpine')
      .withName(`${K1_PREFIX}-postgres`).withLabels({ 'cauce.e2e.owner': K1_OWNER, 'cauce.e2e.run': K1_RUN })
      .withCommand([...COMANDO_POSTGRES_DE_PRUEBA]).withTmpFs({ '/var/lib/postgresql/data': 'rw,nosuid,size=256m' })
      .withEnvironment({ POSTGRES_DB: 'cauce_test', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: password })
      .withExposedPorts(5432).withHealthCheck(saludDePostgresDePrueba('cauce_test', 'cauce_test'))
      .withWaitStrategy(Wait.forHealthCheck()).start());
    pool = createPool(`postgresql://cauce_test:${encodeURIComponent(password)}@${database.getHost()}:${String(database.getMappedPort(5432))}/cauce_test`);
    await applyMigrations(pool);
    for (const current of [alias, sender]) {
      await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,runtime_key,runtime_mode,
        container_name,runtime_user,home_directory,state_directory)
        VALUES('Steven',$1,'codex',true,$1,'native',$2,'node','/home/node','/home/node/.cauce')`, [current, K1_PREFIX]);
      await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','grp.steven',$1,'agent')", [current]);
    }
    app = await buildGateway({ pool, authProvider: DevOnlyAuthProvider.forTests(), logger: false,
      leaseTtlMs: 5_000, ackDeadlineMs: 600_000, outboxPollMs: 20 });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
    await k1Receipt('gateway.json', { database: database.getId(), auth_fixture: 'DevOnlyAuthProvider.forTests',
      production_authorization_exercised: false, alias, sender, tenant: 'Steven' });
    return { pool, app, url, alias, sender, close };
  } catch (error) { await close(); throw error; }
}

export async function startK1Adapter(runtime: Runtime, gateway: Awaited<ReturnType<typeof startK1Gateway>>, pins: CommandPins) {
  const env = {
    CAUCE_TENANT: 'Steven', CAUCE_ROOM: 'grp.steven', CAUCE_ALIAS: gateway.alias,
    CAUCE_INSTANCE_ID: `${gateway.alias}-${randomUUID()}`, CAUCE_STATE_DIR: '/home/node/.cauce',
    CAUCE_SPACE_ROOT: '/home/node/space', CAUCE_SHARED_SESSION_WORKSPACE: '/home/node/space',
    CAUCE_RELAY_URL: `${gateway.url.replace('http:', 'ws:')}/v3/ws`, CAUCE_ENVIRONMENT: 'test',
    CAUCE_DEV_AUTH: '1', CAUCE_SHARED_SESSION: '1', CAUCE_MODEL_ID: 'gpt-5.4', CAUCE_REASONING_EFFORT: 'low',
    CAUCE_HARNESS_COMMAND: pins.command, CAUCE_HARNESS_COMMAND_SHA256: pins.sha256,
    CAUCE_HARNESS_COMMAND_FILES: JSON.stringify(pins.files), CAUCE_HEARTBEAT_MS: '250',
  };
  await runtime.exec(['env', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), 'python3', '-I', '-B', '-c',
    `import json,os,pathlib,subprocess
root=pathlib.Path('/home/node/.cauce');log=(root/'adapter.log').open('ab')
child=subprocess.Popen(['node','/cauce-sdk/src/bin/codex.js'],stdin=subprocess.DEVNULL,stdout=log,stderr=log,
 cwd='/home/node/space',env=os.environ,start_new_session=True)
raw=pathlib.Path('/proc',str(child.pid),'stat').read_text();start=raw[raw.rfind(')')+1:].split()[19]
(root/'k1-adapter-process.json').write_text(json.dumps({'pid':child.pid,'starttime':start}))`]);
}

export async function stopK1Adapter(runtime: Runtime): Promise<void> {
  const result = await runtime.exec(['python3', '-I', '-B', '-c', `import json,os,pathlib,signal,sys,time
receipt=json.loads(pathlib.Path('/home/node/.cauce/k1-adapter-process.json').read_text());pid=receipt['pid']
def same():
 try:
  raw=pathlib.Path('/proc',str(pid),'stat').read_text();fields=raw[raw.rfind(')')+1:].split()
  return fields[0] not in {'Z','X'} and fields[19]==receipt['starttime']
 except FileNotFoundError:return False
if same():
 fd=os.pidfd_open(pid)
 try:
  if not same():raise SystemExit('owned adapter identity changed')
  signal.pidfd_send_signal(fd,signal.SIGTERM)
  for attempt in range(50):
   if not same():break
   time.sleep(0.1)
  if same():
   signal.pidfd_send_signal(fd,signal.SIGKILL)
   for attempt in range(50):
    if not same():break
    time.sleep(0.1)
 finally:os.close(fd)
stopped=not same()
print(json.dumps({'pid':pid,'starttime':receipt['starttime'],'owned_adapter_stopped':stopped}))
if not stopped:sys.exit(1)`]);
  const observed = JSON.parse(result.stdout) as { pid: number; starttime: string; owned_adapter_stopped: unknown };
  await k1Receipt(`adapter-stop-${String(observed.pid)}.json`, observed);
  if (observed.owned_adapter_stopped !== true) throw new Error('the owned adapter did not stop');
}

export async function observeK1NativeSession(runtime: Runtime): Promise<string | undefined> {
  return (JSON.parse((await runtime.exec(['python3', '-I', '-B', '-c', `import json,pathlib
files=sorted(pathlib.Path('/home/node/.codex/sessions').rglob('rollout-*.jsonl'),key=lambda path:path.stat().st_mtime,reverse=True)
native=None
for path in files:
 with path.open() as stream:
  try:row=json.loads(stream.readline())
  except ValueError:continue
 if row.get('type')=='session_meta' and row.get('payload',{}).get('cwd')=='/home/node/space':
  native=row['payload']['id'];break
print(json.dumps({'native_id':native}))`])).stdout) as { native_id: string | null }).native_id ?? undefined;
}
