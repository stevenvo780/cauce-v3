import { execFile } from 'node:child_process';
import { chmod, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { browserDocker } from './browser-owned-lifecycle.js';
import { apiGet, asV4Page, type V4Page } from './v4-console-real-browser.helpers.js';
import { capture, EVIDENCE, hash, receipt, registerCompany, RUN, sourcePython, startLegacyCopyFixture,
  TASK, type LegacyCopyFixture } from './v4-copias-v3-setup-real-browser.helpers.js';

const execute = promisify(execFile);
interface Backup { id: string; status: string; error: string | null; sha256: string | null; bytes: string; manifest_sha256: string | null; policy_sha256: string }
interface Manifest { identity: Record<string, string>; files: { path: string; bytes: number; sha256: string }[]; omissions: { path: string; reason: string }[] }
interface Download { path(): Promise<string | null>; failure(): Promise<string | null>; suggestedFilename(): string }
interface DownloadPage extends V4Page { waitForEvent(event: 'download', options: { timeout: number }): Promise<Download> }
let fixture: LegacyCopyFixture | undefined;
const active = () => { if (!fixture) throw new Error('legacy copy fixture is unavailable'); return fixture; };
const state = (key: string) => `/home/dev/state/${key}`;
const snapshotProgram = `import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);out={}
for path in sorted(root.rglob('*')):
 info=path.lstat()
 out[str(path.relative_to(root))]={'mode':info.st_mode,'uid':info.st_uid,'gid':info.st_gid,'size':info.st_size,
  'sha256':hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None}
print(json.dumps(out))
`;
let source: Record<string, { sha256: string; size: number }>;
let siblingBefore = '', foreignBefore = '', undeclaredBefore = '';

async function seedLegacy(container: string, key: string, sibling: boolean) {
  return JSON.parse(await sourcePython(container, `import hashlib,json,os,pathlib,sys
root=pathlib.Path(sys.argv[1]);root.mkdir(parents=True,mode=0o700);os.chmod(root,0o700)
space=root/'space';space.mkdir(mode=0o700)
files={'context/recovery.md':b'Owned laboratory recovery note.\\n','directives/rules.md':b'Preserve the sibling.\\n',
 'projects/work.bin':os.urandom(2*1024*1024+17),'data/rows.jsonl':b'{"row":1}\\n'}
if sys.argv[3]!='none':files['config/context-state.json']=sys.argv[3].encode()
for name,data in files.items():
 path=space/name;path.parent.mkdir(parents=True,exist_ok=True,mode=0o700);path.write_bytes(data);os.chmod(path,0o600)
private=space/'config/auth.json';private.parent.mkdir(mode=0o700,exist_ok=True)
private.write_text('SYNTHETIC_OMISSION_MARKER');os.chmod(private,0o600)
if sys.argv[2]=='yes':
 other=root.parent/'sibling'/'space/projects';other.mkdir(parents=True,mode=0o700)
 (other/'sentinel.txt').write_text('Sibling must stay byte-identical.');os.chmod(other/'sentinel.txt',0o600)
print(json.dumps({name:{'sha256':hashlib.sha256(data).hexdigest(),'size':len(data)} for name,data in files.items()}))
`, [state(key), sibling ? 'yes' : 'no', sibling ? JSON.stringify({ company_id: active().company, tenant_id: active().tenant, alias: active().alias }) : 'none'])) as Record<string, { sha256: string; size: number }>;
}

async function latest(alias = active().alias): Promise<Backup | undefined> {
  return (await active().computer.pool.query<Backup>(`SELECT id::text,status,error,sha256,bytes::text,manifest_sha256,policy_sha256
    FROM space_backups WHERE tenant_id=$1 AND alias=$2 ORDER BY created_at DESC,id DESC LIMIT 1`, [active().tenant, alias])).rows[0];
}

async function requestCopy(phase: string, alias = active().alias): Promise<Backup> {
  const f = active(); const page = f.page;
  await page.goto(`${f.baseUrl}/messages/${f.tenant}/${alias}?view=context`, { waitUntil: 'domcontentloaded' });
  const panel = page.getByRole('region', { name: 'Backup del espacio', exact: true });
  const previous = await latest(alias);
  await panel.getByRole('button', { name: /^Crear (?:backup del espacio|otro backup)$/u }).click();
  let row: Backup | undefined;
  await expect.poll(async () => { row = await latest(alias); return row && row.id !== previous?.id && ['ready', 'failed'].includes(row.status); },
    { timeout: 180_000, interval: 500 }).toBe(true);
  if (!row) throw new Error('browser request did not persist a backup');
  const audit = (await f.computer.pool.query(`SELECT action,metadata->'failure' AS failure FROM audit_events
    WHERE company_id=$1 AND action='space.backup.failed' AND metadata->>'id'=$2`, [f.company, row.id])).rows;
  await receipt(`${phase}-backup`, { row, audit });
  await panel.getByText(row.status === 'ready' ? 'Backup disponible' : 'El backup falló', { exact: true }).waitFor({ timeout: 30_000 });
  await capture(page, phase, panel);
  return row;
}

async function downloadAndCompare(phase: string, backup: Backup) {
  const f = active(), page = f.page;
  expect(backup).toMatchObject({ status: 'ready', error: null });
  await page.evaluate(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const waitDownload = (page as DownloadPage).waitForEvent('download', { timeout: 60_000 });
  const panel = page.getByRole('region', { name: 'Backup del espacio', exact: true });
  await panel.getByRole('button', { name: 'Descargar backup ZIP', exact: true }).click();
  const download = await waitDownload; expect(await download.failure()).toBeNull(); const browserPath = await download.path();
  expect(browserPath).toMatch(/^\/tmp\/playwright-artifacts-[A-Za-z0-9]+\/[a-f0-9-]{36}$/u);
  const browserId = (await browserDocker(['inspect', '--format', '{{.Id}}', f.browser.container])).stdout.trim();
  expect(browserId).toBe(f.browser.containerId);
  const archive = join(EVIDENCE, `${phase}-chromium-download.zip`);
  await browserDocker(['cp', `${browserId}:${browserPath ?? ''}`, archive]); await chmod(archive, 0o600);
  expect((await stat(archive)).size).toBe(Number(backup.bytes)); expect(hash(await readFile(archive))).toBe(backup.sha256);
  expect(hash(await readFile(join(f.storage, `${backup.id}.zip`)))).toBe(backup.sha256);
  const inspection = await execute('python3', ['-I', '-B', '-c', `import hashlib,json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
 raw=archive.read('space-manifest.json');manifest=json.loads(raw)
 print(json.dumps({'manifest':manifest,'manifest_sha256':hashlib.sha256(raw).hexdigest(),
  'archive_files':{row['path']:hashlib.sha256(archive.read(row['path'])).hexdigest() for row in manifest['files']},'entries':archive.namelist()}))
`, archive]);
  const result = JSON.parse(inspection.stdout) as { manifest: Manifest; manifest_sha256: string; archive_files: Record<string, string>; entries: string[] };
  expect(result.manifest.identity).toEqual({ company_id: f.company, tenant_id: f.tenant, alias: f.alias, runtime_key: f.runtimeKey });
  expect(result.manifest_sha256).toBe(backup.manifest_sha256);
  expect(result.manifest.files.map(row => row.path).sort()).toEqual(Object.keys(source).sort());
  for (const entry of result.manifest.files) expect(entry).toMatchObject({ sha256: source[entry.path]?.sha256, bytes: source[entry.path]?.size });
  expect(result.archive_files).toEqual(Object.fromEntries(Object.entries(source).map(([path, value]) => [path, value.sha256])));
  expect(result.manifest.omissions).toContainEqual({ path: 'config/auth.json', reason: 'sensitive_path' });
  expect(result.entries.some(entry => entry.includes('sibling') || entry.includes('sentinel') || entry.includes('auth.json'))).toBe(false);
  const actualSource = JSON.parse(await sourcePython(f.legacy, snapshotProgram, [join(state(f.runtimeKey), 'space')])) as Record<string, { sha256: string }>;
  for (const [path, expected] of Object.entries(source)) expect(actualSource[path]?.sha256).toBe(expected.sha256);
  await capture(page, `${phase}-download`, panel);
  await receipt(`${phase}-download`, { task: TASK, run: RUN, backup, archive, channel: 'real-chromium-download-event',
    browser_container_id: browserId, suggested_filename: download.suggestedFilename(), source_hashes: source, ...result });
}

async function observedPolicy(phase: string) {
  const f = active(); const filename = join(f.computer.installRoot, f.company, f.host, 'executor-policy.json');
  const raw = await f.computer.onComputer(['cat', filename]); expect(raw.code, raw.stderr).toBe(0);
  const policy = JSON.parse(raw.stdout) as Record<string, unknown>;
  expect(policy.shared_containers).toEqual({ [f.legacy]: { backup_only: true, runtime_user: 'dev', systemd_user: 'dev', home_directory: '/home/dev' } });
  const policySha = hash(raw.stdout);
  await expect.poll(async () => (await f.computer.pool.query<{ capabilities: Record<string, unknown> }>(`SELECT capabilities FROM fleet_host_identities
    WHERE company_id=$1 AND host_id=$2 AND capabilities_seen_at>now()-interval '120 seconds'`, [f.company, f.host])).rows[0]?.capabilities.policy_sha256,
  { timeout: 60_000, interval: 500 }).toBe(policySha);
  const capability = (await f.computer.pool.query<{ capabilities: Record<string, unknown> }>(
    'SELECT capabilities FROM fleet_host_identities WHERE company_id=$1 AND host_id=$2', [f.company, f.host])).rows[0]?.capabilities;
  await receipt(`${phase}-setup-policy`, { policy_file_sha256: policySha, policy, capability, writer: 'cauce hosts setup', hand_written_executor_policy: false });
  return { policy, capability, policySha };
}

describe('copias V3 por activación, setup real y Chromium', () => {
  beforeAll(async () => { fixture = await startLegacyCopyFixture(); }, 600_000);
  afterAll(async () => { await fixture?.close(); }, 240_000);
  it('A aprueba solo el contenedor declarado, copia desde la consola y descarga un ZIP idéntico al origen', async () => {
    const f = active();
    const resources = [];
    for (const name of [f.legacy, f.undeclared, f.foreignContainer]) {
      const observed = JSON.parse(await docker(['inspect', '--format', '{"id":{{json .Id}},"image":{{json .Image}},"mounts":{{json .Mounts}},"labels":{{json .Config.Labels}}}', name])) as { id: string; image: string; mounts: unknown[]; labels: Record<string, string> };
      expect(observed.mounts).toEqual([]); expect(observed.labels['cauce.e2e.owner']).toBe(TASK);
      resources.push({ name, ...observed });
    }
    await receipt('source-resources', { resources, preinstalled_helper_mounts: false, production: false });
    source = await seedLegacy(f.legacy, f.runtimeKey, true);
    await seedLegacy(f.undeclared, 'undeclared', false); await seedLegacy(f.foreignContainer, 'foreign', false);
    siblingBefore = await sourcePython(f.legacy, snapshotProgram, ['/home/dev/state/sibling']);
    undeclaredBefore = await sourcePython(f.undeclared, snapshotProgram, [state('undeclared')]);
    foreignBefore = await sourcePython(f.foreignContainer, snapshotProgram, [state('foreign')]);
    for (const [alias, container, key] of [[f.alias, f.legacy, f.runtimeKey], [`zz-denied-${RUN}`, f.undeclared, 'undeclared']]) {
      await f.computer.pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,company_id,host_id,runtime_key,runtime_mode,
        container_name,runtime_user,home_directory,state_directory,systemd_user)
        VALUES($1,$2,'codex',$2,false,$3,$4,$5,NULL,$6,'dev','/home/dev',$7,NULL)`, [f.tenant, alias, f.company, f.host, key, container, state(key ?? '')]);
      await f.computer.pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')`, [f.tenant, alias]);
    }
    const configured = await observedPolicy('A'); expect(configured.capability?.fleet_executor).toBe(true);
    const backup = await requestCopy('A-ready'); expect(backup.policy_sha256).toBe(configured.policySha);
    await downloadAndCompare('A', backup);
  }, 240_000);
  it('rechaza el no declarado y la descarga desde otra empresa sin alterar hermano ni otro tenant', async () => {
    const f = active(); const denied = await requestCopy('undeclared-rejected', `zz-denied-${RUN}`);
    expect(denied).toMatchObject({ status: 'failed', error: 'EXPORT_FAILED' });
    const audit = (await f.computer.pool.query<{ failure: { message: string } }>(`SELECT metadata->'failure' AS failure FROM audit_events
      WHERE company_id=$1 AND metadata->>'id'=$2 AND action='space.backup.failed'`, [f.company, denied.id])).rows[0];
    expect(audit?.failure.message).toBe('legacy backup container is not approved');
    const context = await f.browser.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
    const foreign = asV4Page(await context.newPage()); const foreignOwner = await registerCompany(foreign, f.baseUrl, 'foreign');
    const foreignTenant = (await f.computer.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [foreignOwner.email])).rows[0]?.tenant_id;
    expect(foreignTenant).toBeTruthy();
    await f.computer.pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,company_id,runtime_key,
      container_name,runtime_user,home_directory,state_directory) VALUES($1,$2,'codex',$2,false,$3,'foreign',$4,'dev','/home/dev',$5)`,
    [foreignTenant, `zz-foreign-${RUN}`, foreignOwner.company.slug, f.foreignContainer, state('foreign')]);
    const backup = await latest(); if (!backup) throw new Error('approved backup is absent');
    const path = `/v3/console/spaces/${f.tenant}/${f.alias}/backups/${backup.id}/download`;
    const response = await apiGet(foreign, path); expect(response.status).toBe(404); expect(response.body).toMatchObject({ error: 'not_found' });
    await foreign.goto(`${f.baseUrl}/messages/${f.tenant}/${f.alias}?view=context`, { waitUntil: 'domcontentloaded' });
    const absent = foreign.getByText('No encontramos esa conversación', { exact: true }); await absent.waitFor({ timeout: 30_000 });
    await capture(foreign, 'foreign-company-denied', absent);
    expect(await sourcePython(f.legacy, snapshotProgram, ['/home/dev/state/sibling'])).toBe(siblingBefore);
    expect(await sourcePython(f.undeclared, snapshotProgram, [state('undeclared')])).toBe(undeclaredBefore);
    expect(await sourcePython(f.foreignContainer, snapshotProgram, [state('foreign')])).toBe(foreignBefore);
    await receipt('isolation', { undeclared_backup: denied, failure: audit?.failure, foreign_download_status: response.status,
      sibling_unchanged: true, undeclared_unchanged: true, other_tenant_unchanged: true,
      sibling_sha256: hash(siblingBefore), other_tenant_sha256: hash(foreignBefore) });
    await context.close();
  }, 240_000);
  it('B prepara un ejecutor solo de copias, sin capacidades de flota, y descarga otra copia desde Chromium', async () => {
    const f = active(); const activation = await f.activate(true);
    const configured = await observedPolicy('B');
    expect(configured.policy.execution_scope).toBe('backups'); expect(configured.policy.native).toEqual([]);
    for (const field of ['containers', 'profiles', 'bundles', 'hooks']) expect(configured.policy[field]).toEqual({});
    for (const field of ['authority', 'transport', 'terminal', 'quota_environments']) expect(configured.policy[field]).toBeUndefined();
    expect(configured.capability).toMatchObject({ fleet_executor: false, space_backup: true });
    const restricted = await f.computer.onComputer(['python3', '-I', '-B', '-c', `import json,pathlib,re,sys
sys.path.insert(0,'/opt/cauce-cli')
from host_channel_client import HostChannel,HostFailure
channel=HostChannel(pathlib.Path.home()/'.local/state/cauce-v3/hosts'/sys.argv[1]/sys.argv[2]);path='/v3/fleet/hosts/'+sys.argv[2]+'/channel'
commands=[{'resource':resource,'action':'claim'} for resource in ('fleet_operation','quota_environment','agent_quota')]
commands.append({'resource':'host_maintenance','action':'reconcile','release_sha256':'a'*64})
capability=json.loads(sys.argv[3]);capability.pop('execution_scope',None);capability['fleet_executor']=True
commands.append(capability);out=[]
for command in commands:
 try:channel.request('POST',path,command);status=200
 except HostFailure as error:
  match=re.search(r'HTTP (\\d{3})',str(error));status=int(match.group(1)) if match else 0
 out.append({'resource':command['resource'],'status':status})
try:channel.request('POST',path.removesuffix('/channel')+'/authority',{'action':'ready'});status=200
except HostFailure as error:
 match=re.search(r'HTTP (\\d{3})',str(error));status=int(match.group(1)) if match else 0
out.append({'resource':'authority','status':status})
print(json.dumps(out))
`, f.company, f.host, JSON.stringify(configured.capability)]);
    expect(restricted.code, restricted.stderr).toBe(0);
    const managementDenials = JSON.parse(restricted.stdout) as { resource: string; status: number }[];
    expect(managementDenials).toHaveLength(6);
    for (const denial of managementDenials) expect(denial.status, denial.resource).toBe(403);
    const backup = await requestCopy('B-ready'); expect(backup.policy_sha256).toBe(configured.policySha);
    await downloadAndCompare('B', backup);
    expect(await sourcePython(f.legacy, snapshotProgram, ['/home/dev/state/sibling'])).toBe(siblingBefore);
    expect(await sourcePython(f.foreignContainer, snapshotProgram, [state('foreign')])).toBe(foreignBefore);
    await receipt('B-backups-only', { activation, policy_sha256: configured.policySha, capability: configured.capability,
      scope: 'backups', management_denials: managementDenials, browser_download_passed: true, sibling_unchanged: true, other_tenant_unchanged: true });
    const inventory = await docker(['ps', '-a', '--filter', `label=cauce.e2e.owner=${TASK}`, '--format', '{{.Names}}']);
    await receipt('owned-resources-before-cleanup', { names: inventory.split('\n'), evidence: EVIDENCE });
  }, 240_000);
});
