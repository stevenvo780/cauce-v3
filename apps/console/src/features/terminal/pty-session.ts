/**
 * PTY session manager. It lives OUTSIDE React on purpose.
 *
 * A terminal is not view state: unmounting the component (a tab switch, a layout reflow, a
 * re-render of the workspace) must not close the socket nor drop the scrollback. So the
 * terminal, its addon, its DOM node and its socket are owned by this module; React only lends
 * a wrapper and the node is REPARENTED into it. When the view hides, the node returns to a
 * detached holder and the session keeps running.
 *
 * Nothing is persisted: no localStorage, no sessionStorage, no ticket in the URL.
 */
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

export type PtyChannelState = 'connecting' | 'attaching' | 'open' | 'closed' | 'error';

export interface PtyNotice {
  level: string;
  message: string;
}

/** Immutable snapshot consumed by React through `useSyncExternalStore`. */
export interface PtySessionView {
  state: PtyChannelState;
  message?: string;
  closeCode?: number;
  notices: PtyNotice[];
  /** The DOM renderer refused to start (headless/jsdom); the channel may still be live. */
  renderError?: string;
}

export interface PtySessionOptions {
  sessionId: string;
  websocketPath: string;
  ticket: string;
  /**
   * Observación en solo lectura: la consola NO manda teclas por este canal.
   *
   * Es una traba de este cliente, no una frontera de seguridad: el candado real es el
   * `attach-session -r` con el que el agente PTY se engancha a la tmux del alias, del lado del
   * servidor. Se dicen las dos cosas para que nadie confunda una con la otra.
   */
  readOnly?: boolean;
  onClosed?: (view: PtySessionView) => void;
}

/** Server close codes translated to plain Spanish for the operator. */
export const PTY_CLOSE_MESSAGES: Readonly<Record<number, string>> = {
  1011: 'Error interno del relay.',
  4400: 'Error de protocolo en el canal PTY.',
  4401: 'Ticket inválido o vencido; hay que pedir una sesión nueva.',
  4403: 'Permiso revocado durante la sesión.',
  4404: 'El agente PTY no está conectado.',
  4408: 'Sesión cerrada por inactividad.',
  4409: 'Ya hay una sesión abierta en ese contenedor.',
  4413: 'Sesión cortada por exceso de salida.',
  4423: 'Venció el tiempo máximo de sesión.',
};

export function ptyCloseMessage(code?: number, reason?: string | null): string {
  const mapped = code === undefined ? undefined : PTY_CLOSE_MESSAGES[code];
  if (mapped) return mapped;
  if (code === 1000) return 'Canal PTY cerrado.';
  const detail = typeof reason === 'string' && reason.trim() ? ` · ${reason.trim()}` : '';
  return `Canal PTY cerrado por el servidor (código ${code ?? 'UNKNOWN'})${detail}.`;
}

/** Same-origin validation kept from the original component: no credentials, no query, no fragment. */
export function websocketUrl(path: string): string {
  const url = new URL(path, window.location.href);
  if (url.host !== window.location.host) throw new Error('PTY WebSocket must be same-origin');
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Invalid PTY WebSocket protocol');
  if (url.username || url.password || url.search || url.hash) throw new Error('PTY WebSocket must not contain credentials, query parameters or fragments');
  return url.toString();
}

function terminalTheme(light: boolean) {
  return light
    ? { background: '#f6f8fb', foreground: '#203149', cursor: '#087c63', selectionBackground: '#c8ddef' }
    : { background: '#070b13', foreground: '#d8e4f7', cursor: '#7ce7c5', selectionBackground: '#244f61' };
}

interface PtyEntry {
  id: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  socket?: WebSocket;
  worker?: Worker;
  decoder?: TextDecoder;
  view: PtySessionView;
  readOnly: boolean;
  inputChunks: string[];
  inputTimer?: number;
  resizeObserver?: ResizeObserver;
  disposers: Array<() => void>;
  onClosed?: (view: PtySessionView) => void;
  closed: boolean;
}

const IDLE_VIEW: PtySessionView = { state: 'connecting', notices: [] };
const entries = new Map<string, PtyEntry>();
/** Kept out of the entry so React can subscribe before the session exists. */
const listeners = new Map<string, Set<() => void>>();
/** Off-screen home for terminals whose panel is hidden; keeps the node alive and reusable. */
let detachedHolder: HTMLDivElement | undefined;

function holder(): HTMLDivElement {
  if (!detachedHolder) {
    detachedHolder = document.createElement('div');
    detachedHolder.className = 'pty-detached-holder';
    detachedHolder.setAttribute('aria-hidden', 'true');
    document.body.appendChild(detachedHolder);
  }
  return detachedHolder;
}

