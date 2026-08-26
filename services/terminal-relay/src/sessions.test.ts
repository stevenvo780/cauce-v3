import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { AgentConnection, AgentSessionHandlers } from './agent-leg.js';
import type {
  AgentPresence, AuthzOutcome, ConsumeOutcome, ResumeOutcome, SessionCloseReport, TerminalGatewayClient,
  TerminalMode, TerminalSessionGrant
} from './gateway-client.js';
import {
  CLOSE_CODES,
  MAX_COLS,
  MAX_INPUT_MESSAGE_BYTES,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  SessionManager,
  claimLeaseContractSatisfied,
  parseClientMessage,
  type SessionLimits,
} from './sessions.js';

const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff';
const CLAIM_TOKEN = '12345678-1234-4234-8234-123456789abc';

type Listener = (...args: readonly never[]) => void;

/** Minimal `ws` stand-in: records what the browser would have received, in order and by kind. */
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

  /** Types a line the way the console would. */
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

function grant(overrides: Partial<TerminalSessionGrant> = {}): TerminalSessionGrant {
  return {
    tenant_id: 'Steven',
    alias: 'jarvis',
    mode: 'shell',
    cols: 80,
    rows: 24,
    operator_id: 'steven',
    container: 'claw',
    runtime_user: 'claw',
    session_expires_at: new Date(Date.now() + 60_000).toISOString(),
    resume_token: 'r'.repeat(100),
    claim_token: CLAIM_TOKEN,
    claim_epoch: '1',
    claim_lease_ms: 150_000,
    claim_lease_ttl_ms: 150_000,
    relay_instance_id: 'a'.repeat(64),
    relay_boot_id: '11111111-1111-4111-8111-111111111111',
    ...overrides
  };
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

describe('client frames', () => {
  it('accepts the typed frames and rejects binary input', () => {
    expect(parseClientMessage(Buffer.from('{"type":"input","data":"ls"}'), false)).toEqual({ type: 'input', data: 'ls' });
    expect(parseClientMessage(Buffer.from(JSON.stringify({ type: 'terminal_response', data: '\x1b[?1;2c' })), false))
      .toEqual({ type: 'terminal_response', data: '\x1b[?1;2c' });
    expect(parseClientMessage(Buffer.from('{"type":"resize","cols":100,"rows":30}'), false))
      .toEqual({ type: 'resize', cols: 100, rows: 30 });
    expect(parseClientMessage(Buffer.from('{"type":"ping"}'), false)).toEqual({ type: 'ping' });
    expect(parseClientMessage(Buffer.from('{"type":"exec","cmd":"rm"}'), false)).toBeUndefined();
    expect(parseClientMessage(Buffer.from([0x01, 0x02]), true)).toBeUndefined();
  });

  it.each([
    ['', 'vacía'],
    ['whoami\r', 'texto humano'],
    ['\x1b[31m', 'ANSI genérico'],
    ['\x1b[<0;1;1M', 'reporte de mouse'],
    ['\x1b[201;1R', 'fila fuera de rango'],
    ['\x1b[1;501R', 'columna fuera de rango'],
    ['\x1b[0;1R', 'coordenada cero'],
    ['á', 'multibyte'],
  ])('rechaza terminal_response abusiva: %s (%s)', (data) => {
    expect(parseClientMessage(Buffer.from(JSON.stringify({ type: 'terminal_response', data })), false)).toBeUndefined();
  });

  it('acepta DA/DSR concatenadas pero pone un límite pequeño al frame técnico', () => {
    const valid = '\x1b[?1;2c\x1b[>0;276;0c\x1b[0n\x1b[24;80R\x1b[?24;80R';
    expect(parseClientMessage(Buffer.from(JSON.stringify({ type: 'terminal_response', data: valid })), false))
      .toEqual({ type: 'terminal_response', data: valid });
    expect(parseClientMessage(Buffer.from(JSON.stringify({
      type: 'terminal_response', data: '\x1b[0n'.repeat(100)
    })), false)).toBeUndefined();
  });

  // 2026-08-24: una tercera terminal mandaba rows:1, el parser devolvía undefined y el llamador
  // cerraba la sesión con protocol_error 4400 — matando las DOS terminales que ya estaban vivas.
  // Se arregló en producción acotando; esta prueba existe para que no vuelva a revertirse.
  it('acota el resize fuera de rango en vez de rechazarlo y matar la sesión', () => {
    expect(parseClientMessage(Buffer.from('{"type":"resize","cols":100,"rows":1}'), false))
      .toEqual({ type: 'resize', cols: 100, rows: MIN_ROWS });
    expect(parseClientMessage(Buffer.from('{"type":"resize","cols":4,"rows":30}'), false))
      .toEqual({ type: 'resize', cols: MIN_COLS, rows: 30 });
    expect(parseClientMessage(Buffer.from('{"type":"resize","cols":9999,"rows":9999}'), false))
      .toEqual({ type: 'resize', cols: MAX_COLS, rows: MAX_ROWS });
  });

  // Control negativo: acotar no puede volverse "acepto cualquier cosa".
  it('sigue rechazando un resize que no trae enteros', () => {
    expect(parseClientMessage(Buffer.from('{"type":"resize","cols":"80","rows":24}'), false)).toBeUndefined();
    expect(parseClientMessage(Buffer.from('{"type":"resize","cols":80.5,"rows":24}'), false)).toBeUndefined();
    expect(parseClientMessage(Buffer.from('{"type":"resize","cols":null,"rows":24}'), false)).toBeUndefined();
    expect(parseClientMessage(Buffer.from('{"type":"resize","rows":24}'), false)).toBeUndefined();
  });
});

describe('terminal sessions', () => {
  it('announces ready as text, streams PTY output as binary and coalesces typing', async () => {
    const { socket, agent } = await openSession();
    expect(socket.json(0)).toMatchObject({
      type: 'ready', session_id: SESSION_ID, alias: 'jarvis', tenant_id: 'Steven', container: 'claw',
      runtime_user: 'claw', mode: 'shell', claim_token: CLAIM_TOKEN, claim_epoch: '1',
    });
    expect(socket.json(0).claim_lease_ms).toEqual(expect.any(Number));
    expect(agent.opens[0]).toMatchObject({ sessionId: SESSION_ID, ticket: 'ticket-under-test', mode: 'shell' });

    agent.handlers?.onStdout(Buffer.from('claw@jarvis:~$ '));
    expect(socket.binary).toHaveLength(1);
    expect(socket.binary[0]?.toString()).toBe('claw@jarvis:~$ ');
    expect(socket.text).toHaveLength(1);

    socket.type('l');
    socket.type('s');
    socket.type('\r');
    await wait(40);
    expect(agent.stdin).toHaveLength(1);
    expect(agent.stdin[0]?.toString()).toBe('ls\r');
  });

  it('holds what is typed while the agent is still opening the PTY', async () => {
    const gateway = new FakeGateway();
    const manager = new SessionManager({ gateway, limits: limits() });
    const socket = new FakeBrowserSocket();
    const agent = new FakeAgentConnection();
    const opening = manager.open({
      socket: socket.asWebSocket(),
      sessionId: SESSION_ID,
      ticket: 'ticket-under-test',
      grant: grant(),
      agent: agent.asAgent(),
      cols: 120,
      rows: 40
    });
    await waitFor(() => agent.opens.length === 1);
    socket.type('whoami\r');
    expect(agent.stdin).toHaveLength(0);
    agent.handlers?.onOpenOk(4242);
    await opening;
    await wait(30);
    expect(agent.stdin[0]?.toString()).toBe('whoami\r');
  });

  it('forwards resize and ignores ping without touching the agent', async () => {
    const { socket, agent } = await openSession();
    socket.raw('{"type":"resize","cols":100,"rows":30}');
    socket.raw('{"type":"ping"}');
    expect(agent.resizes).toEqual([{ cols: 100, rows: 30 }]);
  });

  it('permite DA/DSR por el canal técnico en harness sin abrir STDIN humano', async () => {
    const { socket, agent } = await openSession({}, { mode: 'harness' });
    socket.raw(JSON.stringify({ type: 'terminal_response', data: '\x1b[?1;2c\x1b[24;80R' }));
    expect(agent.terminalResponses.map((chunk) => chunk.toString('ascii'))).toEqual(['\x1b[?1;2c\x1b[24;80R']);
    expect(agent.stdin).toHaveLength(0);
    expect(socket.closes).toHaveLength(0);
  });

  it('cierra fail-closed si un viewer harness intenta teclado/paste humano', async () => {
    const { socket, agent, gateway } = await openSession({}, { mode: 'harness' });
    socket.type('rm -rf /\r');
    expect(agent.stdin).toHaveLength(0);
    expect(agent.terminalResponses).toHaveLength(0);
    expect(socket.closes[0]).toEqual({ code: CLOSE_CODES.protocol_error, reason: 'input_forbidden' });
    await waitFor(() => gateway.closeReports.length > 0);
    expect(gateway.closeReports[0]?.report.reason).toBe('input_forbidden');
  });

  it('no acepta el canal de viewer dentro de un shell interactivo', async () => {
    const { socket, agent } = await openSession();
    socket.raw(JSON.stringify({ type: 'terminal_response', data: '\x1b[0n' }));
    expect(agent.terminalResponses).toHaveLength(0);
    expect(socket.closes[0]).toEqual({
      code: CLOSE_CODES.protocol_error, reason: 'terminal_response_forbidden'
    });
  });

  it('closes with 4400 when the client sends an unknown frame type', async () => {
    const { socket } = await openSession();
    socket.raw('{"type":"exec","cmd":"whoami"}');
    expect(socket.closes[0]).toEqual({ code: CLOSE_CODES.protocol_error, reason: 'protocol_error' });
  });

  it('closes with 4403 as soon as the gateway revokes the session', async () => {
    const { socket, gateway } = await openSession({ authzIntervalMs: 15 });
    gateway.authz = { status: 'revoked' };
    await waitFor(() => socket.closes.length > 0);
    expect(socket.closes[0]?.code).toBe(CLOSE_CODES.revoked);
    expect(socket.json(1)).toMatchObject({ type: 'closed', reason: 'revoked' });
    expect(gateway.closeReports[0]?.report.reason).toBe('revoked');
  });

  it('fails closed when the gateway stays unreachable past the grace window', async () => {
    const { socket, gateway } = await openSession({ authzIntervalMs: 15, authzGraceMs: 40 });
    gateway.authz = { status: 'unreachable' };
    await waitFor(() => socket.closes.length > 0);
    expect(socket.closes[0]).toEqual({ code: CLOSE_CODES.revoked, reason: 'authz_unreachable' });
  });

  it('keeps the session while the gateway is unreachable inside the grace window', async () => {
    const { socket, gateway } = await openSession({ authzIntervalMs: 10, authzGraceMs: 5_000 });
    gateway.authz = { status: 'unreachable' };
    await wait(60);
    expect(socket.closes).toHaveLength(0);
  });

  it('warns and then closes with 4413 when output floods for five windows', async () => {
    const { socket, agent } = await openSession({ outputWindowMs: 10, outputRateBytesPerSec: 1_000 });
    const flood = setInterval(() => agent.handlers?.onStdout(Buffer.alloc(4_096, 0x41)), 5);
    try {
      await waitFor(() => socket.text.some((frame) => frame.includes('"notice"')));
      const notice = JSON.parse(socket.text.find((frame) => frame.includes('"notice"')) ?? '{}') as Record<string, unknown>;
      expect(notice).toMatchObject({ type: 'notice', level: 'warn' });
      await waitFor(() => socket.closes.length > 0);
      expect(socket.closes[0]?.code).toBe(CLOSE_CODES.output_flood);
    } finally {
      clearInterval(flood);
    }
  });

  it('closes with 4408 when the browser stops typing', async () => {
    const { socket } = await openSession({ idleTimeoutMs: 30 });
    await waitFor(() => socket.closes.length > 0);
    expect(socket.closes[0]).toEqual({ code: CLOSE_CODES.idle_timeout, reason: 'idle_timeout' });
  });

  it('mantiene un viewer con salida continua más allá del idle y lo cierra cuando queda realmente quieto', async () => {
    const { socket, agent } = await openSession(
      { idleTimeoutMs: 35, outputRateBytesPerSec: 10_000_000 },
      { mode: 'harness' }
    );
    const output = setInterval(() => agent.handlers?.onStdout(Buffer.from('.')), 10);
    try {
      await wait(120);
      expect(socket.closes).toHaveLength(0);
    } finally {
      clearInterval(output);
    }
    await waitFor(() => socket.closes.length > 0);
    expect(socket.closes[0]).toEqual({ code: CLOSE_CODES.idle_timeout, reason: 'idle_timeout' });
  });

  it('usa ping como presencia sólo para viewer; no vuelve inmortal un shell abandonado', async () => {
    const viewer = await openSession({ idleTimeoutMs: 35 }, { mode: 'harness' });
    const viewerPing = setInterval(() => viewer.socket.raw('{"type":"ping"}'), 10);
    try {
      await wait(100);
      expect(viewer.socket.closes).toHaveLength(0);
    } finally {
      clearInterval(viewerPing);
    }

    const shell = await openSession({ idleTimeoutMs: 35 });
    const shellPing = setInterval(() => shell.socket.raw('{"type":"ping"}'), 10);
    try {
      await waitFor(() => shell.socket.closes.length > 0);
      expect(shell.socket.closes[0]?.code).toBe(CLOSE_CODES.idle_timeout);
    } finally {
      clearInterval(shellPing);
    }
  });

  it('closes with 4423 when the granted TTL runs out', async () => {
    const { socket } = await openSession({}, { session_expires_at: new Date(Date.now() + 40).toISOString() });
    await waitFor(() => socket.closes.length > 0);
    expect(socket.closes[0]).toEqual({ code: CLOSE_CODES.ttl_expired, reason: 'ttl_expired' });
  });

  it('pausa sólo la sesión cuyo browser no drena y la reanuda al bajar el buffer', async () => {
    const { socket, agent } = await openSession();
    socket.bufferedAmount = 8 * 1024 * 1024;
    agent.handlers?.onStdout(Buffer.from('x'));
    expect(agent.pausedSessions).toEqual(new Set([SESSION_ID]));
    socket.bufferedAmount = 0;
    await waitFor(() => agent.pausedSessions.size === 0);
    expect(agent.pauseRequests).toEqual([SESSION_ID]);
    expect(agent.resumeRequests).toEqual([SESSION_ID]);
  });

  it('un browser lento no bloquea output de otra sesión multiplexada', async () => {
    const gateway = new FakeGateway();
    const manager = new SessionManager({ gateway, limits: limits({ maxSessions: 2 }) });
    const agent = new FakeAgentConnection();
    const slow = new FakeBrowserSocket();
    const healthy = new FakeBrowserSocket();

    const firstOpening = manager.open({
      socket: slow.asWebSocket(), sessionId: SESSION_ID, ticket: 'ticket-one',
      grant: grant({ container: 'claw-one' }), agent: agent.asAgent(), cols: 80, rows: 24
    });
    await waitFor(() => agent.handlersBySession.has(SESSION_ID));
    agent.handlersBySession.get(SESSION_ID)?.onOpenOk(1);
    await firstOpening;
    const secondOpening = manager.open({
      socket: healthy.asWebSocket(), sessionId: OTHER_SESSION_ID, ticket: 'ticket-two',
      grant: grant({ container: 'claw-two' }), agent: agent.asAgent(), cols: 80, rows: 24
    });
    await waitFor(() => agent.handlersBySession.has(OTHER_SESSION_ID));
    agent.handlersBySession.get(OTHER_SESSION_ID)?.onOpenOk(2);
    await secondOpening;

    slow.bufferedAmount = 8 * 1024 * 1024;
    agent.handlersBySession.get(SESSION_ID)?.onStdout(Buffer.from('slow'));
    expect(agent.pausedSessions).toEqual(new Set([SESSION_ID]));
    agent.handlersBySession.get(OTHER_SESSION_ID)?.onStdout(Buffer.from('healthy'));
    expect(healthy.binary.at(-1)?.toString()).toBe('healthy');
    expect(healthy.closes).toHaveLength(0);
  });

  it('con un agente viejo cierra sólo el browser lento en vez de pausar el TLS global', async () => {
    const opened = await openSession();
    opened.agent.supportsSessionOutputFlowControl = false;
    opened.socket.bufferedAmount = 8 * 1024 * 1024;
    opened.agent.handlers?.onStdout(Buffer.from('x'));
    expect(opened.socket.closes[0]).toEqual({ code: CLOSE_CODES.slow_consumer, reason: 'slow_browser' });
    expect(opened.agent.pauseRequests).toHaveLength(0);
  });

  it('cierra sólo la sesión que inunda input antes de acumular o escribir la rafaga', async () => {
    const { socket, agent, gateway } = await openSession();
    socket.type('x'.repeat(MAX_INPUT_MESSAGE_BYTES + 1));
    expect(agent.stdin).toHaveLength(0);
    expect(socket.closes[0]).toEqual({ code: CLOSE_CODES.input_flood, reason: 'input_flood' });
    await waitFor(() => gateway.closeReports.length > 0);
    expect(gateway.closeReports[0]?.report.reason).toBe('input_flood');
  });

  it('reports counters and reason to the gateway when the agent exits', async () => {
    const { socket, agent, gateway } = await openSession();
    socket.type('exit\r');
    await wait(30);
    agent.handlers?.onStdout(Buffer.from('logout\r\n'));
    agent.handlers?.onClosed({ exit_code: 0, signal: null, reason: 'agent_closed' });
    await waitFor(() => gateway.closeReports.length > 0);
    expect(gateway.closeReports[0]?.report).toEqual({
      reason: 'agent_closed', exit_code: 0, bytes_in: 5, bytes_out: 8,
      claim_token: CLAIM_TOKEN, claim_epoch: '1',
    });
    expect(socket.closes[0]?.code).toBe(CLOSE_CODES.normal);
  });

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

  it('persiste el cierre antes de reintentar y limpia el spool cuando vuelve el gateway', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-close-'));
    const spool = join(directory, 'reports.json');
    const gateway = new FakeGateway();
    gateway.closeFailures = 2;
    const manager = new SessionManager({ gateway, limits: limits(), closeSpoolFile: spool });
    try {
      manager.reportConsumedClose(SESSION_ID, 'agent_offline', grant());
      const pending = JSON.parse(await readFile(spool, 'utf8')) as {
        readonly version: number;
        readonly reports: readonly { readonly session_id: string; readonly reason: string }[];
      };
      expect(pending).toEqual({
        version: 2,
        reports: [{
          session_id: SESSION_ID,
          reason: 'agent_offline',
          exit_code: null,
          bytes_in: 0,
          bytes_out: 0,
          claim_token: CLAIM_TOKEN,
          claim_epoch: '1',
        }],
      });
      expect((await stat(spool)).mode & 0o777).toBe(0o600);

      await waitFor(() => gateway.closeReports.length === 1);
      expect(gateway.closeAttempts).toBe(3);
      const delivered = JSON.parse(await readFile(spool, 'utf8')) as {
        readonly version: number;
        readonly reports: readonly unknown[];
      };
      expect(delivered).toEqual({ version: 2, reports: [] });
    } finally {
      await manager.flush();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('drains a version-1 legacy close spool but writes only strict version-2 reports', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-close-v1-'));
    const spool = join(directory, 'reports.json');
    await writeFile(spool, JSON.stringify({
      version: 1,
      reports: [{
        session_id: SESSION_ID,
        reason: 'legacy_restart',
        exit_code: null,
        bytes_in: 3,
        bytes_out: 5,
      }],
    }), { mode: 0o600 });
    const gateway = new FakeGateway();
    const manager = new SessionManager({ gateway, limits: limits(), closeSpoolFile: spool });
    try {
      await waitFor(() => gateway.closeReports.length === 1);
      expect(gateway.closeReports[0]).toEqual({
        sessionId: SESSION_ID,
        report: {
          reason: 'legacy_restart', exit_code: null, bytes_in: 3, bytes_out: 5,
        },
      });
      expect(JSON.parse(await readFile(spool, 'utf8'))).toEqual({ version: 2, reports: [] });
    } finally {
      await manager.flush();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a version-2 capability spool that is readable by group or other users', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-close-mode-'));
    const spool = join(directory, 'reports.json');
    await writeFile(spool, JSON.stringify({
      version: 2,
      reports: [{
        session_id: SESSION_ID,
        reason: 'private_claim',
        exit_code: null,
        bytes_in: 0,
        bytes_out: 0,
        claim_token: CLAIM_TOKEN,
        claim_epoch: '1',
      }],
    }));
    await chmod(spool, 0o644);
    try {
      expect(() => new SessionManager({
        gateway: new FakeGateway(), limits: limits(), closeSpoolFile: spool,
      })).toThrow(/mode 0600/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
