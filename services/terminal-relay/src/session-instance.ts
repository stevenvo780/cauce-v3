import { errorLabel, logEvent } from '@cauce/protocol';
import type { RawData, WebSocket } from 'ws';
import type { AgentConnection, AgentNoticeKind } from './agent-leg.js';
import type { RelayMetricsSink } from './metrics.js';
import { SessionRecording } from './recording.js';
import {
  CLAIM_DEADLINE_SAFETY_MARGIN_MS,
  type SessionCloseReport,
  type TerminalGatewayClient,
  type TerminalSessionGrant,
} from './gateway-client.js';
import {
  BACKPRESSURE_HIGH_BYTES,
  BACKPRESSURE_LOW_BYTES,
  BACKPRESSURE_POLL_MS,
  CLOSE_CODES,
  DEFAULT_OPEN_TIMEOUT_MS,
  DEFAULT_OUTPUT_WINDOW_MS,
  DEFAULT_RECONNECT_GRACE_MS,
  FLOOD_CLOSE_WINDOWS,
  FLOOD_WARN_WINDOWS,
  MAX_EARLY_CLIENT_BYTES,
  MAX_EARLY_MESSAGES,
  MAX_INPUT_MESSAGE_BYTES,
  MAX_PENDING_NOTICES,
  MAX_PENDING_STDIN_BYTES,
  STDIN_COALESCE_MS,
  WS_OPEN,
  claimLeaseTtlSatisfied,
  closeSocket,
  containerKey,
  isReadOnlyMode,
  isTuiMode,
  isWritableTuiMode,
  parseClientMessage,
  rawDataByteLength,
  recordingRequirement,
  type OpenSessionInput,
  type QueuedClientMessage,
  type ReattachSessionInput,
  type ScrollbackEntry,
  type SessionLimits,
} from './session-limits.js';

export interface SessionManagerDelegate {
  scrollbackFor(sessionId: string, expiresAt: number): ScrollbackEntry;
  release(sessionId: string, container: string): void;
  enqueueCloseReport(sessionId: string, report: SessionCloseReport): void;
  readonly metrics: RelayMetricsSink;
}

export class TerminalSession {
  private readonly manager: SessionManagerDelegate;
  private readonly metrics: RelayMetricsSink;
  private recording: SessionRecording | undefined;
  private counted = false;
  private readonly gateway: TerminalGatewayClient;
  private readonly limits: SessionLimits;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private socket: WebSocket | undefined;
  private readonly agent: AgentConnection;
  private readonly grant: TerminalSessionGrant;
  private readonly claimToken: string;
  private readonly claimEpochValue: string;
  private readonly sessionId: string;
  private readonly ticket: string;
  private resumeToken: string;
  private readonly container: string;
  private readonly expiresAtMs: number;
  private readonly scrollback: ScrollbackEntry;
  private cols: number;
  private rows: number;
  private bytesIn = 0;
  private bytesOut = 0;
  private windowBytes = 0;
  private floodWindows = 0;
  private lastAuthzOkAt: number;
  private authzInFlight = false;
  private exitCode: number | null = null;
  private agentClosed = false;
  private resumeReady = false;
  private isClosed = false;
  get closed(): boolean { return this.isClosed; }
  private isSessionClosed(): boolean { return this.isClosed; }
  private stdin: Buffer[] = [];
  private stdinBytes = 0;
  private pendingNotices: { kind: AgentNoticeKind; body: Record<string, unknown> }[] = [];
  private outputPaused = false;
  private stdinTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private ttlTimer: NodeJS.Timeout | undefined;
  private authzTimer: NodeJS.Timeout | undefined;
  private windowTimer: NodeJS.Timeout | undefined;
  private drainTimer: NodeJS.Timeout | undefined;
  private openTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private claimDeadlineTimer: NodeJS.Timeout | undefined;
  private claimLeaseExpiresAt = 0;
  private claimDeadlineAt = 0;
  private settleOpen: ((opened: boolean) => void) | undefined;

