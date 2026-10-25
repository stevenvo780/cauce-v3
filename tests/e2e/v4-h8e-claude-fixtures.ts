import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { expect } from 'vitest';
import { isaTenant, newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import { prepareChatRuntimeIdentity } from './chat-runtime-identity.fixtures.js';
import { browserDocker } from './browser-owned-lifecycle.js';
import { H8E_EVIDENCE, h8eReceipt, startH8eClaudeRuntime } from './v4-h8e-claude-runtime.js';
import { asV4Page } from './v4-console-real-browser.helpers.js';

async function prepareH8eMembership(fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>>) {
  const page = asV4Page(await newTrustedPage(fixture, { width: 1440, height: 900 }));
  await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Correo', { exact: true }).fill(isaTenant.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(isaTenant.password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await expect.poll(async () => (await page.context().cookies(fixture.baseUrl)).some(cookie => cookie.name === '__Host-cauce_session'), { timeout: 30_000 }).toBe(true);
  try {
    await page.goto(`${fixture.baseUrl}/config`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Ajustes', exact: true }).waitFor({ timeout: 20_000 });
    const section = page.getByRole('combobox', { name: 'Sección', exact: true });
    if (await section.count() > 0 && await section.isVisible()) await section.selectOption('espacios');
    else await page.getByRole('tab', { name: 'Espacios y salas', exact: true }).click();
    await page.getByRole('button', { name: 'Un solo recurso' }).click();
    await page.getByLabel('Recurso a crear').selectOption('membership');
    await page.getByLabel('Espacio', { exact: true }).fill(isaTenant.tenant);
    await page.getByLabel('Sala', { exact: true }).fill(isaTenant.room);
    await page.getByLabel('Identificador', { exact: true }).fill(isaTenant.target);
    await page.getByText('Opciones de alta:', { exact: false }).click();
    await page.getByLabel('Rol de permisos', { exact: true }).fill('agent');
    await page.getByRole('button', { name: 'Previsualizar el alta' }).click();
    await page.getByRole('status').filter({ hasText: 'Vista previa aceptada' }).waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Crear', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'creado en la revisión' }).waitFor({ timeout: 20_000 });
    const rows = (await fixture.database.pool.query<{ enabled: boolean; role: string }>(
      'SELECT enabled,role FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias=$3', [isaTenant.tenant, isaTenant.room, isaTenant.target])).rows;
    expect(rows).toEqual([{ enabled: true, role: 'agent' }]);
    await h8eReceipt('membership.json', { configured_by_owner_ui: true, configured_before_runtime_identity: true, rows });
    return page;
  } catch (error) {
    await h8eReceipt('membership-failure.json', { preparation_completed: false });
    await page.screenshot({ path: join(H8E_EVIDENCE, 'membership-setup-failed.png'), fullPage: true }).catch(() => undefined);
    throw error;
  }
}

export async function startH8eCanary() {
  const consoleFixture = await startConsoleFunctionalFixture();
  let runtime: Awaited<ReturnType<typeof startH8eClaudeRuntime>> | undefined;
  const fixtureIds: Record<string, string> = { database: consoleFixture.database.container.getId() };
  let networkIds: string[] = [];
  let browserIdentityObserved = false;
  const close = async () => {
    const failures: unknown[] = [];
    try { await runtime?.close(); } catch (error) { failures.push(error); }
    try { await consoleFixture.close(); } catch (error) { failures.push(error); }
    const absent: Record<string, boolean> = {};
    for (const [kind, id] of Object.entries(fixtureIds)) {
      try { absent[kind] = !(await browserDocker(['ps', '-aq', '--no-trunc', '--filter', `id=${id}`])).stdout.trim(); }
      catch (error) { failures.push(error); }
    }
    for (const id of networkIds) {
      try { absent[`network:${id}`] = !(await browserDocker(['network', 'ls', '-q', '--no-trunc', '--filter', `id=${id}`])).stdout.trim(); }
      catch (error) { failures.push(error); }
    }
    await h8eReceipt('console-cleanup.json', { resources: fixtureIds, networks: networkIds, absent, browser_identity_observed: browserIdentityObserved,
      failures: failures.length, clean: browserIdentityObserved && !failures.length && Object.values(absent).every(Boolean) });
    if (failures.length || !Object.values(absent).every(Boolean)) throw new AggregateError(failures, 'the owned H8e console fixture remains');
  };
  try {
    const browserInfo = JSON.parse((await browserDocker(['inspect', '--format',
      '{"id":{{json .Id}},"networks":{{json .NetworkSettings.Networks}}}', consoleFixture.browserContainer])).stdout) as {
        id: string; networks: Record<string, { NetworkID: string }>;
      };
    if (!/^sha256:[a-f0-9]{64}$|^[a-f0-9]{64}$/u.test(browserInfo.id)) throw new Error('the owned browser ID is invalid');
    fixtureIds.browser = browserInfo.id;
    networkIds = [...new Set(Object.values(browserInfo.networks).map(row => row.NetworkID).filter(Boolean))];
    browserIdentityObserved = true;
    const preparedPage = await prepareH8eMembership(consoleFixture);
    const human = (await consoleFixture.database.pool.query<{ id: string }>(
      'SELECT id::text FROM console_users WHERE tenant_id=$1 AND email=$2', [isaTenant.tenant, isaTenant.email])).rows[0];
    if (!human || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(human.id)) throw new Error('the owned H8e human identity is absent');
    const runtimeKey = await prepareChatRuntimeIdentity(consoleFixture, isaTenant);
    const tls = consoleFixture.pki.adapterCerts[0];
    if (!tls) throw new Error('the owned H8e mTLS identity is absent');
    runtime = await startH8eClaudeRuntime({ tlsFiles: [tls.cert, tls.key, consoleFixture.pki.ca.cert], packageSdk: true });
    const active = runtime;
    await consoleFixture.database.pool.query(`UPDATE agents SET harness_id='claude',container_name=$3,runtime_user='node',
      home_directory='/home/node',state_directory='/home/node/.cauce' WHERE tenant_id=$1 AND alias=$2`,
    [isaTenant.tenant, isaTenant.target, active.name]);
    const pins = JSON.parse((await active.exec(['python3', '-I', '-B', '-c', `import hashlib,json,pathlib
command='/home/node/.local/bin/claude';paths=[pathlib.Path(command),pathlib.Path('/usr/local/bin/h8e-claude-native')]
files={str(path):hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
facts=[{'path':str(path),'uid':path.stat().st_uid,'mode':oct(path.stat().st_mode&0o777),'nlink':path.stat().st_nlink,'size':path.stat().st_size} for path in paths]
print(json.dumps({'command':command,'sha256':files[command],'files':files,'facts':facts}))`])).stdout) as { command: string; sha256: string; files: Record<string, string> };
    const environment = {
      HOME: '/home/node', PATH: '/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C.UTF-8',
      CAUCE_TENANT: isaTenant.tenant, CAUCE_ROOM: isaTenant.room, CAUCE_ALIAS: isaTenant.target, CAUCE_RUNTIME_KEY: runtimeKey,
      CAUCE_STATE_DIR: '/home/node/.cauce', CAUCE_SHARED_SESSION: '1', CAUCE_SHARED_SESSION_WORKSPACE: '/home/node/projects',
      CAUCE_RELAY_URL: `${consoleFixture.gatewayUrl.replace('https:', 'wss:')}/v3/ws`, CAUCE_ENVIRONMENT: 'test', CAUCE_HEARTBEAT_MS: '250',
      CAUCE_TLS_CERT_FILE: `/fixture-tls/${basename(tls.cert)}`, CAUCE_TLS_KEY_FILE: `/fixture-tls/${basename(tls.key)}`,
      CAUCE_TLS_CA_FILE: `/fixture-tls/${basename(consoleFixture.pki.ca.cert)}`,
      CAUCE_HARNESS_COMMAND: pins.command, CAUCE_HARNESS_COMMAND_SHA256: pins.sha256, CAUCE_HARNESS_COMMAND_FILES: JSON.stringify(pins.files),
      CAUCE_MODEL_ID: 'claude-sonnet-4-6',
      CAUCE_OWNER_HUMAN_ID: human.id,
    };
    const envArgs = Object.entries(environment).map(([key, value]) => `${key}=${value}`);
    const tlsFacts = await active.exec(['env', ...envArgs, 'python3', '-I', '-B', '-c', `import json,os,pathlib
print(json.dumps([{'kind':key,'uid':pathlib.Path(os.environ[key]).stat().st_uid,'mode':oct(pathlib.Path(os.environ[key]).stat().st_mode&0o777),'readable':os.access(os.environ[key],os.R_OK)} for key in ['CAUCE_TLS_CERT_FILE','CAUCE_TLS_KEY_FILE','CAUCE_TLS_CA_FILE']]))`]);
    await h8eReceipt('runtime-tls-files.json', JSON.parse(tlsFacts.stdout) as unknown);
    const reader = JSON.parse((await active.exec(['env', ...envArgs, 'node', '/cauce-sdk/fixed/src/bin/tls-reader.js'])).stdout) as { secure_context_created: boolean };
    await h8eReceipt('runtime-sdk-tls-reader.json', reader);
    if (!reader.secure_context_created) throw new Error('the canonical SDK TLS reader rejected fresh owned mode0600 material');
    const transport = await active.exec(['env', ...envArgs, 'node', '--input-type=module', '-e', `import{readFileSync}from'node:fs';import{request}from'node:https';
const address=process.env.CAUCE_RELAY_URL.replace('wss:','https:').replace('/v3/ws','/health');
const req=request(address,{cert:readFileSync(process.env.CAUCE_TLS_CERT_FILE),key:readFileSync(process.env.CAUCE_TLS_KEY_FILE),ca:readFileSync(process.env.CAUCE_TLS_CA_FILE)},res=>{res.resume();res.on('end',()=>console.log(JSON.stringify({tls_connected:true,http_status:res.statusCode})));});
req.setTimeout(5000,()=>req.destroy(new Error('fixture timeout')));req.on('error',error=>console.log(JSON.stringify({tls_connected:false,error_code:['ECONNREFUSED','ENOTFOUND','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID','DEPTH_ZERO_SELF_SIGNED_CERT'].includes(error.code)?error.code:'unclassified'})));req.end();`], 8_000);
    await h8eReceipt('runtime-transport.json', JSON.parse(transport.stdout) as unknown);
    const websocket = await active.exec(['env', ...envArgs, 'node', '--input-type=module', '-e', `import{readFileSync}from'node:fs';import WebSocket from'/cauce-sdk/fixed/vendor/ws/wrapper.mjs';
const tls={cert:readFileSync(process.env.CAUCE_TLS_CERT_FILE),key:readFileSync(process.env.CAUCE_TLS_KEY_FILE),ca:readFileSync(process.env.CAUCE_TLS_CA_FILE),rejectUnauthorized:true};
const rows=[];for(const host of ['localhost','127.0.0.1']){const url=new URL(process.env.CAUCE_RELAY_URL);url.hostname=host;
rows.push(await new Promise(resolve=>{let finished=false;const socket=new WebSocket(url,tls);const timer=setTimeout(()=>finish({open:false,timeout:true}),5000);
function finish(result){if(finished)return;finished=true;clearTimeout(timer);resolve({host,...result});if(socket.readyState===WebSocket.OPEN)socket.close();else socket.terminate();}
socket.once('open',()=>finish({open:true}));socket.on('error',error=>finish({open:false,error_code:['ECONNREFUSED','ENOTFOUND','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED'].includes(error.code)?error.code:'unclassified'}));
socket.once('unexpected-response',(_request,response)=>{response.resume();finish({open:false,http_status:response.statusCode});});}));}
console.log(JSON.stringify(rows));`], 15_000);
    await h8eReceipt('runtime-websocket.json', JSON.parse(websocket.stdout) as unknown);
    const observe = async (mode: 'before' | 'fixed') => JSON.parse((await active.exec(['env', ...envArgs,
      'node', `/cauce-sdk/${mode}/src/bin/observe.js`], 15_000)).stdout) as {
        ready: boolean; failure: string | null; created: boolean; pid: string | null; readiness: string;
      };
    const startAdapter = async (mode: 'before' | 'fixed') => {
      await active.exec(['env', ...envArgs, `CAUCE_INSTANCE_ID=h8e-${mode}-${randomUUID()}`, 'python3', '-I', '-B', '-c', `import json,os,pathlib,subprocess
root=pathlib.Path('/home/node/.cauce');log=(root/'${mode}-adapter.log').open('ab')
child=subprocess.Popen(['node','/cauce-sdk/${mode}/src/bin/claude.js'],stdin=subprocess.DEVNULL,stdout=log,stderr=log,cwd='/home/node/projects',env=os.environ,start_new_session=True)
raw=pathlib.Path('/proc',str(child.pid),'stat').read_text();start=raw[raw.rfind(')')+1:].split()[19]
(root/'adapter-process.json').write_text(json.dumps({'pid':child.pid,'starttime':start}))`]);
    };
    const stopAdapter = async () => {
      const result = JSON.parse((await active.exec(['python3', '-I', '-B', '-c', `import json,os,pathlib,signal,sys,time
receipt=json.loads(pathlib.Path('/home/node/.cauce/adapter-process.json').read_text());pid=receipt['pid']
def same():
 try:
  raw=pathlib.Path('/proc',str(pid),'stat').read_text();fields=raw[raw.rfind(')')+1:].split()
  return fields[0] not in {'Z','X'} and fields[19]==receipt['starttime']
 except FileNotFoundError:return False
if same():
 fd=os.pidfd_open(pid)
 try:
  if not same():raise SystemExit('owned adapter identity changed')
  for sig in [signal.SIGTERM,signal.SIGKILL]:
   if not same():break
   signal.pidfd_send_signal(fd,sig)
   for attempt in range(50):
    if not same():break
    time.sleep(.1)
 finally:os.close(fd)
stopped=not same();print(json.dumps({'pid':pid,'starttime':receipt['starttime'],'owned_adapter_stopped':stopped}))
if not stopped:sys.exit(1)`])).stdout) as { pid: number; starttime: string; owned_adapter_stopped: unknown };
      await h8eReceipt(`adapter-stop-${String(result.pid)}.json`, result);
      if (result.owned_adapter_stopped !== true) throw new Error('the owned H8e adapter did not stop');
    };
    const diagnostics = async (mode: 'before' | 'fixed') => JSON.parse((await active.exec(['python3', '-I', '-B', '-c', `import hashlib,json,pathlib,sys
allowed=set(json.loads(sys.argv[1]))
path=pathlib.Path('/home/node/.cauce/${mode}-adapter.log');text=path.read_text(errors='replace') if path.exists() else '';events=[];transport=[]
for line in text.splitlines():
 try:row=json.loads(line)
 except ValueError:continue
 if row.get('event') in {'shared_session_pending','shared_session_degraded'}:
  events.append({'event':row['event'],'reason':row.get('reason') if row.get('reason') in {'tui_starting','provider_login_required','session_identity_unverified','tui_absent','session_absent','startup_cancelled'} else 'unrecognized'})
 if row.get('event') in {'connection_error','connection_degraded','inbound_frame_invalid','outbound_frame_invalid','profile_seed'}:
  reason=row.get('reason');message=row.get('error_message') if isinstance(row.get('error_message'),str) else ''
  transport.append({'event':row['event'],'reason':reason if reason in allowed else 'unrecognized','reason_length':len(reason) if isinstance(reason,str) else None,'reason_sha256':hashlib.sha256(reason.encode()).hexdigest() if isinstance(reason,str) else None,
   'message_flags':[label for label,needle in [('not_constructor','not a constructor'),('dynamic_require','Dynamic require of'),('require_missing','require is not defined'),('undefined_property','Cannot read properties of undefined'),('null_property','Cannot read properties of null'),('invalid_argument','argument'),('websocket_connect','Could not connect'),('schema_validation','Invalid input')] if needle in message]})
process_path=pathlib.Path('/home/node/.cauce/adapter-process.json');receipt=json.loads(process_path.read_text()) if process_path.exists() else {};proc=pathlib.Path('/proc',str(receipt.get('pid',0)));alive=False
try:
 raw=(proc/'stat').read_text();fields=raw[raw.rfind(')')+1:].split();alive=fields[0] not in {'Z','X'} and fields[19]==receipt.get('starttime')
except FileNotFoundError:pass
lock=pathlib.Path('/home/node/.cauce/.consumer-${isaTenant.target}.lock');owned=False
if lock.exists():
 try:owned=json.loads(lock.read_text()).get('pid')==receipt.get('pid')
 except ValueError:pass
print(json.dumps({'log_present':path.exists(),'log_bytes':len(text.encode()),'adapter_alive':alive,'local_lease_owned':owned,'events':events[-20:],'transport':transport[-20:],'codes':[code for code in ['PROVIDER_LOGIN_REQUIRED','ADAPTER_FATAL','SHARED_TUI_UNAVAILABLE','LEASE_CONFLICT','ENOENT','EACCES','ECONNREFUSED','ERR_TLS_CERT_ALTNAME_INVALID','CREDENTIAL_PERMISSIONS'] if code in text]}))`, JSON.stringify(active.diagnosticAllowlist)])).stdout) as unknown;
    await h8eReceipt('console-fixture.json', { resources: fixtureIds, networks: networkIds, runtime_key: runtimeKey, alias: isaTenant.target,
      authentication: 'fresh owned normal mTLS runtime certificate and PasswordAuthProvider', production_authorization_exercised: false,
      owner_identity_source: 'console_users UUID for the authenticated fixture operator', owner_uuid_match: true,
      host_enrolled: false, login_action_guard: 'retained', command_pins: pins });
    return { ...consoleFixture, runtime: active, runtimeKey, tenant: isaTenant, observe, startAdapter, stopAdapter, diagnostics,
      page: () => Promise.resolve(preparedPage), close };
  } catch (error) { await close(); throw error; }
}
