import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { OpenClawApiRunner } from '../src/sdk/openclaw-api-runner.js';
import { AdapterEngine } from '../src/sdk/engine.js';
import { DurableStore } from '../src/sdk/durable-store.js';
import { HarnessAdapter } from '../src/harnesses/shared/adapter.js';
import { openClawDefinition } from '../src/harnesses/openclaw.js';
import { OPENCLAW_BRIDGE_PATH } from '../src/harnesses/bridge-paths.js';
import type { AdapterLog, DeliveryEvent, CommandRunRequest, CommandRunResult } from '../src/sdk/types.js';
import { delivery } from './engine-fixtures.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { SpawnCommandRunner } from '../src/sdk/process-runner.js';
import { ProcessExecutionError } from '../src/sdk/errors.js';
import { OpenClawPhaseFrames, type OpenClawPhaseObservation } from '../src/sdk/openclaw-phases.js';
import { FRAME, phaseRequest, NATIVE_OUTPUT, nativeModules } from './openclaw-phase-observability.fixtures.js';

test('diagnostic metadata never renews the no-progress timeout', async () => {
  const result = await new SpawnCommandRunner({ killGraceMs: 20, orphanPipeGraceMs: 20 }).run(phaseRequest('markers'));
  assert.equal(result.timedOut, true);
  assert.equal(result.stderr, '');
});
test('semantic stdout still renews the no-progress timeout', async () => {
  const result = await new SpawnCommandRunner().run(phaseRequest('semantic'));
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
});

