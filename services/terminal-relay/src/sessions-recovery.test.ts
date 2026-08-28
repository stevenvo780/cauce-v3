import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { AgentConnection, AgentSessionHandlers } from './agent-leg.js';
import type {
  AgentPresence, AuthzOutcome, ConsumeOutcome, ResumeOutcome, SessionCloseReport, TerminalGatewayClient,
  TerminalMode, TerminalSessionGrant
} from './gateway-client.js';
import {
  CLOSE_CODES,
  SessionManager,
  claimLeaseContractSatisfied,
  type SessionLimits,
} from './sessions.js';
import { grant, CLAIM_TOKEN } from './relay-test-fixtures.js';

const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff';

type Listener = (...args: readonly never[]) => void;

class FakeBrowserSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly text: string[] = [];
  readonly binary: Buffer[] = [];
  readonly closes: { code: number; reason: string }[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  send(data: string | Buffer, options?: { binary?: boolean }): void {
    if (typeof data === 'string' && options?.binary !== true) {
      this.text.push(data);
      return;
    }
    this.binary.push(Buffer.from(data));
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closes.push({ code, reason });
    this.emit('close', ...([code, Buffer.from(reason)] as never[]));
  }

  terminate(): void {
    this.close();
  }

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  once(event: string, listener: Listener): this {
    return this.on(event, listener);
  }

  off(event: string, listener: Listener): this {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((entry) => entry !== listener));
    return this;
  }

  emit(event: string, ...args: readonly never[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  type(text: string): void {
    this.emit('message', ...([Buffer.from(JSON.stringify({ type: 'input', data: text })), false] as never[]));
  }

  raw(payload: string, binary = false): void {
    this.emit('message', ...([Buffer.from(payload), binary] as never[]));
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }

  json(index: number): Record<string, unknown> {
    return JSON.parse(this.text[index] ?? '{}') as Record<string, unknown>;
  }
}

class FakeAgentConnection {
  alive = true;
  throwOnAttach = false;
  supportsSessionOutputFlowControl = true;
  readonly handlersBySession = new Map<string, AgentSessionHandlers>();
  private lastSessionId: string | undefined;
  readonly opens: { sessionId: string; ticket: string; mode: TerminalMode }[] = [];
  readonly stdin: Buffer[] = [];
  readonly terminalResponses: Buffer[] = [];
  readonly resizes: { cols: number; rows: number }[] = [];
  readonly closes: { sessionId: string; reason: string }[] = [];
  readonly pausedSessions = new Set<string>();
  readonly pauseRequests: string[] = [];
  readonly resumeRequests: string[] = [];

  get handlers(): AgentSessionHandlers | undefined {
    return this.lastSessionId === undefined ? undefined : this.handlersBySession.get(this.lastSessionId);
  }

  attachSession(sessionId: string, handlers: AgentSessionHandlers): void {
    if (this.throwOnAttach) throw new Error('forced attachSession failure');
    this.handlersBySession.set(sessionId, handlers);
    this.lastSessionId = sessionId;
  }

  detachSession(sessionId: string): void {
    this.handlersBySession.delete(sessionId);
    if (this.lastSessionId === sessionId) this.lastSessionId = undefined;
  }

  sendOpen(sessionId: string, ticket: string, mode: TerminalMode): void {
    this.opens.push({ sessionId, ticket, mode });
  }

  sendStdin(sessionId: string, data: Buffer): boolean {
    void sessionId;
    this.stdin.push(data);
    return true;
  }

  sendTerminalResponse(sessionId: string, data: Buffer): boolean {
    void sessionId;
    this.terminalResponses.push(data);
    return true;
  }

  sendResize(sessionId: string, cols: number, rows: number): void {
    void sessionId;
    this.resizes.push({ cols, rows });
  }

  sendClose(sessionId: string, reason: string): void {
    this.closes.push({ sessionId, reason });
  }

  pauseSessionOutput(sessionId: string): boolean {
    this.pauseRequests.push(sessionId);
    this.pausedSessions.add(sessionId);
    return true;
  }

  resumeSessionOutput(sessionId: string): boolean {
    this.resumeRequests.push(sessionId);
    this.pausedSessions.delete(sessionId);
    return true;
  }

  asAgent(): AgentConnection {
    return this as unknown as AgentConnection;
  }
}

class FakeGateway implements TerminalGatewayClient {
  authz: AuthzOutcome = {
    status: 'allow', claim_epoch: '1', claim_lease_ms: 150_000, claim_lease_ttl_ms: 150_000,
  };
  closeFailures = 0;
  closeAttempts = 0;
  readonly closeReports: { sessionId: string; report: SessionCloseReport }[] = [];

  async consumeTicket(): Promise<ConsumeOutcome> {
    return { status: 'unavailable' };
  }

  async resumeSession(): Promise<ResumeOutcome> {
    return { status: 'unavailable' };
  }

  async authorizeSession(): Promise<AuthzOutcome> {
    return this.authz;
  }

  async reportClose(sessionId: string, report: SessionCloseReport): Promise<void> {
    this.closeAttempts += 1;
    if (this.closeFailures > 0) {
      this.closeFailures -= 1;
      throw new Error('gateway unavailable');
    }
    this.closeReports.push({ sessionId, report });
  }

  async publishPresence(agents: readonly AgentPresence[]): Promise<void> {
    void agents;
  }
}


function limits(overrides: Partial<SessionLimits> = {}): SessionLimits {
  return {
    idleTimeoutMs: 60_000,
    outputRateBytesPerSec: 262_144,
    scrollbackBytes: 64,
    maxSessions: 2,
    authzIntervalMs: 60_000,
    authzGraceMs: 60_000,
    openTimeoutMs: 500,
    outputWindowMs: 10,
    ...overrides
  };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was never met');
    await wait(5);
  }
}

