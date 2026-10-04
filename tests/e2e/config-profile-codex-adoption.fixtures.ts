import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { CauceRepository, AgentProfileRepository } from '@cauce/store';
import { ficherosDelArnes, harnessDocumentPaths, type AgentProfile } from '@cauce/protocol';
import { buildGateway } from '../../services/gateway/src/app.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

const SAFE_MARKER_PREFIX = 'CAUCE_PROFILE_ADOPTION_';
const WRAPPER_INVOCATION_PREFIX = 'wrapper-invocation-';
const WRAPPER_RETRY_PREFIX = 'retry-blocked-';

export interface CodexProfileAdoptionFixture {
  readonly database: TestDatabase;
  readonly deliveryId: string;
  readonly marker: string;
  readonly revision: number;
  readonly expectedSha: string;
  readonly expectedPath: string;
  readonly tenant: 'Steven';
  readonly alias: string;
  readonly traceId: string;
  readonly profileFileShaBefore: string;
  readonly codexExecutable: string;
  readonly namespacePreflight: Readonly<Record<string, boolean>>;
  readonly startedAt: string;
  readonly getAdapterExit: () => number | null;
  readonly getAdapterOutputBytes: () => number;
  readonly getAdapterDiagnostics: () => readonly string[];
  stop(): Promise<{
    profileFileShaAfter: string;
    resources: readonly string[];
    diagnostics: readonly string[];
    wrapperInvocationCount: number;
    blockedRetryCount: number;
    realCliSpawnRequested: boolean;
    realCliProcessStarted: boolean;
    invocationBudgetUsed: boolean;
  }>;
}

export interface CodexProfileAdoptionFixtureOptions {
  readonly repositoryRoot?: string;
  readonly startDatabase?: () => Promise<TestDatabase>;
}

export async function startDatabaseWithOwnedScratch(
  startDatabase: () => Promise<TestDatabase>,
  onScratchCreated?: (path: string) => void,
): Promise<{ database: TestDatabase; scratch: string }> {
  const scratch = await mkdtemp(join(tmpdir(), 'cauce-profile-adoption-'));
  try {
    await mkdir(join(scratch, 'work'), { recursive: true, mode: 0o700 });
    onScratchCreated?.(scratch);
    return { database: await startDatabase(), scratch };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function executableOnPath(name: string, pathValue = process.env.PATH ?? ''): string {
  for (const segment of pathValue.split(delimiter)) {
    if (segment.length === 0) continue;
    const candidate = join(segment, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      // Continue through PATH without exposing candidate paths in diagnostics.
    }
  }
  throw new Error(`required executable is not available on PATH: ${name}`);
}

function bwrapArgs(
  root: string,
  scratch: string,
  codexExecutable: string,
  profile: string,
  profilePath: string,
  codexHome: string,
): string[] {
  const args = [
    '--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--share-net',
    '--uid', String(process.getuid?.() ?? 1000), '--gid', String(process.getgid?.() ?? 1000),
    '--proc', '/proc', '--dev', '/dev',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', '/etc', '/etc', '--symlink', '/usr/bin', '/bin',
    '--dir', '/home', '--dir', '/home/stev',
    '--ro-bind', '/home/stev/.local', '/home/stev/.local',
  ];
  const realParent = dirname(codexExecutable);
  const segments = realParent.split('/').filter(Boolean);
  let current = '';
  for (const segment of segments) {
    current += `/${segment}`;
    args.push('--dir', current);
  }
  args.push('--ro-bind', codexExecutable, codexExecutable);
  args.push('--dir', codexHome, '--overlay-src', codexHome);
  args.push('--tmp-overlay', codexHome);
  for (const filename of ['auth.json', 'config.toml']) {
    const path = join(codexHome, filename);
    args.push('--ro-bind-try', path, path);
  }
  args.push('--ro-bind', profile, profilePath);
  args.push('--dir', '/datos', '--dir', '/datos/workspaces', '--dir', '/datos/workspaces/personal');
  args.push('--ro-bind', root, '/datos/workspaces/personal/cauce-v3');
  args.push('--dir', '/workspace');
  args.push('--ro-bind', root, '/workspace');
  args.push('--tmpfs', '/tmp');
  args.push('--dir', '/tmp/cauce-profile-adoption');
  args.push('--bind', scratch, '/tmp/cauce-profile-adoption');
  args.push('--chdir', '/tmp/cauce-profile-adoption/work');
  return args;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => { resolveExit(false); }, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolveExit(true); });
  });
}

