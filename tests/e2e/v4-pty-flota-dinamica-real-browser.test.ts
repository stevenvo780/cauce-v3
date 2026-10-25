import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildInstalledCli } from './v4-cli-flota-dinamica.install.js';
import { discardPtyFleetInstallation, loginPtyFleetCli, usePtyFleetShells, type PtyFleetCli } from './v4-pty-flota-dinamica.client.js';
import { assertPtyFleetOnline, createPtyFleetAgent, enqueuePtyFleet, observePtyFleet, openPtyFleetPanel, purgePtyFleet,
  ptyFleetAlias, ptyFleetRuntimeKey, retryPtyFleet, type PtyFleetOperation } from './v4-pty-flota-dinamica.flow.js';
import { capturePtyFleet, PTY_FLEET_OWNER, ptyFleetReceipt, ptyFleetReceipts, startPtyFleetFixture,
  type PtyFleetFixture } from './v4-pty-flota-dinamica.helpers.js';

const execute = promisify(execFile);
let installation = '', cli: PtyFleetCli | undefined, fixture: PtyFleetFixture | undefined;
let completed = false;
const sources = ['tests/e2e/v4-pty-flota-dinamica-real-browser.test.ts', 'tests/e2e/v4-pty-flota-dinamica.helpers.ts',
  'tests/e2e/v4-pty-flota-dinamica.infra.ts', 'tests/e2e/v4-pty-flota-dinamica.flow.ts',
  'tests/e2e/v4-pty-flota-dinamica.client.ts', 'tests/e2e/v4-pty-flota-dinamica.observe.py',
  'tests/e2e/v4-cli-flota-dinamica.install.ts', 'services/gateway/src/fleet/host-computer.fixtures.ts',
  'ops/cli/fleet_executor_steps.py', 'ops/cli/fleet_executor_terminal.py', 'ops/cli/fleet-authority-issuer.py',
  'ops/cli/fleet_executor_terminal_provision.py', 'ops/cli/fleet_executor_terminal_files.py',
  'ops/cli/fleet_executor_terminal_manager.py', 'ops/cli/fleet_executor_terminal_inventory.py',
  'ops/pty-agent/cauce-pty-launcher.sh', 'ops/pty-agent/systemd/cauce-v3-pty@.service',
  'services/gateway/src/fleet/authority/schemas.ts', 'services/gateway/src/fleet/authority/service.ts'];

