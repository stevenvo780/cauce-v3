import { initialDeadlineFactor } from './v4-contexto-aplicacion-segura-real.environment.js';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireDockerLab } from '../integration/b2-lab.js';
import { browserDocker } from './browser-owned-lifecycle.js';
import { isaTenant, startContextFixture, waitForLease } from './context-multiuser-continuity.fixtures.js';
import { fireUserTimer, guardArtifacts, prepareGuardRuntime } from './b2-guards-runtime.helpers.js';
import { verifyRealBackups } from './b2-backups-real.helpers.js';

const evidence = join(process.cwd(), '.delegados/v4/recibos/b2-barrido-servicios-1025/guards');
let fixture: Awaited<ReturnType<typeof startContextFixture>> | undefined;
let runtime: Awaited<ReturnType<typeof prepareGuardRuntime>> | undefined;
const active = () => { if (!runtime) throw new Error('owned guard runtime absent'); return runtime; };
const service = `cauce-v3-container-${isaTenant.target}.service`;
async function state() { return (await active().user(['systemctl', '--user', 'show', '--property=ActiveState', '--value', service])).stdout.trim(); }
async function panel(): Promise<{ present: boolean; session?: string; pid?: number }> {
  try {
    const status = JSON.parse((await active().helper('status')).stdout) as { present: boolean; session: string; pid?: string };
    expect(status.session).toBe(active().session);
    return { present: status.present, session: status.session, ...(status.pid === undefined ? {} : { pid: Number(status.pid) }) };
  }
  catch { return { present: false }; }
}
async function identity(window = 'agente') {
  return (await browserDocker(['exec', '--user', 'node', active().agent, 'tmux', '-L', 'cauce', 'display-message', '-p',
    '-t', `${active().session}:${window}`, '#{session_id}:#{pane_id}:#{pane_pid}'])).stdout.trim();
}

beforeAll(async () => {
  await requireDockerLab();
  await guardArtifacts(evidence);
  fixture = await startContextFixture();
  runtime = await prepareGuardRuntime(fixture, evidence);
}, 600_000);
afterAll(async () => {
  const errors: unknown[] = [];
  try {
    if (runtime) {
      const log = await runtime.execute(['journalctl', '--no-pager', '_UID=1000',
        '_SYSTEMD_USER_UNIT=cauce-v3-panel-guard.service', '_SYSTEMD_USER_UNIT=cauce-attach-guard.service']);
      await writeFile(join(evidence, 'journal.log'), log.stdout + log.stderr, { mode: 0o600 });
    }
  } catch (error) { errors.push(error); }
  try { await runtime?.close(); } catch (error) { errors.push(error); }
  try { await fixture?.close(); } catch (error) { errors.push(error); }
  if (initialDeadlineFactor === undefined) delete process.env.CAUCE_PLAZOS_FACTOR;
  else process.env.CAUCE_PLAZOS_FACTOR = initialDeadlineFactor;
  if (errors.length) throw new AggregateError(errors, 'owned guard fixture cleanup incomplete');
}, 180_000);