  constructor(
    manager: SessionManagerDelegate,
    gateway: TerminalGatewayClient,
    limits: SessionLimits,
    now: () => number,
    monotonicNow: () => number,
    input: OpenSessionInput
  ) {
    this.manager = manager;
    this.metrics = manager.metrics;
    this.gateway = gateway;
    this.limits = limits;
    this.now = now;
    this.monotonicNow = monotonicNow;
    this.socket = input.socket;
    this.agent = input.agent;
    this.grant = input.grant;
    this.claimToken = input.grant.claim_token;
    this.claimEpochValue = input.grant.claim_epoch;
    this.sessionId = input.sessionId;
    this.ticket = input.ticket;
    this.resumeToken = input.grant.resume_token;
    this.container = containerKey(input.grant.container);
    this.cols = input.cols;
    this.rows = input.rows;
    this.expiresAtMs = Date.parse(input.grant.session_expires_at);
    this.lastAuthzOkAt = now();
    this.scrollback = manager.scrollbackFor(input.sessionId, this.expiresAtMs);
    this.updateClaimLease(
      input.grant.claim_lease_ms,
      input.grant.claim_lease_ttl_ms,
      input.claimRequestStartedAt ?? monotonicNow(),
    );
  }

  async start(queued: readonly QueuedClientMessage[]): Promise<void> {
    const socket = this.socket;
    if (socket === undefined) {
      this.terminate(CLOSE_CODES.internal_error, 'browser_socket_missing');
      return;
    }
    if (!this.claimIsLive()) {
      this.terminate(CLOSE_CODES.revoked, 'claim_lease_expired');
      return;
    }
    // The browser may have closed between the consume and this listener. State is the only signal (the event already fired): no orphan PTY opens, and `terminate` reports idempotent.
    if (socket.readyState !== WS_OPEN) {
      this.terminate(CLOSE_CODES.normal, 'browser_closed');
      return;
    }
    if (!(this.expiresAtMs - this.now() > 0)) {
      this.metrics.openAttempt('expired');
      this.terminate(CLOSE_CODES.ttl_expired, 'ttl_expired');
      return;
    }
    if (!this.startRecording()) return;
    // Listening from the first synchronous moment: whatever is typed while the agent is opening
    // the PTY is held, not lost, and is replayed in order once the session is ready.
    let ready = false;
    const early: QueuedClientMessage[] = [...queued];
    let earlyBytes = early.reduce((total, message) => total + rawDataByteLength(message.data), 0);
    if (early.length > MAX_EARLY_MESSAGES || earlyBytes > MAX_EARLY_CLIENT_BYTES) {
      this.terminate(CLOSE_CODES.input_flood, 'input_flood');
      return;
    }
    const onEarlyMessage = (data: RawData, isBinary: boolean): void => {
      if (ready) {
        this.onClientMessage(data, isBinary);
        return;
      }
      const bytes = rawDataByteLength(data);
      if (early.length >= MAX_EARLY_MESSAGES || earlyBytes + bytes > MAX_EARLY_CLIENT_BYTES) {
        this.terminate(CLOSE_CODES.input_flood, 'input_flood');
        return;
      }
      early.push({ data, isBinary });
      earlyBytes += bytes;
    };
    socket.on('message', onEarlyMessage);
    this.bindBrowserLifecycle(socket);
    const opened = await this.openOnAgent();
    if (!opened || this.closed) return;
    socket.off('message', onEarlyMessage);
    this.bindReadyBrowser(socket);
    this.sendReady(false, this.bytesOut);
    this.metrics.openAttempt('opened');
    this.metrics.sessionOpened(this.grant.mode);
    this.counted = true;
    this.startTimers();
    ready = true;
    for (const message of early) {
      if (this.isSessionClosed()) break;
      this.onClientMessage(message.data, message.isBinary);
    }
    logEvent('terminal_relay_session_started', {
      session_id: this.sessionId,
      tenant_id: this.grant.tenant_id,
      alias: this.grant.alias,
      container: this.grant.container,
      runtime_user: this.grant.runtime_user,
      mode: this.grant.mode
    });
  }

