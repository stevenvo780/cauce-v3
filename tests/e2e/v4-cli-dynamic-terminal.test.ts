import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { decodeTerminalSubject } from '../../services/gateway/src/terminal/authority-continuity.js';
import { runDynamicCli, startDynamicTerminalFixture } from './v4-cli-dynamic-terminal.fixtures.js';

describe.sequential('dynamic terminal CLI with real Python PTY', () => {
it('opens a dynamically registered real Python PTY with cauce login and rejects missing authority', async () => {
  const active = await startDynamicTerminalFixture();
  try {
    expect(active.alias).toMatch(/^zz-canary-/u);
    const nonce = randomUUID();
    const result = await runDynamicCli([active.alias], active.sessionFile,
      `printf 'CLI_%s\\n' '${nonce}'; printf 'UID:%s\\n' "$(id -u)"; printf 'HOME:%s\\n' "$HOME"; exit\n`);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`(?:^|[\\r\\n])CLI_${nonce}\\r?\\n`, 'u'));
    expect(result.stdout).toContain(`UID:${String(active.runtimeUid)}`);
    expect(result.stdout).toContain(`HOME:${active.home}`);
    expect(active.paths).toContain('POST /v3/auth/login');
    expect(active.paths).toContain('GET /v3/console/terminal/targets');
    expect(active.paths).toContain('POST /v3/console/terminal/sessions');
    expect(active.paths.some(path => /^WS \/v3\/console\/terminal\/relays\/[0-9a-f]{64}\/ws$/u.test(path))).toBe(true);
    const durable = await active.database.pool.query<{ console_subject: string; consumed_at: Date | null; operator_id: string }>(
      'SELECT console_subject,consumed_at,operator_id FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2', [active.tenant, active.alias]);
    expect(durable.rows).toHaveLength(1);
    expect(durable.rows[0]?.operator_id).toBe(active.email);
    expect(durable.rows[0]?.consumed_at).toBeInstanceOf(Date);
    expect(decodeTerminalSubject(durable.rows[0]?.console_subject ?? '').kind).toBe('human');

    const missing = await runDynamicCli([active.alias, '--tenant', active.tenant, '--mode', 'shell'], join(active.directory, 'absent-session.json'));
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('cauce login');
    expect(missing.stdout).not.toContain(`CLI_${nonce}`);
    await active.denyTarget();
    const denied = await runDynamicCli([active.alias, '--tenant', active.tenant, '--mode', 'shell'], active.sessionFile);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain('no autoriza esta terminal');
    expect(denied.stdout).not.toContain(`CLI_${nonce}`);
    const count = await active.database.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM terminal_sessions WHERE alias=$1', [active.alias]);
    expect(count.rows[0]?.count).toBe('1');
    for (const secret of active.secrets) {
      expect(active.loginOutput + result.stdout + result.stderr + missing.stdout + missing.stderr + denied.stdout + denied.stderr).not.toContain(secret);
    }
    process.stdout.write(`V4_CLI_REAL_PTY ${JSON.stringify({ alias: active.alias, database_container: active.database.container.getId(),
      runtime_uid: active.runtimeUid, shell_output: true, nominal_human: true, missing_session_rejected: true, target_permission_rejected: true })}\n`);
  } finally { await active.close(); }
}, 180_000);

