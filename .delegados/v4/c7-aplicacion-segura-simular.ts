import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from '../../packages/store/node_modules/zod/index.js';
import { nativeContextFileBindings } from '../../packages/adapter-sdk/src/context/native-context-files.js';
import { nombresDelArnes } from '../../packages/protocol/src/ficheros-del-arnes.js';

const Sha = z.string().regex(/^[a-f0-9]{64}$/u);
const Identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
const Absolute = z.string().refine(path => isAbsolute(path) && resolve(path) === path && path !== '/');
const File = z.object({ path: z.string().regex(/^(?:context|directives)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:md|txt|json|yaml|yml)$/u), sha256: Sha }).strict();
const Agent = z.object({
  company_id: z.string().min(1), tenant_id: Identifier, alias: Identifier, harness: Identifier, root: Absolute,
  environment: z.object({ HOME: Absolute.optional(), CODEX_HOME: Absolute.optional(), CLAUDE_CONFIG_DIR: Absolute.optional(),
    CAUCE_AGENT_WORKSPACE: Absolute.optional(), CAUCE_OPENCLAW_WORKSPACE: Absolute.optional(),
    CAUCE_MUSE_WORKSPACE: Absolute.optional(), CAUCE_GROK_WORKSPACE: Absolute.optional() }).strict().default({}),
  transport: z.object({ ssh: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/u).optional(),
    container: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u).optional() }).strict().default({}),
  snapshot: z.object({ version: z.number().int().positive(), files: z.array(File).max(100) }).strict(),
}).strict();
const UnlocatedAgent = z.object({ tenant_id: Identifier, alias: Identifier,
  reason: z.string().regex(/^[a-z_]{1,80}$/u) }).strict();
const Inventory = z.object({ captured_at: z.string().datetime(), agents: z.array(z.union([Agent, UnlocatedAgent])).min(1) }).strict();

// Remote code returns digests only and opens every path component without following symlinks.
const SCAN = String.raw`import hashlib,json,os,re,stat,sys
def read(path,limit):
 fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
 try:
  parts=path.split('/')[1:]
  for part in parts[:-1]:
   nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=nxt
  leaf=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
  try:
   before=os.fstat(leaf)
   if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_size>limit:raise ValueError()
   with os.fdopen(leaf,'rb',closefd=False) as stream:body=stream.read(limit+1)
   after=os.fstat(leaf)
   if len(body)>limit or (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):raise ValueError()
   return body
  finally:os.close(leaf)
 finally:os.close(fd)
payload=json.load(sys.stdin);result={'files':[],'canonical':[],'state':None}
try:
 if not stat.S_ISDIR(os.lstat(payload['root']).st_mode) or os.path.realpath(payload['root'])!=payload['root']:raise ValueError()
except Exception:result['root_error']='missing_or_unsafe'
for item in payload['files']:
 try:result['files'].append({'path':item['path'],'sha256':hashlib.sha256(read(item['nativePath'],262144)).hexdigest()})
 except FileNotFoundError:result['files'].append({'path':item['path'],'sha256':None})
 except Exception:result['files'].append({'path':item['path'],'error':'unsafe_or_changed'})
def scan(directory):
 try:
  info=os.lstat(directory)
  if not stat.S_ISDIR(info.st_mode):raise ValueError()
  for entry in os.scandir(directory):
   if entry.is_dir(follow_symlinks=False):scan(entry.path);continue
   relative=os.path.relpath(entry.path,payload['root'])
   if not re.fullmatch(r'(context|directives)/[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*\.(md|txt|json|yaml|yml)',relative):continue
   result['canonical'].append({'path':relative,'sha256':hashlib.sha256(read(entry.path,262144)).hexdigest()})
   if len(result['canonical'])>100:raise ValueError()
 except FileNotFoundError:pass
 except Exception:result['canonical_error']='unsafe_or_changed'
for directory in ('context','directives'):scan(payload['root']+'/'+directory)
try:
 state=json.loads(read(payload['statePath'],262144));result['state']={key:state.get(key) for key in ('company_id','tenant_id','alias','version','documents')}
except FileNotFoundError:pass
except Exception:result['state_error']='unsafe_or_invalid'
print(json.dumps(result))`;

