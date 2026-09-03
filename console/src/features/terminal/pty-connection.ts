import { cancelPendingInput } from './pty-input';
import { finishOutput, writeOutput } from './pty-output';
import {
  PTY_HANDSHAKE_TIMEOUT_MS,
  PTY_RECONNECT_DELAYS_MS,
  PTY_VIEWER_HEARTBEAT_MS,
  avisoDeEntradaRechazada,
  claimReady,
  geometriaRemota,
  ptyCloseMessage,
  websocketUrl,
  type PtyEntry,
  type PtySessionOptions,
  type PtySessionView,
} from './pty-types';

export function stopViewerHeartbeat(entry: PtyEntry): void {
  if (entry.heartbeatTimer !== undefined) window.clearInterval(entry.heartbeatTimer);
  entry.heartbeatTimer = undefined;
}

export function stopReconnect(entry: PtyEntry): void {
  if (entry.reconnectTimer !== undefined) window.clearTimeout(entry.reconnectTimer);
  entry.reconnectTimer = undefined;
}

export function stopHandshake(entry: PtyEntry): void {
  if (entry.handshakeTimer !== undefined) window.clearTimeout(entry.handshakeTimer);
  entry.handshakeTimer = undefined;
}

function startViewerHeartbeat(entry: PtyEntry): void {
  if (!entry.readOnly || entry.heartbeatTimer !== undefined) return;
  entry.heartbeatTimer = window.setInterval(() => {
    if (entry.socket?.readyState === WebSocket.OPEN) {
      entry.socket.send(JSON.stringify({ type: 'ping' }));
    }
  }, PTY_VIEWER_HEARTBEAT_MS);
}

function finishChannel(
  entry: PtyEntry,
  code: number,
  reason: string,
  publish: (patch: Partial<PtySessionView>) => void,
): void {
  cancelPendingInput(entry);
  stopViewerHeartbeat(entry);
  stopReconnect(entry);
  stopHandshake(entry);
  finishOutput(entry);
  const explained = ptyCloseMessage(code, reason);
  publish({
    state: entry.view.state === 'closed' ? 'closed' : code === 1000 ? 'closed' : 'error',
    message: entry.view.state === 'closed' && entry.view.message ? entry.view.message : explained,
    closeCode: code,
  });
  entry.onClosed?.(entry.view);
}

function rejectMalformedReady(
  entry: PtyEntry,
  publish: (patch: Partial<PtySessionView>) => void,
): void {
  const socket = entry.socket;
  entry.socket = undefined;
  if (socket && socket.readyState <= WebSocket.OPEN) socket.close(4400, 'invalid_ready');
  finishChannel(entry, 4400, 'invalid_ready', publish);
}

function handleControlFrame(
  entry: PtyEntry,
  raw: string,
  publish: (patch: Partial<PtySessionView>) => void,
  onReady: () => void,
): void {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    publish({ notices: [...entry.view.notices, { level: 'error', message: 'Frame de control ilegible del relay.' }] });
    return;
  }

  if (payload.type === 'ready') {
    const claim = claimReady(payload);
    if (claim === undefined) {
      rejectMalformedReady(entry, publish);
      return;
    }
    if (typeof payload.resume_token === 'string' && payload.resume_token.length >= 80 && payload.resume_token.length <= 1_024) {
      entry.resumeToken = payload.resume_token;
    }
    entry.claimToken = claim.claimToken;
    entry.claimEpoch = claim.claimEpoch;
    entry.claimLeaseMs = claim.claimLeaseMs;
    entry.reconnectAttempt = 0;
    stopReconnect(entry);
    publish({ state: 'open', message: undefined, ticketConsumido: true });
    startViewerHeartbeat(entry);
    onReady();
    try {
      entry.terminal.focus();
    } catch {
      // Focus is best-effort; a headless renderer has nothing to focus.
    }
    return;
  }
  if (payload.type === 'notice') {
    const level = typeof payload.level === 'string' ? payload.level : 'info';
    const message = typeof payload.message === 'string' ? payload.message : 'Aviso sin texto del relay.';
    publish({ notices: [...entry.view.notices, { level, message }] });
    return;
  }
  if (payload.type === 'input_refused') {
    publish({ notices: [...entry.view.notices, { level: 'warn', message: avisoDeEntradaRechazada(payload.reason) }] });
    return;
  }
  if (payload.type === 'geometry') {
    const remota = geometriaRemota(payload);
    if (remota === undefined) return;
    entry.columnasRemotas = remota.cols;
    publish({ columnasRemotas: remota.cols });
    onReady();
    return;
  }
  if (payload.type === 'closed') {
    const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
    const exitCode = typeof payload.exit_code === 'number' ? payload.exit_code : undefined;
    const suffix = exitCode === undefined ? '' : ` · exit ${String(exitCode)}`;
    publish({ state: 'closed', message: `${reason ?? 'El servidor cerró la sesión.'}${suffix}` });
    return;
  }
  publish({
    notices: [...entry.view.notices, { level: 'warn', message: `El relay mandó una trama de control que esta consola no conoce: ${typeof payload.type === 'string' ? payload.type : 'sin tipo'}` }],
  });
}