function failureCategory(value: string): string {
  if (/unauthori[sz]ed|login|credential|auth(?:entication|orization)?|401/iu.test(value)) return 'authentication';
  if (/network|connect|dns|proxy|timeout|timed out|econn|fetch/iu.test(value)) return 'network';
  if (/sandbox|read.only|permission|denied|readonly|filesystem|operation not permitted|\bEROFS\b/iu.test(value)) return 'sandbox';
  if (/model|rate.limit|quota|429/iu.test(value)) return 'model-service';
  return 'unspecified';
}

function namespaceFailureCode(stderr: string): string {
  if (/unknown option.*tmp-overlay/iu.test(stderr)) return 'BWRAP_TMP_OVERLAY_UNSUPPORTED';
  if (/tmp-overlay requires at least one --overlay-src/iu.test(stderr)) return 'BWRAP_TMP_OVERLAY_SOURCE_MISSING';
  if (/creating new namespace|user namespace.*(?:disabled|unavailable)|operation not permitted/iu.test(stderr)) {
    return 'BWRAP_NAMESPACE_UNAVAILABLE';
  }
  if (/bwrap:.*(?:invalid argument|mount.*failed)/iu.test(stderr)) return 'BWRAP_MOUNT_INVALID';
  if (/bwrap:.*no such file or directory/iu.test(stderr)) return 'BWRAP_PATH_MISSING';
  if (/bwrap:.*(?:read.only file system|\bEROFS\b)/iu.test(stderr)) return 'BWRAP_READONLY_MOUNT';
  if (/bwrap:.*permission denied/iu.test(stderr)) return 'BWRAP_PERMISSION_DENIED';
  if (/error:.*\bEROFS\b|read.only file system/iu.test(stderr)) return 'NAMESPACE_WRITE_BLOCKED';
  if (/error:.*\bEACCES\b|permission denied/iu.test(stderr)) return 'NAMESPACE_PERMISSION_DENIED';
  if (/error:.*\bENOENT\b|no such file or directory/iu.test(stderr)) return 'NAMESPACE_PATH_MISSING';
  if (/\bEPERM\b/iu.test(stderr)) return 'NAMESPACE_OPERATION_NOT_PERMITTED';
  if (/\bEACCES\b/iu.test(stderr)) return 'NAMESPACE_PERMISSION_DENIED';
  if (/\bEINVAL\b/iu.test(stderr)) return 'NAMESPACE_INVALID_OPERATION';
  if (/syntaxerror/iu.test(stderr)) return 'NAMESPACE_PROBE_SYNTAX_ERROR';
  if (/typeerror/iu.test(stderr)) return 'NAMESPACE_PROBE_RUNTIME_ERROR';
  if (/cannot find module/iu.test(stderr)) return 'NAMESPACE_PROBE_NODE_MISSING';
  if (/^bwrap:/mu.test(stderr)) return 'BWRAP_UNCLASSIFIED';
  if (/^(?:node:|Error:|TypeError:|RangeError:|SyntaxError:)/mu.test(stderr)) return 'NODE_PROBE_UNCLASSIFIED';
  if (stderr.trim().length === 0) return 'NAMESPACE_PROBE_NO_STDERR';
  return 'NAMESPACE_PROBE_FAILED';
}

