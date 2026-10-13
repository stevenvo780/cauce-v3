import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startRealPtyFixture } from './real-pty-agent.fixtures.js';
import { connectTerminalWire, type TerminalWireClient } from './terminal-authority-vertical.pty.js';
import { emitReceipt, execute, jsonLogLines, runCli, startCliDrill } from './v4-rupturas-terminal-cli.fixtures.js';

describe('V4 real terminal and CLI ruptures located using operator records', () => {
  it('locates a cut real Python PTY agent by its session chain and relay close log', async () => {
    const active = await startRealPtyFixture();
    let wire: TerminalWireClient | undefined;
    try {
      const human = await active.login();
      await active.waitForTarget(human.cookie);
      const opened = await active.request('/v3/console/terminal/sessions', {
        method: 'POST', headers: { cookie: human.cookie, 'x-csrf-token': human.csrf, origin: active.gatewayUrl },
        body: { tenant_id: active.tenant, alias: active.targetAlias, mode: 'shell', cols: 100, rows: 30,
          request_id: randomUUID(), owner_token: randomUUID() },
      });
      expect(opened.status).toBe(201);
      const grant = JSON.parse(opened.body) as { session_id: string; ticket: string; authority_proof: string };
      wire = await connectTerminalWire(active, { type: 'attach', session_id: grant.session_id,
        ticket: grant.ticket, authority_proof: grant.authority_proof, cols: 100, rows: 30 });
      await wire.waitControl(frame => frame.type === 'ready' && frame.session_id === grant.session_id);
      wire.sendInput("printf 'REAL_RUPTURE_PTY_READY\\n'\n");
      expect(await wire.waitOutput(text => text.includes('REAL_RUPTURE_PTY_READY'))).toContain('REAL_RUPTURE_PTY_READY');
      const owner = await execute('docker', ['inspect', '--format', '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}}', active.agentContainer]);
      expect(owner.stdout.trim()).toBe(`${active.agentContainerId} real-pty-agent`);
      await execute('docker', ['kill', '--signal=KILL', active.agentContainer]);
      expect(await wire.waitForClose()).toBe(4404);
      await expect.poll(() => jsonLogLines(active.relayLog()).some(row => row.event === 'terminal_relay_session_closed'
        && row.session_id === grant.session_id && row.reason === 'agent_disconnected'), { timeout: 15_000 }).toBe(true);
      await writeFile(join(active.directory, 'terminal-relay.log'), active.relayLog(), { mode: 0o600 });
      const filter = `select(.event == "terminal_relay_session_closed" and .session_id == "${grant.session_id}")`
        + ' | {event, session_id, reason, code, exit_code}';
      const found = await execute('jq', ['-c', filter, 'terminal-relay.log'], { cwd: active.directory });
      const cause = JSON.parse(found.stdout.trim()) as Record<string, unknown>;
      expect(cause).toMatchObject({ session_id: grant.session_id, reason: 'agent_disconnected', code: 4404 });
      let chain: Record<string, unknown> = {};
      await expect.poll(async () => {
        const response = await active.request(`/v3/console/diagnose/${grant.session_id}`, { headers: { cookie: human.cookie } });
        expect(response.status).toBe(200);
        chain = JSON.parse(response.body) as Record<string, unknown>;
        return (chain.items as Record<string, unknown>[]).some(item => item.type === 'session' && item.state === 'closed');
      }, { timeout: 15_000 }).toBe(true);
      const evidence = JSON.stringify({ cause, chain });
      for (const secret of [human.cookie, human.csrf, grant.ticket, grant.authority_proof]) expect(evidence).not.toContain(secret);
      emitReceipt({ kind: 'terminal_cut', id: grant.session_id, component: 'terminal-relay', cause: String(cause.reason),
        command: `jq -c '${filter}' terminal-relay.log`,
        operator_evidence: { close_log: cause, chain,
          diagnostic_query: { method: 'GET', path: `/v3/console/diagnose/${grant.session_id}` } } });
    } finally {
      try { if (wire?.socket.readyState === 1) await wire.close(); }
      finally { await active.close(); }
    }
  }, 300_000);

  it('locates a real cauce context CAS rejection by the gateway request log', async () => {
    const active = await startCliDrill();
    try {
      const accepted = await runCli(active.contextArgs);
      expect(accepted.code).toBe(0);
      const rejected = await runCli(active.contextArgs);
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toContain('context request rejected with HTTP 409');
      await expect.poll(async () => jsonLogLines(await active.logs()).some(row => row.event === 'console_request_rejected'
        && row.error_code === 'conflict'), { timeout: 10_000 }).toBe(true);
      const records = jsonLogLines(await active.logs());
      const refused = records.find(row => row.event === 'console_request_rejected' && row.error_code === 'conflict');
      if (!refused || typeof refused.reqId !== 'string' || typeof refused.pid !== 'number') {
        throw new Error('CLI rejection has no operator request identifier or process scope');
      }
      const id = refused.reqId;
      const filter = `select(.reqId == "${id}" and .pid == ${String(refused.pid)})`
        + ' | {time, pid, reqId, event, component, error_code, req, res, msg}';
      const found = await execute('jq', ['-c', filter, 'gateway.log'], { cwd: active.directory });
      const evidence = jsonLogLines(found.stdout);
      expect(evidence.some(row => (row.res as Record<string, unknown> | undefined)?.statusCode === 409)).toBe(true);
      expect(evidence.some(row => (row.req as Record<string, unknown> | undefined)?.method === 'PUT')).toBe(true);
      expect(evidence.some(row => row.component === 'gateway' && row.error_code === 'conflict')).toBe(true);
      const serialized = JSON.stringify({ evidence, stderr: rejected.stderr });
      for (const secret of active.secrets) expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain('Synthetic CLI rupture mission.');
      emitReceipt({ kind: 'cauce_cli_error', id, component: 'gateway', cause: 'conflict',
        command: `jq -c '${filter}' gateway.log`, operator_evidence: { log_chain: evidence, cli_exit: rejected.code, cli_stderr: rejected.stderr.trim() } });
    } finally { await active.close(); }
  }, 180_000);
});
