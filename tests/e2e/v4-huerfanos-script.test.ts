import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { agentPlan, EVIDENCE, LIVE_ALIAS, NATIVE_ALIAS, nativeObservation, OWNER, PREFIX, runCleanup,
  liveReply, startOrphansFixture, waitOperation, type OrphansFixture, type OrphansPlan } from './v4-huerfanos.fixtures.js';

interface CleanupItem {
  id: string; status: string; reason_code: string; reason: string;
  operation?: { id: string; status: string };
}
interface CleanupOutput { status: string; items: CleanupItem[]; external_mutations: false | 'possible' }

function output(value: { code: number; stdout: string; stderr: string }, expected = 0): CleanupOutput {
  expect(value.code, value.stdout + value.stderr).toBe(expected);
  return JSON.parse(value.stdout) as CleanupOutput;
}

async function operationalState(fixture: OrphansFixture) {
  return {
    agents: (await fixture.computer.pool.query(`SELECT alias,enabled,lifecycle_state,retired_at::text,purged_at::text,container_name
      FROM agents WHERE tenant_id=$1 ORDER BY alias`, [fixture.tenant])).rows,
    operations: (await fixture.computer.pool.query('SELECT id,kind,status FROM fleet_operations ORDER BY id')).rows,
    native: await nativeObservation(fixture),
    live: await docker(['inspect', '--format', '{{.Id}} {{.State.Running}}', fixture.liveContainer]),
    volume: await docker(['volume', 'inspect', '--format', '{{json .Labels}}', fixture.retainedVolume]),
    network: await docker(['network', 'inspect', '--format', '{{.Id}}', fixture.retainedNetwork.name]),
  };
}

async function captureReceipt(fixture: OrphansFixture, name: string) {
  const file = join(fixture.directory, `${name}-receipt.json`);
  const info = await stat(file);
  expect(info.mode & 0o777).toBe(0o600);
  expect(info.uid).toBe(process.getuid?.());
  const raw = await readFile(file, 'utf8');
  expect(raw).not.toContain(fixture.session.cookie);
  expect(raw).not.toContain(fixture.session['x-csrf-token']);
  await writeFile(join(EVIDENCE, `${name}-receipt.json`), raw, { mode: 0o600 });
  return JSON.parse(raw) as CleanupOutput;
}