  matchesGrant(grant: TerminalSessionGrant): boolean {
    return grant.tenant_id === this.grant.tenant_id && grant.alias === this.grant.alias &&
      grant.container === this.grant.container && grant.runtime_user === this.grant.runtime_user &&
      grant.mode === this.grant.mode && grant.operator_id === this.grant.operator_id &&
      grant.session_expires_at === this.grant.session_expires_at &&
      grant.claim_token === this.claimToken && grant.claim_epoch === this.claimEpochValue &&
      grant.relay_instance_id === this.grant.relay_instance_id &&
      grant.relay_boot_id === this.grant.relay_boot_id;
  }

  claimFence(): { readonly token: string; readonly epoch: string } {
    return { token: this.claimToken, epoch: this.claimEpochValue };
  }

  reattach(input: ReattachSessionInput): boolean {
    if (this.closed || this.socket !== undefined || !Number.isSafeInteger(input.afterBytes) || input.afterBytes < 0 ||
        input.afterBytes > this.bytesOut) return false;
    if (!this.updateClaimLease(
      input.grant.claim_lease_ms,
      input.grant.claim_lease_ttl_ms,
      input.claimRequestStartedAt ?? this.monotonicNow(),
    )) return false;
    this.socket = input.socket;
    this.resumeToken = input.grant.resume_token;
    this.cols = input.cols;
    this.rows = input.rows;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.bindBrowserLifecycle(input.socket);
    this.bindReadyBrowser(input.socket);
    this.agent.sendResize(this.sessionId, input.cols, input.rows);
    this.sendReady(true, input.afterBytes);
    this.replayScrollback(input.afterBytes);
    for (const message of input.queued ?? []) {
      if (this.isSessionClosed()) break;
      this.onClientMessage(message.data, message.isBinary);
    }
    logEvent('terminal_relay_session_resumed', {
      session_id: this.sessionId, tenant_id: this.grant.tenant_id, alias: this.grant.alias
    });
    return true;
  }

