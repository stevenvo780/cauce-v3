#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TIMEOUT_MS = 90_000;
const CLOSE_BUDGET_MS = 2_000;
const READ_BUDGET_MS = 30_000;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AUTHENTICATED_SESSION_KEY = /^auth-v3:[A-Za-z0-9_-]{43}(?:\.agent-lane)?$/u;
const PHASES = new Set(['session/start', 'session/resume', 'session/read', 'model/list',
  'session/setModel', 'session/setApprovalMode']);
const ENVIRONMENT_KEYS = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];

class CanaryError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function fail(code) { throw new CanaryError(code); }

function object(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('CANARY_METADATA_INVALID');
  return value;
}

async function validate(options, environment) {
  if (!['teseo', 'perseo'].includes(options.alias)) fail('CANARY_ALIAS_INVALID');
  if (environment.CAUCE_ALIAS !== undefined && environment.CAUCE_ALIAS !== options.alias) fail('CANARY_ALIAS_MISMATCH');
  if (options.sessionKey !== undefined && (typeof options.sessionKey !== 'string'
    || !AUTHENTICATED_SESSION_KEY.test(options.sessionKey))) fail('CANARY_SESSION_KEY_INVALID');
  if (typeof environment.HOME !== 'string') fail('CANARY_HOME_MISSING');
  let nodeHome;
  try { nodeHome = await realpath(environment.HOME); } catch { fail('CANARY_HOME_UNAVAILABLE'); }
  for (const field of ['sdkRoot', 'stateDirectory', 'executable', 'configHome', 'dataHome', 'workspace']) {
    const path = options[field];
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail('CANARY_PATH_INVALID');
  }
  const museHome = dirname(options.configHome);
  if ((museHome !== nodeHome && !museHome.startsWith(`${nodeHome}${sep}`))
    || dirname(options.dataHome) !== museHome || options.configHome === options.dataHome) {
    fail('CANARY_MUSE_HOME_MISMATCH');
  }
  if (await realpath(museHome) !== museHome || await realpath(options.configHome) !== options.configHome
    || await realpath(options.dataHome) !== options.dataHome) fail('CANARY_MUSE_HOME_MISMATCH');
  if (options.stateDirectory !== join(museHome, 'cauce-v3', options.alias)) fail('CANARY_STATE_SCOPE_MISMATCH');
  let stateDirectory;
  try { stateDirectory = await realpath(options.stateDirectory); } catch { fail('CANARY_STATE_DIRECTORY_UNAVAILABLE'); }
  if (stateDirectory !== options.stateDirectory) fail('CANARY_STATE_SCOPE_MISMATCH');
  if (await realpath(options.workspace) !== options.workspace) fail('CANARY_WORKSPACE_INVALID');
  if (!['denyUnmatched', 'onRequest', 'allowAll'].includes(options.approvalMode)
    || (options.approvalMode === 'allowAll') !== (options.yolo === true)) fail('CANARY_APPROVAL_INVALID');
  return { ...options, museHome };
}

async function loadRuntime(sdkRoot) {
  const require = createRequire(pathToFileURL(join(sdkRoot, 'package.json')));
  const [runner, session, store, msp] = await Promise.all([
    import(pathToFileURL(join(sdkRoot, 'dist/src/sdk/muse-msp-runner.js')).href),
    import(pathToFileURL(join(sdkRoot, 'dist/src/sdk/muse-msp-session.js')).href),
    import(pathToFileURL(join(sdkRoot, 'dist/src/sdk/durable-store/session-file.js')).href),
    import(pathToFileURL(require.resolve('@muse-code/sdk')).href),
  ]);
  const digests = {};
  for (const name of ['muse-msp-runner', 'muse-msp-session', 'muse-msp-reconciliation']) {
    digests[name] = createHash('sha256').update(await readFile(join(sdkRoot, 'dist/src/sdk', `${name}.js`))).digest('hex');
  }
  return { Runner: runner.MuseMspRunner, Session: session.MuseMspSession,
    readSessions: store.readSessionsSecure, spawn: msp.spawnMspConnection,
    durability: msp.readSessionDurability, digests };
}