function diagnosticSummary(stderr: string): readonly string[] {
  const allowedEvents = new Set([
    'delivery_start', 'delivery_state', 'delivery_end', 'claim_renewal_start', 'claim_renewal_end',
    'fixed_context', 'spawn', 'exit', 'terminate', 'orphaned_pipes', 'emission_result',
    'connection_error', 'connection_degraded', 'profile_seed', 'internal_error',
  ]);
  const allowedReasons = new Set([
    'sin-sello', 'version-distinta', 'contenido-distinto', 'no-hace-falta',
    'confirmed', 'ownership_lost', 'queue_renewal_not_applied', 'text_fallback', 'mcp_deposit',
    'PROFILE_SEED_FAILED',
  ]);
  const allowedCodes = new Set([
    'PROCESS_EXIT_PREFLIGHT', 'PROCESS_EXIT_AMBIGUOUS', 'SPAWN_FAILED', 'EXECUTION_TIMEOUT',
    'EXECUTION_CANCELLED_AMBIGUOUS', 'CLAIM_OWNERSHIP_LOST', 'PROFILE_SEED_FAILED',
  ]);
  return stderr.split(/\r?\n/u).flatMap((line) => {
    if (line.startsWith('bwrap: ')) return [`bwrap_error:${failureCategory(line)}`];
    if (line.startsWith('ADAPTER_FATAL: ')) {
      const code = /^ADAPTER_FATAL:\s*([A-Z0-9_]+)/u.exec(line)?.[1];
      return code !== undefined && allowedCodes.has(code) ? [`adapter_fatal:${code}`] : [];
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) return [];
      const event = 'event' in parsed && typeof parsed.event === 'string' ? parsed.event : undefined;
      if (event === undefined || !allowedEvents.has(event)) return [];
      const reason = 'reason' in parsed && typeof parsed.reason === 'string' ? parsed.reason : undefined;
      const code = 'error_code' in parsed && typeof parsed.error_code === 'string' ? parsed.error_code
        : 'code' in parsed && typeof parsed.code === 'string' ? parsed.code : undefined;
      const errorMessage = 'error_message' in parsed && typeof parsed.error_message === 'string'
        ? parsed.error_message
        : 'message' in parsed && typeof parsed.message === 'string' ? parsed.message : undefined;
      const category = errorMessage === undefined ? undefined : failureCategory(errorMessage);
      const safeReason = reason !== undefined && allowedReasons.has(reason) ? reason : undefined;
      const safeCode = code !== undefined && allowedCodes.has(code) ? code : undefined;
      return [[event, safeReason, safeCode, category].filter((part): part is string => part !== undefined).join(':')];
    } catch {
      return [];
    }
  }).slice(-8);
}

export function budgetedCodexWrapperSource(
  codexExecutable: string,
  stateDirectory = '/tmp/cauce-profile-adoption',
): string {
  return `#!/usr/bin/node\n`
    + `const { closeSync, openSync } = require('node:fs');\n`
    + `const { spawn } = require('node:child_process');\n`
    + `const { randomUUID } = require('node:crypto');\n`
    + `const directory = ${JSON.stringify(stateDirectory)};\n`
    + `function marker(name) { const fd = openSync(directory + '/' + name, 'wx', 0o600); closeSync(fd); }\n`
    + `marker('${WRAPPER_INVOCATION_PREFIX}' + process.pid + '-' + randomUUID());\n`
    + `try { marker('invocation-budget-used'); } catch (error) {\n`
    + `  if (error && error.code === 'EEXIST') {\n`
    + `    marker('${WRAPPER_RETRY_PREFIX}' + process.pid + '-' + randomUUID());\n`
    + `    process.stderr.write('CAUCE_PROFILE_ADOPTION_BUDGET_BLOCKED\\n'); process.exit(86);\n`
    + `  }\n`
    + `  process.stderr.write('CAUCE_PROFILE_ADOPTION_WRAPPER_ERROR\\n'); process.exit(87);\n`
    + `}\n`
    + `const args = process.argv.slice(2);\n`
    + `if (args[0] === 'exec') args.shift();\n`
    + `marker('real-cli-spawn-requested');\n`
    + `const child = spawn(${JSON.stringify(codexExecutable)}, ['exec', '--ephemeral', '--sandbox', 'read-only', '--model', 'gpt-6-luna', ...args], { stdio: 'inherit', env: process.env });\n`
    + `child.once('spawn', () => { try { marker('real-cli-process-started'); } catch {} });\n`
    + `child.once('error', (error) => {\n`
    + `  const code = error && ['EACCES', 'ENOENT', 'ENOEXEC', 'EMFILE', 'ENOMEM'].includes(error.code) ? error.code : 'OTHER';\n`
    + `  try { marker('real-cli-spawn-error-' + code); } catch {}\n`
    + `  process.stderr.write('CAUCE_PROFILE_ADOPTION_SPAWN_ERROR:' + code + '\\n'); process.exit(127);\n`
    + `});\n`
    + `child.once('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));\n`;
}

