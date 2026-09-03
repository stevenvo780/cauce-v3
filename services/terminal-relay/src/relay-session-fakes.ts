import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import type { AgentConnection, AgentSessionHandlers } from './agent-leg.js';
import type {
  AgentPresence, AuthzOutcome, ConsumeOutcome, ResumeOutcome, SessionCloseReport,
  TerminalGatewayClient, TerminalMode, TerminalSessionGrant
} from './gateway-client.js';
import { SessionManager, type SessionLimits } from './sessions.js';
import { grant } from './relay-test-fixtures.js';

/** In-process doubles for the browser socket, the PTY agent and the gateway. They live outside the
 * suites because the session contract is asserted from more than one file and the ratchet keeps
 * every one of them small. */

export const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const OTHER_SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff';
const scratchDirectories: string[] = [];

/** Every suite that opens a recording calls this from its own `afterEach`. */
export async function cleanScratchDirectories(): Promise<void> {
  while (scratchDirectories.length > 0) {
    const directory = scratchDirectories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
}

export async function recordingDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'relay-sessions-'));
  scratchDirectories.push(directory);
  return join(directory, 'casts');
}

type Listener = (...args: readonly never[]) => void;

/** Minimal `ws` stand-in: records what the browser would have received, in order and by kind. */
export class FakeBrowserSocket {
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

export class FakeAgentConnection {
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

export class FakeGateway implements TerminalGatewayClient {
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


export function limits(overrides: Partial<SessionLimits> = {}): SessionLimits {
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

export const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was never met');
    await wait(5);
  }
}

export interface OpenedSession {
  readonly manager: SessionManager;
  readonly socket: FakeBrowserSocket;
  readonly agent: FakeAgentConnection;
  readonly gateway: FakeGateway;
}

export async function openSession(
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