async function binding(runtime, config) {
  const document = object(await runtime.readSessions(join(config.stateDirectory, 'sessions.json')));
  if (document.version !== 1) fail('CANARY_BINDING_FORMAT_INVALID');
  const selectedValue = object(document.sessions)[`muse:${config.alias}:${config.sessionKey ?? 'alias-default'}`];
  if (selectedValue === undefined) fail('CANARY_OWN_INITIALIZED_BINDING_MISSING');
  const selected = object(selectedValue);
  if (selected.initialized !== true || typeof selected.native_id !== 'string'
    || !UUID_V7.test(selected.native_id)) fail('CANARY_OWN_INITIALIZED_BINDING_MISSING');
  return selected.native_id;
}

function bounded(promise, deadline, signal, budgetMs) {
  if (signal.aborted) return Promise.reject(new CanaryError('CANARY_DEADLINE'));
  const remaining = Math.min(budgetMs, deadline - Date.now());
  if (remaining <= 0) return Promise.reject(new CanaryError('CANARY_DEADLINE'));
  return new Promise((resolveResult, rejectResult) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
    const onAbort = () => { stop(); rejectResult(new CanaryError('CANARY_DEADLINE')); };
    const timer = setTimeout(onAbort, remaining);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolveResult, rejectResult).finally(stop).catch(() => undefined);
  });
}

function hostEnvironment(config, environment) {
  const selected = {};
  for (const key of ENVIRONMENT_KEYS) if (environment[key] !== undefined) selected[key] = environment[key];
  return { ...selected, HOME: config.museHome, XDG_CONFIG_HOME: config.configHome,
    XDG_DATA_HOME: config.dataHome, MUSE_NO_AUTO_UPDATE: '1' };
}

async function nativeTurnCount(runtime, config, nativeId, deadline, signal, environment) {
  const host = runtime.spawn({ command: config.executable,
    args: ['serve', ...(config.yolo === true ? ['--disable-sandbox'] : []), '--trust-workspace'],
    cwd: config.workspace, env: hostEnvironment(config, environment), shutdownTimeoutMs: CLOSE_BUDGET_MS });
  host.onServerRequest(async () => { fail('CANARY_UNEXPECTED_SERVER_REQUEST'); });
  try {
    const initialized = await bounded(host.initialize({
      clientInfo: { name: 'cauce_muse_preflight_canary', version: '1' },
      capabilities: { userInputDialogs: false },
    }), deadline, signal, 5_000);
    if (runtime.durability(initialized.initializeResult).kind !== 'durable') fail('CANARY_DURABILITY_INVALID');
    const read = await bounded(initialized.connection.request('session/read', {
      sessionId: nativeId, excludeItems: true,
    }), deadline, signal, READ_BUDGET_MS);
    const session = object(read.session);
    if (session.sessionId !== nativeId) fail('CANARY_NATIVE_IDENTITY_MISMATCH');
    if (session.workspaceRoot !== config.workspace) fail('CANARY_NATIVE_WORKSPACE_MISMATCH');
    if (!Number.isSafeInteger(session.turnCount) || session.turnCount < 0) fail('CANARY_TURN_COUNT_INVALID');
    return session.turnCount;
  } finally { await host.close().catch(() => undefined); }
}

function safeTelemetry(event) {
  if (event.event === 'muse_host_initialized') {
    const safe = { event: event.event };
    if (typeof event.server_version === 'string' && /^[A-Za-z0-9._-]{1,128}$/u.test(event.server_version)) {
      safe.server_version = event.server_version;
    }
    if (typeof event.schema_fingerprint === 'string' && /^sha256:[a-f0-9]{64}$/u.test(event.schema_fingerprint)) {
      safe.schema_fingerprint = event.schema_fingerprint;
    }
    if (typeof event.fingerprint_warning === 'boolean') safe.fingerprint_warning = event.fingerprint_warning;
    return safe;
  }
  if (!['muse_preflight_started', 'muse_preflight_finished'].includes(event.event) || !PHASES.has(event.phase)) return undefined;
  const safe = { event: event.event, phase: event.phase };
  for (const key of ['budget_ms', 'elapsed_ms']) {
    if (Number.isSafeInteger(event[key]) && event[key] >= 0) safe[key] = event[key];
  }
  if (['completed', 'failed'].includes(event.outcome)) safe.outcome = event.outcome;
  if (['MUSE_PREFLIGHT_TIMEOUT', 'MUSE_PREFLIGHT_CANCELLED', 'MUSE_PREFLIGHT_FAILED',
    'MUSE_PROTOCOL_FAILED', 'MUSE_HOST_EXITED', 'MUSE_VIEW_UNAVAILABLE'].includes(event.error_code)) {
    safe.error_code = event.error_code;
  }
  return safe;
}

