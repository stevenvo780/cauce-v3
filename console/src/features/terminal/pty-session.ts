/**
 * PTY session manager, OUTSIDE React on purpose: a terminal is not view state, so unmounting the
 * component must neither close the socket nor drop the scrollback.
 */
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './xterm-csp.css';
import 'virtual:cauce/xterm-ansi.css';

import {
  openSocket,
  stopHandshake,
  stopReconnect,
  stopViewerHeartbeat,
} from './pty-connection';
import { cancelPendingInput, queueInput } from './pty-input';
import { finishOutput, initTerminalWorker } from './pty-output';
import {
  COLUMNAS_MINIMAS,
  CUERPO_BASE,
  CUERPO_MINIMO,
  FUENTE_TERMINAL,
  TEMA_TERMINAL,
  documentoQueNiegaLosEstilos,
  holder,
  pintarPiel,
} from './pty-theme';
import type {
  PtyEntry,
  PtySessionOptions,
  PtySessionView,
} from './pty-types';

export type {
  PtyChannelState,
  PtyNotice,
  PtySessionOptions,
  PtySessionView,
} from './pty-types';

export {
  PTY_CLOSE_MESSAGES,
  PTY_HANDSHAKE_TIMEOUT_MS,
  PTY_RECONNECT_DELAYS_MS,
  PTY_VIEWER_HEARTBEAT_MS,
  esRespuestaTecnicaDelTerminal,
  ptyCloseMessage,
  websocketUrl,
} from './pty-types';

const IDLE_VIEW: PtySessionView = { state: 'connecting', notices: [], seguirAlFinal: true };
const entries = new Map<string, PtyEntry>();
const listeners = new Map<string, Set<() => void>>();

function publish(entry: PtyEntry, patch: Partial<PtySessionView>): void {
  entry.view = { ...entry.view, ...patch };
  for (const listener of listeners.get(entry.id) ?? []) listener();
}

/** Is the view watching the bottom of the buffer, or did the operator scroll up to read? */
function alFinal(entry: PtyEntry): boolean {
  try {
    const buffer = entry.terminal.buffer.active;
    return buffer.viewportY >= buffer.baseY;
  } catch {
    return true;
  }
}

function mantenerElFinal(entry: PtyEntry): void {
  if (!entry.pegadoAbajo) return;
  try {
    entry.terminal.scrollToBottom();
  } catch {
    // Headless
  }
}

function ajustarGeometria(entry: PtyEntry): void {
  let cuerpo = CUERPO_BASE;
  const objetivo = Math.max(COLUMNAS_MINIMAS, entry.columnasRemotas ?? 0);
  try {
    for (let intento = 0; intento < 3; intento += 1) {
      entry.terminal.options.fontSize = cuerpo;
      const propuesta = entry.fitAddon.proposeDimensions();
      if (!propuesta || !Number.isFinite(propuesta.cols) || propuesta.cols <= 0) break;
      if (propuesta.cols >= objetivo || cuerpo <= CUERPO_MINIMO) break;
      const siguiente = Math.max(CUERPO_MINIMO, Math.floor((cuerpo * propuesta.cols) / objetivo));
      if (siguiente >= cuerpo) break;
      cuerpo = siguiente;
    }
    entry.fitAddon.fit();
  } catch {
    // Headless or hidden panel
  }
  pintarPiel(entry);
  if (entry.terminal.cols !== entry.view.columnas) publish(entry, { columnas: entry.terminal.cols });
}

function sendResize(entry: PtyEntry): void {
  ajustarGeometria(entry);
  mantenerElFinal(entry);
  // Observation resizes nobody: the agent attaches with `-f ignore-size` and the frame is noise.
  if (entry.readOnly || entry.socket?.readyState !== WebSocket.OPEN) return;
  const { cols, rows } = entry.terminal;
  if (entry.geometriaDicha?.cols === cols && entry.geometriaDicha.rows === rows) return;
  entry.geometriaDicha = { cols, rows };
  entry.socket.send(JSON.stringify({ type: 'resize', cols, rows }));
}

const EVENTOS_DE_ENTRADA = ['beforeinput', 'input', 'paste', 'drop', 'compositionstart', 'compositionupdate', 'compositionend'] as const;

/** `harness_rw` starts without the keyboard and gains it on the take: the guard is re-armable. */
function aplicarSoloLectura(entry: PtyEntry, soloLectura: boolean): void {
  entry.readOnly = soloLectura;
  entry.terminal.options.cursorBlink = !soloLectura;
  entry.terminal.attachCustomKeyEventHandler(() => !soloLectura);
  if (soloLectura === (entry.bloqueoEntrada !== undefined)) return;
  if (!soloLectura) {
    entry.bloqueoEntrada?.();
    entry.bloqueoEntrada = undefined;
    return;
  }
  const bloquear = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const tipo of EVENTOS_DE_ENTRADA) entry.container.addEventListener(tipo, bloquear, true);
  entry.bloqueoEntrada = () => {
    for (const tipo of EVENTOS_DE_ENTRADA) entry.container.removeEventListener(tipo, bloquear, true);
  };
}