for (const mode of ['fragment', 'invalid', 'oversize', 'eof'] as const) {
  test(`reserved ${mode} diagnostics are bounded and never reflected`, async () => {
    const observations: OpenClawPhaseObservation[] = [];
    const result = await new SpawnCommandRunner({ killGraceMs: 20, orphanPipeGraceMs: 20 }).run(phaseRequest(mode, { onOpenClawPhase: (phase) => { observations.push(phase); } }));
    assert.equal(result.stderr, '');
    assert.equal(result.timedOut, mode === 'fragment');
    assert.equal(observations.some((value) => value.phase === 'agent_cli_started'), mode === 'fragment');
    assert.doesNotMatch(JSON.stringify(observations), /dummy-secret/u);
  });
}
test('mixed stderr preserves ordinary bytes and strips only reserved frames', async () => {
  const result = await new SpawnCommandRunner().run(phaseRequest('mixed'));
  assert.equal(result.stderr, 'ordinary\ntail\n');
});
test('reserved prefixes at every forced EOF boundary remain diagnostics', () => {
  for (let boundary = 1; boundary < FRAME.length; boundary++) {
    const observations: OpenClawPhaseObservation[] = [];
    const frames = new OpenClawPhaseFrames((value) => { observations.push(value); });
    for (const byte of Buffer.from(FRAME.slice(0, boundary))) assert.equal(frames.push(Buffer.from([byte])).length, 0);
    assert.equal(frames.finish(true).length, 0);
    assert.equal(frames.diagnosticBytes, boundary);
    assert.equal(frames.push(Buffer.from(FRAME.slice(0, boundary))).length, 0);
    assert.equal(frames.finish().toString(), FRAME.slice(0, boundary));
    assert.equal(frames.diagnosticBytes, boundary);
    assert.equal(frames.finish().length, 0);
    assert.equal(frames.diagnosticBytes, boundary);
    assert.deepEqual(observations, []);
    assert.equal(frames.push(Buffer.from('ordinary\n')).toString(), 'ordinary\n');
    assert.equal(frames.push(Buffer.from('@cauce/openclaw-phasX')).toString(), '@cauce/openclaw-phasX');
    assert.equal(frames.finish().length, 0);
    assert.equal(frames.diagnosticBytes, boundary);
  }
});
test('EOF prefixes retain the independent diagnostic output bound', async () => {
  const frame = FRAME + JSON.stringify({ phase: 'agent_cli_started', elapsedMs: 1, utc: '2026-10-04T00:00:00.000Z' }) + '\n';
  const output = frame + FRAME.slice(0, 10);
  const request = phaseRequest('mixed', { args: ['--eval', `process.stderr.write(${JSON.stringify(output)});setTimeout(()=>{},650);`] });
  await assert.rejects(new SpawnCommandRunner({ maxOutputBytes: Buffer.byteLength(frame) }).run(request),
    (error: unknown) => error instanceof ProcessExecutionError && error.code === 'OUTPUT_LIMIT_AMBIGUOUS');
  const result = await new SpawnCommandRunner({ maxOutputBytes: Buffer.byteLength(output) }).run(request);
  assert.equal(result.timedOut, true);
  assert.equal(result.stderr, '');
});
test('diagnostics do not consume the ordinary stderr budget', async () => {
  const ordinary = 'x'.repeat(1000) + '\n';
  const frame = FRAME + JSON.stringify({ phase: 'agent_cli_started', elapsedMs: 1, utc: new Date().toISOString() }) + '\n';
  const output = frame + ordinary + frame;
  assert.ok(Buffer.byteLength(output) > 1024);
  const result = await new SpawnCommandRunner({ maxOutputBytes: 1024 }).run(phaseRequest('mixed', {
    args: ['--eval', `process.stderr.write(${JSON.stringify(output)});`], timeoutKind: 'hard', timeoutMs: 2000,
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, ordinary);
  assert.equal(result.timedOut, false);
});
for (const mode of ['ordinary', 'diagnostic', 'unfinished'] as const) {
  test(`${mode} stderr retains its independent output bound`, async () => {
    const frame = FRAME + JSON.stringify({ phase: 'agent_cli_started', elapsedMs: 1, utc: new Date().toISOString() }) + '\n';
    const output = mode === 'ordinary' ? 'x'.repeat(1025)
      : mode === 'diagnostic' ? frame.repeat(20) : FRAME + 'x'.repeat(1025);
    await assert.rejects(new SpawnCommandRunner({ maxOutputBytes: 1024, killGraceMs: 20, orphanPipeGraceMs: 20 }).run(phaseRequest('mixed', {
      args: ['--eval', `process.stderr.write(${JSON.stringify(output)});`], timeoutKind: 'hard', timeoutMs: 2000,
    })), (error: unknown) => error instanceof ProcessExecutionError && error.code === 'OUTPUT_LIMIT_AMBIGUOUS');
  });
}
test('undeclared bridge and other harnesses retain their stderr contract', async () => {
  for (const harness of ['openclaw', 'fake'] as const) {
    const request = phaseRequest('mixed', { harness });
    if (harness === 'openclaw') delete (request as { openClawPhaseFrames?: true }).openClawPhaseFrames;
    const result = await new SpawnCommandRunner().run(request);
    assert.match(result.stderr, /@cauce\/openclaw-phase\/v1/u);
  }
});
test('hard timeout and cancellation are not prolonged by metadata', async () => {
  const runner = new SpawnCommandRunner({ killGraceMs: 20, orphanPipeGraceMs: 20 });
  const timeoutPhases: OpenClawPhaseObservation[] = [];
  const hard = await runner.run(phaseRequest('markers', { timeoutKind: 'hard', onOpenClawPhase: (value) => { timeoutPhases.push(value); } }));
  assert.equal(hard.timedOut, true);
  assert.ok(timeoutPhases.some((value) => value.phase === 'runner_timeout'));
  const controller = new AbortController();
  const cancelledPhases: OpenClawPhaseObservation[] = [];
  const cancelled = await runner.run(phaseRequest('markers', { signal: controller.signal, onOpenClawPhase: (value) => { cancelledPhases.push(value); if (value.phase === 'agent_cli_started') controller.abort(); } }));
  assert.equal(cancelled.cancelled, true);
  assert.ok(cancelledPhases.some((value) => value.phase === 'runner_cancelled'));
});
test('observer exceptions never replace output or exit status', async () => {
  const result = await new SpawnCommandRunner().run(phaseRequest('mixed', { onOpenClawPhase: () => { throw new Error('dummy-secret'); } }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, 'ordinary\ntail\n');
  const failure = await new SpawnCommandRunner().run(phaseRequest('error'));
  assert.equal(failure.exitCode, 7);
});
test('JSON before child exit does not settle the runner early', async () => {
  const phases: OpenClawPhaseObservation[] = [];
  const begin = performance.now();
  const result = await new SpawnCommandRunner().run(phaseRequest('final', { timeoutKind: 'hard', timeoutMs: 1500, onOpenClawPhase: (value) => { phases.push(value); } }));
  assert.ok(performance.now() - begin >= 450);
  assert.equal((JSON.parse(result.stdout) as { result: { status: string } }).result.status, 'done');
  assert.deepEqual(phases.map((value) => value.phase), ['child_spawned', 'child_exit', 'child_close', 'runner_settled']);
});
test('frame parser handles every byte boundary without leaking private candidate fields', () => {
  const observed: OpenClawPhaseObservation[] = [];
  const frames = new OpenClawPhaseFrames((value) => { observed.push(value); });
  const frame = FRAME + JSON.stringify({ phase: 'decode_completed', elapsedMs: 4, utc: '2026-10-04T00:00:00.000Z' }) + '\n';
  const ordinary = Buffer.concat([...Buffer.from('é\n' + frame + '尾\n')].map((byte) => frames.push(Buffer.from([byte]))));
  assert.equal(ordinary.toString('utf8'), 'é\n尾\n');
  assert.equal(observed.length, 1);
  for (const object of [null, [], { phase: 'decode_completed', elapsedMs: -1, utc: '2026-10-04T00:00:00.000Z' }, { phase: 'decode_completed', elapsedMs: 1, utc: 'invalid' }, { phase: 'decode_completed', elapsedMs: 1, utc: '2026-10-04T00:00:00.000Z', prompt: 'dummy-secret' }]) {
    assert.equal(frames.push(Buffer.from(FRAME + JSON.stringify(object) + '\n')).length, 0);
  }
  assert.equal(observed.length, 1);
});

test('real bridge does not publish native JSON before agentCliCommand resolves', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-phase-bridge-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await nativeModules(directory);
  const observations: OpenClawPhaseObservation[] = [];
  const runner = new SpawnCommandRunner();
  const result = await runner.run(phaseRequest('final', {
    args: [fileURLToPath(new URL('../bridge/openclaw-stdin-bridge.mjs', import.meta.url)), '--cauce-phase-observer-v1'],
    env: { CAUCE_OPENCLAW_DIST_DIR: directory }, stdin: 'dummy-secret-prompt', timeoutMs: 1800, timeoutKind: 'hard',
    onOpenClawPhase: (value) => { observations.push(value); },
  }));
  assert.equal(result.exitCode, 0);
  assert.deepEqual((JSON.parse(result.stdout) as { result: unknown }).result, NATIVE_OUTPUT);
  const bridgePhases = observations.filter((value) => value.transport === 'bridge');
  assert.deepEqual(bridgePhases.map((value) => value.phase), ['bridge_enter', 'modules_loaded', 'agent_cli_started', 'agent_cli_resolved', 'decode_completed', 'envelope_flush_requested']);
  const started = bridgePhases.find((value) => value.phase === 'agent_cli_started');
  const resolved = bridgePhases.find((value) => value.phase === 'agent_cli_resolved');
  assert.ok(started && resolved && resolved.elapsedMs - started.elapsedMs >= 390);
  assert.doesNotMatch(JSON.stringify(observations), /dummy-secret|native fixture|payloads/u);
  assert.equal(result.stderr, '<<cauce:harness-started>>\n');
});
test('concurrent Engine closures correlate stages and keep started ACK before runner invocation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-phase-engine-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const modules = join(directory, 'native');
  await nativeModules(modules);
  const store = await DurableStore.open(join(directory, 'store'));
  const observations: AdapterLog[] = [];
  const events: DeliveryEvent[] = [];
  const harness = new HarnessAdapter({ definition: openClawDefinition, runner: new SpawnCommandRunner(), store,
    resolveCredentialEnv: async () => ({ CAUCE_OPENCLAW_DIST_DIR: modules }), sessionNamespace: 'phase-test' });
  const engine = new AdapterEngine({ harness, store, ownTenantId: 'Steven', executionIntentMode: 'local-test-only',
    publish: async (event) => { events.push(event); }, logger: (entry) => { observations.push(entry); } });
  await engine.activateEpoch(1);
  const a = { ...delivery('phase-a'), console_human_subject: `human:${'a'.repeat(64)}` };
  const b = { ...delivery('phase-b'), console_human_subject: `human:${'b'.repeat(64)}`,
    authenticated_context: { ...delivery('phase-b').authenticated_context, session_id: 'another-conversation', channel: 'console' } };
  await Promise.all([engine.handleDelivery(a), engine.handleDelivery(b)]);
  for (const value of [a, b]) {
    const records = observations.filter((entry) => entry.event === 'openclaw_phase' && entry.delivery_id === value.delivery_id);
    assert.ok(records.length > 10);
    assert.ok(records.every((entry) => entry.attempt === value.attempt && typeof entry.timestamp === 'string'));
    const names = records.map((entry) => entry.phase_name);
    assert.ok(names.indexOf('invocation_enter') < names.indexOf('started_ack_enqueued'));
    assert.ok(names.indexOf('started_ack_enqueued') < names.indexOf('child_spawned'));
    assert.ok(names.indexOf('decoded_final_valid') < names.indexOf('harness_completed'));
    assert.ok(events.some((event) => event.delivery_id === value.delivery_id && event.phase === 'done'));
  }
  assert.doesNotMatch(JSON.stringify(observations.filter((entry) => entry.event === 'openclaw_phase')), /claim_token|human:|dummy-secret|native fixture/u);
});
test('API headers are not a complete body and diagnostics do not expose content', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-phase-api-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const token = join(directory, 'token');
  await writeFile(token, 'owned-dummy-token', { mode: 0o600 });
  let release: (() => void) | undefined;
  const bodyBarrier = new Promise<void>((resolveBarrier) => { release = resolveBarrier; });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }); response.flushHeaders();
    void bodyBarrier.then(() => { response.end(JSON.stringify(NATIVE_OUTPUT)); });
  });
  t.after(async () => { release?.(); server.closeAllConnections(); await new Promise<void>((resolveClose) => { server.close(() => { resolveClose(); }); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const runner = new OpenClawApiRunner({ endpoint: `http://127.0.0.1:${String(address.port)}/v1/chat/completions`, tokenFile: token });
  const observations: OpenClawPhaseObservation[] = [];
  let headerSeen: (() => void) | undefined;
  const headers = new Promise<void>((resolveHeaders) => { headerSeen = resolveHeaders; });
  let settled = false;
  const pending = runner.run(phaseRequest('final', { stdin: 'dummy-private-input', timeoutKind: 'hard', timeoutMs: 1800,
    onOpenClawPhase: (value) => { observations.push(value); if (value.phase === 'api_headers') headerSeen?.(); },
  })).finally(() => { settled = true; });
  await headers;
  assert.equal(settled, false);
  assert.equal(observations.some((value) => value.phase === 'api_body_complete'), false);
  release?.();
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.deepEqual(observations.map((value) => value.phase), ['api_enter', 'api_dispatch', 'api_headers', 'api_body_complete', 'api_resolved']);
  assert.ok(observations.every((value, index) => index === 0 || value.elapsedMs >= (observations[index - 1]?.elapsedMs ?? 0)));
  assert.doesNotMatch(JSON.stringify(observations), /owned-dummy-token|dummy-private-input|native fixture|127\.0/u);
});

test('API failure and timeout diagnostics preserve ambiguous outcomes without content', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-phase-api-errors-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const token = join(directory, 'token');
  await writeFile(token, 'owned-dummy-token', { mode: 0o600 });
  let fail = true;
  const server = createServer((_request, response) => {
    if (fail) { response.writeHead(500); response.end('{"error":"dummy-private-error"}'); }
    else { response.writeHead(200); response.flushHeaders(); }
  });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolveClose) => { server.close(() => { resolveClose(); }); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const runner = new OpenClawApiRunner({ endpoint: `http://127.0.0.1:${String(address.port)}/v1/chat/completions`, tokenFile: token });
  const phases: OpenClawPhaseObservation[] = [];
  const observer = (value: OpenClawPhaseObservation): void => { phases.push(value); };
  await assert.rejects(runner.run(phaseRequest('final', { onOpenClawPhase: observer })));
  assert.ok(phases.some((value) => value.phase === 'api_failed'));
  assert.equal(phases.some((value) => value.phase === 'api_resolved'), false);
  fail = false; phases.length = 0;
  const timedOut = await runner.run(phaseRequest('final', { timeoutKind: 'hard', timeoutMs: 80, onOpenClawPhase: observer }));
  assert.equal(timedOut.timedOut, true);
  assert.ok(phases.some((value) => value.phase === 'api_timeout'));
  phases.length = 0;
  const controller = new AbortController();
  const cancelled = await runner.run(phaseRequest('final', { signal: controller.signal, onOpenClawPhase: (value) => { observer(value); if (value.phase === 'api_headers') controller.abort(); } }));
  assert.equal(cancelled.cancelled, true);
  assert.ok(phases.some((value) => value.phase === 'api_cancelled'));
  assert.doesNotMatch(JSON.stringify(phases), /owned-dummy-token|dummy-private-error/u);
});
test('runner lifecycle reaps its exact owned PID after diagnostic-only timeout', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-phase-pid-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const pidFile = join(directory, 'pid');
  const request = phaseRequest('markers');
  const code = request.args[1]; assert.ok(code);
  const result = await new SpawnCommandRunner({ killGraceMs: 20, orphanPipeGraceMs: 20 }).run({ ...request,
    args: ['--eval', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));${code}`],
  });
  assert.equal(result.timedOut, true);
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
});


test('ordinary partial prefixes survive EOF but a truncated reserved frame is not progress', async () => {
  const runner = new SpawnCommandRunner({ killGraceMs: 20, orphanPipeGraceMs: 20 });
  for (const ordinary of ['@', '@cauce', '@cauce/openclaw-phase/v1']) {
    const result = await runner.run(phaseRequest('eof', { args: ['--eval', `process.stderr.write(${JSON.stringify(ordinary)});`] }));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, ordinary);
  }
  const partialFrame = FRAME + '{"phase":"agent_cli_started","private":"dummy-secret"';
  const result = await runner.run(phaseRequest('eof', {
    args: ['--eval', `process.stderr.write(${JSON.stringify(partialFrame)});const t=setInterval(()=>process.stderr.write(' '),50);setTimeout(()=>{clearInterval(t);process.exit(0)},650);`],
  }));
  assert.equal(result.timedOut, true);
  assert.equal(result.stderr, '');
});


test('command overrides cannot activate packaged bridge diagnostic parsing', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-phase-override-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const store = await DurableStore.open(join(directory, 'store'));
  t.after(() => { store.close(); });
  for (const command of ['/bin/echo', process.execPath]) {
    let captured: CommandRunRequest | undefined;
    const adapter = new HarnessAdapter({ definition: openClawDefinition, store,
      commandOverride: { command, baseArgs: [OPENCLAW_BRIDGE_PATH] },
      runner: { run: async (request) => {
        captured = request;
        return { stdout: JSON.stringify(NATIVE_OUTPUT), stderr: '', exitCode: 0,
          signal: null, timedOut: false, cancelled: false };
      } } });
    await adapter.execute({ prompt: 'fixture', timeoutMs: 1000, signal: new AbortController().signal,
      onOpenClawPhase: (phase) => { assert.equal(phase.transport, 'adapter'); } });
    assert.ok(captured);
    assert.equal(captured.openClawPhaseFrames, undefined);
    assert.equal(captured.args.includes('--cauce-phase-observer-v1'), false);
  }
  const child = join(directory, 'override.cjs');
  const frame = FRAME + JSON.stringify({ phase: 'agent_cli_started', elapsedMs: 1, utc: '2026-10-04T00:00:00.000Z' }) + '\n';
  await writeFile(child, `process.stderr.write(${JSON.stringify(frame)});process.stdout.write(${JSON.stringify(JSON.stringify(NATIVE_OUTPUT))});`);
  const observations: OpenClawPhaseObservation[] = [];
  let result: CommandRunResult | undefined;
  const runner = new SpawnCommandRunner();
  const adapter = new HarnessAdapter({ definition: openClawDefinition, store,
    commandOverride: { command: process.execPath, baseArgs: [child, OPENCLAW_BRIDGE_PATH] },
    runner: { run: async (request) => { result = await runner.run(request); return result; } } });
  await adapter.execute({ prompt: 'fixture', timeoutMs: 1000, signal: new AbortController().signal,
    onOpenClawPhase: (phase) => { observations.push(phase); } });
  assert.ok(result);
  assert.equal(result.stderr, frame);
  assert.ok(observations.some((phase) => phase.phase === 'child_spawned'));
  assert.ok(observations.some((phase) => phase.phase === 'decoded_final_valid'));
  assert.equal(observations.some((phase) => phase.transport === 'bridge'), false);
});