export async function runPreflightCanary(options, injectedRuntime, environment = process.env) {
  const started = Date.now();
  const deadline = started + TIMEOUT_MS - CLOSE_BUDGET_MS;
  const report = { kind: 'hospital-muse-preflight-canary',
    ...(['teseo', 'perseo'].includes(options.alias) ? { alias: options.alias } : {}),
    status: 'failed', read_budget_ms: READ_BUDGET_MS, timeout_ms: TIMEOUT_MS, events: [] };
  const deadlineController = new AbortController();
  const runController = new AbortController();
  const timer = setTimeout(() => { deadlineController.abort(); }, TIMEOUT_MS - CLOSE_BUDGET_MS);
  const abortRun = () => { runController.abort(); };
  deadlineController.signal.addEventListener('abort', abortRun, { once: true });
  let restoreSubmit;
  let pendingRun;
  let runSettled = false;
  let turnAttempts = 0;
  let harnessStarts = 0;
  let admittedTurns = 0;
  try {
    report.stage = 'configuration';
    const wait = (promise) => bounded(promise, deadline, deadlineController.signal, TIMEOUT_MS);
    const config = await wait(validate(options, environment));
    const runtime = injectedRuntime ?? await wait(loadRuntime(config.sdkRoot));
    if (injectedRuntime === undefined) report.candidate_modules_sha256 = runtime.digests;
    report.stage = 'binding';
    const nativeId = await wait(binding(runtime, config));
    report.stage = 'baseline-metadata';
    const before = await nativeTurnCount(runtime, config, nativeId, deadline, deadlineController.signal, environment);
    if (before === 0) fail('CANARY_EXISTING_SESSION_EMPTY');
    report.existing_nonempty_session = true;
    const originalSubmit = runtime.Session.prototype.submit;
    if (typeof originalSubmit !== 'function') fail('CANARY_SUBMISSION_GUARD_UNAVAILABLE');
    runtime.Session.prototype.submit = async function () {
      turnAttempts += 1;
      fail('CANARY_TURN_SUBMISSION_ATTEMPTED');
    };
    restoreSubmit = () => { runtime.Session.prototype.submit = originalSubmit; };
    report.stage = 'runner-preflight';
    const runner = new runtime.Runner({ executable: config.executable, configHome: config.configHome,
      dataHome: config.dataHome, workspace: config.workspace, approvalMode: config.approvalMode,
      ...(config.yolo === true ? { yolo: true } : {}),
      ...(config.model === undefined ? {} : { model: config.model }),
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
      onTelemetry: (event) => {
        const safe = safeTelemetry(event);
        if (safe !== undefined) report.events.push(safe);
        if (event.event === 'muse_preflight_started' && event.phase === 'session/read') {
          report.read_budget_ms = safe?.budget_ms;
        }
        if (event.event === 'muse_turn_admitted') admittedTurns += 1;
        if (event.event === 'muse_preflight_finished' && event.phase === 'session/read' && event.outcome === 'completed') {
          report.read_completed = true;
          report.read_elapsed_ms = safe?.elapsed_ms;
          runController.abort();
        }
      } });
    pendingRun = runner.run({ harness: 'muse', command: config.executable, args: ['serve'], stdin: '',
      sessionId: nativeId, resumeSession: true, timeoutMs: Math.max(1, deadline - Date.now()),
      signal: runController.signal, onHarnessStart: () => { harnessStarts += 1; } });
    void pendingRun.finally(() => { runSettled = true; }).catch(() => undefined);
    const run = await wait(pendingRun);
    if (report.read_completed !== true || report.read_budget_ms !== READ_BUDGET_MS
      || run.cancelled !== true || run.timedOut === true || run.stdout !== ''
      || run.harnessStarted === true || harnessStarts !== 0 || admittedTurns !== 0 || turnAttempts !== 0) {
      fail('CANARY_PREFLIGHT_CANCELLATION_UNVERIFIED');
    }
    report.cancelled = true;
    report.harness_started = false;
    report.stage = 'after-metadata';
    const after = await nativeTurnCount(runtime, config, nativeId, deadline, deadlineController.signal, environment);
    report.new_turns = after - before;
    report.same_sid_binding = await wait(binding(runtime, config)) === nativeId;
    if (report.new_turns !== 0 || report.same_sid_binding !== true) fail('CANARY_SESSION_CHANGED');
    if (!Number.isSafeInteger(report.read_elapsed_ms) || report.read_elapsed_ms < 0
      || report.read_elapsed_ms > READ_BUDGET_MS) fail('CANARY_READ_LATENCY_INVALID');
    report.exceeded_previous_read_budget = report.read_elapsed_ms > 5_000;
    report.stage = 'verified';
    report.status = 'passed';
  } catch (error) {
    report.error_code = turnAttempts > 0 ? 'CANARY_TURN_SUBMISSION_ATTEMPTED'
      : error instanceof CanaryError ? error.code : 'CANARY_RUNTIME_FAILED';
  } finally {
    runController.abort();
    deadlineController.abort();
    if (pendingRun !== undefined && !runSettled) {
      void pendingRun.finally(() => { restoreSubmit?.(); }).catch(() => undefined);
    } else restoreSubmit?.();
    clearTimeout(timer);
    deadlineController.signal.removeEventListener('abort', abortRun);
    report.harness_start_witnesses = harnessStarts;
    report.turn_submission_attempts = turnAttempts;
    report.admitted_turns = admittedTurns;
    report.elapsed_ms = Date.now() - started;
  }
  return report;
}