export function readCodexWrapperEvidence(directory: string): {
  wrapperInvocationCount: number;
  blockedRetryCount: number;
  realCliSpawnRequested: boolean;
  realCliProcessStarted: boolean;
  invocationBudgetUsed: boolean;
} {
  const entries = readdirSync(directory);
  return {
    wrapperInvocationCount: entries.filter((entry) => entry.startsWith(WRAPPER_INVOCATION_PREFIX)).length,
    blockedRetryCount: entries.filter((entry) => entry.startsWith(WRAPPER_RETRY_PREFIX)).length,
    realCliSpawnRequested: entries.includes('real-cli-spawn-requested'),
    realCliProcessStarted: entries.includes('real-cli-process-started'),
    invocationBudgetUsed: entries.includes('invocation-budget-used'),
  };
}

export async function probeCodexNamespace(
  root: string,
  scratch: string,
  codexExecutable: string,
  generatedProfilePath: string,
  profilePath: string,
  codexHome: string,
): Promise<Readonly<Record<string, boolean>>> {
  const readonlyPaths = [
    { name: 'profile', path: profilePath },
    ...(['auth.json', 'config.toml'] as const).flatMap((filename) => {
      const path = join(codexHome, filename);
      return existsSync(path) ? [{ name: filename === 'auth.json' ? 'auth' : 'config', path }] : [];
    }),
  ];
  const probeSource = `const fs = require('node:fs');\n`
    + `const path = require('node:path');\n`
    + `const expected = JSON.parse(process.env.CAUCE_READONLY_PATHS);\n`
    + `const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\\n').flatMap((line) => {\n`
    + `  const parts = line.split(' - '); if (parts.length !== 2) return [];\n`
    + `  const left = parts[0].split(' '); return [{ point: left[4].replaceAll('\\\\040', ' '), flags: left[5].split(',') }];\n`
    + `});\n`
    + `const flagsFor = (target) => mounts.filter((mount) => target === mount.point || target.startsWith(mount.point + '/'))\n`
    + `  .sort((a,b) => b.point.length - a.point.length)[0]?.flags ?? [];\n`
    + `const result = Object.fromEntries(expected.map(({name,target}) => [name, flagsFor(target).includes('ro')]));\n`
    + `const marker = path.join(process.env.CODEX_HOME, 'sessions', '.cauce-probe-' + process.pid);\n`
    + `fs.writeFileSync(marker, 'namespace-only', { flag: 'wx', mode: 0o600 }); fs.unlinkSync(marker);\n`
    + `console.log(JSON.stringify({ ...result, sessionScratchWritable: true }));\n`;
  await writeFile(join(scratch, 'namespace-probe.cjs'), probeSource, { mode: 0o600 });
  const probe = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveProbe) => {
    const child = spawn('/usr/bin/bwrap', [
      ...bwrapArgs(root, scratch, codexExecutable, generatedProfilePath, profilePath, codexHome),
      '--setenv', 'HOME', '/home/stev', '--setenv', 'CODEX_HOME', codexHome,
      '--setenv', 'CAUCE_READONLY_PATHS', JSON.stringify(readonlyPaths.map(({ name, path }) => ({ name, target: path }))),
      '--', '/usr/bin/node', '/tmp/cauce-profile-adoption/namespace-probe.cjs',
    ], { cwd: root, env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8').slice(0, 1_000); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8').slice(0, 1_000); });
    child.once('error', () => { resolveProbe({ code: null, stdout, stderr }); });
    child.once('close', (code) => { resolveProbe({ code, stdout, stderr }); });
  });
  if (probe.code !== 0) {
    throw new Error(`Codex namespace filesystem preflight failed (exit=${String(probe.code)}, reason=${namespaceFailureCode(probe.stderr)})`);
  }
  let result: Record<string, boolean>;
  try {
    const parsed: unknown = JSON.parse(probe.stdout.trim());
    if (typeof parsed !== 'object' || parsed === null) throw new Error('invalid probe result');
    result = parsed as Record<string, boolean>;
  } catch {
    throw new Error('Codex namespace filesystem preflight returned an invalid result');
  }
  if (readonlyPaths.some(({ name }) => result[name] !== true) || result.sessionScratchWritable !== true) {
    throw new Error('Codex namespace mount preflight did not preserve read-only documents and isolated writable state');
  }
  return result;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid !== undefined) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
  if (await waitForExit(child, 4_000)) return;
  if (child.pid !== undefined) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
  if (!await waitForExit(child, 3_000)) throw new Error('Codex adapter process group did not exit');
}