function publish(entry: PtyEntry, patch: Partial<PtySessionView>): void {
  entry.view = { ...entry.view, ...patch };
  for (const listener of listeners.get(entry.id) ?? []) listener();
}

/** The input buffer coalesces keystrokes over 8 ms so a burst is one frame, not one frame per key. */
function queueInput(entry: PtyEntry, data: string): void {
  // Canal de observación: la tecla se descarta acá, nunca llega al socket.
  if (entry.readOnly) return;
  entry.inputChunks.push(data);
  if (entry.inputTimer !== undefined) return;
  entry.inputTimer = window.setTimeout(() => {
    entry.inputTimer = undefined;
    const payload = entry.inputChunks.join('');
    entry.inputChunks = [];
    if (!payload || entry.socket?.readyState !== WebSocket.OPEN) return;
    entry.socket.send(JSON.stringify({ type: 'input', data: payload }));
  }, 8);
}

/** Drops a pending keystroke batch: once the channel is gone there is nowhere to send it. */
function cancelPendingInput(entry: PtyEntry): void {
  if (entry.inputTimer === undefined) return;
  window.clearTimeout(entry.inputTimer);
  entry.inputTimer = undefined;
}

function sendResize(entry: PtyEntry): void {
  if (entry.socket?.readyState !== WebSocket.OPEN) return;
  try {
    entry.fitAddon.fit();
  } catch {
    // Headless or hidden panel: keep the last known geometry instead of crashing the channel.
  }
  entry.socket.send(JSON.stringify({ type: 'resize', cols: entry.terminal.cols, rows: entry.terminal.rows }));
}

function writeOutput(entry: PtyEntry, data: ArrayBuffer | string): void {
  if (entry.worker) {
    if (typeof data === 'string') entry.worker.postMessage({ type: 'chunk', data });
    else entry.worker.postMessage({ type: 'chunk', data }, [data]);
    return;
  }
  // No Worker available (headless test runtime): decode inline, same streaming semantics.
  entry.decoder ??= new TextDecoder();
  entry.terminal.write(typeof data === 'string' ? data : entry.decoder.decode(data, { stream: true }));
}

/** Text frames are CONTROL, binary frames are PTY OUTPUT. They are never conflated. */
function handleControlFrame(entry: PtyEntry, raw: string): void {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    publish(entry, { notices: [...entry.view.notices, { level: 'error', message: 'Frame de control ilegible del relay.' }] });
    return;
  }

  if (payload.type === 'ready') {
    publish(entry, { state: 'open', message: undefined });
    sendResize(entry);
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
    publish(entry, { notices: [...entry.view.notices, { level, message }] });
    return;
  }
  if (payload.type === 'closed') {
    const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
    const exitCode = typeof payload.exit_code === 'number' ? payload.exit_code : undefined;
    const suffix = exitCode === undefined ? '' : ` · exit ${exitCode}`;
    publish(entry, { state: 'closed', message: `${reason ?? 'El servidor cerró la sesión.'}${suffix}` });
    return;
  }
  publish(entry, {
    notices: [...entry.view.notices, { level: 'warn', message: `Frame de control desconocido: ${String(payload.type ?? 'UNKNOWN')}` }],
  });
}

function openSocket(entry: PtyEntry, options: PtySessionOptions): void {
  let socket: WebSocket;
  try {
    socket = new WebSocket(websocketUrl(options.websocketPath));
  } catch (error) {
    publish(entry, { state: 'error', message: error instanceof Error ? error.message : 'Endpoint PTY inválido.' });
    return;
  }
  entry.socket = socket;
  socket.binaryType = 'arraybuffer';

  socket.onopen = () => {
    try {
      entry.fitAddon.fit();
    } catch {
      // Geometry falls back to the terminal defaults; attach still carries explicit cols/rows.
    }
    // The attach frame MUST be the first thing on the wire: the relay authorises before anything else.
    socket.send(JSON.stringify({
      type: 'attach',
      session_id: options.sessionId,
      ticket: options.ticket,
      cols: entry.terminal.cols,
      rows: entry.terminal.rows,
    }));
    publish(entry, { state: 'attaching', message: 'Ticket enviado; esperando autorización del relay.' });
  };

  socket.onmessage = (event: MessageEvent<string | ArrayBuffer | Blob>) => {
    // Text is ALWAYS control, binary is ALWAYS PTY output. Blobs are detected by shape rather
    // than `instanceof`, which is realm-bound and silently misclassifies buffers.
    if (typeof event.data === 'string') {
      handleControlFrame(entry, event.data);
      return;
    }
    const blob = event.data as Blob;
    if (typeof blob.arrayBuffer === 'function') {
      void blob.arrayBuffer().then((buffer) => {
        if (!entry.closed) writeOutput(entry, buffer);
      });
      return;
    }
    writeOutput(entry, event.data as ArrayBuffer);
  };

  socket.onclose = (event: CloseEvent) => {
    cancelPendingInput(entry);
    const explained = ptyCloseMessage(event.code, event.reason);
    publish(entry, {
      // A `closed` control frame already explained it; keep that wording and just add the code.
      state: entry.view.state === 'closed' ? 'closed' : event.code === 1000 ? 'closed' : 'error',
      message: entry.view.state === 'closed' && entry.view.message ? entry.view.message : explained,
      closeCode: event.code,
    });
    entry.onClosed?.(entry.view);
  };

  socket.onerror = () => {
    if (entry.view.state === 'closed' || entry.view.closeCode !== undefined) return;
    publish(entry, { state: 'error', message: 'El backend cerró o rechazó el canal PTY.' });
  };
}

