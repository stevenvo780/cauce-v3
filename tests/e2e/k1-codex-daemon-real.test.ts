import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import { k1Receipt, startK1CodexRuntime } from './k1-codex-runtime.js';
import { captureK1Mismatch, configureK1Daemon, k1DaemonIdentity, probeK1Daemon, type K1DaemonIdentity } from './k1-codex-daemon.js';
import { observeK1NativeSession, startK1Adapter, startK1Gateway, stopK1Adapter } from './k1-codex-infra.js';
import { startK1CodexResponses } from './k1-codex-responses.js';
import { browserErrorStderr } from './browser-owned-lifecycle.js';

let runtime: Awaited<ReturnType<typeof startK1CodexRuntime>> | undefined;
let responses: Awaited<ReturnType<typeof startK1CodexResponses>> | undefined;
let gateway: Awaited<ReturnType<typeof startK1Gateway>> | undefined;
let pins: Awaited<ReturnType<typeof configureK1Daemon>> | undefined;
let daemon: K1DaemonIdentity | undefined;
let adapterStarted = false;
let baselineConfirmed = false;
function active() { if (!runtime) throw new Error('K1 runtime is unavailable'); return runtime; }

beforeAll(async () => { runtime = await startK1CodexRuntime(); }, 360_000);
afterAll(async () => {
  try {
    if (runtime && adapterStarted) await stopK1Adapter(runtime);
  } finally {
    try { await gateway?.close(); }
    finally { try { await responses?.close(); } finally { await runtime?.close(); } }
  }
}, 120_000);

