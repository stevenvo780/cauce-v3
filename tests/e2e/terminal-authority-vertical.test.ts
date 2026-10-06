import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { startRealPtyFixture, type RealPtyFixture } from './real-pty-agent.fixtures.js';
import { connectTerminalWire, type TerminalWireClient } from './terminal-authority-vertical.pty.js';
import { decodeTerminalSubject } from '../../services/gateway/src/terminal/authority-continuity.js';

let fixture: RealPtyFixture | undefined;

beforeAll(async () => {
  fixture = await startRealPtyFixture();
}, 10 * 60_000);

afterAll(async () => { await fixture?.close(); });

function carriesOriginalProof(resumeToken: string, proof: string): boolean {
  const segments = resumeToken.split('.');
  const encoded = segments[1];
  if (segments[0] !== 'r2' || encoded === undefined) return false;
  try {
    const envelope: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return Array.isArray(envelope) && envelope.length === 2
      && typeof envelope[0] === 'string' && envelope[0].startsWith('r1.') && envelope[1] === proof;
  } catch {
    return false;
  }
}

async function readSession(fixtureValue: RealPtyFixture, sessionId: string): Promise<{
  console_subject: string;
  relay_claim_sha256: Buffer | null;
  relay_claim_epoch: string | null;
  relay_claim_expires_at: Date | null;
  closed_at: Date | null;
}> {
  const result = await fixtureValue.database.pool.query<{
    console_subject: string;
    relay_claim_sha256: Buffer | null;
    relay_claim_epoch: string | null;
    relay_claim_expires_at: Date | null;
    closed_at: Date | null;
  }>(`SELECT console_subject,relay_claim_sha256,relay_claim_epoch,relay_claim_expires_at,closed_at
        FROM terminal_sessions WHERE id=$1`, [sessionId]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('durable terminal session is missing');
  return row;
}

describe('human authority across HTTPS, PostgreSQL, relay and Python PTY', () => {
  it('attaches with ac2, resumes the same PTY with bound r2, and closes without lease renewal after human revocation', async () => {
    const active = fixture;
    if (active === undefined) throw new Error('real PTY fixture did not initialize');
    process.stdout.write(`${JSON.stringify({ event: 'terminal_authority_fixture', database_container: active.database.container.getId(),
      agent_container: active.agentContainer, agent_container_id: active.agentContainerId,
      agent_image: active.agentImage, agent_image_id: active.agentImageId, browser_container: active.browserContainer })}\n`);
    const human = await active.login();
    await active.waitForTarget(human.cookie);
    const requestId = randomUUID();
    const ownerToken = randomUUID();
    const opened = await active.request('/v3/console/terminal/sessions', {
      method: 'POST',
      headers: { cookie: human.cookie, 'x-csrf-token': human.csrf, origin: active.gatewayUrl },
      body: {
        tenant_id: active.tenant, alias: active.targetAlias, mode: 'shell',
        cols: 100, rows: 30, request_id: requestId, owner_token: ownerToken,
      },
    });
    expect(opened.status).toBe(201);
    const admission: unknown = JSON.parse(opened.body);
    if (typeof admission !== 'object' || admission === null || Array.isArray(admission)) throw new Error('terminal admission is malformed');
    const value = admission as Record<string, unknown>;
    const sessionId = value.session_id;
    const ticket = value.ticket;
    const proof = value.authority_proof;
    const ownerGeneration = value.owner_generation;
    expect(typeof sessionId).toBe('string');
    expect(typeof ticket).toBe('string');
    expect(typeof proof === 'string' && proof.startsWith('ac2.')).toBe(true);
    expect(typeof ownerGeneration).toBe('string');
    if (typeof sessionId !== 'string' || typeof ticket !== 'string' || typeof proof !== 'string'
        || typeof ownerGeneration !== 'string') throw new Error('terminal admission omitted required authority fields');

    let first: TerminalWireClient | undefined;
    let resumed: TerminalWireClient | undefined;
    try {
      const attachedFrame = { type: 'attach', session_id: sessionId, ticket, authority_proof: proof, cols: 100, rows: 30 };
      first = await connectTerminalWire(active, attachedFrame);
      const ready = await first.waitControl((frame) => frame.type === 'ready' && frame.session_id === sessionId);
      const resumeToken = ready.resume_token;
      const claimToken = ready.claim_token;
      const claimEpoch = ready.claim_epoch;
      expect(typeof resumeToken === 'string' && carriesOriginalProof(resumeToken, proof)).toBe(true);
      expect(typeof claimToken === 'string').toBe(true);
      expect(typeof claimEpoch === 'string').toBe(true);
      if (typeof resumeToken !== 'string' || typeof claimToken !== 'string' || typeof claimEpoch !== 'string') {
        throw new Error('relay ready omitted its fenced resume grant');
      }

      const activeRow = await readSession(active, sessionId);
      const account = await active.database.pool.query<{ id: string }>(
        'SELECT id::text AS id FROM console_users WHERE email=$1', [active.operatorEmail],
      );
      const subject = decodeTerminalSubject(activeRow.console_subject);
      expect(subject.kind === 'human' && subject.humanId === account.rows[0]?.id
        && subject.actor.tenantId === active.tenant && subject.actor.alias === active.operatorAlias).toBe(true);
      expect(activeRow.relay_claim_epoch).toBe(claimEpoch);
      expect(activeRow.relay_claim_sha256?.toString('hex')).toBe(createHash('sha256').update(claimToken).digest('hex'));
      expect(activeRow.relay_claim_expires_at).toBeInstanceOf(Date);

      const firstNonce = `VERTICAL-${randomUUID()}`;
      first.sendInput(`CAUCE_PTY_MARKER='${firstNonce}'; printf '\\nPTY_STATE:%s:%s\\n' "$CAUCE_PTY_MARKER" "$$"; pwd; id -u\n`);
      const statePattern = new RegExp(`PTY_STATE:${firstNonce}:(\\d+)`, 'u');
      const firstOutput = await first.waitOutput((text) => statePattern.test(text) && text.includes('/home/node') && /(?:^|\s)1000(?:\s|$)/u.test(text));
      expect(firstOutput.includes(firstNonce) && firstOutput.includes('/home/node') && /(?:^|\s)1000(?:\s|$)/u.test(firstOutput)).toBe(true);
      const originalPid = statePattern.exec(firstOutput)?.[1];
      if (originalPid === undefined) throw new Error('original PTY shell PID was not observed');
      expect(Number.isSafeInteger(Number(originalPid)) && Number(originalPid) > 0).toBe(true);

      expect(await first.dropTransport()).toBe(1006);
      resumed = await connectTerminalWire(active, {
        type: 'resume', session_id: sessionId, resume_token: resumeToken, authority_proof: proof,
        prior_claim_token: claimToken, prior_claim_epoch: claimEpoch, after_bytes: first.outputBytes(), cols: 100, rows: 30,
      });
      const resumedReady = await resumed.waitControl((frame) => frame.type === 'ready' && frame.session_id === sessionId);
      expect(resumedReady.resumed).toBe(true);
      expect(resumedReady.resume_token === resumeToken || carriesOriginalProof(String(resumedReady.resume_token), proof)).toBe(true);

      const secondNonce = `RESUMED-${randomUUID()}`;
      resumed.sendInput(`printf '\\nPTY_RESUMED:%s:%s\\n' "\${CAUCE_PTY_MARKER-unset}" "$$"; printf 'PTY:${secondNonce}\\n'; pwd; id -u\n`);
      const originalState = `PTY_RESUMED:${firstNonce}:${originalPid}`;
      const secondOutput = await resumed.waitOutput((text) => text.includes(originalState) && text.includes(secondNonce) && text.includes('/home/node') && /(?:^|\s)1000(?:\s|$)/u.test(text));
      expect(secondOutput.includes(secondNonce) && secondOutput.includes('/home/node') && /(?:^|\s)1000(?:\s|$)/u.test(secondOutput)).toBe(true);
      expect(secondOutput).toContain(originalState);

      const disabled = await active.database.pool.query<{ id: string }>(
        'UPDATE console_users SET active=false WHERE email=$1 RETURNING id::text AS id', [active.operatorEmail],
      );
      expect(disabled.rows).toHaveLength(1);
      const expiryAfterRevocation = (await readSession(active, sessionId)).relay_claim_expires_at;
      expect(expiryAfterRevocation).toBeInstanceOf(Date);
      const closeCode = await resumed.waitForClose(15_000);
      expect(closeCode).toBe(4403);

      const closeDeadline = Date.now() + 10_000;
      let finalRow = await readSession(active, sessionId);
      while (finalRow.closed_at === null && Date.now() < closeDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        finalRow = await readSession(active, sessionId);
      }
      expect(finalRow.closed_at).toBeInstanceOf(Date);
      expect(finalRow.relay_claim_expires_at?.getTime()).toBe(expiryAfterRevocation?.getTime());

      const audit = await active.database.pool.query<{ action: string; metadata: unknown }>(
        "SELECT action,metadata FROM audit_events WHERE action LIKE 'terminal.session.%'",
      );
      const records = audit.rows.map((row) => JSON.stringify(row.metadata));
      const proofAbsent = records.every((record) => !record.includes(proof) && !record.includes('ac2.')
        && !record.includes('r2.') && !/"(?:authority_proof|resume_token)"\s*:/u.test(record));
      expect(proofAbsent).toBe(true);
      expect(audit.rows.some((row) => row.action === 'terminal.session.consume')).toBe(true);
      expect(audit.rows.some((row) => row.action === 'terminal.session.resume')).toBe(true);
    } finally {
      if (first?.socket.readyState === 1) await first.close().catch(() => undefined);
      if (resumed?.socket.readyState === 1) await resumed.close().catch(() => undefined);
    }
  }, 240_000);
});
