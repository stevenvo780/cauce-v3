import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assertLegacyPtyAbsent, assertLegacyPtyTurn, createLegacyPtyAgent, legacyPtyOperations, legacyPtySdkDiagnostics,
  observeLegacyPty, runLegacyPtyOperation } from './v4-pty-fleet-legacy-policy.flow.js';
import { legacyPtyAlias, legacyPtyCapture, legacyPtyReceipt, startLegacyPtyFixture, type LegacyPtyFixture } from './v4-pty-fleet-legacy-policy.helpers.js';

const execute = promisify(execFile);
let fixture: LegacyPtyFixture | undefined, completed = false;
const sources = ['tests/e2e/v4-pty-fleet-legacy-policy-real-browser.test.ts', 'tests/e2e/v4-pty-fleet-legacy-policy.helpers.ts',
  'tests/e2e/v4-pty-fleet-legacy-policy.flow.ts', 'services/gateway/src/fleet/host-computer.fixtures.ts',
  'ops/cli/host_setup.py', 'ops/cli/fleet_executor_steps.py', 'ops/cli/fleet_executor_terminal_provision.py',
  'ops/cli/fleet_executor_terminal_manager.py', 'services/gateway/src/terminal/session-control/targets.ts'];
const dependencies = ['tests/e2e/v4-fleet-cancel-deploy.runtime.ts', 'tests/e2e/v4-pty-flota-dinamica.observe.py',
  'packages/adapter-sdk/src/sdk/bootstrap-runner.ts', 'packages/adapter-sdk/src/bin/shared.ts'];

async function sourceReceipt(phase: string): Promise<void> {
  const hashes: Record<string, string> = {}, dependencyHashes: Record<string, string> = {};
  for (const path of sources) hashes[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  for (const path of dependencies) dependencyHashes[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  await legacyPtyReceipt('source-' + phase, { head: (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim(), hashes,
    dependency_hashes: dependencyHashes, aggregate: createHash('sha256').update(JSON.stringify({ hashes, dependencyHashes })).digest('hex') });
}

beforeAll(async () => {
  await sourceReceipt('before');
  fixture = await startLegacyPtyFixture();
  await sourceReceipt('during');
}, 1_500_000);

afterAll(async () => {
  try {
    if (fixture && !completed) {
      const results = await Promise.allSettled([legacyPtyOperations(fixture), observeLegacyPty(fixture), legacyPtySdkDiagnostics(fixture),
        legacyPtyCapture(fixture.page, 'failed')]);
      await legacyPtyReceipt('failure-diagnostics', { operations: results[0].status === 'fulfilled' ? results[0].value : null,
        physical: results[1].status === 'fulfilled' ? results[1].value : null,
        sdk_log: results[2].status === 'fulfilled' ? results[2].value : null, browser_errors: fixture.errors.unexpected });
    }
  } finally {
    try { await fixture?.close(); } finally { await sourceReceipt('after'); }
  }
}, 180_000);

it('admite y consume turnos después de Crear y Arrancar con política y emisor sin terminal', async () => {
  if (!fixture) throw new Error('the legacy PTY fixture is absent');
  const created = await createLegacyPtyAgent(fixture);
  const initial = await assertLegacyPtyAbsent(fixture, 'created');
  expect(initial.sdk.normal_process_count).toBe(1); expect(initial.sdk.metadata_matches).toBe(true);
  expect(initial.applied_contains_runtime).toBe(true);
  const ready = async () => (await fixture?.computer.pool.query<{ enabled: boolean; lifecycle_state: string }>(
    'SELECT enabled,lifecycle_state FROM agents WHERE tenant_id=$1 AND alias=$2', [fixture.tenantId, legacyPtyAlias]))?.rows;
  expect(await ready()).toEqual([{ enabled: true, lifecycle_state: 'ready' }]);
  await legacyPtyCapture(fixture.page, 'created-online-without-pty');
  await assertLegacyPtyTurn(fixture, 'created');
  const stopped = await runLegacyPtyOperation(fixture, 'stop');
  const paused = await assertLegacyPtyAbsent(fixture, 'stopped');
  expect(paused.sdk.normal_process_count).toBe(0); expect(paused.sdk.metadata_alive).toBe(false);
  expect(await ready()).toEqual([{ enabled: false, lifecycle_state: 'draft' }]);
  await legacyPtyCapture(fixture.page, 'stopped-without-pty');
  const started = await runLegacyPtyOperation(fixture, 'start');
  const resumed = await assertLegacyPtyAbsent(fixture, 'started');
  expect(resumed.sdk.normal_process_count).toBe(1); expect(resumed.sdk.metadata_matches).toBe(true);
  expect(resumed.sdk.metadata).not.toEqual(initial.sdk.metadata);
  expect(await ready()).toEqual([{ enabled: true, lifecycle_state: 'ready' }]);
  await legacyPtyCapture(fixture.page, 'started-online-without-pty');
  await assertLegacyPtyTurn(fixture, 'started');
  expect(fixture.errors.unexpected).toEqual([]);
  await legacyPtyReceipt('complete', { alias: legacyPtyAlias, created: created.id, stopped: stopped.id, started: started.id,
    terminal_policy_absent: true, issuer_terminal_absent: true, terminal_modes: ['shell'], pty_provisioned: false,
    sdk: 'real', provider_cli: 'approved synthetic account and native response', real_turns: 2 });
  completed = true;
}, 600_000);
