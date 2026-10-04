import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { startRealPtyFixture, type RealPtyFixture } from './real-pty-agent.fixtures.js';

let fixture: RealPtyFixture | undefined;

beforeAll(async () => {
  fixture = await startRealPtyFixture();
}, 10 * 60_000);

afterAll(async () => { await fixture?.close(); });

describe('PTY real Python agent through gateway and relay', () => {
  it('authenticates, claims a real PTY, runs fixed shell probes as UID 1000, and revokes it', async () => {
    if (!fixture) throw new Error('PTY fixture not initialized');
    const active = fixture;
    const session = await active.login();
    await active.waitForTarget(session.cookie);
    const requestId = randomUUID();
    const ownerToken = randomUUID();
    const opened = await active.request('/v3/console/terminal/sessions', {
      method: 'POST',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, origin: active.gatewayUrl },
      body: {
        tenant_id: active.tenant, alias: active.targetAlias, mode: 'shell', reason: 'real PTY E2E',
        cols: 100, rows: 30, request_id: requestId, owner_token: ownerToken,
      },
    });
    expect(opened.status, opened.body).toBe(201);
    const admission = JSON.parse(opened.body) as {
      session_id: string; ticket: string; websocket_path: string; owner_generation: string; request_id: string;
    };
    expect(admission.request_id).toBe(requestId);
    const pty = await active.connect(admission.ticket, admission.session_id, 100, 30);
    const ready = await pty.waitControl((frame) => frame.type === 'ready');
    expect(ready).toMatchObject({ type: 'ready', session_id: admission.session_id, resumed: false });
    expect(typeof ready.claim_token).toBe('string');
    expect(typeof ready.claim_epoch).toBe('string');
    const claimed = await active.database.pool.query<{
      relay_claim_sha256: Buffer | null; relay_claim_epoch: string | null; request_id: string;
      browser_owner_generation: string; browser_owner_sha256: Buffer; operator_id: string;
      console_subject: string; revoked_at: Date | null; closed_at: Date | null;
    }>(`SELECT relay_claim_sha256,relay_claim_epoch,request_id,browser_owner_generation,browser_owner_sha256,
               operator_id,console_subject,revoked_at,closed_at
          FROM terminal_sessions WHERE id=$1`, [admission.session_id]);
    expect(claimed.rows).toHaveLength(1);
    expect(claimed.rows[0]).toMatchObject({
      relay_claim_epoch: ready.claim_epoch, request_id: requestId, browser_owner_generation: admission.owner_generation,
      operator_id: active.operatorEmail, console_subject: `${active.tenant}:${active.operatorAlias}`,
      revoked_at: null, closed_at: null,
    });
    expect(claimed.rows[0]?.relay_claim_sha256?.toString('hex')).toBe(
      createHash('sha256').update(String(ready.claim_token)).digest('hex'),
    );
    expect(claimed.rows[0]?.browser_owner_sha256.toString('hex')).toBe(
      createHash('sha256').update(ownerToken).digest('hex'),
    );

    const nonce = `PTY-${randomUUID()}`;
    pty.socket.send(JSON.stringify({ type: 'input', data: `printf 'PTY:${nonce}\\n'; id -u; printf 'HOME:%s\\n' "$HOME"; stty size\n` }));
    const output = await pty.waitOutput((value) => value.includes(nonce) && value.includes('1000') && value.includes('HOME:/home/node') && value.includes('30 100'));
    expect(output).toContain(`PTY:${nonce}`);
    expect(output).toMatch(/\b1000\b/u);
    expect(output).toContain('HOME:/home/node');
    expect(output).toContain('30 100');

    const closed = await active.request(`/v3/console/terminal/sessions/${encodeURIComponent(admission.session_id)}`, {
      method: 'DELETE', headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, origin: active.gatewayUrl },
      body: { owner_generation: admission.owner_generation, owner_token: ownerToken, request_id: requestId },
    });
    expect(closed.status, closed.body).toBe(204);
    await pty.waitForClose(10_000);
    expect(pty.closeCode).toBe(4403);
    const durable = await active.database.pool.query<{ revoked_at: Date | null; closed_at: Date | null }>(
      'SELECT revoked_at,closed_at FROM terminal_sessions WHERE id=$1', [admission.session_id]);
    expect(durable.rows[0]?.revoked_at).toBeInstanceOf(Date);
    expect(durable.rows[0]?.closed_at).toBeInstanceOf(Date);
    const closeAudit = await active.database.pool.query<{ decision: string; session_id: string }>(
      "SELECT decision,metadata->>'session_id' AS session_id FROM audit_events WHERE action='terminal.session.close' AND metadata->>'session_id'=$1",
      [admission.session_id],
    );
    expect(closeAudit.rows).toEqual([{ decision: 'info', session_id: admission.session_id }]);
    expect(active.agentLog()).toContain('1000');
  }, 180_000);
});