interface OpenedSession {
  readonly manager: SessionManager;
  readonly socket: FakeBrowserSocket;
  readonly agent: FakeAgentConnection;
  readonly gateway: FakeGateway;
}

async function openSession(
  overrides: Partial<SessionLimits> = {},
  grantOverrides: Partial<TerminalSessionGrant> = {},
  sessionId = SESSION_ID,
  reuse?: { manager: SessionManager; gateway: FakeGateway }
): Promise<OpenedSession> {
  const gateway = reuse?.gateway ?? new FakeGateway();
  const manager = reuse?.manager ?? new SessionManager({ gateway, limits: limits(overrides) });
  const socket = new FakeBrowserSocket();
  const agent = new FakeAgentConnection();
  const opening = manager.open({
    socket: socket.asWebSocket(),
    sessionId,
    ticket: 'ticket-under-test',
    grant: grant(grantOverrides),
    agent: agent.asAgent(),
    cols: 120,
    rows: 40
  });
  await waitFor(() => agent.opens.length === 1 || socket.closes.length > 0);
  agent.handlers?.onOpenOk(4242);
  await opening;
  return { manager, socket, agent, gateway };
}

describe('terminal sessions recovery and conflicts', () => {
  it('refuses a second terminal for the same container and honours the session cap', async () => {
    const first = await openSession();
    const conflicting = new FakeBrowserSocket();
    await first.manager.open({
      socket: conflicting.asWebSocket(),
      sessionId: OTHER_SESSION_ID,
      ticket: 'second-ticket',
      grant: grant(),
      agent: new FakeAgentConnection().asAgent(),
      cols: 80,
      rows: 24
    });
    expect(conflicting.closes[0]).toEqual({ code: CLOSE_CODES.session_conflict, reason: 'session_conflict' });
    await first.manager.flush();
    expect(first.gateway.closeReports.some((entry) => entry.report.reason === 'session_conflict')).toBe(true);
  });

  it('rejects the same active sid without reporting a close for the winner', async () => {
    const first = await openSession();
    const duplicate = new FakeBrowserSocket();
    await first.manager.open({
      socket: duplicate.asWebSocket(),
      sessionId: SESSION_ID,
      ticket: 'same-ticket',
      grant: grant(),
      agent: new FakeAgentConnection().asAgent(),
      cols: 80,
      rows: 24,
    });
    expect(duplicate.closes[0]).toEqual({
      code: CLOSE_CODES.session_conflict,
      reason: 'session_conflict',
    });
    expect(first.manager.hasSession(SESSION_ID)).toBe(true);
    expect(first.gateway.closeReports).toHaveLength(0);
  });

  it('releases ownership and reports once when an unexpected collaborator throws during open', async () => {
    const gateway = new FakeGateway();
    const manager = new SessionManager({ gateway, limits: limits() });
    const socket = new FakeBrowserSocket();
    const agent = new FakeAgentConnection();
    agent.throwOnAttach = true;

    await manager.open({
      socket: socket.asWebSocket(),
      sessionId: SESSION_ID,
      ticket: 'ticket-under-test',
      grant: grant(),
      agent: agent.asAgent(),
      cols: 80,
      rows: 24,
    });

    expect(manager.hasSession(SESSION_ID)).toBe(false);
    expect(manager.size).toBe(0);
    expect(socket.closes[0]).toEqual({ code: CLOSE_CODES.internal_error, reason: 'open_failed' });
    await manager.flush();
    expect(gateway.closeReports).toEqual([
      expect.objectContaining({
        sessionId: SESSION_ID,
        report: expect.objectContaining({ reason: 'open_failed' }) as unknown,
      }),
    ]);
  });

  it('reporta y libera la fila consumida cuando el límite corta antes de crear TerminalSession', async () => {
    const first = await openSession({ maxSessions: 1 });
    const rejected = new FakeBrowserSocket();
    await first.manager.open({
      socket: rejected.asWebSocket(),
      sessionId: OTHER_SESSION_ID,
      ticket: 'second-ticket',
      grant: grant({ alias: 'socrates', container: 'ws-socrates' }),
      agent: new FakeAgentConnection().asAgent(),
      cols: 80,
      rows: 24
    });
    expect(rejected.closes[0]).toEqual({ code: CLOSE_CODES.session_conflict, reason: 'session_limit' });
    await first.manager.flush();
    expect(first.gateway.closeReports.some((entry) => entry.report.reason === 'session_limit')).toBe(true);
  });

  it('fails closed when claim TTL cannot cover authz, grace, request timeout and takeover margin', () => {
    expect(claimLeaseContractSatisfied(
      grant({ claim_lease_ms: 130_000, claim_lease_ttl_ms: 130_000 }),
      limits(),
    )).toBe(false);
    expect(claimLeaseContractSatisfied(
      grant({ claim_lease_ms: 130_001, claim_lease_ttl_ms: 130_001 }),
      limits(),
    )).toBe(true);
  });

  it('hard-closes on the monotonic claim deadline before another relay may take over', async () => {
    vi.useFakeTimers();
    let monotonicNow = 0;
    const gateway = new FakeGateway();
    const manager = new SessionManager({
      gateway,
      monotonicNow: () => monotonicNow,
      limits: limits({ authzIntervalMs: 2_000, authzGraceMs: 1_000 }),
    });
    const socket = new FakeBrowserSocket();
    const agent = new FakeAgentConnection();
    try {
      const opening = manager.open({
        socket: socket.asWebSocket(),
        sessionId: SESSION_ID,
        ticket: 'ticket-under-test',
        grant: grant({ claim_lease_ms: 6_000, claim_lease_ttl_ms: 14_000 }),
        agent: agent.asAgent(),
        cols: 120,
        rows: 40,
        claimRequestStartedAt: 0,
      });
      await vi.advanceTimersByTimeAsync(0);
      agent.handlers?.onOpenOk(4242);
      await opening;
      expect(socket.closes).toHaveLength(0);

      monotonicNow = 1_001;
      await vi.advanceTimersByTimeAsync(1_001);
      expect(socket.closes[0]).toEqual({ code: CLOSE_CODES.revoked, reason: 'claim_lease_expired' });
      expect(gateway.closeReports[0]?.report).toMatchObject({
        reason: 'claim_lease_expired', claim_token: CLAIM_TOKEN, claim_epoch: '1',
      });
    } finally {
      manager.closeAll(CLOSE_CODES.going_away, 'test_teardown');
      await manager.flush();
      vi.useRealTimers();
    }
  });

  it('reanexa el mismo PTY y entrega sólo el tail no confirmado, sin un segundo OPEN', async () => {
    const sessionExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const first = await openSession(
      { scrollbackBytes: 16, reconnectGraceMs: 500 },
      { session_expires_at: sessionExpiresAt }
    );
    first.agent.handlers?.onStdout(Buffer.from('0123456789'));
    first.agent.handlers?.onStdout(Buffer.from('abcdefghij'));
    first.socket.close(1006, 'network_lost');

    const resumed = new FakeBrowserSocket();
    expect(first.manager.reattach({
      socket: resumed.asWebSocket(),
      sessionId: SESSION_ID,
      grant: grant({ session_expires_at: sessionExpiresAt }),
      cols: 100,
      rows: 30,
      afterBytes: 10
    })).toBe(true);
    expect(first.agent.opens).toHaveLength(1);
    expect(first.agent.resizes.at(-1)).toEqual({ cols: 100, rows: 30 });
    expect(resumed.json(0)).toMatchObject({ type: 'ready', resumed: true, stream_offset: 10 });
    expect(resumed.json(1)).toMatchObject({ type: 'notice', level: 'info' });
    expect(resumed.binary[0]?.toString()).toBe('abcdefghij');
    expect(first.gateway.closeReports).toHaveLength(0);
  });

  it('a replay cannot open a PTY or attach two browser sockets concurrently', async () => {
    const sessionExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const first = await openSession(
      { reconnectGraceMs: 500 }, { session_expires_at: sessionExpiresAt },
    );
    const whileOwned = new FakeBrowserSocket();
    expect(first.manager.reattach({
      socket: whileOwned.asWebSocket(), sessionId: SESSION_ID,
      grant: grant({ session_expires_at: sessionExpiresAt }), cols: 80, rows: 24, afterBytes: 0,
    })).toBe(false);

    first.socket.close(1006, 'network_lost');
    const winner = new FakeBrowserSocket();
    const replay = new FakeBrowserSocket();
    const input = {
      sessionId: SESSION_ID,
      grant: grant({ session_expires_at: sessionExpiresAt }),
      cols: 80,
      rows: 24,
      afterBytes: 0,
    };
    expect(first.manager.reattach({ socket: winner.asWebSocket(), ...input })).toBe(true);
    expect(first.manager.reattach({ socket: replay.asWebSocket(), ...input })).toBe(false);
    expect(first.agent.opens).toHaveLength(1);
    expect(winner.json(0)).toMatchObject({ type: 'ready', resumed: true });
    expect(replay.text).toHaveLength(0);
    expect(first.gateway.closeReports).toHaveLength(0);
  });

  it('reattach rejects any destination, operator or TTL mismatch', async () => {
    const sessionExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const first = await openSession(
      { reconnectGraceMs: 500 }, { session_expires_at: sessionExpiresAt },
    );
    first.socket.close(1006, 'network_lost');
    for (const mismatch of [
      { operator_id: 'intruder' },
      { container: 'another-container' },
      { alias: 'another-alias' },
      { session_expires_at: new Date(Date.now() + 120_000).toISOString() },
    ]) {
      expect(first.manager.reattach({
        socket: new FakeBrowserSocket().asWebSocket(), sessionId: SESSION_ID,
        grant: grant({ session_expires_at: sessionExpiresAt, ...mismatch }), cols: 80, rows: 24, afterBytes: 0,
      })).toBe(false);
    }
    expect(first.agent.opens).toHaveLength(1);
  });

  it('closes with 4404 when the agent connection dies underneath the session', async () => {
    const { socket, agent } = await openSession();
    agent.handlers?.onAgentGone('agent_disconnected');
    expect(socket.closes[0]).toEqual({ code: CLOSE_CODES.agent_offline, reason: 'agent_disconnected' });
  });
});
