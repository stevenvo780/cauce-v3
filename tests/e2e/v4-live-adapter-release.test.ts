import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { command, receipt, RECEIPTS, startLiveAdapterFixture } from './v4-live-adapter-release.helpers.js';

let fixture: Awaited<ReturnType<typeof startLiveAdapterFixture>> | undefined;
beforeAll(async () => { fixture = await startLiveAdapterFixture(); }, 1_500_000);
afterAll(async () => { await fixture?.close(); }, 600_000);

describe.sequential('live V3 container adapter release through the operator script', () => {
  test('simulates without writes, upgrades with a real delivery, reports API failure promptly and rolls back', async () => {
    assert.ok(fixture);
    const active = fixture;
    const child = active.start();
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_384); });
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-16_384); });
    const baseline = await active.probe(active.old.name, 'baseline-proof').catch((error: unknown) => {
      throw new Error(`Initial canonical supervisor did not become ready: ${stderr}\n${stdout}`, { cause: error });
    });
    assert.equal(baseline.delivery_done, true, stderr);
    const before = await readFile(active.config);
    const beforeCount = (await active.pool.query<{ count: string }>(
      "SELECT count(*)::text FROM deliveries WHERE recipient_alias=$1", [active.alias])).rows[0]?.count;
    const script = join(process.cwd(), '.delegados/v4/adaptador-vivo.sh');
    const appliedReceipt = join(RECEIPTS, `apply-${active.alias}.json`);
    const baseArgs = [script, '--laboratorio', '--inventario', active.inventory,
      '--agente', active.alias, '--ref', active.candidate.ref, '--bundle-preconstruido', active.candidate.bundle,
      '--sonda', active.probePath, '--sonda-sha256', active.probeSha, '--recibo', appliedReceipt];
    const simulation = await command('bash', baseArgs, active.environment, 180_000);
    assert.deepEqual(await readFile(active.config), before);
    assert.equal(await stat(appliedReceipt).then(() => true, () => false), false);
    assert.equal((await active.pool.query<{ count: string }>(
      "SELECT count(*)::text FROM deliveries WHERE recipient_alias=$1", [active.alias])).rows[0]?.count, beforeCount);
    const upgraded = await command('bash', [...baseArgs, '--ejecutar'], active.environment, 240_000);
    const updated = await readFile(active.config, 'utf8');
    const release = /^BUNDLE_RELEASE=(.+)$/mu.exec(updated)?.[1];
    assert.ok(release && release !== active.old.name);
    assert.equal((await readFile(join(active.roots.bundle, 'releases', release, '.release-sha'), 'utf8')).trim(), active.candidate.ref);
    assert.ok(active.probes.some(probe => probe.release === release && probe.delivery_done === true));
    const startedAt = Date.now();
    const failed = await active.delivery(true);
    const failureMs = Date.now() - startedAt;
    assert.equal(failed.status, 'dead');
    assert.equal(failed.error_code, 'PROCESS_EXIT_AMBIGUOUS');
    assert.match(failed.last_error ?? '', /terminal API error/u);
    assert.doesNotMatch(failed.last_error ?? '', /Harness timed out|180 min|PRIVATE_PROVIDER_ERROR/u);
    assert.ok(failureMs < 15_000);
    const rolledBack = await command('bash', [script, '--laboratorio', '--inventario', active.inventory, '--agente', active.alias,
      '--revertir', '--recibo', appliedReceipt, '--ejecutar', '--sonda', active.probePath,
      '--sonda-sha256', active.probeSha], active.environment, 240_000);
    const restored = await readFile(active.config, 'utf8');
    assert.match(restored, new RegExp(`^BUNDLE_RELEASE=${active.old.name}$`, 'mu'));
    assert.match(restored, new RegExp(`^BUNDLE_SHA256=${active.old.digest}$`, 'mu'));
    const rollbackProbe = active.probes.at(-1);
    assert.equal(rollbackProbe?.release, active.old.name);
    assert.equal(rollbackProbe.delivery_done, true);
    await active.stop();
    assert.equal(await readFile(active.config, 'utf8'), restored);
    const interrupted = JSON.parse(await readFile(appliedReceipt, 'utf8')) as { agents: Record<string, Record<string, unknown>> };
    const interruptedAgent = interrupted.agents[active.alias]; assert.ok(interruptedAgent);
    Object.assign(interruptedAgent, { state: 'failed', failure_stage: 'stopped' });
    Object.assign(interrupted, { test_fixture_interruption: { synthetic_receipt_copy: true,
      physical_stop_verified: true, previous_pin_intact: true } });
    const interruptedReceipt = join(RECEIPTS, `interrupted-${active.alias}.json`);
    await writeFile(interruptedReceipt, JSON.stringify(interrupted), { mode: 0o600 });
    await command('bash', [script, '--laboratorio', '--inventario', active.inventory, '--agente', active.alias,
      '--revertir', '--recibo', interruptedReceipt, '--salida-recibo', join(RECEIPTS, `recovery-${active.alias}.json`),
      '--ejecutar', '--sonda', active.probePath, '--sonda-sha256', active.probeSha], active.environment, 240_000);
    assert.equal(active.probes.at(-1)?.release, active.old.name);
    assert.equal(active.probes.at(-1)?.delivery_done, true);
    await receipt('roundtrip', { result: 'PASS', alias: active.alias, appliedReceipt, oldRef: active.old.ref, newRef: active.candidate.ref,
      oldRelease: active.old.name, newRelease: release, simulationUnchanged: true,
      configBeforeSha256: createHash('sha256').update(before).digest('hex'), helloAndDeliveryProofs: active.probes,
      apiFailure: { status: failed.status, code: failed.error_code, cause: failed.last_error, elapsedMs: failureMs }, rollbackRestored: true,
      stoppedBeforePinRecovery: { receiptIsSyntheticInterruptedCopy: true, physicalStopVerified: true, previousPinIntact: true, recoveredWithRealDelivery: true },
      scriptExitCodes: { simulation: 0, upgrade: 0, rollback: 0 },
      outputSizes: [simulation.stdout.length, upgraded.stdout.length, rolledBack.stdout.length] });
  }, 720_000);

  test('upgrades an OpenClaw supervisor container from the old release to a live delivery', async () => {
    const active = await startLiveAdapterFixture({ harness: 'openclaw' });
    try {
      const child = active.start();
      let stderr = '';
      let stdout = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_384); });
      child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-16_384); });
      const baseline = await active.probe(active.old.name, 'openclaw-baseline').catch((error: unknown) => {
        throw new Error(`Initial OpenClaw supervisor did not become ready: ${stderr}\n${stdout}`, { cause: error });
      });
      assert.equal(baseline.delivery_done, true, stderr);
      assert.equal(baseline.process_alive, true);
      assert.equal(baseline.lease_valid, true);
      assert.equal(baseline.hello_ack, true);
      assert.match(baseline.executable_path, /\/bin\/openclaw\.js$/u);
      const before = await readFile(active.config);
      const beforeCount = (await active.pool.query<{ count: string }>(
        'SELECT count(*)::text FROM deliveries WHERE recipient_alias=$1', [active.alias])).rows[0]?.count;
      const script = join(process.cwd(), '.delegados/v4/adaptador-vivo.sh');
      const appliedReceipt = join(RECEIPTS, `apply-openclaw-${active.alias}.json`);
      const baseArgs = [script, '--laboratorio', '--inventario', active.inventory,
        '--agente', active.alias, '--ref', active.candidate.ref, '--bundle-preconstruido', active.candidate.bundle,
        '--sonda', active.probePath, '--sonda-sha256', active.probeSha, '--recibo', appliedReceipt];
      await command('bash', baseArgs, active.environment, 180_000);
      assert.deepEqual(await readFile(active.config), before);
      assert.equal(await stat(appliedReceipt).then(() => true, () => false), false);
      assert.equal((await active.pool.query<{ count: string }>(
        'SELECT count(*)::text FROM deliveries WHERE recipient_alias=$1', [active.alias])).rows[0]?.count, beforeCount);
      const upgraded = await command('bash', [...baseArgs, '--ejecutar'], active.environment, 240_000);
      const updated = await readFile(active.config, 'utf8');
      const release = /^BUNDLE_RELEASE=(.+)$/mu.exec(updated)?.[1];
      assert.ok(release && release !== active.old.name);
      assert.equal((await readFile(join(active.roots.bundle, 'releases', release, '.release-sha'), 'utf8')).trim(), active.candidate.ref);
      const proof = active.probes.at(-1) as { release: string; delivery_done: boolean; process_alive: boolean;
        lease_valid: boolean; hello_ack: boolean; pid: number; executable_path: string; lease_epoch: string };
      assert.equal(proof.release, release);
      assert.equal(proof.delivery_done, true);
      assert.equal(proof.process_alive, true);
      assert.equal(proof.lease_valid, true);
      assert.equal(proof.hello_ack, true);
      assert.notEqual(proof.pid, baseline.pid);
      assert.match(proof.executable_path, new RegExp(`/releases/${release}/packages/adapter-sdk/dist/src/bin/openclaw\\.js$`, 'u'));
      assert.equal(upgraded.stdout.includes('"state": "verified"') || upgraded.stdout.includes('"state": "succeeded"'), true);
      await receipt('openclaw-roundtrip', { result: 'PASS', alias: active.alias, harness: 'openclaw', lifecycle: 'supervisor',
        oldRelease: active.old.name, newRelease: release, oldRef: active.old.ref, newRef: active.candidate.ref,
        baselinePid: baseline.pid, baselineEpoch: baseline.lease_epoch, proof });
    } finally {
      await active.close();
    }
  }, 1_200_000);
});