const State = z.object({ company_id: z.string(), tenant_id: z.string(), alias: z.string(), version: z.number().int().nonnegative(),
  documents: z.array(File) });
const Measurement = z.object({ files: z.array(z.object({ path: z.string(), sha256: Sha.nullable().optional(), error: z.string().optional() })),
  canonical: z.array(File), canonical_error: z.string().optional(), root_error: z.string().optional(),
  state: State.nullable(), state_error: z.string().optional() });

function measure(agent: z.infer<typeof Agent>) {
  let bindings = nativeContextFileBindings(agent.root, agent.harness, agent.snapshot.files, agent.environment);
  const files = agent.snapshot.files.map(file => ({ path: file.path,
    nativePath: bindings.find(binding => binding.path === file.path)?.nativePath ?? join(agent.root, file.path) }));
  let argv = ['python3', '-I', '-B', '-c', SCAN];
  if (agent.transport.container) argv = ['docker', 'exec', '-i', agent.transport.container, ...argv];
  if (agent.transport.ssh) {
    const quoted = argv.map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
    argv = ['ssh', '-oBatchMode=yes', '-oConnectTimeout=8', '-oStrictHostKeyChecking=yes', '-oUpdateHostKeys=no',
      agent.transport.ssh, quoted];
  } else if (agent.transport.container) {
    throw new Error('local container reads require an explicit SSH target to prevent selecting the wrong daemon');
  }
  const command = argv.shift();
  if (!command) throw new Error('missing scanner');
  const scan = () => Measurement.parse(JSON.parse(execFileSync(command, argv, {
    input: JSON.stringify({ root: agent.root, files, statePath: join(agent.root, 'config/context-state.json') }),
    encoding: 'utf8', timeout: 30_000, maxBuffer: 2_097_152, stdio: ['pipe', 'pipe', 'pipe'],
  })));
  let measurement = scan();
  if (measurement.state) {
    const retired = measurement.state.documents.filter(file => !agent.snapshot.files.some(current => current.path === file.path));
    const retiredBindings = nativeContextFileBindings(agent.root, agent.harness, retired, agent.environment);
    files.push(...retired.map(file => ({ path: file.path,
      nativePath: retiredBindings.find(binding => binding.path === file.path)?.nativePath ?? join(agent.root, file.path) })));
    bindings = [...bindings, ...retiredBindings];
    if (retired.length > 0) measurement = scan();
  }
  const state = measurement.state;
  if (state && (state.company_id !== agent.company_id || state.tenant_id !== agent.tenant_id || state.alias !== agent.alias)) {
    throw new Error('receipt belongs to a different agent');
  }
  if (measurement.files.length !== files.length) throw new Error('incomplete scan');
  const canonical = new Map(measurement.canonical.map(file => [file.path, file.sha256]));
  const baseline = new Map(state?.documents.map(file => [file.path, file.sha256]));
  const desired = new Map(agent.snapshot.files.map(file => [file.path, file.sha256]));
  const disk = new Map(canonical); let localCollision = false;
  for (const binding of bindings) {
    const native = measurement.files.find(file => file.path === binding.path)?.sha256;
    const copy = canonical.get(binding.path); const expected = baseline.get(binding.path) ?? desired.get(binding.path);
    if (native == null) { if (baseline.has(binding.path)) disk.delete(binding.path); continue; }
    if (copy !== undefined && copy !== expected && native !== expected && copy !== native) localCollision = true;
    if (state === null || copy === undefined || copy === expected || native !== expected) disk.set(binding.path, native);
  }
  const candidate = state ? disk : new Map([...desired, ...disk]);
  const compared = [...new Set([...files.map(file => file.path), ...canonical.keys()])].map(path => {
    const observed = measurement.files.find(item => item.path === path);
    return { path, native_path: files.find(item => item.path === path)?.nativePath ?? join(agent.root, path),
      expected_sha256: desired.get(path) ?? null, observed_sha256: observed?.sha256 ?? canonical.get(path) ?? null,
      canonical_sha256: canonical.get(path) ?? null, baseline_sha256: baseline.get(path) ?? null,
      changed: candidate.get(path) !== desired.get(path), ...(observed?.error ? { error: observed.error } : {}) };
  });
  const equal = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>) =>
    a.size === b.size && [...a].every(([path, hash]) => b.get(path) === hash);
  const changed = [...new Set([...candidate.keys(), ...desired.keys()])].filter(path => candidate.get(path) !== desired.get(path));
  const localChanged = state ? !equal(disk, baseline) : changed.length > 0;
  const ahead = state !== null && state.version > agent.snapshot.version;
  const both = state !== null && state.version < agent.snapshot.version && !equal(baseline, desired) && localChanged && changed.length > 0;
  const blocked = measurement.root_error !== undefined || measurement.state_error !== undefined
    || measurement.canonical_error !== undefined || compared.some(file => file.error !== undefined);
  const unresolved = files.some(file => nombresDelArnes(agent.harness).some(name =>
    file.path === `directives/global-${name}` || file.path === `directives/workspace-${name}`
      || agent.harness === 'openclaw' && (file.path === `context/${name}` || file.path === `directives/${name}`))
    && !bindings.some(binding => binding.path === file.path));
  const creatingNative = state === null && bindings.some(binding => desired.has(binding.path)
    && measurement.files.find(file => file.path === binding.path)?.sha256 == null);
  const nativeChanged = bindings.some(binding => {
    const native = measurement.files.find(file => file.path === binding.path)?.sha256;
    return native != null && native !== (baseline.get(binding.path) ?? desired.get(binding.path));
  });
  const unknownBase = state === null && agent.snapshot.version > 1 && nativeChanged;
  const governed = changed.some(path => !path.startsWith('context/notes/')
    && !(desired.has(path) && bindings.some(binding => binding.path === path)));
  const decision = blocked ? 'bloqueado_lectura_insegura' : unresolved ? 'bloqueado_ruta_nativa_no_resuelta'
    : bindings.length === 0 ? 'bloqueado_sin_ficheros_nativos_versionados'
    : ahead ? 'bloqueado_snapshot_obsoleto'
    : localCollision ? 'bloqueado_copias_locales_divergentes'
    : unknownBase ? 'bloqueado_sin_base_comparable'
    : creatingNative && changed.length === 0 ? 'aplicar_cambio_del_servidor'
    : changed.length === 0 ? 'aplicar_sin_cambiar_contenido' : both ? 'conflicto_ambos_lados'
      : !localChanged ? 'aplicar_cambio_del_servidor' : governed ? 'bloqueado_cambio_gobernado' : 'ingerir_antes_de_aplicar';
  return { tenant_id: agent.tenant_id, alias: agent.alias, version: agent.snapshot.version,
    receipt_version: state?.version ?? null, mapped_native_files: bindings.length,
    missing_native_files: bindings.filter(binding => measurement.files.find(file => file.path === binding.path)?.sha256 == null).map(binding => binding.path),
    decision, ingest_files: decision === 'ingerir_antes_de_aplicar' ? changed : [],
    files: compared };
}

