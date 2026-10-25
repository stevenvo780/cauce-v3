import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { arrancarPostgresDePrueba, COMANDO_POSTGRES_DE_PRUEBA, saludDePostgresDePrueba } from '../../tests/helpers/contenedor-de-prueba.ts';
import { createSelfSignedCert } from '../../tests/terminal-pty/certs.mjs';

const ROOT = process.cwd();
assert.equal(process.env.T3D_ON_VM, '1');
const expectedVm = process.env.T3D_LAB_VM ?? 'docker-lab';
assert.ok(['docker-lab', 'docker-lab-2'].includes(expectedVm));
assert.equal((await readFile('/etc/hostname', 'utf8')).trim(), expectedVm);
assert.equal(process.getuid(), 1000);
const SOURCE = process.env.T3D_SOURCE ?? ROOT;
const fromSource = path => import(pathToFileURL(join(SOURCE, path)).href);
const { applyMigrations, applyMigrationsThrough, createPool } = await fromSource('packages/store/src/index.ts');
const { buildGateway } = await fromSource('services/gateway/src/app.ts');
const { HashedMtlsIdentityFileProvider, MtlsAuthProvider } = await fromSource('services/gateway/src/auth.ts');
const OWNER = 't3d-astra-sin-tui-1025';
const harness = 'codex';
const RECEIPTS = join(ROOT, '.delegados/v4/recibos', OWNER, 'lab', process.env.T3D_RUN ?? 'run-1');
const execute = promisify(execFile);
const command = (file, args, timeout = 45_000) => execute(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const remote = (args, timeout = 45_000) => command(args[0], args.slice(1), timeout);
const labDocker = args => command('docker', ['--host', 'unix:///var/run/docker.sock', ...args]);
async function toolHashes() {
  const directory = join(ROOT, '.delegados/v4');
  const files = (await readdir(directory)).filter(file => file.endsWith('.py') && (file.startsWith('live_adapter_v3') || file === 'live_adapter.py'));
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, createHash('sha256').update(await readFile(join(directory, file))).digest('hex')])));
}
const save = async (name, value) => writeFile(join(RECEIPTS, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
async function waitFor(operation, timeout = 45_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await operation();
    if (value !== undefined) return value;
    await delay(150);
  }
  throw new Error('Owned systemd canary condition exceeded deadline');
}

await mkdir(RECEIPTS, { recursive: true, mode: 0o700 });
await chmod(RECEIPTS, 0o700);
const bundle = process.env.T3D_BUNDLE;
assert.ok(bundle, 'T3D_BUNDLE must name an official clean-ref adapter bundle');
const bundleRef = (await readFile(join(bundle, '.release-sha'), 'utf8')).trim();
assert.equal((await command('git', ['-C', SOURCE, 'rev-parse', 'HEAD'])).stdout.trim(), bundleRef);
assert.equal((await command('git', ['-C', SOURCE, 'status', '--porcelain'])).stdout, '');
const frozenTools = await toolHashes();
const frozenDriver = createHash('sha256').update(await readFile(join(ROOT, 'tests/e2e/t3d-astra-sin-tui.lab.mjs'))).digest('hex');
const bundleDigest = (await command('python3', [join(ROOT, 'ops/container-runtime/cauce-container-runtime.py'), 'bundle-digest', bundle])).stdout.trim();
const directory = await mkdtemp('/tmp/zz-canary-t3d-systemd-');
const run = randomUUID().slice(0, 8);
const alias = `zz-canary-t3d-sd-${run}`, publisher = `zz-canary-t3d-pub-${run}`;
const unit = `${alias}.service`;
const home = join(directory, 'home'), state = join(home, '.local/state/cauce-v3', alias);
const socketRoot = join(directory, 'tmux');
const bundleRoot = join(directory, 'bundle');
const installedBundle = join(bundleRoot, 'releases', `lab-old-${bundleRef.slice(0, 12)}`);
const bin = join(directory, 'bin');
let database, pool, app, unitPath, unitDirectory;
const probeServer = createServer();
const probes = []; const deliveries = []; const commands = [];
const cleanup = { owner: OWNER, directory, unit, started_at: new Date().toISOString(), failures: [] };
const failure = error => String(error instanceof Error ? error.message : error).replace(/postgresql:\/\/[^\s]+/gu, '[owned database URL omitted]');
let proof;
try {
  await Promise.all([bin, home, state, socketRoot, join(home, 'projects')].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  await writeFile(join(state, 'inbox.json'), JSON.stringify({ version: 1, deliveries: {} }), { mode: 0o600 });
  await writeFile(join(state, 'outbox.json'), JSON.stringify({ version: 1, pending: [] }), { mode: 0o600 });
  await copyFile(process.execPath, join(bin, 'node'));
  await chmod(join(bin, 'node'), 0o700);
  await mkdir(join(bundleRoot, 'releases'), { recursive: true });
  await command('cp', ['-a', bundle, installedBundle]);
  const controlled = (await readFile(join(ROOT, 'tests/e2e/h6d-reinicio-politica.provider.py'), 'utf8'))
      .replace('#!/usr/local/bin/python3', '#!/usr/bin/python3')
      .replace('response = "ACK"', 'response = re.search(r"CAUCE_LIVE_[a-f0-9]{32}", text).group(0) if re.search(r"CAUCE_LIVE_[a-f0-9]{32}", text) else "ACK"')
      .replace('if "app-server" in sys.argv:', 'if "--version" in sys.argv:\n    print("codex-cli 0.1.0")\n    sys.exit(0)\n\nif "app-server" in sys.argv:');
  assert.ok(controlled);
  await writeFile(join(bin, harness), controlled, { mode: 0o700 });
  await writeFile(join(home, '.bash_profile'), `export PATH=${quote(bin)}:/usr/bin:/bin\n`, { mode: 0o600 });
  process.env.DOCKER_HOST = 'unix:///var/run/docker.sock';
  delete process.env.DOCKER_CONTEXT;
  process.env.TESTCONTAINERS_HOST_OVERRIDE = '127.0.0.1';
  process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
  const daemon = await waitFor(() => command('docker', ['info', '--format', '{{.Name}}']).then(result => result.stdout.trim() === expectedVm ? result.stdout.trim() : undefined, () => undefined));
  const { GenericContainer, Wait } = await import('testcontainers');
  const password = randomUUID();
  database = await arrancarPostgresDePrueba(() => new GenericContainer('postgres:16-alpine')
    .withName(`${alias}-pg`).withLabels({ 'cauce.e2e.owner': OWNER })
    .withCommand([...COMANDO_POSTGRES_DE_PRUEBA])
    .withEnvironment({ POSTGRES_DB: 'cauce_test', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: password })
    .withExposedPorts(5432).withHealthCheck(saludDePostgresDePrueba('cauce_test', 'cauce_test')).withWaitStrategy(Wait.forHealthCheck()).withStartupTimeout(300_000).start());
  pool = createPool(`postgresql://cauce_test:${encodeURIComponent(password)}@${database.getHost()}:${database.getMappedPort(5432)}/cauce_test`);
  await applyMigrationsThrough(pool, '047_agent_preferences.sql');
  for (const target of [alias, publisher]) {
    await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory)
      VALUES('Steven',$1,$2,true,$3,'deploy',$4,$5)`, [target, harness, unit, home, state]);
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','grp.steven',$1,'agent')", [target]);
  }
  await applyMigrations(pool);
  const tls = createSelfSignedCert({ directory });
  const workerTls = createSelfSignedCert({ directory });
  await Promise.all([tls.cert_path, tls.key_path, workerTls.cert_path, workerTls.key_path].map(path => chmod(path, 0o600)));
  const identities = join(directory, 'identities.json');
  await writeFile(identities, JSON.stringify({ version: 1, identities: [[alias, workerTls], [publisher, tls]].map(([target, material]) => ({
    certificate_sha256: new X509Certificate(material.cert).fingerprint256.replaceAll(':', '').toLowerCase(),
    expires_at: new Date(Date.now() + 1_800_000).toISOString(), principal: { tenant_id: 'Steven', alias: target,
      session_id: `canary:${run}`, channel: 'adapter', roles: ['adapter'], permissions: ['route', 'read'] },
  })) }), { mode: 0o600 });
  app = await buildGateway({ pool, logger: false, outboxPollMs: 10, leaseTtlMs: 30_000,
    authProvider: new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(identities)),
    https: { cert: tls.cert, key: tls.key, ca: [tls.cert, workerTls.cert], requestCert: true, rejectUnauthorized: true } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.server.address().port;
  const relayPort = port;
  const environment = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TMUX_TMPDIR: socketRoot, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', DBUS_SESSION_BUS_ADDRESS: `unix:path=${directory}/no-session-bus`,
    CAUCE_TENANT: 'Steven', CAUCE_ROOM: 'grp.steven', CAUCE_ALIAS: alias, CAUCE_INSTANCE_ID: `systemd-${alias}`,
    CAUCE_STATE_DIR: state, CAUCE_RELAY_URL: `wss://127.0.0.1:${relayPort}/v3/ws`, CAUCE_ENVIRONMENT: 'development',
    CAUCE_TLS_CERT_FILE: workerTls.cert_path, CAUCE_TLS_KEY_FILE: workerTls.key_path, CAUCE_TLS_CA_FILE: tls.cert_path,
    CAUCE_SHARED_SESSION: '1', CAUCE_SHARED_SESSION_WORKSPACE: join(home, 'projects'), CAUCE_SEMBRAR_PERFIL: '1',
    CAUCE_EXPECTED_CLI_VERSION: '0.1.0', CAUCE_HEARTBEAT_MS: '1000' };
  const envFile = join(directory, 'adapter.env');
  await writeFile(envFile, Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
  const runtimeRoot = (await remote(['sh', '-c', 'printf %s "$XDG_RUNTIME_DIR"'])).stdout.trim();
  assert.match(runtimeRoot, /^\/run\/user\/1000$/u);
  unitDirectory = `${runtimeRoot}/systemd/user`;
  unitPath = `${unitDirectory}/${unit}`;
  const unitSource = join(directory, 'adapter.service');
  await writeFile(unitSource, `[Unit]\nDescription=Owned Cauce V3 adapter systemd lab\n[Service]\nType=simple\nEnvironmentFile=${envFile}\nWorkingDirectory=${join(home, 'projects')}\nExecStart=${join(bin, 'node')} ${join(installedBundle, 'packages/adapter-sdk/dist/src/bin', `${harness}.js`)}\nKillMode=control-group\nTimeoutStopSec=15\nRestart=no\nStandardOutput=append:${join(directory, 'adapter.log')}\nStandardError=append:${join(directory, 'adapter.log')}\n`);
  await remote(['mkdir', '-p', unitDirectory]);
  await remote(['cp', unitSource, unitPath]);
  await remote(['systemctl', '--user', 'daemon-reload']);
  await remote(['systemctl', '--user', 'start', unit]);
  const tmux = args => remote(['env', `TMUX_TMPDIR=${socketRoot}`, '/usr/bin/tmux', '-L', 'cauce', ...args]);
  async function snapshot(stage) {
    const properties = (await remote(['systemctl', '--user', 'show', unit, '--property=MainPID,KillMode,ControlGroup,ActiveState,InvocationID'])).stdout;
    const values = Object.fromEntries(properties.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
    const pane = (await tmux(['list-panes', '-a', '-F', '#{session_id}|#{session_name}|#{window_id}|#{pane_id}|#{pane_pid}|#{pane_start_command}'])).stdout.trim();
    const fields = pane.split('|');
    assert.equal(fields.length, 6);
    const cgroup = (await remote(['cat', `/proc/${fields[4]}/cgroup`])).stdout.trim();
    const starttime = (await remote(['python3', '-c', 'import pathlib,sys;print(pathlib.Path("/proc/"+sys.argv[1]+"/stat").read_text().rsplit(")",1)[1].split()[19])', fields[4]])).stdout.trim();
    const transcripts = join(home, '.codex/sessions');
    const files = (await readdir(transcripts, { recursive: true })).filter(path => path.endsWith('.jsonl'));
    const canonicalStore = JSON.parse(await readFile(join(state, 'sessions.json'), 'utf8'));
    const pointer = canonicalStore.sessions['codex:' + alias + ':shared:' + alias];
    assert.equal(pointer.initialized, true);
    const candidates = await Promise.all(files.map(async file => ({ file,
      entries: (await readFile(join(transcripts, file), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) })));
    const selected = candidates.filter(candidate => candidate.entries.some(entry => entry.type === 'session_meta' && entry.payload.id === pointer.native_id));
    assert.equal(selected.length, 1);
    const { entries, file } = selected[0];
    const sessions = entries.filter(entry => entry.type === 'session_meta').map(entry => entry.payload.id);
    assert.equal(sessions.length, 1);
    const lease = (await pool.query("SELECT epoch,instance_id,last_heartbeat_at FROM connection_leases WHERE tenant_id='Steven' AND alias=$1 AND lease_until>now()", [alias])).rows[0] ?? null;
    assert.ok(lease && Number(lease.epoch) > 0);
    const nativeIds = new Set();
    for (const name of ['sessions.json', 'shared-tui-session.json']) {
      const value = await readFile(join(state, name), 'utf8').then(JSON.parse, () => undefined);
      if (value?.native_id) nativeIds.add(value.native_id);
      for (const record of Object.values(value?.sessions ?? {})) if (record.initialized && record.native_id) nativeIds.add(record.native_id);
    }
    assert.ok(nativeIds.has(sessions[0]));
    const result = { stage, properties: values, pane: { sessionId: fields[0], sessionName: fields[1], windowId: fields[2], paneId: fields[3], pid: Number(fields[4]), starttime, command: fields[5], cgroup }, conversation: { sessionId: sessions[0], transcript: file, retainedTranscripts: files.length, nativeIds: [...nativeIds], nativeIdsSha256: createHash('sha256').update(JSON.stringify([...nativeIds].sort())).digest('hex'), userTurns: entries.filter(entry => entry.type === 'user' || entry.type === 'response_item' && entry.payload.role === 'user').length }, lease };
    await save(stage, result); return result;
  }
  async function delivery(marker) {
    const body = JSON.stringify({ room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias }], body: { text: `Responde únicamente ${marker}` }, idempotency_key: randomUUID() });
    const published = await new Promise((resolve, reject) => {
      const outgoing = request(`https://127.0.0.1:${port}/v3/messages`, { method: 'POST', ca: tls.cert, cert: tls.cert, key: tls.key,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, incoming => {
        let text = ''; incoming.setEncoding('utf8'); incoming.on('data', chunk => { text += chunk; });
        incoming.once('error', reject); incoming.once('end', () => { incoming.statusCode === 202 ? resolve(JSON.parse(text)) : reject(new Error(`Owned publish failed ${incoming.statusCode}`)); });
      }); outgoing.once('error', reject); outgoing.end(body);
    });
    assert.equal(published.delivery_ids.length, 1);
    const row = await waitFor(async () => {
      const value = (await pool.query("SELECT id,status,attempt,consumer_epoch,last_error,(SELECT payload->'result'->'output'->>'reply' FROM delivery_acks WHERE delivery_id=deliveries.id AND status='done' AND applied ORDER BY id DESC LIMIT 1) AS reply FROM deliveries WHERE id=$1 AND message_id=$2", [published.delivery_ids[0], published.message_id])).rows[0];
      return value && ['done', 'dead', 'failed'].includes(value.status) ? value : undefined;
    });
    assert.equal(row.status, 'done'); assert.equal(row.reply, marker); deliveries.push(row); return row;
  }
  await waitFor(async () => (await pool.query("SELECT epoch FROM connection_leases WHERE tenant_id='Steven' AND alias=$1 AND lease_until>now()", [alias])).rows[0]);
  const oldGeneration = (await tmux(['list-panes', '-a', '-F', '#{session_id}:#{window_id}:#{pane_id}:#{pane_pid}'])).stdout.trim();
  assert.match(oldGeneration, /^\$\d+:@\d+:%\d+:\d+$/u);
  await tmux(['kill-server']);
  await delay(400);
  const quarantine = join(state, '.shared-session-quarantine');
  const pending = quarantine + '.' + 'a'.repeat(64) + '.pending';
  const staleBytes = oldGeneration + '\n';
  await Promise.all([quarantine, pending].map(path => writeFile(path, staleBytes, { mode: 0o600 })));
  const agent = { alias, kind: 'native', harness, transport: 'local', manager: 'deploy', uid: 1000,
    tenant_id: 'Steven', room_id: 'grp.steven', unit, unit_file: unitPath, bundle_root: bundleRoot, ops_root: join(ROOT, 'ops'), privileged_proc_read: true };
  const inventory = join(directory, 'inventory.json');
  await writeFile(inventory, JSON.stringify({ version: 1, agents: [agent] }), { mode: 0o600 });
  const safetyReceipt = join(RECEIPTS, 'tool-safety-receipt.json');
  const t3bProof = process.env.T3D_PREREQUISITE_PROOF ?? join(ROOT, '.delegados/v4/recibos/t3b-adaptadores-v3-astra-1025/systemd/lab-proof.json');
  async function toolPython(label, source) {
    const began = Date.now();
    try {
      const value = await remote(['env', 'DOCKER_CONTEXT=lab', 'CI=1', 'TMUX_TMPDIR=' + socketRoot, 'python3', '-I', '-B', '-c',
        'import json,sys,types\nsys.path.insert(0,' + JSON.stringify(join(ROOT, '.delegados/v4')) + ')\nimport live_adapter_v3 as tool\nagent=json.loads(' + JSON.stringify(JSON.stringify(agent)) + ')\n' + source], 240_000);
      commands.push({ label, exit: 0, elapsed_ms: Date.now() - began });
      await writeFile(join(RECEIPTS, label + '.log'), value.stdout + value.stderr, { mode: 0o600 });
      return value.stdout;
    } catch (error) {
      commands.push({ label, exit: error.code ?? null, elapsed_ms: Date.now() - began });
      await writeFile(join(RECEIPTS, label + '.log'), (error.stdout ?? '') + (error.stderr ?? ''), { mode: 0o600 });
      throw error;
    }
  }
  const absenceTrace = `import runpy
witness=runpy.run_path(${JSON.stringify(join(ROOT, '.delegados/v4/live_adapter_v3_snapshot.py'))})
def observe(frame,event,packet):
 if event=="exception":
  error=packet[1];trace=packet[2];origin=[]
  while trace is not None:
   origin.append({"function":trace.tb_frame.f_code.co_name,"line":trace.tb_lineno});trace=trace.tb_next
  pid=frame.f_locals.get("pid");number=getattr(error,"errno",None)
  print(json.dumps({"inspection_pid":pid if type(pid) is int else None,"error_type":type(error).__name__,"errno":number if type(number) is int else None,"origin":origin}),file=sys.stderr)
 return observe
def select(frame,event,packet):
 return observe if event=="call" and frame.f_code.co_name=="process_absence" else None
sys.settrace(select)
try:
 print(json.dumps(witness["snapshot"](agent["unit"],agent["alias"],agent["uid"],privileged_proc_read=True)))
finally:
 sys.settrace(None)
`;
  await toolPython('absence-preflight', absenceTrace);
  const absent = JSON.parse(await toolPython('initial-snapshot', 'print(json.dumps(tool.snapshot(agent)))\n'));
  assert.equal(absent.tui, 'absent');
  const initialDeliveryCount = (await pool.query('SELECT count(*)::int AS count FROM deliveries WHERE recipient_alias=$1', [alias])).rows[0].count;
  assert.equal(initialDeliveryCount, 0);
  const options = { prueba_laboratorio: t3bProof, execute: true, parada_recibo: safetyReceipt };
  await toolPython('prepare', 'options=types.SimpleNamespace(**json.loads(' + JSON.stringify(JSON.stringify(options)) + '))\ntool.prepare(agent,options)\n');
  const preparedReceipt = JSON.parse(await readFile(safetyReceipt, 'utf8'));
  assert.equal(preparedReceipt.state, 'prepared');
  assert.equal(preparedReceipt.tui_before.tui, 'absent');
  assert.equal((await remote(['systemctl', '--user', 'show', unit, '-p', 'KillMode', '--value'])).stdout.trim(), 'process');
  assert.deepEqual(JSON.parse(await toolPython('prepared-snapshot', 'print(json.dumps(tool.snapshot(agent)))\n')), absent);
  const invalidProof = join(RECEIPTS, 'negative-proof.json');
  await writeFile(invalidProof, JSON.stringify({ result: 'PASS' }), { mode: 0o600 });
  await toolPython('negative-invalid-proof',
    'try:\n tool.laboratory_proof(' + JSON.stringify(invalidProof) + ')\nexcept tool.core.Failure:\n print(json.dumps({"result":"PASS","invalid_proof_rejected":True}))\nelse:\n raise AssertionError("invalid proof accepted")\n');
  async function realProbe(release, nonce) {
    const boundary = (await pool.query('SELECT clock_timestamp() AS boundary')).rows[0].boundary;
    const lease = await waitFor(async () => (await pool.query("SELECT epoch,instance_id,last_heartbeat_at FROM connection_leases WHERE tenant_id='Steven' AND alias=$1 AND lease_until>now() AND last_heartbeat_at>$2", [alias, boundary])).rows[0]);
    const entry = join(bundleRoot, 'releases', release, 'packages/adapter-sdk/dist/src/bin/codex.js');
    const pid = (await remote(['systemctl', '--user', 'show', unit, '-p', 'MainPID', '--value'])).stdout.trim();
    const cmdline = (await remote(['python3', '-c', 'import pathlib,sys,json;print(json.dumps(pathlib.Path("/proc",sys.argv[1],"cmdline").read_bytes().decode().split(chr(0))[:-1]))', pid])).stdout;
    assert.deepEqual(JSON.parse(cmdline), [join(bin, 'node'), entry]);
    const creationStage = await tmux(['list-panes', '-a', '-F', '#{pane_id}|#{pane_pid}']).then(value => value.stdout.trim() ? 'adapter-start-before-delivery' : 'delivery', () => 'delivery');
    const completed = await delivery('CAUCE_LIVE_' + nonce);
    const leaseAfter = (await pool.query("SELECT epoch,instance_id,last_heartbeat_at FROM connection_leases WHERE tenant_id='Steven' AND alias=$1 AND lease_until>now() AND epoch=$2 AND instance_id=$3 AND last_heartbeat_at>$4", [alias, lease.epoch, lease.instance_id, boundary])).rows[0];
    assert.ok(leaseAfter, 'Canonical lease must remain valid after the nonce reply');
    assert.equal((await remote(['systemctl', '--user', 'show', unit, '-p', 'MainPID', '--value'])).stdout.trim(), pid);
    const result = { alias, release, nonce, effective_release: release, process_alive: Number(pid) > 0,
      hello_ack: true, lease_valid: Number(lease.epoch) > 0, delivery_done: completed.status === 'done',
      delivery_id: completed.id, pid: Number(pid), creation_stage: creationStage, observed_at: new Date().toISOString(), heartbeat_boundary: boundary, lease, lease_after: leaseAfter };
    probes.push(result); return result;
  }
  probeServer.on('request', (incoming, outgoing) => {
    const url = new URL(incoming.url ?? '/', 'http://localhost');
    void realProbe(url.searchParams.get('release') ?? '', url.searchParams.get('nonce') ?? '').then(value => {
      outgoing.writeHead(200, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify(value));
    }, error => { void save('probe-failure', { error: failure(error) }); outgoing.writeHead(500); outgoing.end('{}'); });
  });
  await new Promise(resolve => probeServer.listen(0, '127.0.0.1', resolve));
  const probePort = probeServer.address().port;
  const probeRelay = probePort;
  const probePath = join(directory, 'probe.py');
  await writeFile(probePath, '#!/usr/bin/env python3\nimport sys,urllib.parse,urllib.request\nquery=urllib.parse.urlencode({"release":sys.argv[2],"nonce":sys.argv[3]})\nwith urllib.request.urlopen("http://127.0.0.1:' + probeRelay + '/?"+query,timeout=150) as response: print(response.read().decode())\n', { mode: 0o700 });
  const probeSha = createHash('sha256').update(await readFile(probePath)).digest('hex');
  async function update(number) {
    const args = [join(ROOT, '.delegados/v4/adaptador-vivo.sh'), '--laboratorio', '--inventario', inventory,
      '--agente', alias, '--ref', bundleRef, '--bundle-preconstruido', bundle, '--sonda', probePath,
      '--sonda-sha256', probeSha, '--recibo', join(RECEIPTS, 'update-' + number + '.json'),
      '--parada-recibo', safetyReceipt, '--prueba-laboratorio', t3bProof, '--timeout', '180', '--ejecutar'];
    await toolPython('update-' + number,
      'tool.astra=lambda candidate: candidate["alias"]==agent["alias"]\nsys.argv=json.loads(' + JSON.stringify(JSON.stringify(args)) + ')\nraise SystemExit(tool.main())\n');
    const receipt = JSON.parse(await readFile(join(RECEIPTS, 'update-' + number + '.json'), 'utf8'));
    assert.equal(receipt.agents[alias].state, 'verified');
    return receipt;
  }
  const firstUpdate = await update(1);
  const before = await snapshot('before');
  assert.equal(before.properties.KillMode, 'process');
  assert.ok(before.pane.cgroup.includes(unit));
  assert.notEqual(before.pane.pid, Number(oldGeneration.split(':').at(-1)));
  const secondUpdate = await update(2);
  const restarted = await snapshot('restarted');
  assert.deepEqual(restarted.pane, before.pane);
  assert.equal(restarted.conversation.sessionId, before.conversation.sessionId);
  assert.equal(restarted.conversation.transcript, before.conversation.transcript);
  assert.notEqual(restarted.properties.MainPID, before.properties.MainPID);
  assert.equal(restarted.conversation.userTurns, before.conversation.userTurns + 1);
  assert.equal(await readFile(quarantine, 'utf8'), staleBytes);
  assert.equal(await readFile(pending, 'utf8'), staleBytes);
  assert.equal(deliveries.length, 2);
  assert.deepEqual(await toolHashes(), frozenTools);
  assert.equal(createHash('sha256').update(await readFile(join(ROOT, 'tests/e2e/t3d-astra-sin-tui.lab.mjs'))).digest('hex'), frozenDriver);
  proof = { schema_version: 1, result: 'PASS', owner: OWNER, lab: expectedVm, daemon, unit_kind: 'user', harness,
    provider: 'controlled-tui-fixture', production_writes: false, real_adapter: true, ref: bundleRef, bundle,
    bundle_ref: bundleRef, bundle_sha256: bundleDigest, product_source: SOURCE, execution_host: expectedVm, kill_mode: 'process', same_pane: true,
    same_pane_pid_starttime: true, same_conversation: true, adapter_restarted: true, adopted: true,
    adopted_by_new_adapter: true, fresh_heartbeats_after_start: true, initial_tui: 'absent',
    no_tmux_server: true, no_harness_process: true, no_delivery_in_progress: true,
    stale_quarantine_preserved: true, tui_created: true, creation_stage: probes[0].creation_stage,
    initial_snapshot: absent, old_generation: oldGeneration, quarantine_sha256: createHash('sha256').update(staleBytes).digest('hex'),
    heartbeat_boundaries: probes.map(value => value.heartbeat_boundary),
    dropin_sha256: createHash('sha256').update('[Service]\nKillMode=process\n').digest('hex'),
    snapshots: { before, restarted }, deliveries, probes,
    updates: [firstUpdate.agents[alias].verification, secondUpdate.agents[alias].verification],
    tool_sha256: createHash('sha256').update(await readFile(join(ROOT, '.delegados/v4/live_adapter_v3.py'))).digest('hex'),
    tool_sources_sha256: frozenTools, driver_sha256: frozenDriver,
    gateway_port: port, probe_port: probePort, driver_pid: process.pid, shared_session: '1',
    commands, started_at: cleanup.started_at, completed_at: new Date().toISOString(), elapsed_ms: Date.now() - Date.parse(cleanup.started_at) };
  await save('lab-proof', proof);
} catch (error) {
  const adapterLog = await readFile(join(directory, 'adapter.log'), 'utf8').catch(() => 'unavailable');
  await writeFile(join(RECEIPTS, 'adapter.log'), adapterLog, { mode: 0o600 });
  await save('failure', { result: 'FAIL', error: failure(error), directory, unit });
  process.exitCode = 1;
} finally {
  for (const [label, operation] of [
    ['adapterStopped', async () => { if (unitPath) await remote(['systemctl', '--user', 'stop', unit]); }],
    ['tmuxRemoved', async () => { await remote(['env', `TMUX_TMPDIR=${socketRoot}`, '/usr/bin/tmux', '-L', 'cauce', 'kill-server']).catch(error => { if (!error.stderr?.includes('no server running') && !error.stderr?.includes('No such file')) throw error; }); }],
    ['unitRemoved', async () => { if (unitPath) { await remote(['rm', '-f', unitPath]); await remote(['python3', '-c', 'import shutil,sys;shutil.rmtree(sys.argv[1],ignore_errors=True)', `${unitPath}.d`]); await remote(['systemctl', '--user', 'daemon-reload']); await remote(['systemctl', '--user', 'reset-failed', unit]).catch(() => undefined); } }],
    ['probeServerClosed', async () => { await new Promise(resolve => probeServer.close(() => resolve())); }],
    ['gatewayClosed', async () => { await app?.close(); }],
    ['poolClosed', async () => { await pool?.end(); }],
    ['databaseRemoved', async () => { await database?.stop(); }],
    ['partialDatabaseRemoved', async () => { await labDocker(['rm', '-fv', alias + '-pg']).catch(error => { if (!error.stderr?.includes('No such container')) throw error; }); }],
    ['runtimeRemoved', async () => { await command('find', [directory, '-type', 'd', '-exec', 'chmod', 'u+w', '{}', '+']); await rm(directory, { recursive: true, force: true }); }],
    ['resourcesVerified', async () => {
      const containers = (await labDocker(['ps', '-a', '--filter', 'name=' + alias, '--format', '{{.Names}}'])).stdout.trim();
      const units = (await remote(['systemctl', '--user', 'list-units', '--all', '--no-legend', '--plain', unit])).stdout.trim();
      const resources = { result: containers || units ? 'FAIL' : 'PASS', containers, units, directory_removed: await readFile(join(directory, 'adapter.env')).then(() => false, () => true) };
      await save('resources-final', resources); assert.equal(resources.result, 'PASS'); assert.equal(resources.directory_removed, true);
    }],
  ]) {
    try { await operation(); cleanup[label] = true; } catch (error) { cleanup.failures.push({ phase: label, error: failure(error) }); }
  }
  await save('cleanup', { ...cleanup, result: cleanup.failures.length ? 'FAIL' : 'PASS' });
  if (cleanup.failures.length) process.exitCode = 1;
  if (proof && cleanup.failures.length === 0) { await save('lab-proof', { ...proof, cleanup_passed: true }); process.stdout.write('ASTRA_ABSENT_TUI_LAB_PASS\n'); }
}