describe.sequential('real Codex daemon compatibility', () => {
  it('records the pinned binary help and shared-daemon opt-out for both supported releases', async () => {
    for (const [version, command] of [['0.160.1', '/usr/local/share/k1-compat/node_modules/.bin/codex'],
      ['0.164.0', '/usr/local/bin/codex']] as const) {
      const actual = (await active().exec([command, '--version'])).stdout.trim();
      expect(actual).toBe(`codex-cli ${version}`);
      await k1Receipt(`codex-${version}-version.txt`, `${actual}\n`);
      const help = (await active().exec([command, '--help'])).stdout;
      await k1Receipt(`codex-${version}-help.txt`, help);
      expect(help).toContain('--no-daemon');
      const appServerHelp = (await active().exec([command, 'app-server', '--help'])).stdout;
      await k1Receipt(`codex-${version}-app-server-help.txt`, appServerHelp);
    }
  }, 60_000);

  it('captures the incompatible daemon dialogue without selecting an action', async () => {
    let stage = 'configure_daemon';
    try {
      responses = await startK1CodexResponses();
      pins = await configureK1Daemon(active(), responses.url);
      stage = 'observe_daemon';
      daemon = await k1DaemonIdentity(active());
      expect(daemon.socket_present).toBe(true);
      stage = 'initialize_daemon';
      expect(await probeK1Daemon(active())).toBe(true);
      stage = 'capture_baseline';
      const captured = await captureK1Mismatch(active(), pins.command);
      expect(captured).toContain('Background server has incompatible feature settings');
      expect(captured).toContain('This session requires api_key_model_discovery to be disabled');
      expect(captured).toContain('1. Run without daemon this time');
      expect(captured).toContain('2. Restart with these settings');
      expect(captured).toContain('3. Cancel');
      stage = 'verify_daemon_unchanged';
      expect(await k1DaemonIdentity(active())).toEqual(daemon);
      await k1Receipt('baseline.json', { exact_dialog_observed: true, selected_action: null, daemon });
      baselineConfirmed = true;
    } catch (error) {
      await k1Receipt('baseline-setup-error.json', { stage, stderr: browserErrorStderr(error).slice(-8_192) });
      throw new Error(`the owned Codex baseline failed at ${stage}`);
    }
  }, 90_000);

  it('restarts the real SDK, preserves its healthy TUI, then resumes a newly launched TUI and completes durable deliveries', async () => {
    if (!baselineConfirmed || !pins || !daemon || !responses) throw new Error('the incompatible daemon baseline is required');
    onTestFailed(async () => {
      const diagnostic = await active().exec(['python3', '-I', '-B', '-c', `import json,pathlib,re
path=pathlib.Path('/home/node/.cauce/adapter.log');text=path.read_text(errors='replace') if path.exists() else ''
codes=[code for code in ['SHARED_TUI_UNAVAILABLE','ADAPTER_FATAL','LEASE_CONFLICT','ENOENT','EACCES','ERR_MODULE_NOT_FOUND'] if code in text]
events=[]
for line in text.splitlines():
 try:row=json.loads(line)
 except ValueError:continue
 if row.get('event') in {'shared_session_pending','shared_session_degraded'}:
  events.append({'event':row['event'],'reason':row.get('reason') if row.get('reason') in {'tui_starting','session_identity_unverified','tui_absent','session_absent','provider_login_required','startup_cancelled'} else 'unrecognized'})
print(json.dumps({'log_present':path.exists(),'codes':codes,'events':events[-20:]}))`])
        .then(value => JSON.parse(value.stdout) as unknown, () => ({ diagnostic_available: false }));
      await k1Receipt('sdk-failure.json', diagnostic);
      const pane = await active().tmux(['capture-pane', '-p', '-J', '-S', '-100', '-t', `cauce-${gateway?.alias ?? ''}:agente`])
        .then(value => value.stdout, () => 'owned SDK pane unavailable');
      await k1Receipt('sdk-failure-pane.txt', pane);
    });
    gateway = await startK1Gateway();
    const current = gateway;
    let native: string | undefined;
    let initialPane = '';
    for (const phase of ['new_launch', 'adapter_restart_reuse', 'adapter_restart_after_owned_tui_close'] as const) {
      if (adapterStarted) {
        await stopK1Adapter(active()); adapterStarted = false;
        await expect.poll(async () => (await current.pool.query(
          'SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND lease_until>now()', ['Steven', current.alias])).rowCount,
        { timeout: 15_000 }).toBe(0);
        if (phase === 'adapter_restart_after_owned_tui_close') {
          await active().tmux(['kill-session', '-t', `cauce-${current.alias}`]);
        }
      }
      await startK1Adapter(active(), current, pins); adapterStarted = true;
      await expect.poll(async () => (await current.pool.query(
        'SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND lease_until>now()', ['Steven', current.alias])).rowCount,
      { timeout: 60_000, interval: 250 }).toBe(1);
      const pane = (await active().tmux(['display-message', '-p', '-t', `cauce-${current.alias}:agente`,
        '#{session_id}|#{pane_id}|#{pane_pid}|#{pane_start_command}'])).stdout.trim();
      expect(pane).toContain('--no-daemon');
      if (phase === 'new_launch') initialPane = pane;
      if (phase === 'adapter_restart_reuse') expect(pane).toBe(initialPane);
      if (phase === 'adapter_restart_after_owned_tui_close') expect(pane).not.toBe(initialPane);
      const capture = (await active().tmux(['capture-pane', '-p', '-J', '-S', '-100', '-t', `cauce-${current.alias}:agente`])).stdout;
      expect(capture).not.toContain('Background server has incompatible feature settings');
      await k1Receipt(`${phase}-ready.txt`, capture);
      const published = await fetch(`${current.url}/v3/messages`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cauce-tenant': 'Steven', 'x-cauce-alias': current.sender },
        body: JSON.stringify({ room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: current.alias }],
          body: { type: 'text', text: `K1 owned synthetic delivery ${phase}` }, idempotency_key: randomUUID() }) });
      expect(published.status).toBe(202);
      const delivery = await published.json() as { delivery_ids: string[] };
      const deliveryId = delivery.delivery_ids[0];
      expect(deliveryId).toMatch(/^[a-f0-9-]{36}$/u);
      let observed: { status: string; reply: string | null } | undefined;
      await expect.poll(async () => {
        observed = (await current.pool.query<{ status: string; reply: string | null }>(
          "SELECT status,result->'output'->>'reply' AS reply FROM deliveries WHERE id=$1", [deliveryId])).rows[0];
        return observed?.status;
      }, { timeout: 90_000, interval: 250 }).toBe('done');
      expect(observed?.reply).toBe('K1_DELIVERED');
      const acknowledgements = (await current.pool.query<{
        status: string; applied: boolean; native_id: string | null; native_turn_id: string | null;
      }>(`SELECT status,applied,payload->'result'->'harness_consumption_v1'->>'native_session_id' AS native_id,
        payload->'result'->'harness_consumption_v1'->>'native_turn_id' AS native_turn_id
        FROM delivery_acks WHERE delivery_id=$1 ORDER BY id`, [deliveryId])).rows;
      const done = acknowledgements.find(row => row.status === 'done' && row.applied);
      expect(done).toBeDefined();
      const actualNative = await observeK1NativeSession(active());
      expect(actualNative).toMatch(/^[a-f0-9-]{36}$/u);
      if (native === undefined) native = actualNative;
      else expect(actualNative).toBe(native);
      expect(done?.native_id).toBe(native);
      expect(done?.native_turn_id).toMatch(/^[a-f0-9-]{36}$/u);
      expect(await k1DaemonIdentity(active())).toEqual(daemon);
      expect(await probeK1Daemon(active())).toBe(true);
      await k1Receipt(`${phase}.json`, { delivery_id: deliveryId, ...observed, acknowledgements,
        native_id: native, pane, daemon_unchanged: true, daemon_initialize_ok: true, provider_requests: responses.requestCount() });
    }
  }, 300_000);
});