const { values } = parseArgs({ options: { simular: { type: 'boolean' }, inventario: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) {
  process.stdout.write('Uso: pnpm exec tsx .delegados/v4/c7-aplicacion-segura-simular.ts --simular --inventario <JSON-de-digests>\nSolo lee: no tiene modo de aplicación ni ingesta.\n');
} else {
  if (!values.simular || !values.inventario) throw new Error('se requieren --simular y --inventario; no existe modo de ejecución');
  const inventory = Inventory.parse(JSON.parse(readFileSync(values.inventario, 'utf8')));
  const identities = inventory.agents.map(agent => JSON.stringify([agent.tenant_id, agent.alias]));
  if (new Set(identities).size !== identities.length) throw new Error('duplicate agent');
  const agents = inventory.agents.map(agent => {
    if ('reason' in agent) return { tenant_id: agent.tenant_id, alias: agent.alias,
      decision: 'bloqueado_ubicacion_no_acreditada', reason: agent.reason };
    try { return measure(agent); } catch {
      return { tenant_id: agent.tenant_id, alias: agent.alias, version: agent.snapshot.version, decision: 'bloqueado_lectura_no_acreditada' };
    }
  });
  process.stdout.write(`${JSON.stringify({ mode: 'simular', measured_at: new Date().toISOString(), snapshot_captured_at: inventory.captured_at,
    writes: false, agents }, null, 2)}\n`);
  if (agents.some(agent => agent.decision.startsWith('bloqueado'))) process.exitCode = 2;
}