/** Creates the session once. Calling it again for a live session only re-reads its read-only bit. */
export function ensurePtySession(options: PtySessionOptions): void {
  const existing = entries.get(options.sessionId);
  if (existing) {
    existing.onClosed = options.onClosed;
    if (existing.readOnly !== (options.readOnly === true)) {
      aplicarSoloLectura(existing, options.readOnly === true);
      sendResize(existing);
    }
    return;
  }

  const container = document.createElement('div');
  container.className = 'pty-host';
  container.setAttribute('aria-label', 'Terminal PTY interactiva');
  holder().appendChild(container);

  const terminal = new Terminal({
    cursorBlink: options.readOnly !== true,
    disableStdin: false,
    convertEol: false,
    documentOverride: documentoQueNiegaLosEstilos(),
    fontFamily: FUENTE_TERMINAL,
    fontSize: CUERPO_BASE,
    lineHeight: 1.15,
    scrollback: 5000,
    theme: TEMA_TERMINAL,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const entry: PtyEntry = {
    id: options.sessionId,
    terminal,
    fitAddon,
    container,
    view: { state: 'connecting', notices: [], seguirAlFinal: true },
    readOnly: options.readOnly === true,
    inputChunks: [],
    inputBytes: 0,
    pegadoAbajo: true,
    disposers: [],
    onClosed: options.onClosed,
    closed: false,
    outputFinished: false,
    outputBytes: 0,
    reconnectAttempt: 0,
    options,
  };

  aplicarSoloLectura(entry, options.readOnly === true);
  entry.disposers.push(() => { entry.bloqueoEntrada?.(); });
  entries.set(options.sessionId, entry);
  pintarPiel(entry);

  try {
    terminal.open(container);
  } catch (error) {
    entry.view = { ...entry.view, renderError: error instanceof Error ? error.message : 'El renderer del terminal no pudo iniciar.' };
  }

  initTerminalWorker(entry);

  const input = terminal.onData((data) => { queueInput(entry, data, (message, closeCode) => {
    publish(entry, { state: 'error', message, closeCode });
  }); });
  entry.disposers.push(() => { input.dispose(); });

  const scroll = terminal.onScroll(() => {
    const abajo = alFinal(entry);
    if (abajo === entry.pegadoAbajo) return;
    entry.pegadoAbajo = abajo;
    publish(entry, { seguirAlFinal: abajo });
  });
  entry.disposers.push(() => { scroll.dispose(); });

  openSocket(
    entry,
    options,
    false,
    (patch) => { publish(entry, patch); },
    () => { sendResize(entry); },
  );
}

/** Returns to the bottom and reattaches the follow. Called by the view's "return to bottom" button. */
export function ptySessionVolverAlFinal(sessionId: string): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  entry.pegadoAbajo = true;
  try {
    entry.terminal.scrollToBottom();
  } catch {
    // No renderer
  }
  publish(entry, { seguirAlFinal: true });
}

export function subscribePtySession(sessionId: string, listener: () => void): () => void {
  const registered = listeners.get(sessionId) ?? new Set<() => void>();
  registered.add(listener);
  listeners.set(sessionId, registered);
  return () => {
    registered.delete(listener);
    if (registered.size === 0) listeners.delete(sessionId);
  };
}

export function readPtySession(sessionId: string): PtySessionView {
  return entries.get(sessionId)?.view ?? IDLE_VIEW;
}

export function attachPtySession(sessionId: string, wrapper: HTMLElement): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  wrapper.appendChild(entry.container);
  entry.resizeObserver?.disconnect();
  if (typeof ResizeObserver === 'function') {
    entry.resizeObserver ??= new ResizeObserver(() => { sendResize(entry); });
    entry.resizeObserver.observe(wrapper);
  }
  sendResize(entry);
}

export function detachPtySession(sessionId: string): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  entry.resizeObserver?.disconnect();
  holder().appendChild(entry.container);
}

export function closePtySession(sessionId: string, reason = 'console terminal closed'): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  entry.closed = true;
  cancelPendingInput(entry);
  stopViewerHeartbeat(entry);
  stopReconnect(entry);
  stopHandshake(entry);
  finishOutput(entry);
  entries.delete(sessionId);
  entry.resizeObserver?.disconnect();
  for (const dispose of entry.disposers) dispose();
  entry.worker?.terminate();
  if (entry.socket && entry.socket.readyState <= WebSocket.OPEN) entry.socket.close(1000, reason);
  entry.terminal.dispose();
  entry.container.remove();
}

export function ptySessionType(sessionId: string, data: string): void {
  entries.get(sessionId)?.terminal.input(data);
}

export function ptySessionPosicion(sessionId: string): { viewportY: number; baseY: number } {
  const entry = entries.get(sessionId);
  if (!entry) return { viewportY: 0, baseY: 0 };
  const buffer = entry.terminal.buffer.active;
  return { viewportY: buffer.viewportY, baseY: buffer.baseY };
}

export function ptySessionText(sessionId: string): string {
  const entry = entries.get(sessionId);
  if (!entry) return '';
  const buffer = entry.terminal.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buffer.length; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
  }
  return lines.join('\n').trimEnd();
}