const USAGE = 'Usage: node muse-preflight-canary.mjs --sdk-root /own/candidate/packages/adapter-sdk'
  + ' --alias teseo|perseo --state-directory /own/NodeHOME/.muse/cauce-v3/alias'
  + ' --executable /own/muse-launcher --config-home /own/NodeHOME/.muse/config --data-home /own/NodeHOME/.muse/data'
  + ' --workspace /own/workspace [--session-key auth-v3:BASE64URL43[.agent-lane]]'
  + ' [--approval-mode denyUnmatched|onRequest|allowAll] [--yolo 1]';

function cliOptions(argv, environment) {
  const names = { 'sdk-root': 'sdkRoot', alias: 'alias', 'state-directory': 'stateDirectory',
    executable: 'executable', 'config-home': 'configHome', 'data-home': 'dataHome', workspace: 'workspace',
    'approval-mode': 'approvalMode', yolo: 'yolo', model: 'model', 'reasoning-effort': 'reasoningEffort',
    'session-key': 'sessionKey' };
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--')) fail('CANARY_ARGUMENT_INVALID');
    const key = names[argv[index]?.replace(/^--/u, '')];
    if (key === undefined || argv[index + 1] === undefined || flags[key] !== undefined) fail('CANARY_ARGUMENT_INVALID');
    flags[key] = argv[index + 1];
  }
  const inherited = { alias: environment.CAUCE_ALIAS, stateDirectory: environment.CAUCE_STATE_DIR,
    executable: environment.CAUCE_MUSE_EXECUTABLE, configHome: environment.CAUCE_MUSE_CONFIG_HOME,
    dataHome: environment.CAUCE_MUSE_DATA_HOME, workspace: environment.CAUCE_MUSE_WORKSPACE,
    approvalMode: environment.CAUCE_MUSE_APPROVAL_MODE ?? 'denyUnmatched', yolo: environment.CAUCE_MUSE_YOLO,
    model: environment.CAUCE_MUSE_MODEL, reasoningEffort: environment.CAUCE_MUSE_REASONING_EFFORT };
  const options = { ...inherited, ...flags };
  if (options.yolo !== undefined && options.yolo !== '1') fail('CANARY_ARGUMENT_INVALID');
  options.yolo = options.yolo === '1';
  return options;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write(`${USAGE}\n`);
  else {
    try {
      const report = await runPreflightCanary(cliOptions(process.argv.slice(2), process.env));
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.exitCode = report.status === 'passed' ? 0 : 1;
    } catch {
      process.stdout.write(`${JSON.stringify({ kind: 'hospital-muse-preflight-canary', status: 'failed',
        error_code: 'CANARY_ARGUMENT_INVALID' })}\n`);
      process.exitCode = 1;
    }
  }
}