/** Creates the session once. Calling it again for a live session is a no-op (tickets are single-use). */
export function ensurePtySession(options: PtySessionOptions): void {
  const existing = entries.get(options.sessionId);
  if (existing) {
    existing.onClosed = options.onClosed;
    return;
  }

  const container = document.createElement('div');
  container.className = 'pty-host';
  container.setAttribute('aria-label', 'Terminal PTY interactiva');
  holder().appendChild(container);

  const colorScheme = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : undefined;
  const terminal = new Terminal({
    cursorBlink: options.readOnly !== true,
    disableStdin: options.readOnly === true,
    convertEol: false,
    fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
    fontSize: 13,
    scrollback: 5000,
    theme: terminalTheme(colorScheme?.matches ?? false),
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const entry: PtyEntry = {
    id: options.sessionId,
    terminal,
    fitAddon,
    container,
    view: { state: 'connecting', notices: [] },
    readOnly: options.readOnly === true,
    inputChunks: [],
    disposers: [],
    onClosed: options.onClosed,
    closed: false,
  };
  entries.set(options.sessionId, entry);

  try {
    terminal.open(container);
  } catch (error) {
    // The DOM renderer needs a real layout engine. The terminal core stays usable, so the
    // channel is not killed: the failure is surfaced instead of being swallowed.
    entry.view = { ...entry.view, renderError: error instanceof Error ? error.message : 'El renderer del terminal no pudo iniciar.' };
  }

  if (typeof Worker === 'function') {
    const worker = new Worker(new URL('./terminal.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ type: 'flush'; data: string }>) => {
      if (!entry.closed && event.data.type === 'flush') terminal.write(event.data.data);
    };
    entry.worker = worker;
  }

  const input = terminal.onData((data) => queueInput(entry, data));
  entry.disposers.push(() => input.dispose());

  if (typeof ResizeObserver === 'function') {
    entry.resizeObserver = new ResizeObserver(() => sendResize(entry));
    entry.resizeObserver.observe(container);
  }

  if (colorScheme) {
    const updateTheme = (event: MediaQueryListEvent) => { terminal.options.theme = terminalTheme(event.matches); };
    colorScheme.addEventListener('change', updateTheme);
    entry.disposers.push(() => colorScheme.removeEventListener('change', updateTheme));
  }

  openSocket(entry, options);
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

/** Moves the live terminal node into the panel React just rendered. */
export function attachPtySession(sessionId: string, wrapper: HTMLElement): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  wrapper.appendChild(entry.container);
  sendResize(entry);
}

/** Parks the node off-screen; the socket and the scrollback survive. */
export function detachPtySession(sessionId: string): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  holder().appendChild(entry.container);
}

/** Tears the session down locally. Releasing it server-side is a separate DELETE. */
export function closePtySession(sessionId: string, reason = 'console terminal closed'): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  entry.closed = true;
  cancelPendingInput(entry);
  entries.delete(sessionId);
  entry.resizeObserver?.disconnect();
  for (const dispose of entry.disposers) dispose();
  entry.worker?.postMessage({ type: 'close' });
  entry.worker?.terminate();
  if (entry.socket && entry.socket.readyState <= WebSocket.OPEN) entry.socket.close(1000, reason);
  entry.terminal.dispose();
  entry.container.remove();
}

/**
 * Feeds keystrokes through the real `onData` path (same route as a physical keypress), so the
 * input buffering can be exercised headlessly. Diagnostics/tests only.
 */
export function ptySessionType(sessionId: string, data: string): void {
  entries.get(sessionId)?.terminal.input(data);
}

/**
 * Visible terminal text. Diagnostics/assertions only: it is a mirror of server output and is
 * never used to take a decision in the UI.
 */
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