export function assertCodexAdapterBuildAvailable(root: string): void {
  const entry = join(root, 'packages/adapter-sdk/dist/src/bin/codex.js');
  try {
    if (!statSync(entry).isFile()) throw new Error('missing');
    accessSync(entry, constants.R_OK);
  } catch {
    throw new Error('Codex adapter build is missing; run `pnpm prepare:runtime && pnpm build:adapter` before the E2E');
  }

  const probe = `import { accessSync, constants, statSync } from 'node:fs';\n`
    + `import { createRequire } from 'node:module';\n`
    + `import { dirname, join } from 'node:path';\n`
    + `const root = '/workspace';\n`
    + `const entry = join(root, 'packages/adapter-sdk/dist/src/bin/codex.js');\n`
    + `const targets = [entry, join(dirname(entry), 'shared.js'), `
    + `join(root, 'packages/protocol/dist/index.js')];\n`
    + `for (const target of targets) { if (!statSync(target).isFile()) process.exit(2); accessSync(target, constants.R_OK); }\n`
    + `const require = createRequire(entry);\n`
    + `for (const specifier of ['ws', '@muse-code/sdk', '@modelcontextprotocol/sdk/server/index.js']) {\n`
    + `  accessSync(require.resolve(specifier), constants.R_OK);\n`
    + `}\n`;
  const result = spawnSync(executableOnPath('bwrap'), [
    '--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc',
    '--uid', String(process.getuid?.() ?? 1000), '--gid', String(process.getgid?.() ?? 1000),
    '--proc', '/proc', '--dev', '/dev', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64', '--ro-bind', '/etc', '/etc', '--symlink', '/usr/bin', '/bin',
    '--dir', '/workspace', '--ro-bind', root, '/workspace', '--chdir', '/workspace',
    '--', process.execPath, '--input-type=module', '-e', probe,
  ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('Codex adapter build or runtime dependencies are not readable in the isolated E2E namespace');
  }
}

export async function startCodexProfileAdoptionFixture(
  options: CodexProfileAdoptionFixtureOptions = {},
): Promise<CodexProfileAdoptionFixture> {
  const root = options.repositoryRoot ?? process.cwd();
  assertCodexAdapterBuildAvailable(root);
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1'
      || process.env.CAUCE_TEST_DATABASE_URL !== undefined
      || process.env.CAUCE_TEST_DOCKER_NETWORK !== undefined
      || process.env.CAUCE_TEST_DOCKER_NETWORK_OWNER !== undefined) {
    throw new Error('Codex adoption E2E requires an independently owned native Testcontainers network');
  }
  if (process.env.HOME !== '/home/stev' || process.getuid?.() !== 1000) {
    throw new Error('Codex adoption E2E must run as the normal /home/stev owner');
  }
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  if (codexHome !== join(homedir(), '.codex')) {
    throw new Error('Codex adoption E2E must use the current owner Codex home unchanged');
  }
  const profilePath = harnessDocumentPaths('codex', { home: process.env.HOME, codexHome })[0];
  if (profilePath !== join(codexHome, 'AGENTS.md')) throw new Error('Codex profile path is not canonical');

  const codexExecutable = executableOnPath('codex');
  const profileFileShaBefore = digest(await readFile(profilePath));
  const marker = `${SAFE_MARKER_PREFIX}${randomBytes(16).toString('hex')}`;
  const { scratch, database } = await startDatabaseWithOwnedScratch(options.startDatabase ?? startTestDatabase);
  let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let adapter: ChildProcess | undefined;
  let outputBytes = 0;
  let outputTail = '';
  let closed = false;
  try {
    await resetTestDatabase(database.pool);
    const tenant = 'Steven' as const;
    const alias = `qa_codex_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const room = 'grp.steven';
    const senderAlias = `qa_sender_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await database.pool.query(
      `INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,
                          home_directory,state_directory,max_concurrent_deliveries)
       VALUES($1,$2,'codex',$2,true,$2,'stev',$3,$4,1),
             ($1,$5,'codex',$5,true,$5,'stev',$3,$6,1)`,
      [tenant, alias, codexHome, join(scratch, 'agent-state'), senderAlias, join(scratch, 'sender-state')],
    );
    await database.pool.query(
      `INSERT INTO memberships(tenant_id,room_id,alias,role,enabled)
       VALUES($1,$2,$3,'agent',true),($1,$2,$4,'operator',true)`, [tenant, room, alias, senderAlias],
    );
    const profiles = new AgentProfileRepository(database.pool);
    const initial = await profiles.readWithPresence(tenant, alias);
    const profile: AgentProfile = {
      ...initial.perfil,
      purpose: 'Consumidor Codex de Cauce para verificar una revisión de perfil aislada.',
      responsibilities: [
        `Cuando el operador solicite verificar el perfil activo, responde exactamente ${marker} y nada más.`,
      ],
    };
    const saved = await profiles.replace(profile, initial.revision, { tenant_id: tenant, alias });
    const context = await profiles.readContext(tenant, alias);
    const rendered = ficherosDelArnes('codex', context).find((file) => file.nombre === 'AGENTS.md');
    if (!rendered?.escribir || !rendered.texto.includes(marker)) {
      throw new Error('canonical profile renderer did not produce the authored runtime instruction');
    }
    const generatedProfilePath = join(scratch, 'canonical', 'AGENTS.md');
    await mkdir(dirname(generatedProfilePath), { recursive: true, mode: 0o700 });
    await writeFile(generatedProfilePath, rendered.texto, { mode: 0o600 });
    const namespacePreflight = await probeCodexNamespace(
      root, scratch, codexExecutable, generatedProfilePath, profilePath, codexHome,
    );
    const expectedSha = digest(rendered.texto);
    const expectedPath = profilePath;
    const runtimeContract = {
      revision: saved.revision,
      generation: `codex-profile-e2e-${randomUUID()}`,
      documents: [{ name: 'AGENTS.md', path: expectedPath, sha: expectedSha }],
    };
    const repository = new CauceRepository(database.pool);
    await repository.recordProfileRuntimeExpectation(tenant, alias, runtimeContract);
    app = await buildGateway({
      pool: database.pool,
      authProvider: DevOnlyAuthProvider.forTests(),
      outboxPollMs: 10,
      leaseTtlMs: 30_000,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    const traceId = `codex-profile-adoption-${randomUUID()}`;
    const receipt = await repository.publish({
      version: '3.0', request_id: randomUUID(), trace_id: traceId,
      tenant_id: tenant, room_id: room, actor_alias: senderAlias,
      recipients: [{ tenant_id: tenant, alias }],
      body: { text: 'Inspect your active instructions and return the verification requested by them.' },
      idempotency_key: randomUUID(), lane: 'interactive', priority: 7,
    });
    const deliveryId = receipt.delivery_ids[0];
    if (deliveryId === undefined) throw new Error('profile task was not routed to the Codex alias');
    const wrapper = join(scratch, 'codex-qa-wrapper.cjs');
    await writeFile(wrapper, budgetedCodexWrapperSource(codexExecutable), { mode: 0o700 });
    const env: Record<string, string | undefined> = {
      PATH: '/usr/bin:/bin:/home/stev/.local/bin',
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      CAUCE_TENANT: tenant,
      CAUCE_ROOM: room,
      CAUCE_ALIAS: alias,
      CAUCE_INSTANCE_ID: `codex-e2e-${randomUUID()}`,
      CAUCE_STATE_DIR: '/tmp/cauce-profile-adoption/agent-state',
      CAUCE_RELAY_URL: `ws://127.0.0.1:${String(address.port)}/v3/ws`,
      CAUCE_ENVIRONMENT: 'test',
      CAUCE_HEARTBEAT_MS: '1000',
      CAUCE_NO_PROGRESS_TIMEOUT_MS: '240000',
      CAUCE_DEV_AUTH: '1',
      CAUCE_HARNESS_COMMAND: '/tmp/cauce-profile-adoption/codex-qa-wrapper.cjs',
      HOME: '/home/stev',
      CODEX_HOME: codexHome,
      NODE_ENV: 'test',
    };
    adapter = spawn('/usr/bin/bwrap', [
      ...bwrapArgs(root, scratch, codexExecutable, generatedProfilePath, profilePath, codexHome),
      ...Object.entries(env).flatMap(([key, value]) => value === undefined ? [] : ['--setenv', key, value]),
      '--', '/usr/bin/node', '/workspace/packages/adapter-sdk/dist/src/bin/codex.js',
    ], { cwd: root, env: {}, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    adapter.stderr?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      outputTail = `${outputTail}${chunk.toString('utf8')}`.slice(-8_000);
    });
    const runningAdapter = adapter;
    return {
      database, deliveryId, marker, revision: saved.revision, expectedSha, expectedPath,
      tenant, alias, traceId, profileFileShaBefore, codexExecutable, namespacePreflight,
      startedAt: new Date().toISOString(),
      getAdapterExit: () => runningAdapter.exitCode ?? null,
      getAdapterOutputBytes: () => outputBytes,
      getAdapterDiagnostics: () => diagnosticSummary(outputTail),
      async stop() {
        if (closed) throw new Error('Codex profile fixture cleanup ran more than once');
        closed = true;
        const cleanupErrors: string[] = [];
        try { await stopChild(runningAdapter); } catch { cleanupErrors.push('adapter_process'); }
        try { await app?.close(); } catch { cleanupErrors.push('gateway'); }
        try { await database.pool.end(); } catch { cleanupErrors.push('postgres_pool'); }
        try { await database.container.stop(); } catch { cleanupErrors.push('postgres_container'); }
        let profileFileShaAfter = '';
        try { profileFileShaAfter = digest(await readFile(profilePath)); }
        catch { cleanupErrors.push('host_profile_hash'); }
        const wrapperEvidence = readCodexWrapperEvidence(scratch);
        try { await rm(scratch, { recursive: true, force: true }); }
        catch { cleanupErrors.push('fixture_scratch'); }
        if (profileFileShaBefore !== profileFileShaAfter) {
          throw new Error('host Codex profile file changed during the read-only adoption fixture');
        }
        if (cleanupErrors.length > 0) throw new Error(`Codex profile fixture cleanup failed: ${cleanupErrors.join(',')}`);
        return {
          profileFileShaAfter,
          resources: [`testcontainer:${database.container.getId()}`],
          diagnostics: diagnosticSummary(outputTail),
          ...wrapperEvidence,
        };
      },
    };
  } catch (error) {
    if (adapter !== undefined) await stopChild(adapter).catch(() => undefined);
    await app?.close().catch(() => undefined);
    await database.pool.end().catch(() => undefined);
    await database.container.stop().catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}
