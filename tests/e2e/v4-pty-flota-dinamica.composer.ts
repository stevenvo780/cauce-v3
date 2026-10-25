import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect } from 'vitest';
import { released } from './v4-pty-flota-dinamica.client.js';
import { observePtyFleet, ptyFleetAlias, ptyFleetRuntimeKey } from './v4-pty-flota-dinamica.flow.js';
import { ptyFleetReceipt, type PtyFleetFixture } from './v4-pty-flota-dinamica.helpers.js';

const modules = ['cauce_container_base', 'cauce_container_proc', 'cauce_container_restart'];

export async function capturePtyFleetComposer(fixture: PtyFleetFixture): Promise<void> {
  await released(fixture);
  const physical = await observePtyFleet(fixture);
  expect(physical.sdk.normal_process_count).toBe(1); expect(physical.sdk.metadata_matches).toBe(true);
  const { container_id: containerId, metadata } = physical.sdk;
  if (!containerId || !metadata) throw new Error('the restart guard has no observed normal runtime');
  const row = (await fixture.computer.pool.query<{ state_directory: string }>(
    'SELECT state_directory FROM agents WHERE tenant_id=$1 AND alias=$2', [fixture.tenantId, ptyFleetAlias])).rows[0];
  if (!row) throw new Error('the restart guard has no durable placement');
  const format = '{{.Id}}|{{.State.Running}}|{{.State.Paused}}|{{.State.Pid}}|{{.State.StartedAt}}'
    + '|{{index .Config.Labels "cauce.fleet.runtime_key"}}|{{index .Config.Labels "cauce.fleet.alias"}}';
  const inspect = async () => {
    const result = await fixture.computer.onComputer(['docker', 'inspect', '--format', format, containerId]);
    expect(result.code).toBe(0);
    return result.stdout.trim();
  };
  const before = await inspect(), fields = before.split('|');
  expect(fields).toHaveLength(7);
  expect(fields.slice(0, 3)).toEqual([containerId, 'true', 'false']);
  expect(fields.slice(5)).toEqual([ptyFleetRuntimeKey, ptyFleetAlias]);
  if (!fields[3] || !/^[1-9][0-9]*$/u.test(fields[3]) || !fields[4]) throw new Error('the restart guard container is not running');
  const generation = createHash('sha256').update(containerId + '\0' + fields[4]).digest('hex');
  const sources = Object.fromEntries<string>(await Promise.all(modules.map(async name => [name,
    createHash('sha256').update(await readFile('ops/container-runtime/' + name + '.py')).digest('hex')] as const)));
  const expected = { alias: ptyFleetRuntimeKey, wireAlias: ptyFleetAlias, tenantId: fixture.tenantId,
    containerId, containerGeneration: generation, stateDirectory: row.state_directory,
    controlDirectory: '/run/cauce-fleet/' + ptyFleetRuntimeKey, phase: 'running', pid: metadata.pid, starttime: metadata.starttime };
  const script = await readFile('tests/e2e/v4-pty-flota-dinamica.composer.py', 'utf8');
  const result = await fixture.computer.onComputer(['docker', 'exec', '-i', '-w', '/', '--user', '0', containerId,
    'python3', '-I', '-B', '-c', script], JSON.stringify({ expected, sources }));
  if (result.stdout.length > 65536) throw new Error('the restart guard observation exceeds its bound');
  const observed = JSON.parse(result.stdout) as unknown;
  await ptyFleetReceipt('before-stop-composer', { exit_code: result.code, container_id: containerId, generation,
    pid: metadata.pid, starttime: metadata.starttime, observation: observed });
  expect(result.code, 'the read only restart guard could not be observed').toBe(0);
  expect(await inspect(), 'the container changed during the restart guard observation').toBe(before);
  expect(observed).toEqual({ source_pins: sources, metadata_stable: true, clients_before: 0, clients_after: 0,
    composer: { prompt_known: true, previous_line_blank: true, dim_placeholder: true, cursor_at_start: true },
    guard_code: null, canonical_guard_accepted: true });
  await released(fixture);
}