describe('guardias ejecutados por systemd y tmux reales en docker-lab', () => {
  it('el timer repone un panel ausente, conserva el panel vivo y no mata una sesión sin TUI', async () => {
    if (!fixture) throw new Error('owned gateway fixture absent');
    await waitForLease(fixture, isaTenant);
    expect(await state()).toBe('active');
    expect(await panel()).toMatchObject({ present: false });
    await fireUserTimer(active(), 'cauce-v3-panel-guard');
    await expect.poll(async () => (await panel()).pid, { timeout: 45_000 }).toBeGreaterThan(0);
    const firstIdentity = await identity();
    expect(firstIdentity).toMatch(/^\$\d+:%\d+:\d+$/u);
    expect(Number(firstIdentity.split(':')[2])).toBe((await panel()).pid);
    const trigger = await active().user(['systemctl', '--user', 'show', '--property=LastTriggerUSec', '--value', 'cauce-v3-panel-guard.timer']);
    expect(trigger.stdout.trim()).not.toBe('');
    await fireUserTimer(active(), 'cauce-v3-panel-guard');
    await expect.poll(identity, { timeout: 5_000 }).toBe(firstIdentity);
    expect((await panel()).pid).toBe(Number(firstIdentity.split(':')[2]));
    const sessions = (await browserDocker(['exec', '--user', 'node', active().agent, 'tmux', '-L', 'cauce', 'list-sessions',
      '-F', '#{session_id}:#{session_name}'])).stdout;
    const windows = (await browserDocker(['exec', '--user', 'node', active().agent, 'tmux', '-L', 'cauce', 'list-windows', '-a',
      '-F', '#{session_name}:#{window_name}:#{pane_id}:#{pane_pid}:#{pane_current_command}:#{pane_dead}'])).stdout;
    await writeFile(join(evidence, 'panel-before-negative.json'), JSON.stringify({ session: active().session,
      firstIdentity, panel: await panel(), sessions, windows }, null, 2), { mode: 0o600 });
    await browserDocker(['exec', '--user', 'node', active().agent, 'tmux', '-L', 'cauce', 'new-window',
      '-t', `${active().session}:`, '-n', 'manual', '/bin/bash']);
    await browserDocker(['exec', '--user', 'node', active().agent, 'tmux', '-L', 'cauce', 'kill-window',
      '-t', `${active().session}:agente`]);
    expect(await panel()).toEqual({ present: true, session: active().session });
    const idleIdentity = await identity('manual');
    expect(idleIdentity).toMatch(/^\$\d+:%\d+:\d+$/u);
    await fireUserTimer(active(), 'cauce-v3-panel-guard');
    await expect.poll(async () => (await active().execute(['cat', '/home/node/.local/state/cauce-attach/guard.log'])).stdout,
      { timeout: 10_000 }).toContain('tui_absent');
    expect(await identity('manual')).toBe(idleIdentity);
    await writeFile(join(evidence, 'panel.json'), JSON.stringify({ firstIdentity, idleIdentity, timer_trigger: trigger.stdout.trim(),
      service: await state(), panel: await panel(), actual_provider_turn: false }, null, 2), { mode: 0o600 });
  }, 90_000);

  it('el timer restaura el adaptador tras un attach huérfano y respeta una parada sin marcador', async () => {
    const current = active();
    await current.user(['systemctl', '--user', 'stop', service]);
    expect(await state()).toBe('inactive');
    const marker = `/home/node/.local/state/cauce-attach/${isaTenant.target}.json`;
    await current.user(['python3', '-c', 'import json,pathlib,sys,time;pathlib.Path(sys.argv[1]).write_text(json.dumps({"alias":sys.argv[2],"unit":sys.argv[3],"attach_pid":2147483647,"started_at":int(time.time())-10}))', marker, isaTenant.target, service]);
    await fireUserTimer(current, 'cauce-attach-guard');
    await expect.poll(state, { timeout: 20_000 }).toBe('active');
    if (!fixture) throw new Error('owned gateway fixture absent');
    await waitForLease(fixture, isaTenant);
    await expect.poll(async () => (await current.user(['python3', '-c', 'import pathlib,sys;print(pathlib.Path(sys.argv[1]).exists())', marker])).stdout.trim(),
      { timeout: 10_000 }).toBe('False');
    const restored = (await current.execute(['cat', '/home/node/.local/state/cauce-attach/guard.log'])).stdout;
    expect(restored).toContain('RESTAURADO');
    await current.user(['systemctl', '--user', 'stop', service]);
    await fireUserTimer(current, 'cauce-attach-guard');
    await expect.poll(async () => (await current.execute(['cat', '/home/node/.local/state/cauce-attach/guard.log'])).stdout,
      { timeout: 10_000 }).toContain('SIN marcador de attach');
    expect(await state()).toBe('inactive');
    await writeFile(join(evidence, 'attach.json'), JSON.stringify({ restored, final_state: await state(),
      source_sha256: createHash('sha256').update(await readFile(join(process.cwd(), 'ops/guardias/cauce-attach-guard'))).digest('hex') }, null, 2), { mode: 0o600 });
  }, 90_000);

  it('el timer crea una copia PostgreSQL y blobs restaurable y el monitor detecta offsite ausente y corrupción', async () => {
    if (!fixture) throw new Error('owned gateway fixture absent');
    await verifyRealBackups(fixture, active(), evidence);
  }, 240_000);
});
