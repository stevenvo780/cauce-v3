import type { TLSSocket } from 'node:tls';
import {
  decodeDataFrame, decodeJsonFrame, encodeDataFrame, encodeFrame, encodeJsonFrame,
  FramingError, FRAME_TAGS, MAX_DATA_BYTES, type Frame
} from './framing.js';
import type { AgentPresence, TerminalMode } from './gateway-client.js';
import { errorLabel, logEvent } from './log.js';
import {
  AGENT_PING_INTERVAL_MS,
  AGENT_PONG_TIMEOUT_MS,
  FEATURE_READ_GOVERNANCE,
  FEATURE_READ_GOVERNANCE_DONE,
  FEATURE_SESSION_OUTPUT_FLOW_CONTROL,
  FEATURE_WRITE_GOVERNANCE,
  FEATURE_WRITE_GOVERNANCE_BATCH,
  MAX_AGENT_CRITICAL_QUEUE_BYTES,
  MAX_AGENT_READS_IN_FLIGHT,
  MAX_AGENT_WRITE_QUEUE_BYTES,
  MAX_TERMINAL_READ_TOMBSTONES,
  agentKey,
  integerField,
  stringField,
  type AgentGovernanceBatchEntry,
  type AgentHello,
  type AgentReadHandlers,
  type AgentSessionHandlers,
  type AgentWriteHandlers,
} from './agent-hello.js';

/** One live agent socket. Frame routing to sessions lives here so the leg stays a registry. */
export class AgentConnection {
  readonly hello: AgentHello;
  readonly fingerprint: string;
  readonly connectedAt: Date;
  private readonly socket: TLSSocket;
  private readonly sessions = new Map<string, AgentSessionHandlers>();
  /** Governance reads in flight, by `request_id`. Almost always empty. */
  private readonly reads = new Map<string, AgentReadHandlers>();
  /** Operations closed correctly / by READ_ERR; never grows without bound. */
  private readonly terminalReads = new Set<string>();
  /** Governed writes in flight. Separated from PTY and from reads by capacity negotiation. */
  private readonly writes = new Map<string, AgentWriteHandlers>();
  private readonly ping: NodeJS.Timeout;
  private lastPongAt: number;
  private queuedWrites: Buffer[] = [];
  private queuedWriteBytes = 0;
  private waitingDrain = false;
  private closed = false;

  constructor(socket: TLSSocket, hello: AgentHello, fingerprint: string, now: () => number) {
    this.socket = socket;
    this.hello = hello;
    this.fingerprint = fingerprint;
    this.connectedAt = new Date(now());
    this.lastPongAt = now();
    this.ping = setInterval(() => {
      if (now() - this.lastPongAt > AGENT_PONG_TIMEOUT_MS) {
        this.destroy('pong_timeout');
        return;
      }
      void this.write(encodeFrame(FRAME_TAGS.PING));
    }, AGENT_PING_INTERVAL_MS);
    this.ping.unref();
  }

  get key(): string {
    return agentKey(this.hello.tenant_id, this.hello.alias);
  }

  get container(): string {
    return this.hello.container_id;
  }

  get alive(): boolean {
    return !this.closed;
  }