  private bindBrowserLifecycle(socket: WebSocket): void {
    socket.once('close', (code: number) => {
      if (this.socket !== socket || this.closed) return;
      this.socket = undefined;
      if (!this.resumeReady) {
        this.terminate(CLOSE_CODES.normal, 'browser_closed_before_ready');
        return;
      }
      // 1000 is an explicit orderly close, regardless of the client's human-readable reason. Only an abnormal
      // transport loss gets a reconnect grace; trusting one magic reason left old clients' normal closes holding a physical-container slot for the whole grace window.
      if (code === CLOSE_CODES.normal) {
        this.terminate(CLOSE_CODES.normal, 'browser_closed');
        return;
      }
      const grace = this.limits.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        this.terminate(CLOSE_CODES.going_away, 'reconnect_timeout');
      }, grace);
      this.reconnectTimer.unref();
      logEvent('terminal_relay_browser_detached', {
        session_id: this.sessionId, code, reconnect_grace_ms: grace
      });
    });
    socket.on('error', (error: unknown) => {
      logEvent('terminal_relay_browser_socket_error', {
        session_id: this.sessionId, error: errorLabel(error)
      });
    });
  }

  private bindReadyBrowser(socket: WebSocket): void {
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (this.socket === socket) this.onClientMessage(data, isBinary);
    });
  }

  private sendReady(resumed: boolean, streamOffset: number): void {
    this.resumeReady = true;
    this.sendControl({
      type: 'ready',
      session_id: this.sessionId,
      alias: this.grant.alias,
      tenant_id: this.grant.tenant_id,
      container: this.grant.container,
      runtime_user: this.grant.runtime_user,
      mode: this.grant.mode,
      expires_at: this.grant.session_expires_at,
      resumed,
      stream_offset: streamOffset,
      resume_token: this.resumeToken,
      claim_token: this.claimToken,
      claim_epoch: this.claimEpochValue,
      claim_lease_ms: Math.max(1, Math.floor(this.claimLeaseExpiresAt - this.monotonicNow())),
      relay_instance_id: this.grant.relay_instance_id,
    });
    const held = this.pendingNotices;
    this.pendingNotices = [];
    for (const notice of held) this.forwardNotice(notice.kind, notice.body);
  }

  terminate(code: number, reason: string, exitCode: number | null = null): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (exitCode !== null) this.exitCode = exitCode;
    this.clearTimers();
    this.stdin = [];
    this.stdinBytes = 0;
    this.pendingNotices = [];
    // A teardown mid-handshake must release `start()`, or the attach would hang forever.
    this.settleOpen?.(false);
    this.settleOpen = undefined;
    if (!this.agentClosed && this.agent.alive) this.agent.sendClose(this.sessionId, reason);
    this.agent.detachSession(this.sessionId);
    this.manager.release(this.sessionId, this.container);
    const socket = this.socket;
    if (socket?.readyState === WS_OPEN) {
      this.sendControl({ type: 'closed', reason, exit_code: this.exitCode });
      closeSocket(socket, code, reason);
    }
    this.socket = undefined;
    const recorded = this.recording?.close();
    this.recording = undefined;
    if (recorded?.capped === true) this.metrics.recording('capped');
    if (this.counted) this.metrics.sessionClosed(this.grant.mode, code);
    else this.metrics.closeCode(code);
    const report: SessionCloseReport = {
      reason,
      exit_code: this.exitCode,
      bytes_in: this.bytesIn,
      bytes_out: this.bytesOut,
      claim_token: this.claimToken,
      claim_epoch: this.claimEpochValue,
      ...(recorded === undefined
        ? {}
        : {
          input_batches: recorded.input_batches,
          recording_sha256: recorded.sha256,
          recording_capped: recorded.capped,
        }),
    };
    this.manager.enqueueCloseReport(this.sessionId, report);
    logEvent('terminal_relay_session_closed', {
      session_id: this.sessionId,
      alias: this.grant.alias,
      code,
      reason,
      exit_code: this.exitCode,
      bytes_in: this.bytesIn,
      bytes_out: this.bytesOut
    });
  }

  /** A writable TUI without a recording is not a mode: the open is refused, never downgraded. */
  private startRecording(): boolean {
    const requirement = recordingRequirement(this.grant.mode, this.limits);
    if (requirement === 'none') return true;
    try {
      this.recording = SessionRecording.open(this.sessionId, {
        directory: this.limits.recordingDir,
        maxBytes: this.limits.recordingMaxBytes,
        cols: this.cols,
        rows: this.rows,
      });
    } catch (error) {
      logEvent('terminal_relay_recording_unavailable', {
        session_id: this.sessionId, mode: this.grant.mode, error: errorLabel(error)
      });
      this.metrics.recording('refused');
      if (requirement === 'optional') return true;
      this.terminate(CLOSE_CODES.internal_error, 'recording_unavailable');
      return false;
    }
    this.metrics.recording('started');
    return true;
  }

  private recordingBroke(): boolean {
    if (this.recording?.broken !== true) return false;
    this.metrics.recording('failed');
    this.terminate(CLOSE_CODES.internal_error, 'recording_failed');
    return true;
  }

  /** Sends OPEN and resolves once the agent answers, or tears the session down trying. */
  private openOnAgent(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (value: boolean): void => {
        if (settled) return;
        settled = true;
        if (this.openTimer) clearTimeout(this.openTimer);
        this.openTimer = undefined;
        this.settleOpen = undefined;
        resolve(value);
      };
      this.settleOpen = settle;
      this.agent.attachSession(this.sessionId, {
        onOpenOk: () => { settle(true); },
        onAgentNotice: (kind, body) => { this.onAgentNotice(kind, body); },
        onOpenErr: (reason) => {
          // The agent is the second gate on the ticket: it may refuse what the relay accepted.
          const code = reason === 'ticket_invalid'
            ? CLOSE_CODES.ticket_invalid
            : reason === 'revoked' ? CLOSE_CODES.revoked : CLOSE_CODES.internal_error;
          this.metrics.openAttempt('denied');
          this.terminate(code, reason);
          settle(false);
        },
        onStdout: (data) => { this.onStdout(data); },
        onClosed: (exit) => {
          this.agentClosed = true;
          this.terminate(CLOSE_CODES.normal, exit.reason, exit.exit_code);
          settle(false);
        },
        onAgentGone: (reason) => {
          this.agentClosed = true;
          this.terminate(CLOSE_CODES.agent_offline, reason);
          settle(false);
        }
      });
      this.openTimer = setTimeout(() => {
        this.metrics.openAttempt('denied');
        this.terminate(CLOSE_CODES.internal_error, 'open_timeout');
        settle(false);
      }, this.limits.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);
      this.openTimer.unref();
      try {
        this.agent.sendOpen(this.sessionId, this.ticket, this.grant.mode, this.cols, this.rows);
      } catch (error) {
        logEvent('terminal_relay_open_failed', { session_id: this.sessionId, error: errorLabel(error) });
        this.metrics.openAttempt('denied');
        this.terminate(CLOSE_CODES.internal_error, 'open_failed');
        settle(false);
      }
    });
  }

  private onClientMessage(data: RawData, isBinary: boolean): void {
    if (this.closed) return;
    try {
      const message = parseClientMessage(data, isBinary);
      if (!message) {
        this.terminate(CLOSE_CODES.protocol_error, 'protocol_error');
        return;
      }
      if (message.type === 'ping') {
        // Only a read-only viewer has no keyboard: its ping proves presence without STDIN. A
        // writable session proves presence by typing or by the operator's explicit extension.
        if (isReadOnlyMode(this.grant.mode)) this.resetIdle();
        return;
      }
      if (message.type === 'resize') {
        this.cols = message.cols;
        this.rows = message.rows;
        this.agent.sendResize(this.sessionId, message.cols, message.rows);
        return;
      }
      if (message.type === 'terminal_response') {
        // The parser already validated DA/DSR. Mode is the second boundary: an interactive shell
        // uses normal STDIN, and only a TUI mode owes the remote emulator this answer.
        if (!isTuiMode(this.grant.mode)) {
          this.terminate(CLOSE_CODES.protocol_error, 'terminal_response_forbidden');
          return;
        }
        const response = Buffer.from(message.data, 'ascii');
        this.bytesIn += response.byteLength;
        this.metrics.bytesIn(response.byteLength);
        if (!this.agent.sendTerminalResponse(this.sessionId, response)) {
          this.terminate(CLOSE_CODES.slow_consumer, 'agent_input_backpressure');
        }
        return;
      }
      if (isReadOnlyMode(this.grant.mode)) {
        this.terminate(CLOSE_CODES.protocol_error, 'input_forbidden');
        return;
      }
      const bytes = Buffer.from(message.data, 'utf8');
      if (bytes.byteLength > MAX_INPUT_MESSAGE_BYTES
        || this.stdinBytes + bytes.byteLength > MAX_PENDING_STDIN_BYTES) {
        this.terminate(CLOSE_CODES.input_flood, 'input_flood');
        return;
      }
      this.bytesIn += bytes.byteLength;
      this.metrics.bytesIn(bytes.byteLength);
      this.stdin.push(bytes);
      this.stdinBytes += bytes.byteLength;
      this.resetIdle();
      if (this.stdinTimer === undefined) {
        this.stdinTimer = setTimeout(() => { this.flushStdin(); }, STDIN_COALESCE_MS);
        this.stdinTimer.unref();
      }
    } catch (error) {
      logEvent('terminal_relay_client_message_failed', { session_id: this.sessionId, error: errorLabel(error) });
      this.terminate(CLOSE_CODES.internal_error, 'client_message_failed');
    }
  }

  private onAgentNotice(kind: AgentNoticeKind, body: Record<string, unknown>): void {
    if (this.closed) return;
    // The console dispatches on `ready` first, so a notice that beats OPEN_OK waits behind it.
    if (!this.resumeReady) {
      if (this.pendingNotices.length < MAX_PENDING_NOTICES) this.pendingNotices.push({ kind, body });
      return;
    }
    this.forwardNotice(kind, body);
  }

  /** The relay is a pipe for these: it forwards the agent's object verbatim and only stamps the discriminator LAST, so a hostile agent cannot rename the frame the console dispatches on.
   * The bytes are metered and backpressured exactly like stdout — a GEOMETRY storm IS an output flood — but they stay out of `bytesOut`, which addresses the binary stream a resume replays. */
  private forwardNotice(kind: AgentNoticeKind, body: Record<string, unknown>): void {
    const frame = JSON.stringify({ ...body, type: kind });
    const bytes = Buffer.byteLength(frame, 'utf8');
    this.windowBytes += bytes;
    this.metrics.bytesOut(bytes);
    this.sendFrame(frame);
    this.applyBackpressure();
  }

  private flushStdin(): void {
    this.stdinTimer = undefined;
    if (this.closed || this.stdin.length === 0) return;
    const pending = Buffer.concat(this.stdin);
    this.stdin = [];
    this.stdinBytes = 0;
    this.recording?.recordInput(pending);
    if (this.recordingBroke()) return;
    try {
      if (!this.agent.sendStdin(this.sessionId, pending)) {
        this.terminate(CLOSE_CODES.input_flood, 'agent_input_backpressure');
      }
    } catch (error) {
      logEvent('terminal_relay_stdin_failed', { session_id: this.sessionId, error: errorLabel(error) });
      this.terminate(CLOSE_CODES.internal_error, 'stdin_failed');
    }
  }

  private onStdout(data: Buffer): void {
    if (this.closed || data.byteLength === 0) return;
    this.bytesOut += data.byteLength;
    this.windowBytes += data.byteLength;
    this.metrics.bytesOut(data.byteLength);
    this.rememberScrollback(data);
    this.recording?.recordOutput(data);
    if (this.recordingBroke()) return;
    // A read-only viewer cannot type, so its output is the only proof it is being watched. A writable session is NOT rearmed by output: that is what stops an abandoned tab living on.
    if (isReadOnlyMode(this.grant.mode)) this.resetIdle();
    const socket = this.socket;
    if (socket?.readyState !== WS_OPEN) return;
    // PTY output is always binary; control frames are always text. The client splits on that.
    try {
      socket.send(data, { binary: true });
      this.applyBackpressure();
    } catch (error) {
      logEvent('terminal_relay_output_send_failed', { session_id: this.sessionId, error: errorLabel(error) });
      this.terminate(CLOSE_CODES.slow_consumer, 'browser_output_failed');
    }
  }

  /** Bounded, offset-addressed tail used only after gateway-authorized resume of this same PTY. */
  private rememberScrollback(data: Buffer): void {
    const end = this.bytesOut;
    const start = end - data.byteLength;
    this.scrollback.chunks.push({ start, end, data });
    this.scrollback.bytes += data.byteLength;
    const limit = this.limits.scrollbackBytes;
    while (this.scrollback.bytes > limit) {
      const oldest = this.scrollback.chunks[0];
      if (oldest === undefined) break;
      const excess = this.scrollback.bytes - limit;
      if (oldest.data.byteLength <= excess) {
        this.scrollback.chunks.shift();
        this.scrollback.bytes -= oldest.data.byteLength;
        continue;
      }
      this.scrollback.chunks[0] = {
        start: oldest.start + excess,
        end: oldest.end,
        data: oldest.data.subarray(excess)
      };
      this.scrollback.bytes -= excess;
    }
  }

  private replayScrollback(afterBytes: number): void {
    const socket = this.socket;
    if (this.scrollback.bytes === 0 || socket?.readyState !== WS_OPEN || afterBytes >= this.bytesOut) return;
    const first = this.scrollback.chunks[0];
    if (first !== undefined && afterBytes < first.start) {
      this.sendControl({
        type: 'notice', level: 'warn',
        message: 'la desconexión superó el scrollback acotado; se repite únicamente la cola disponible'
      });
    } else {
      this.sendControl({ type: 'notice', level: 'info', message: 'reanudando desde el último byte confirmado' });
    }
    const chunks: Buffer[] = [];
    for (const chunk of this.scrollback.chunks) {
      if (chunk.end <= afterBytes) continue;
      const offset = Math.max(0, afterBytes - chunk.start);
      chunks.push(chunk.data.subarray(offset));
    }
    if (chunks.length > 0) socket.send(Buffer.concat(chunks), { binary: true });
  }

  private applyBackpressure(): void {
    const socket = this.socket;
    if (socket === undefined || socket.bufferedAmount <= BACKPRESSURE_HIGH_BYTES || this.drainTimer !== undefined) return;
    // An old agent does not know these tags. Only the slow consumer is closed: pausing its multiplexed TLS would freeze PONG, reads and every other session.
    if (!this.agent.supportsSessionOutputFlowControl
      || !this.agent.pauseSessionOutput(this.sessionId)) {
      this.terminate(CLOSE_CODES.slow_consumer, 'slow_browser');
      return;
    }
    this.outputPaused = true;
    this.drainTimer = setInterval(() => {
      const activeSocket = this.socket;
      if (this.closed || activeSocket === undefined || activeSocket.bufferedAmount < BACKPRESSURE_LOW_BYTES) {
        if (this.drainTimer) clearInterval(this.drainTimer);
        this.drainTimer = undefined;
        if (!this.closed && this.outputPaused) {
          this.outputPaused = false;
          if (!this.agent.resumeSessionOutput(this.sessionId)) {
            this.terminate(CLOSE_CODES.slow_consumer, 'agent_flow_control_failed');
          }
        }
      }
    }, BACKPRESSURE_POLL_MS);
    this.drainTimer.unref();
  }

  private startTimers(): void {
    this.resetIdle();
    const remaining = this.expiresAtMs - this.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      this.terminate(CLOSE_CODES.ttl_expired, 'ttl_expired');
      return;
    }
    this.ttlTimer = setTimeout(() => { this.terminate(CLOSE_CODES.ttl_expired, 'ttl_expired'); }, remaining);
    this.ttlTimer.unref();
    this.authzTimer = setInterval(() => void this.revalidate(), this.limits.authzIntervalMs);
    this.authzTimer.unref();
    this.windowTimer = setInterval(() => { this.closeWindow(); }, this.limits.outputWindowMs ?? DEFAULT_OUTPUT_WINDOW_MS);
    this.windowTimer.unref();
  }

  private resetIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { this.terminate(CLOSE_CODES.idle_timeout, 'idle_timeout'); }, this.limits.idleTimeoutMs);
    this.idleTimer.unref();
  }

  /** Re-asks the gateway whether this session may continue. An unreachable gateway is not an allow: once the grace
   * window is spent the terminal dies, because the alternative is a shell that outlives the revocation of its own permission. */
  private async revalidate(): Promise<void> {
    if (this.closed || this.authzInFlight) return;
    this.authzInFlight = true;
    const requestStartedAt = this.monotonicNow();
    try {
      const outcome = await this.gateway.authorizeSession(
        this.sessionId,
        this.claimToken,
        this.claimEpochValue,
      );
      if (this.isSessionClosed()) return;
      if (outcome.status === 'allow') {
        if (outcome.claim_epoch !== this.claimEpochValue
            || !this.updateClaimLease(
              outcome.claim_lease_ms,
              outcome.claim_lease_ttl_ms,
              requestStartedAt,
            )) {
          this.terminate(CLOSE_CODES.revoked, 'claim_lease_invalid');
          return;
        }
        this.lastAuthzOkAt = this.now();
        return;
      }
      if (outcome.status === 'control_released') {
        this.terminate(
          isWritableTuiMode(this.grant.mode) ? CLOSE_CODES.control_released : CLOSE_CODES.revoked,
          'control_released',
        );
        return;
      }
      if (outcome.status === 'revoked') {
        this.terminate(CLOSE_CODES.revoked, 'revoked');
        return;
      }
      if (this.now() - this.lastAuthzOkAt > this.limits.authzGraceMs) {
        this.terminate(CLOSE_CODES.revoked, 'authz_unreachable');
      }
    } catch (error) {
      logEvent('terminal_relay_authz_failed', { session_id: this.sessionId, error: errorLabel(error) });
      if (!this.isSessionClosed() && this.now() - this.lastAuthzOkAt > this.limits.authzGraceMs) {
        this.terminate(CLOSE_CODES.revoked, 'authz_unreachable');
      }
    } finally {
      this.authzInFlight = false;
    }
  }

  private closeWindow(): void {
    if (this.closed) return;
    const windowMs = this.limits.outputWindowMs ?? DEFAULT_OUTPUT_WINDOW_MS;
    const allowance = (this.limits.outputRateBytesPerSec * windowMs) / 1_000;
    const flooded = this.windowBytes > allowance;
    this.windowBytes = 0;
    this.floodWindows = flooded ? this.floodWindows + 1 : 0;
    if (this.floodWindows === FLOOD_WARN_WINDOWS) {
      this.sendControl({
        type: 'notice',
        level: 'warn',
        message: 'output rate is above the terminal limit; the session will close if it continues'
      });
      logEvent('terminal_relay_output_flood_warned', { session_id: this.sessionId, alias: this.grant.alias });
      return;
    }
    if (this.floodWindows >= FLOOD_CLOSE_WINDOWS) this.terminate(CLOSE_CODES.output_flood, 'output_flood');
  }

  private sendControl(message: Record<string, unknown>): void {
    this.sendFrame(JSON.stringify(message));
  }

  private sendFrame(frame: string): void {
    const socket = this.socket;
    if (socket?.readyState !== WS_OPEN) return;
    try {
      socket.send(frame);
    } catch (error) {
      logEvent('terminal_relay_control_send_failed', { session_id: this.sessionId, error: errorLabel(error) });
    }
  }

  private clearTimers(): void {
    if (this.stdinTimer) clearTimeout(this.stdinTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.ttlTimer) clearTimeout(this.ttlTimer);
    if (this.authzTimer) clearInterval(this.authzTimer);
    if (this.windowTimer) clearInterval(this.windowTimer);
    if (this.drainTimer) clearInterval(this.drainTimer);
    if (this.openTimer) clearTimeout(this.openTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.claimDeadlineTimer) clearTimeout(this.claimDeadlineTimer);
    this.stdinTimer = undefined;
    this.idleTimer = undefined;
    this.ttlTimer = undefined;
    this.authzTimer = undefined;
    this.windowTimer = undefined;
    this.drainTimer = undefined;
    this.openTimer = undefined;
    this.reconnectTimer = undefined;
    this.claimDeadlineTimer = undefined;
  }

  /** Converts a DB-derived remaining lease to a process-monotonic hard deadline. The request
   * start, not response receipt, is the base: a slow response only shortens the usable lease. */
  private updateClaimLease(remainingMs: number, ttlMs: number, requestStartedAt: number): boolean {
    const now = this.monotonicNow();
    if (!Number.isFinite(requestStartedAt) || requestStartedAt > now
        || !Number.isSafeInteger(remainingMs)
        || remainingMs <= CLAIM_DEADLINE_SAFETY_MARGIN_MS
        || !claimLeaseTtlSatisfied(ttlMs, this.limits)
        || remainingMs > ttlMs) return false;
    const expiresAt = requestStartedAt + remainingMs;
    const deadlineAt = expiresAt - CLAIM_DEADLINE_SAFETY_MARGIN_MS;
    if (!Number.isFinite(deadlineAt) || deadlineAt <= now) return false;
    this.claimLeaseExpiresAt = expiresAt;
    this.claimDeadlineAt = deadlineAt;
    if (this.claimDeadlineTimer) clearTimeout(this.claimDeadlineTimer);
    this.claimDeadlineTimer = setTimeout(() => {
      this.claimDeadlineTimer = undefined;
      this.terminate(CLOSE_CODES.revoked, 'claim_lease_expired');
    }, Math.max(0, deadlineAt - now));
    this.claimDeadlineTimer.unref();
    return true;
  }

  private claimIsLive(): boolean {
    return this.claimDeadlineAt > this.monotonicNow();
  }
}