async function sourceReceipt(phase: string): Promise<void> {
  const hashes: Record<string, string> = {};
  for (const path of sources) hashes[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  const head = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
  await ptyFleetReceipt('source-' + phase, { head, hashes, aggregate: createHash('sha256').update(JSON.stringify(hashes)).digest('hex') });
}

async function journalDiagnostics(active: PtyFleetFixture, executor = false): Promise<unknown> {
  const unit = executor ? 'cauce-v3-host-executor-' + active.owner.company.slug + '-' + active.hostId + '.service'
    : 'cauce-v3-pty@' + ptyFleetRuntimeKey + '.service';
  const since = active.retryDiagnostic?.since;
  const result = await active.computer.onComputer(['journalctl', '--user', '--user-unit=' + unit,
    '--no-pager', '-o', 'json', '-n', '100', ...(since ? ['--since', since] : [])]);
  if (result.code !== 0 || result.stdout.length > 1024 * 1024) return { code: result.code, observation_unavailable: true };
  const fields = new Set(['_PID', '_UID', '_BOOT_ID', '__MONOTONIC_TIMESTAMP', '_SYSTEMD_USER_UNIT']);
  const publicSources = ['fleet-executor.py', 'fleet_executor_terminal_manager.py', 'fleet_executor_terminal_provision.py',
    'fleet_executor_terminal_files.py', 'fleet_executor_terminal_inventory.py', 'fleet_executor_steps.py'];
  const publicFailures = executor ? (await Promise.all(publicSources.map(name => readFile(join('ops/cli', name), 'utf8'))))
    .flatMap(source => [...source.matchAll(/raise SafeFailure\('([A-Za-z0-9 ,;:._-]+)'\)/gu)].map(match => match[1] ?? '')) : [];
  const rows = result.stdout.split('\n').filter(Boolean).map(line => {
    const row = JSON.parse(line) as Record<string, unknown>, message = typeof row.MESSAGE === 'string' ? row.MESSAGE : '';
    const identifiers = Object.fromEntries(Object.entries(row).filter(([name, value]) => typeof value === 'string'
      && (fields.has(name) || /^[A-Z_]*INVOCATION_ID$/u.test(name))));
    return { ...identifiers, start: /\bstarting alias=/u.test(message), ack: /\brelay accepted alias=/u.test(message),
      disconnect: message.includes('relay connect failed:') || message.includes('relay session ended:'),
      ...(executor ? { safe_failures: [...new Set(publicFailures.filter(value => value && message.includes('fleet effect failed: ' + value)))],
        command_failed: message.startsWith('fleet host command failed '),
        step_failed: message.startsWith('fleet step failed '),
        terminal_provision_failed: message.includes('CAUCE_FLEET_FAILURE=terminal_provision_failed') } : {}) };
  });
  return { code: result.code, since: since ?? null, rows };
}

async function failureDiagnostics(active: PtyFleetFixture): Promise<void> {
  const observed = await Promise.allSettled([
    active.computer.pool.query<Record<string, unknown>>(`SELECT id,kind,status,version,error->>'code' AS error_code,
      error->>'reason' AS error_reason,error->>'step' AS error_step FROM fleet_operations
      WHERE target->>'tenant_id'=$1 AND target->>'alias'=$2 ORDER BY created_at`, [active.tenantId, ptyFleetAlias])
      .then(result => result.rows),
    active.computer.pool.query<Record<string, unknown>>('SELECT enabled,lifecycle_state,runtime_key,host_id FROM agents WHERE tenant_id=$1 AND alias=$2',
      [active.tenantId, ptyFleetAlias]).then(result => result.rows),
    observePtyFleet(active),
    active.computer.onComputer(['systemctl', '--user', 'show', 'cauce-v3-pty@' + ptyFleetRuntimeKey + '.service',
      '--property=LoadState,ActiveState,Result,ExecMainStatus,MainPID,InvocationID,ExecMainStartTimestampMonotonic', '--no-pager'])
      .then(result => ({ code: result.code, properties: result.stdout })),
    journalDiagnostics(active),
    journalDiagnostics(active, true),
  ]);
  const values = observed.map(result => result.status === 'fulfilled' ? result.value : { observation_unavailable: true });
  let pathname = '';
  try { pathname = new URL(active.page.url()).pathname; } catch { /* A closed browser has no safe current pathname. */ }
  await ptyFleetReceipt('failure-diagnostics', { operations: values[0], agents: values[1], physical: values[2], unit: values[3],
    journal: values[4], executor_journal: values[5], retry: active.retryDiagnostic,
    pathname, browser_error_count: active.errors.unexpected.length });
  if (pathname === '/config' || pathname.startsWith('/terminal')) {
    await capturePtyFleet(active.page, 'failure').catch(async () => ptyFleetReceipt('failure-capture-unavailable', { unavailable: true }));
  }
}

beforeAll(async () => {
  await mkdir(ptyFleetReceipts, { recursive: true, mode: 0o700 });
  await sourceReceipt('before');
  installation = await mkdtemp('/tmp/cauce-h12-installed-');
  cli = await buildInstalledCli(installation, { owner: PTY_FLEET_OWNER });
  fixture = await startPtyFleetFixture();
  const release = JSON.parse(await readFile(join(dirname(fixture.computer.installRoot), 'host-release/host-release.json'), 'utf8')) as unknown;
  await ptyFleetReceipt('host-release', release);
  await sourceReceipt('during');
}, 1_500_000);

afterAll(async () => {
  try {
    if (fixture && !completed) await failureDiagnostics(fixture).catch(() => { console.info('H12_FAILURE_DIAGNOSTICS_UNAVAILABLE'); });
  }
  finally {
    try { await fixture?.close(); }
    finally {
      try { if (installation) await discardPtyFleetInstallation(installation); }
      finally { await sourceReceipt('after'); }
    }
  }
}, 180_000);

it('crea desde la web un PTY automático, abre shell web y CLI instalada, detiene, arranca y purga', async () => {
  if (!fixture || !cli) throw new Error('the dynamic fleet PTY fixture is not ready');
  await loginPtyFleetCli(fixture, cli);
  const absent = await observePtyFleet(fixture);
  expect(absent.pki).toBeNull(); expect(absent.env).toBeNull(); expect(absent.process_alive).toBe(false);
  expect(absent.sdk.observation).toBe('absent'); expect(absent.sdk.normal_process_count).toBe(0);
  await ptyFleetReceipt('before-create-pty-absent', absent);
  console.info('H12_FLOW create with the owned relay paused');
  const paused = await fixture.pauseRelay();
  let failed: PtyFleetOperation, stagedFingerprint: string | null = null;
  try {
    failed = await createPtyFleetAgent(fixture, 'failed');
    expect(failed.error).toMatchObject({ step: 'admission', retryable: true, reason: 'terminal_provision_failed' });
    expect(failed.steps.find(step => step.name === 'admission')?.status).toBe('failed');
    expect(failed.steps.find(step => step.name === 'admission')?.evidence?.terminal_verified).not.toBe(true);
    const staged = await observePtyFleet(fixture);
    expect(staged.sdk.normal_process_count).toBe(0); expect(staged.sdk.metadata_alive).toBe(false);
    expect(staged.applied_contains_runtime).toBe(false);
    expect(staged.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    stagedFingerprint = staged.fingerprint;
    const identities = JSON.parse(await readFile(fixture.registryFile, 'utf8')) as
      { agents: { tenant_id: string; alias: string; fingerprint_sha256: string }[] };
    const registered = identities.agents.filter(row => row.tenant_id === fixture?.tenantId && row.alias === ptyFleetAlias);
    expect(registered).toHaveLength(1); expect(registered[0]?.fingerprint_sha256.toLowerCase()).toBe(stagedFingerprint);
    const agent = (await fixture.computer.pool.query<{ enabled: boolean; lifecycle_state: string }>(
      'SELECT enabled,lifecycle_state FROM agents WHERE tenant_id=$1 AND alias=$2', [fixture.tenantId, ptyFleetAlias])).rows[0];
    expect(agent).toEqual({ enabled: false, lifecycle_state: 'failed' });
    await capturePtyFleet(fixture.page, 'create-failed-relay-offline');
    await ptyFleetReceipt('failed-admission', { operation: failed, relay: paused, staged, agent, registered });
    console.info('H12_FLOW failed admission, SDK stopped, grant staged');
  } finally {
    const resumed = await fixture.resumeRelay();
    expect(resumed.pid).toBe(paused.pid); expect(resumed.starttime).toBe(paused.starttime);
    await ptyFleetReceipt('relay-resumed', { paused, resumed });
  }
  if (!stagedFingerprint) throw new Error('the real failed admission omitted its staged grant');
  const created = await retryPtyFleet(fixture, failed);
  expect(created.id).toBe(failed.id);
  const first = await assertPtyFleetOnline(fixture, 'created');
  expect(first.fingerprint).toBe(stagedFingerprint);
  expect(created.steps.find(step => step.name === 'admission')?.evidence).toMatchObject({
    terminal_verified: true, terminal_certificate_sha256: first.fingerprint,
  });
  await capturePtyFleet(fixture.page, 'created-online');
  await capturePtyFleet(fixture.page, 'retried-same-operation');
  console.info('H12_FLOW created online; web and installed CLI');
  await usePtyFleetShells(fixture, cli, first.uid, 'created');
  let panel = await openPtyFleetPanel(fixture);
  await panel.getByLabel('¿Qué quieres hacer?').selectOption('stop');
  const stopped = await enqueuePtyFleet(fixture, panel, 'stop');
  console.info('H12_FLOW stopped');
  const afterStop = await observePtyFleet(fixture);
  expect(afterStop.sdk.normal_process_count).toBe(0); expect(afterStop.sdk.metadata_alive).toBe(false);
  await capturePtyFleet(fixture.page, 'stopped');
  await ptyFleetReceipt('stopped-pty', { operation: stopped.id, observed: afterStop });
  panel = await openPtyFleetPanel(fixture);
  await panel.getByLabel('¿Qué quieres hacer?').selectOption('start');
  const started = await enqueuePtyFleet(fixture, panel, 'start');
  const second = await assertPtyFleetOnline(fixture, 'started');
  expect(second.fingerprint).toBe(first.fingerprint);
  expect(started.steps.find(step => step.name === 'admission')?.evidence).toMatchObject({
    terminal_verified: true, terminal_certificate_sha256: second.fingerprint,
  });
  await capturePtyFleet(fixture.page, 'started-online');
  console.info('H12_FLOW started online; web and installed CLI');
  await usePtyFleetShells(fixture, cli, second.uid, 'started');
  if (!second.fingerprint) throw new Error('the started PTY has no observed certificate');
  await purgePtyFleet(fixture, second.fingerprint);
  console.info('H12_FLOW purged');
  await capturePtyFleet(fixture.page, 'purged');
  expect(fixture.errors.unexpected).toEqual([]);
  await ptyFleetReceipt('complete', { alias: ptyFleetAlias, created: created.id, stopped: stopped.id, started: started.id,
    web_and_installed_cli_before_after_start: true, manual_alias_provisioning: false, purged: true,
    real_relay_outage: true, same_operation_retry: failed.id, certificate_preserved_across_retry_start: true });
  completed = true;
}, 600_000);