  presence(): AgentPresence {
    return {
      tenant_id: this.hello.tenant_id,
      alias: this.hello.alias,
      container_id: this.hello.container_id,
      generation: this.hello.generation,
      image_id: this.hello.image_id,
      runtime_user: this.hello.runtime_user,
      runtime_uid: this.hello.runtime_uid,
      harness: this.hello.harness,
      ...(this.hello.runtime_facts_observed === undefined
        ? {} : { runtime_facts_observed: this.hello.runtime_facts_observed }),
      // Propagated only if it arrived. The gateway needs it to compose the governance file path;
      // without it it answers "unidentified container" instead of guessing a path.
      ...(this.hello.home === undefined ? {} : { home: this.hello.home }),
      ...(this.hello.codex_home === undefined ? {} : { codex_home: this.hello.codex_home }),
      ...(this.hello.claude_config_dir === undefined
        ? {} : { claude_config_dir: this.hello.claude_config_dir }),
      ...(this.hello.openclaw_workspace === undefined
        ? {} : { openclaw_workspace: this.hello.openclaw_workspace }),
      ...(this.hello.cwd === undefined ? {} : { cwd: this.hello.cwd }),
      ...(this.hello.workspace_root === undefined
        ? {} : { workspace_root: this.hello.workspace_root }),
      ...(this.hello.project_root === undefined
        ? {} : { project_root: this.hello.project_root }),
      ...(this.hello.project_doc_max_bytes === undefined
        ? {} : { project_doc_max_bytes: this.hello.project_doc_max_bytes }),
      ...(this.hello.project_doc_fallback_filenames === undefined
        ? {} : { project_doc_fallback_filenames: this.hello.project_doc_fallback_filenames }),
      agent_version: this.hello.agent_version,
      modes: this.hello.modes,
      connected_since: this.connectedAt.toISOString()
    };
  }

  attachSession(sessionId: string, handlers: AgentSessionHandlers): void {
    this.sessions.set(sessionId, handlers);
  }

  detachSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** False for any agent that does not advertise it, including any build older than this one. */
  get supportsGovernanceRead(): boolean {
    return this.hello.features.includes(FEATURE_READ_GOVERNANCE);
  }

  get supportsGovernanceReadDone(): boolean {
    return this.hello.features.includes(FEATURE_READ_GOVERNANCE_DONE);
  }

  get supportsGovernanceWrite(): boolean {
    return this.hello.features.includes(FEATURE_WRITE_GOVERNANCE);
  }

  get supportsGovernanceWriteBatch(): boolean {
    return this.hello.features.includes(FEATURE_WRITE_GOVERNANCE_BATCH);
  }

  get supportsSessionOutputFlowControl(): boolean {
    return this.hello.features.includes(FEATURE_SESSION_OUTPUT_FLOW_CONTROL);
  }

  attachRead(requestId: string, handlers: AgentReadHandlers): boolean {
    if (this.closed || this.reads.has(requestId) || this.terminalReads.has(requestId)
        || this.reads.size >= MAX_AGENT_READS_IN_FLIGHT) return false;
    this.reads.set(requestId, handlers);
    return true;
  }

  detachRead(requestId: string, terminal = false): void {
    this.reads.delete(requestId);
    if (!terminal) return;
    this.terminalReads.delete(requestId);
    if (this.terminalReads.size >= MAX_TERMINAL_READ_TOMBSTONES) {
      // Evicting the oldest would let a late DATA for that id be silently dropped. The transport
      // is closed and the agent reconnects clean; so the memory cap does not weaken ordering.
      this.destroy('read_tombstone_capacity');
      return;
    }
    this.terminalReads.add(requestId);
  }

  attachWrite(requestId: string, handlers: AgentWriteHandlers): void {
    this.writes.set(requestId, handlers);
  }

  detachWrite(requestId: string): void {
    this.writes.delete(requestId);
  }

  /**
   * Requests a governance file. The `requestId` also travels as the 36-byte prefix of each
   * READ_DATA, so it has to be a lowercase hyphenated UUID or the agent will not be able to
   * encode the response.
   */
  sendRead(requestId: string, kind: 'file' | 'dir', path: string): void {
    void this.write(encodeJsonFrame(FRAME_TAGS.READ, { request_id: requestId, kind, path }));
  }