function scheduleReconnect(
  entry: PtyEntry,
  publish: (patch: Partial<PtySessionView>) => void,
  onReady: () => void,
): boolean {
  if (entry.closed || entry.resumeToken === undefined || entry.claimToken === undefined ||
      entry.claimEpoch === undefined || entry.claimLeaseMs === undefined ||
      entry.reconnectTimer !== undefined) return false;
  if (entry.reconnectAttempt >= PTY_RECONNECT_DELAYS_MS.length) return false;
  const delay = PTY_RECONNECT_DELAYS_MS[entry.reconnectAttempt];
  entry.reconnectAttempt += 1;
  publish({
    state: 'connecting',
    message: `Canal interrumpido; reanudando el mismo PTY (${String(entry.reconnectAttempt)}/${String(PTY_RECONNECT_DELAYS_MS.length)}).`,
    closeCode: undefined,
  });
  entry.reconnectTimer = window.setTimeout(() => {
    entry.reconnectTimer = undefined;
    openSocket(entry, entry.options, true, publish, onReady);
  }, delay);
  return true;
}

export function openSocket(
  entry: PtyEntry,
  options: PtySessionOptions,
  resume: boolean,
  publish: (patch: Partial<PtySessionView>) => void,
  onReady: () => void,
): void {
  let socket: WebSocket;
  try {
    socket = new WebSocket(websocketUrl(options.websocketPath));
  } catch (error) {
    if (resume && scheduleReconnect(entry, publish, onReady)) return;
    publish({ state: 'error', message: error instanceof Error ? error.message : 'Endpoint PTY inválido.' });
    return;
  }
  entry.socket = socket;
  socket.binaryType = 'arraybuffer';
  stopHandshake(entry);
  entry.handshakeTimer = window.setTimeout(() => {
    if (entry.closed || entry.socket !== socket || socket.readyState !== WebSocket.CONNECTING) return;
    entry.handshakeTimer = undefined;
    entry.socket = undefined;
    socket.close(4400, 'handshake_timeout');
    if (resume && scheduleReconnect(entry, publish, onReady)) return;
    cancelPendingInput(entry);
    stopViewerHeartbeat(entry);
    stopReconnect(entry);
    finishOutput(entry);
    publish({
      state: 'error',
      message: `La conexión WebSocket no completó el handshake en ${String(Math.round(PTY_HANDSHAKE_TIMEOUT_MS / 1000))} s. `
        + 'No se reutilizó el ticket de un solo uso; pedí una sesión nueva.',
      closeCode: undefined,
    });
    entry.onClosed?.(entry.view);
  }, PTY_HANDSHAKE_TIMEOUT_MS);

  socket.onopen = () => {
    if (entry.closed || entry.socket !== socket) return;
    stopHandshake(entry);
    try {
      entry.fitAddon.fit();
    } catch {
      // Geometry falls back to the terminal defaults; attach still carries explicit cols/rows.
    }
    entry.geometriaDicha = { cols: entry.terminal.cols, rows: entry.terminal.rows };
    socket.send(JSON.stringify(resume ? {
      type: 'resume',
      session_id: options.sessionId,
      resume_token: entry.resumeToken,
      prior_claim_token: entry.claimToken,
      prior_claim_epoch: entry.claimEpoch,
      after_bytes: entry.outputBytes,
      cols: entry.terminal.cols,
      rows: entry.terminal.rows,
    } : {
      type: 'attach',
      session_id: options.sessionId,
      ticket: options.ticket,
      cols: entry.terminal.cols,
      rows: entry.terminal.rows,
    }));
    publish({
      state: 'attaching',
      message: resume ? 'Revalidando continuidad y reanudando el mismo PTY.' : 'Ticket enviado; esperando autorización del relay.',
    });
  };

  socket.onmessage = (event: MessageEvent<string | ArrayBuffer | Blob>) => {
    if (typeof event.data === 'string') {
      handleControlFrame(entry, event.data, publish, onReady);
      return;
    }
    const blob = event.data as Blob;
    if (typeof blob.arrayBuffer === 'function') {
      void blob.arrayBuffer().then((buffer) => {
        if (!entry.closed) {
          entry.outputBytes += buffer.byteLength;
          writeOutput(entry, buffer);
        }
      });
      return;
    }
    const buffer = event.data as ArrayBuffer;
    entry.outputBytes += buffer.byteLength;
    writeOutput(entry, buffer);
  };

  socket.onclose = (event: CloseEvent) => {
    if (entry.socket !== socket || entry.closed) return;
    stopHandshake(entry);
    entry.socket = undefined;
    cancelPendingInput(entry);
    stopViewerHeartbeat(entry);
    if (event.code === 1006 && scheduleReconnect(entry, publish, onReady)) return;
    finishChannel(entry, event.code, event.reason, publish);
  };

  socket.onerror = () => {
    if (entry.view.state === 'closed' || entry.view.closeCode !== undefined) return;
    if (resume) return;
    publish({ state: 'error', message: 'El backend cerró o rechazó el canal PTY.' });
  };
}