it('defaults to the writable shared tmux TUI and releases its control without closing the shared shell', async () => {
  const active = await startDynamicTerminalFixture({ tui: true });
  try {
    const nonce = randomUUID();
    const marker = `TMUX_${nonce}`;
    const result = await runDynamicCli([active.alias], active.sessionFile,
      `printf 'TMUX_%s\\n' '${nonce}'\r`, marker);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(marker);
    expect(await active.tmuxSessionExists()).toBe(true);
    expect(await active.captureTmux()).toContain(marker);
    const sessions = await active.database.pool.query<{ id: string; mode: string; revoked_at: Date | null; closed_at: Date | null; console_subject: string }>(
      'SELECT id,mode,revoked_at,closed_at,console_subject FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2', [active.tenant, active.alias]);
    expect(sessions.rows).toHaveLength(1);
    const session = sessions.rows[0];
    expect(session?.mode).toBe('harness_rw');
    expect(session?.revoked_at ?? session?.closed_at).toBeInstanceOf(Date);
    expect(decodeTerminalSubject(session?.console_subject ?? '').kind).toBe('human');
    const holds = await active.database.pool.query<{ taken_at: Date; released_at: Date | null; released_reason: string | null }>(
      'SELECT taken_at,released_at,released_reason FROM terminal_control_holds WHERE session_id=$1', [session?.id]);
    expect(holds.rows).toHaveLength(1);
    expect(holds.rows[0]?.taken_at).toBeInstanceOf(Date);
    expect(holds.rows[0]?.released_at).toBeInstanceOf(Date);
    expect(holds.rows[0]?.released_reason).toBeTruthy();
    expect(active.paths).toContain(`POST /v3/console/terminal/sessions/${session?.id ?? ''}/control`);
    expect(active.paths).toContain(`DELETE /v3/console/terminal/sessions/${session?.id ?? ''}`);
    const recordings = await readdir(active.recordingDirectory);
    expect(recordings).toContain(`${session?.id ?? ''}.cast`);
    const recording = await readFile(join(active.recordingDirectory, `${session?.id ?? ''}.cast`), 'utf8');
    expect(recording).toContain(nonce);
    const forbiddenInput = `VIEWER_${randomUUID()}`;
    const viewer = await runDynamicCli([active.alias, 'ver', '--session-file', active.sessionFile], undefined,
      `printf '${forbiddenInput}\\n'\r`, marker);
    expect(viewer.code, viewer.stderr).toBe(0);
    expect(viewer.stdout).toContain(marker);
    expect(await active.captureTmux()).not.toContain(forbiddenInput);
    const viewerSessions = await active.database.pool.query<{ mode: string; closed_at: Date | null; revoked_at: Date | null }>(
      'SELECT mode,closed_at,revoked_at FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2 ORDER BY issued_at', [active.tenant, active.alias]);
    expect(viewerSessions.rows.map(row => row.mode)).toEqual(['harness_rw', 'harness']);
    expect(viewerSessions.rows[1]?.closed_at ?? viewerSessions.rows[1]?.revoked_at).toBeInstanceOf(Date);
    const viewerControl = await active.database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM terminal_control_holds WHERE session_id IN
        (SELECT id FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2 AND mode='harness')`, [active.tenant, active.alias]);
    expect(viewerControl.rows[0]?.count).toBe('0');
    const incompatible = await runDynamicCli([active.alias, 'ver', '--mode', 'shell'], active.sessionFile);
    expect(incompatible.code).toBe(1);
    expect(incompatible.stderr).toContain('sin tomar el control');
    for (const secret of active.secrets) expect(result.stdout + result.stderr + recording + viewer.stdout + viewer.stderr).not.toContain(secret);
    process.stdout.write(`V4_CLI_REAL_TMUX_TUI ${JSON.stringify({ alias: active.alias, database_container: active.database.container.getId(),
      runtime_uid: active.runtimeUid, mode: session?.mode, shared_shell_survives: true, control_released: true, recorded: true })}\n`);
  } finally { await active.close(); }
}, 180_000);

it('resolves the current placement after the same alias moves into a real destination container', async () => {
  const active = await startDynamicTerminalFixture();
  try {
    const origin = await runDynamicCli([active.alias], active.sessionFile, "printf 'ORIGIN_READY\\n'; exit\n");
    expect(origin.code, origin.stderr).toBe(0);
    const destination = await active.relocate();
    const nonce = randomUUID();
    const moved = await runDynamicCli([`${active.tenant}/${active.alias}`], active.sessionFile,
      `printf 'MOVED_%s\\n' '${nonce}'; pwd; exit\n`);
    expect(moved.code, moved.stderr).toBe(0);
    expect(moved.stdout).toContain(`MOVED_${nonce}`);
    expect(moved.stdout).toContain(destination.home);
    const sessions = await active.database.pool.query<{ container: string; generation: string }>(
      'SELECT container,generation FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2 ORDER BY issued_at', [active.tenant, active.alias]);
    expect(sessions.rows).toHaveLength(2);
    expect(sessions.rows[0]?.container).not.toBe(destination.container);
    expect(sessions.rows[1]).toEqual({ container: destination.container, generation: destination.generation });
    const placement = await active.database.pool.query<{ host_id: string }>('SELECT host_id FROM agents WHERE tenant_id=$1 AND alias=$2',
      [active.tenant, active.alias]);
    expect(placement.rows[0]?.host_id).toBe(destination.host);
    for (const secret of active.secrets) expect(moved.stdout + moved.stderr).not.toContain(secret);
    process.stdout.write(`V4_CLI_RELOCATED ${JSON.stringify({ alias: active.alias, container: destination.container,
      host: destination.host, database_container: active.database.container.getId(), current_generation: true, destination_nonce: true })}\n`);
  } finally { await active.close(); }
}, 180_000);
});