  /**
   * Sends a complete transaction. The precondition lives in WRITE and the binary content in
   * WRITE_DATA; nothing is interpolated into argv, shell JSON or any command.
   */
  sendWrite(
    requestId: string,
    path: string,
    operation: 'replace' | 'create',
    expectedSha: string | undefined,
    contentSha: string,
    content: Buffer
  ): boolean {
    if (!this.supportsGovernanceWrite) return false;
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < content.byteLength; offset += MAX_DATA_BYTES) {
      chunks.push(encodeDataFrame(
        FRAME_TAGS.WRITE_DATA,
        requestId,
        content.subarray(offset, offset + MAX_DATA_BYTES)
      ));
    }
    const begin = encodeJsonFrame(FRAME_TAGS.WRITE, {
      request_id: requestId,
      path,
      operation,
      ...(expectedSha === undefined ? {} : { expected_sha: expectedSha }),
      content_sha: contentSha,
      bytes: content.byteLength,
      chunks: chunks.length
    });
    return this.writeBatch([begin, ...chunks]);
  }

  cancelWrite(requestId: string): void {
    if (!this.supportsGovernanceWrite) return;
    void this.write(encodeJsonFrame(FRAME_TAGS.WRITE_CANCEL, { request_id: requestId }));
  }

  /**
   * Envía el perfil como una sola transacción. Los DATA van en el mismo orden que `entries`, y el
   * agente no preflighta ni toca disco hasta haber recibido/verificado todos sus digests.
   */
  sendGovernanceWriteBatch(requestId: string, entries: readonly AgentGovernanceBatchEntry[]): boolean {
    if (!this.supportsGovernanceWriteBatch) return false;
    const frames: Buffer[] = [];
    const metadata = entries.map((entry) => {
      if (entry.mode === 'verify') {
        return {
          path: entry.path,
          mode: entry.mode,
          operation: entry.operation,
          ...(entry.expectedSha === undefined ? {} : { expected_sha: entry.expectedSha }),
          bytes: 0,
          chunks: 0,
        };
      }
      let chunks = 0;
      for (let offset = 0; offset < entry.content.byteLength; offset += MAX_DATA_BYTES) {
        frames.push(encodeDataFrame(
          FRAME_TAGS.WRITE_BATCH_DATA,
          requestId,
          entry.content.subarray(offset, offset + MAX_DATA_BYTES)
        ));
        chunks += 1;
      }
      return {
        path: entry.path,
        mode: entry.mode,
        operation: entry.operation,
        ...(entry.expectedSha === undefined ? {} : { expected_sha: entry.expectedSha }),
        content_sha: entry.contentSha,
        bytes: entry.content.byteLength,
        chunks,
      };
    });
    const begin = encodeJsonFrame(FRAME_TAGS.WRITE_BATCH, { request_id: requestId, entries: metadata });
    return this.writeBatch([begin, ...frames]);
  }

  cancelGovernanceWriteBatch(requestId: string): void {
    if (!this.supportsGovernanceWriteBatch) return;
    void this.write(encodeJsonFrame(FRAME_TAGS.WRITE_BATCH_CANCEL, { request_id: requestId }));
  }

  sendOpen(sessionId: string, ticket: string, mode: TerminalMode, cols: number, rows: number): void {
    void this.write(encodeJsonFrame(FRAME_TAGS.OPEN, { session_id: sessionId, ticket, mode, cols, rows }));
  }

  /** Chunked to the wire limit. `false` means the bounded TLS queue refused more input. */
  sendStdin(sessionId: string, data: Buffer): boolean {
    const frames: Buffer[] = [];
    for (let offset = 0; offset < data.byteLength; offset += MAX_DATA_BYTES) {
      frames.push(encodeDataFrame(
        FRAME_TAGS.STDIN,
        sessionId,
        data.subarray(offset, offset + MAX_DATA_BYTES)
      ));
    }
    return this.writeBatch(frames);
  }

  /** Respuesta técnica ya validada; el tag separado mantiene STDIN fuera de los viewers. */
  sendTerminalResponse(sessionId: string, data: Buffer): boolean {
    const frames: Buffer[] = [];
    for (let offset = 0; offset < data.byteLength; offset += MAX_DATA_BYTES) {
      frames.push(encodeDataFrame(
        FRAME_TAGS.TERMINAL_RESPONSE,
        sessionId,
        data.subarray(offset, offset + MAX_DATA_BYTES)
      ));
    }
    return this.writeBatch(frames);
  }

  sendResize(sessionId: string, cols: number, rows: number): void {
    void this.write(encodeJsonFrame(FRAME_TAGS.RESIZE, { session_id: sessionId, cols, rows }));
  }

  sendClose(sessionId: string, reason: string): boolean {
    const accepted = this.writeCritical(encodeJsonFrame(FRAME_TAGS.CLOSE, { session_id: sessionId, reason }));
    if (!accepted) this.destroy('critical_close_backpressure');
    return accepted;
  }

  pauseSessionOutput(sessionId: string): boolean {
    if (!this.supportsSessionOutputFlowControl) return false;
    return this.write(encodeJsonFrame(FRAME_TAGS.PAUSE_OUTPUT, { session_id: sessionId }));
  }

  resumeSessionOutput(sessionId: string): boolean {
    if (!this.supportsSessionOutputFlowControl) return false;
    return this.write(encodeJsonFrame(FRAME_TAGS.RESUME_OUTPUT, { session_id: sessionId }));
  }

  destroy(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ping);
    // Las lecturas en vuelo se avisan igual que las sesiones: si no, se quedan esperando hasta
    // que venza su temporizador y el que pregunta ve «tardó» donde lo que pasó fue «se cayó».
    const handlers = [...this.sessions.values(), ...this.reads.values(), ...this.writes.values()];
    this.sessions.clear();
    this.reads.clear();
    this.terminalReads.clear();
    this.writes.clear();
    this.queuedWrites = [];
    this.queuedWriteBytes = 0;
    this.waitingDrain = false;
    this.socket.destroy();
    for (const handler of handlers) {
      try {
        handler.onAgentGone(reason);
      } catch (error) {
        logEvent('terminal_relay_agent_gone_handler_failed', { error: errorLabel(error) });
      }
    }
  }

  /** Called by the leg for every decoded frame after HELLO_ACK. */
  handleFrame(frame: Frame, now: () => number): void {
    if (frame.tag === FRAME_TAGS.PONG) {
      this.lastPongAt = now();
      return;
    }
    if (frame.tag === FRAME_TAGS.STDOUT) {
      const data = decodeDataFrame(frame.payload);
      this.dispatch(data.sessionId, (handlers) => { handlers.onStdout(data.data); });
      return;
    }
    if (frame.tag === FRAME_TAGS.OPEN_OK) {
      const body = decodeJsonFrame(frame.payload);
      const sessionId = stringField(body, 'session_id');
      if (sessionId === undefined) throw new FramingError('OPEN_OK without a session id');
      const pid = integerField(body, 'pid') ?? 0;
      this.dispatch(sessionId, (handlers) => { handlers.onOpenOk(pid); });
      return;
    }
    if (frame.tag === FRAME_TAGS.OPEN_ERR) {
      const body = decodeJsonFrame(frame.payload);
      const sessionId = stringField(body, 'session_id');
      if (sessionId === undefined) throw new FramingError('OPEN_ERR without a session id');
      this.dispatch(sessionId, (handlers) => { handlers.onOpenErr(stringField(body, 'reason') ?? 'open_failed'); });
      return;
    }
    if (frame.tag === FRAME_TAGS.CLOSED) {
      const body = decodeJsonFrame(frame.payload);
      const sessionId = stringField(body, 'session_id');
      if (sessionId === undefined) throw new FramingError('CLOSED without a session id');
      const exitCode = integerField(body, 'exit_code');
      this.dispatch(sessionId, (handlers) => { handlers.onClosed({
        exit_code: exitCode ?? null,
        signal: stringField(body, 'signal') ?? null,
        reason: stringField(body, 'reason') ?? 'agent_closed'
      }); });
      return;
    }
    if (frame.tag === FRAME_TAGS.READ_OK) {
      const body = decodeJsonFrame(frame.payload);
      const requestId = stringField(body, 'request_id');
      if (requestId === undefined) throw new FramingError('READ_OK without a request id');
      this.dispatchRead(requestId, 'ok', (handlers) => { handlers.onReadOk(body); });
      return;
    }
    if (frame.tag === FRAME_TAGS.READ_ERR) {
      const body = decodeJsonFrame(frame.payload);
      const requestId = stringField(body, 'request_id');
      if (requestId === undefined) throw new FramingError('READ_ERR without a request id');
      this.dispatchRead(requestId, 'error', (handlers) => { handlers.onReadErr({
        code: stringField(body, 'error') ?? 'unknown',
        reason: stringField(body, 'reason') ?? 'read_failed'
      }); });
      return;
    }
    if (frame.tag === FRAME_TAGS.READ_DATA) {
      // Mismo prefijo de 36 bytes que STDOUT, pero lo que lleva es el `request_id`.
      const data = decodeDataFrame(frame.payload);
      this.dispatchRead(data.sessionId, 'data', (handlers) => { handlers.onReadData(data.data); });
      return;
    }
    if (frame.tag === FRAME_TAGS.READ_DONE) {
      const body = decodeJsonFrame(frame.payload);
      const requestId = stringField(body, 'request_id');
      if (requestId === undefined) throw new FramingError('READ_DONE without a request id');
      this.dispatchRead(requestId, 'done', (handlers) => { handlers.onReadDone(body); });
      return;
    }
    if (frame.tag === FRAME_TAGS.WRITE_OK) {
      const body = decodeJsonFrame(frame.payload);
      const requestId = stringField(body, 'request_id');
      if (requestId === undefined) throw new FramingError('WRITE_OK without a request id');
      this.dispatchWrite(requestId, (handlers) => { handlers.onWriteOk(body); });
      return;
    }
    if (frame.tag === FRAME_TAGS.WRITE_ERR) {
      const body = decodeJsonFrame(frame.payload);
      const requestId = stringField(body, 'request_id');
      if (requestId === undefined) throw new FramingError('WRITE_ERR without a request id');
      this.dispatchWrite(requestId, (handlers) => { handlers.onWriteErr({
        code: stringField(body, 'error') ?? 'unknown',
        reason: stringField(body, 'reason') ?? 'write_failed'
      }); });
      return;
    }
    if (frame.tag === FRAME_TAGS.WRITE_BATCH_OK) {
      const body = decodeJsonFrame(frame.payload);
      const requestId = stringField(body, 'request_id');
      if (requestId === undefined) throw new FramingError('WRITE_BATCH_OK without a request id');
      this.dispatchWrite(requestId, (handlers) => { handlers.onWriteOk(body); });
      return;
    }
    if (frame.tag === FRAME_TAGS.WRITE_BATCH_ERR) {
      const body = decodeJsonFrame(frame.payload);
      const requestId = stringField(body, 'request_id');
      if (requestId === undefined) throw new FramingError('WRITE_BATCH_ERR without a request id');
      this.dispatchWrite(requestId, (handlers) => { handlers.onWriteErr({
        code: stringField(body, 'error') ?? 'unknown',
        reason: stringField(body, 'reason') ?? 'write_batch_failed'
      }); });
      return;
    }
    // AGENT_HELLO after the handshake, or any frame only the relay may send, is a violation.
    throw new FramingError('unexpected frame from the agent');
  }

  private dispatchRead(
    requestId: string,
    frame: 'ok' | 'data' | 'done' | 'error',
    apply: (handlers: AgentReadHandlers) => void,
  ): void {
    const handlers = this.reads.get(requestId);
    if (!handlers) {
      // Un id inventado o una lectura abandonada por timeout no compromete las PTY. En cambio,
      // DATA después de un cierre terminal contradice el orden TCP acreditado: la conexión queda
      // degradada y se cierra, en vez de aceptar éxito y tirar silenciosamente la evidencia.
      if (frame === 'data' && this.terminalReads.has(requestId)) {
        this.destroy('read_data_after_terminal');
        throw new FramingError('READ_DATA after terminal read frame');
      }
      return;
    }
    try {
      apply(handlers);
    } catch (error) {
      logEvent('terminal_relay_read_handler_failed', { request_id: requestId, error: errorLabel(error) });
    }
  }

  private dispatchWrite(requestId: string, apply: (handlers: AgentWriteHandlers) => void): void {
    const handlers = this.writes.get(requestId);
    // ACK tardío después de timeout/cancelación: se descarta sin afectar las PTY multiplexadas.
    if (!handlers) return;
    try {
      apply(handlers);
    } catch (error) {
      logEvent('terminal_relay_write_handler_failed', { request_id: requestId, error: errorLabel(error) });
    }
  }

  private dispatch(sessionId: string, apply: (handlers: AgentSessionHandlers) => void): void {
    const handlers = this.sessions.get(sessionId);
    // Frames for a session we already closed are stale, not fatal: drop them.
    if (!handlers) return;
    try {
      apply(handlers);
    } catch (error) {
      logEvent('terminal_relay_session_handler_failed', { session_id: sessionId, error: errorLabel(error) });
    }
  }

  /**
   * Node acepta la trama que hace que `write()` devuelva false; sólo las siguientes esperan
   * `drain`. La cola propia está acotada para que un browser que pega más rápido que el TLS no
   * convierta al relay en almacenamiento. No se pausa nunca el lado legible del socket.
   */
  private write(frame: Buffer): boolean {
    if (this.closed || this.socket.destroyed) return false;
    if (this.waitingDrain) {
      if (this.queuedWriteBytes + frame.byteLength > MAX_AGENT_WRITE_QUEUE_BYTES) return false;
      this.queuedWrites.push(frame);
      this.queuedWriteBytes += frame.byteLength;
      return true;
    }
    if (!this.socket.write(frame)) {
      this.waitingDrain = true;
      this.socket.once('drain', () => { this.flushWrites(); });
    }
    return true;
  }

  /**
   * CLOSE may not be silently discarded behind PTY/data traffic. A small reserved tail accepts
   * every close for the bounded session set; if even that cannot fit, destroying TLS is the safe
   * signal because the pty-agent's teardown SIGHUPs and then SIGKILLs every child.
   */
  private writeCritical(frame: Buffer): boolean {
    if (this.closed || this.socket.destroyed) return false;
    if (this.waitingDrain) {
      if (this.queuedWriteBytes + frame.byteLength >
          MAX_AGENT_WRITE_QUEUE_BYTES + MAX_AGENT_CRITICAL_QUEUE_BYTES) return false;
      this.queuedWrites.push(frame);
      this.queuedWriteBytes += frame.byteLength;
      return true;
    }
    if (!this.socket.write(frame)) {
      this.waitingDrain = true;
      this.socket.once('drain', () => { this.flushWrites(); });
    }
    return true;
  }

  /** Preflight de una transacción: nunca deja media escritura en la cola propia acotada. */
  private writeBatch(frames: readonly Buffer[]): boolean {
    if (this.closed || this.socket.destroyed) return false;
    const total = frames.reduce((bytes, frame) => bytes + frame.byteLength, 0);
    if (this.waitingDrain && this.queuedWriteBytes + total > MAX_AGENT_WRITE_QUEUE_BYTES) return false;
    for (const frame of frames) {
      if (!this.write(frame)) return false;
    }
    return true;
  }

  private flushWrites(): void {
    if (this.closed || this.socket.destroyed) return;
    this.waitingDrain = false;
    while (this.queuedWrites.length > 0) {
      const frame = this.queuedWrites.shift();
      if (frame === undefined) break;
      this.queuedWriteBytes -= frame.byteLength;
      if (!this.socket.write(frame)) {
        this.waitingDrain = true;
        this.socket.once('drain', () => { this.flushWrites(); });
        return;
      }
    }
  }
}