it('simula sin efectos, retira y purga un canario por la API y conserva referencias y recursos de Praxis', async () => {
  const evidence: Record<string, unknown> = { owner: OWNER, prefix: PREFIX, provider: 'existing synthetic CLI', sdk: 'real' };
  let fixture: OrphansFixture | undefined;
  try {
    fixture = await startOrphansFixture();
    const current = fixture;
    evidence.reply_before = await liveReply(current);
    const retire = await agentPlan(current, 'retire');
    retire.items.push(
      { id: 'live-container', kind: 'resource', resource_type: 'container', name: current.liveContainer,
        reason: 'Referenced by the active fixture agent', scope: { company_id: current.company, tenant_id: current.tenant, host_id: current.host } },
      { id: 'live-state', kind: 'resource', resource_type: 'volume', name: `${current.liveContainer}-state`,
        reason: 'State of the active fixture agent', scope: { company_id: current.company, tenant_id: current.tenant } },
      { id: 'praxis-state', kind: 'resource', resource_type: 'volume', name: current.retainedVolume,
        reason: 'Synthetic equivalent of a retained real-agent state volume', scope: { company_id: 'Praxis', tenant_id: 'Hospital', host_id: 'server2-praxis' } },
      { id: 'network', kind: 'resource', resource_type: 'network', name: current.retainedNetwork.name,
        reason: 'No canonical cleanup route is authorized', scope: { company_id: current.company } },
    );
    const before = await operationalState(current);
    const offline = output(await runCleanup(current, retire, 'offline', undefined, false));
    expect(offline.status).toBe('offline_unvalidated');
    expect(offline.items.find(item => item.id === 'native-retire')?.reason_code).toBe('offline_unvalidated');
    expect(await operationalState(current)).toEqual(before);
    const simulated = output(await runCleanup(current, retire, 'retire-simulation'));
    expect(simulated.status).toBe('simulated');
    expect(simulated.external_mutations).toBe(false);
    expect(simulated.items.find(item => item.id === 'native-retire')).toMatchObject({ status: 'would_enqueue', reason_code: 'ready' });
    expect(simulated.items.find(item => item.id === 'live-container')).toMatchObject({ status: 'retained', reason_code: 'no_canonical_cleanup' });
    expect(simulated.items.find(item => item.id === 'live-state')).toMatchObject({ status: 'retained', reason_code: 'volume_retained' });
    expect(simulated.items.find(item => item.id === 'praxis-state')).toMatchObject({ status: 'retained', reason_code: 'praxis_inventory_only' });
    expect(simulated.items.find(item => item.id === 'network')).toMatchObject({ status: 'retained', reason_code: 'no_canonical_cleanup' });
    expect(await operationalState(current)).toEqual(before);
    evidence.default_simulation = simulated;
    await captureReceipt(current, 'retire-simulation');
    const noAuthority = output(await runCleanup(current, retire, 'without-authority', '--aplicar', false), 1);
    expect(noAuthority.status).toBe('blocked');
    expect(await operationalState(current)).toEqual(before);
    evidence.apply_without_authority_rejected = noAuthority;
    const holdOnly: OrphansPlan = { ...retire, items: retire.items.filter(item => item.kind === 'resource') };
    const held = output(await runCleanup(current, holdOnly, 'retained-only', '--aplicar'));
    expect(held.status).toBe('retained');
    expect(held.external_mutations).toBe(false);
    expect(held.items.every(item => item.status === 'retained')).toBe(true);
    expect(await operationalState(current)).toEqual(before);
    evidence.retained_only = held;
    await captureReceipt(current, 'retained-only');
    const changedPin: OrphansPlan = structuredClone(retire);
    const changedItem = changedPin.items[0];
    if (changedItem?.kind !== 'agent') throw new Error('native retirement plan item absent');
    changedItem.preview_sha256 = 'f'.repeat(64);
    const rejected = output(await runCleanup(current, changedPin, 'changed-pin', '--aplicar'), 1);
    expect(rejected.items.find(item => item.id === 'native-retire')?.reason_code).toBe('preview_changed');
    expect(await operationalState(current)).toEqual(before);
    evidence.changed_pin_rejected = rejected;
    await captureReceipt(current, 'changed-pin');
    const accepted = output(await runCleanup(current, retire, 'retire-apply', '--aplicar'));
    const operation = accepted.items.find(item => item.id === 'native-retire')?.operation;
    if (!operation) throw new Error('canonical retirement operation absent');
    evidence.retire = await waitOperation(current, operation.id);
    const afterRetire = await nativeObservation(current);
    expect(afterRetire.properties.ActiveState).toBe('inactive');
    expect(Object.values(afterRetire.paths).every(Boolean)).toBe(true);
    const retiredAgent = (await current.computer.pool.query<{ enabled: boolean; retired: boolean }>(
      'SELECT enabled,retired_at IS NOT NULL AS retired FROM agents WHERE tenant_id=$1 AND alias=$2', [current.tenant, NATIVE_ALIAS])).rows[0];
    expect(retiredAgent).toEqual({ enabled: false, retired: true });
    const countAfterRetire = (await current.computer.pool.query('SELECT id FROM fleet_operations')).rowCount;
    const retireAgain = output(await runCleanup(current, retire, 'retire-apply', '--aplicar'));
    expect(retireAgain.items.find(item => item.id === 'native-retire')).toMatchObject({ status: 'succeeded', operation: { id: operation.id } });
    expect((await current.computer.pool.query('SELECT id FROM fleet_operations')).rowCount).toBe(countAfterRetire);
    evidence.retire_idempotent = retireAgain;
    await captureReceipt(current, 'retire-apply');
    const purge = await agentPlan(current, 'purge');
    const purging = output(await runCleanup(current, purge, 'purge-apply', '--aplicar'));
    const purgeOperation = purging.items.find(item => item.id === 'native-purge')?.operation;
    if (!purgeOperation) throw new Error('canonical purge operation absent');
    evidence.purge = await waitOperation(current, purgeOperation.id);
    const afterPurge = await nativeObservation(current);
    expect(afterPurge.properties.LoadState).toBe('not-found');
    expect(Object.values(afterPurge.paths).every(value => !value)).toBe(true);
    expect(afterPurge.enabled_link).toBe(false);
    const purged = (await current.computer.pool.query<{ purged: boolean }>(
      'SELECT purged_at IS NOT NULL AS purged FROM agents WHERE tenant_id=$1 AND alias=$2', [current.tenant, NATIVE_ALIAS])).rows[0];
    expect(purged).toEqual({ purged: true });
    const countAfterPurge = (await current.computer.pool.query('SELECT id FROM fleet_operations')).rowCount;
    const purgeAgain = output(await runCleanup(current, purge, 'purge-apply', '--aplicar'));
    expect(purgeAgain.items.find(item => item.id === 'native-purge')).toMatchObject({ status: 'succeeded', operation: { id: purgeOperation.id } });
    expect((await current.computer.pool.query('SELECT id FROM fleet_operations')).rowCount).toBe(countAfterPurge);
    evidence.purge_idempotent = purgeAgain;
    await captureReceipt(current, 'purge-apply');
    expect(await docker(['inspect', '--format', '{{.Id}} {{.State.Running}}', current.liveContainer])).toBe(before.live);
    expect(await docker(['volume', 'inspect', '--format', '{{json .Labels}}', current.retainedVolume])).toBe(before.volume);
    expect(await docker(['network', 'inspect', '--format', '{{.Id}}', current.retainedNetwork.name])).toBe(before.network);
    expect((await current.computer.pool.query<{ enabled: boolean }>('SELECT enabled FROM agents WHERE tenant_id=$1 AND alias=$2',
      [current.tenant, LIVE_ALIAS])).rows[0]?.enabled).toBe(true);
    evidence.reply_after = await liveReply(current);
    evidence.native_after = afterPurge;
    evidence.retained = { container: current.liveContainer, volume: current.retainedVolume, network: current.retainedNetwork };
    evidence.sources = Object.fromEntries(await Promise.all(['limpiar-huerfanos.sh', 'limpiar-huerfanos-driver.py'].map(async name =>
      [name, createHash('sha256').update(await readFile(join(process.cwd(), '.delegados/v4', name))).digest('hex')] as const)));
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    try { await fixture?.close(); }
    finally { await writeFile(join(EVIDENCE, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 }); }
  }
}, 1_200_000);
