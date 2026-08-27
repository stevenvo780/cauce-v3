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
// Estilos empaquetados para compatibilidad con CSP
import './xterm-csp.css';

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
  /**
   * `false` cuando el operador subió a leer y hay salida nueva más abajo. La vista lo usa para
   * ofrecer «volver al final» en vez de arrastrarlo hacia abajo a mitad de una lectura.
   */
  seguirAlFinal: boolean;
  /**
   * Columnas que caben de verdad en esta pantalla. Se publica porque cuando son menos de
   * `COLUMNAS_MINIMAS` el espejo NO es fiel: el agente PTY se engancha con `-f ignore-size`, la
   * ventana remota conserva su ancho, y lo que sobra por la derecha simplemente no se ve. Callarlo
   * sería lo peor de todo: el operador leería una TUI recortada creyendo que la está viendo entera.
   */
  columnas?: number;
}

export interface PtySessionOptions {
  sessionId: string;
  websocketPath: string;
  ticket: string;
  /**
   * Observación en solo lectura: la consola NO manda teclas por este canal.
   *
   * El cliente corta teclado/paste/mouse y separa DA/DSR, pero la frontera no depende de confiar
   * en él: relay y agente vuelven a validar el tipo, y el agente rechaza STDIN humano en
   * `harness`. Cuando el origen es tmux, `attach-session -r` queda como defensa adicional.
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
  4414: 'Sesión cerrada por exceso de entrada.',
  4415: 'El navegador no alcanzó a consumir la salida del terminal.',
  4423: 'Venció el tiempo máximo de sesión.',
};

export function ptyCloseMessage(code?: number, reason?: string | null): string {
  const mapped = code === undefined ? undefined : PTY_CLOSE_MESSAGES[code];
  if (mapped) return mapped;
  if (code === 1000) return 'Canal PTY cerrado.';
  const detail = typeof reason === 'string' && reason.trim() ? ` · ${reason.trim()}` : '';
  return `El servidor cerró el canal PTY${code === undefined ? ' sin decir con qué código' : ` con el código ${code}`}${detail}.`;
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

/**
 * Paleta de colores para emulación de terminal con soporte ANSI sobre fondo oscuro.
 */
export const TEMA_TERMINAL = {
  background: '#0a0e16',
  foreground: '#d8e4f7',
  cursor: '#7ce7c5',
  cursorAccent: '#0a0e16',
  selectionBackground: '#2c5468',
} as const;

/**
 * La familia monoespaciada del terminal.
 *
 * `ui-monospace` y `SFMono-Regular` primero: son las monoespaciadas del sistema y están SIEMPRE.
 * `JetBrains Mono` iba primera y no viaja en el bundle, así que en cualquier navegador sin ella
 * instalada la cadena caía en la `monospace` genérica del navegador.
 *
 * Se declara UNA vez y se usa DOS: como opción de xterm (de ahí sale la medición de la celda) y
 * como variable `--pty-fuente` en el atributo `style` del nodo (de ahí sale lo que se PINTA, ver
 * `xterm-csp.css`). Si las dos no dijeran lo mismo, la geometría se calcularía con una letra y se
 * dibujaría con otra: columnas que no cuadran con lo que se lee.
 */
export const FUENTE_TERMINAL =
  "ui-monospace, 'SFMono-Regular', 'JetBrains Mono', Menlo, Consolas, 'Liberation Mono', monospace";

/**
 * Columnas por debajo de las cuales el espejo deja de servir.
 *
 * El agente PTY se engancha con `attach-session -r -f ignore-size`, o sea que la ventana remota NO
 * se adapta a nosotros (y bien que hace: redimensionar la tmux de un agente que está trabajando
 * sería tocarle el escritorio). La consecuencia es que un terminal estrecho no reflowea el
 * contenido: lo CORTA. Medido a 360x800: `"tenan`, `"socr`, `mes` — cada línea partida por la
 * mitad en el borde derecho. Antes que cortar se baja el cuerpo de letra, que es reversible y no
 * pierde nada.
 */
const COLUMNAS_MINIMAS = 80;
const CUERPO_BASE = 13;
/**
 * El suelo del cuerpo de letra, y por qué es 10 y no 7.
 *
 * Bajar la letra para no perder columnas sólo paga MIENTRAS SE PUEDA LEER. Con el suelo en 7 px,
 * medido en Chrome a 360x800 contra producción: el terminal quedaba a 7 px y entraban 65 columnas
 * —o sea que la TUI se cortaba IGUAL (hacen falta 80), y encima ya no se leía—. Se perdía por los
 * dos lados: ni se veía entero ni se veía. Con el suelo en 10 px entran ~43 columnas, se corta lo
 * mismo, y lo que queda SÍ se lee; el aviso `.pty-estrecho` sigue diciendo cuántas caben, que es
 * el hueco dicho en voz alta.
 *
 * 10 y no 11: medido a 1400 px de ventana, el hueco del terminal mide 535 px y a 10 px de cuerpo
 * entran exactamente 80 columnas. Subir a 11 dejaría 72 y haría aparecer el aviso de recorte en un
 * escritorio normal, que es justo lo que no hay que romper.
 */
const CUERPO_MINIMO = 10;

/**
 * Respuestas técnicas que xterm 5.5 genera al procesar DA/DSR. En un visor `harness` son la
 * ÚNICA entrada que puede salir del emulador: teclado, paste, composición y mouse quedan fuera.
 * Mantener la lista cerrada evita convertir "solo lectura" en un STDIN disfrazado de ANSI.
 */
const MAX_RESPUESTA_TECNICA = 256;
const DA_PRIMARIA = '\x1b[?1;2c';
const DA_SECUNDARIA = '\x1b[>0;276;0c';
const DSR_ESTADO = '\x1b[0n';
const MAX_FILAS_REMOTAS = 200;
const MAX_COLUMNAS_REMOTAS = 500;
const MAX_INPUT_FRAME_BYTES = 16 * 1024;
const MAX_PENDING_INPUT_BYTES = 64 * 1024;
const MAX_CLAIM_LEASE_MS = 300_000;
const MAX_POSTGRES_BIGINT = '9223372036854775807';
const UUID_CANONICO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PTY_VIEWER_HEARTBEAT_MS = 30_000;
/** Browser TCP/TLS/upgrade deadline. The relay attach deadline starts only after `open`. */
export const PTY_HANDSHAKE_TIMEOUT_MS = 10_000;
export const PTY_RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;
const UTF8_ENCODER = new TextEncoder();

function decimalPositivo(value: string): boolean {
  if (value.length === 0 || value.length > 3 || value[0] === '0') return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return false;
  }
  return true;
}

/** Longitud del CPR/DECXCPR inicial, o cero si el prefijo no es exactamente una respuesta DSR. */
function longitudRespuestaDeCursor(data: string): number {
  if (!data.startsWith('\x1b[')) return 0;
  let start = 2;
  if (data[start] === '?') start += 1;
  const separator = data.indexOf(';', start);
  if (separator < 0) return 0;
  const end = data.indexOf('R', separator + 1);
  if (end < 0) return 0;
  const row = data.slice(start, separator);
  const col = data.slice(separator + 1, end);
  if (!decimalPositivo(row) || !decimalPositivo(col)) return 0;
  if (Number(row) > MAX_FILAS_REMOTAS || Number(col) > MAX_COLUMNAS_REMOTAS) return 0;
  return end + 1;
}

/** Exportada para que la frontera negativa de la consola se pueda probar sin abrir una sesión. */
export function esRespuestaTecnicaDelTerminal(data: string): boolean {
  if (data.length === 0 || data.length > MAX_RESPUESTA_TECNICA) return false;
  // Las respuestas admitidas son ASCII. Un homoglyph o byte multibyte nunca cruza como control.
  for (let index = 0; index < data.length; index += 1) {
    if (data.charCodeAt(index) > 0x7f) return false;
  }
  let pendiente = data;
  while (pendiente.length > 0) {
    if (pendiente.startsWith(DA_PRIMARIA)) {
      pendiente = pendiente.slice(DA_PRIMARIA.length);
      continue;
    }
    if (pendiente.startsWith(DA_SECUNDARIA)) {
      pendiente = pendiente.slice(DA_SECUNDARIA.length);
      continue;
    }
    if (pendiente.startsWith(DSR_ESTADO)) {
      pendiente = pendiente.slice(DSR_ESTADO.length);
      continue;
    }
    const longitud = longitudRespuestaDeCursor(pendiente);
    if (longitud === 0) return false;
    pendiente = pendiente.slice(longitud);
  }
  return true;
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
  inputBytes: number;
  inputTimer?: number;
  heartbeatTimer?: number;
  resizeObserver?: ResizeObserver;
  /** La última geometría que se le DIJO al agente. Ver `sendResize`. */
  geometriaDicha?: { cols: number; rows: number };
  /** Falso en cuanto el operador sube a leer; verdadero mientras esté pegado al final. */
  pegadoAbajo: boolean;
  disposers: Array<() => void>;
  onClosed?: (view: PtySessionView) => void;
  closed: boolean;
  outputFinished: boolean;
  resumeToken?: string;
  /**
   * Fence que el relay asignó a esta encarnación del attach. Vive sólo mientras vive la
   * entrada en este módulo: no se publica en la vista, URL ni almacenamiento del navegador.
   */
  claimToken?: string;
  claimEpoch?: string;
  claimLeaseMs?: number;
  outputBytes: number;
  reconnectAttempt: number;
  reconnectTimer?: number;
  handshakeTimer?: number;
  options: PtySessionOptions;
}

const IDLE_VIEW: PtySessionView = { state: 'connecting', notices: [], seguirAlFinal: true };
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

/**
 * **Pinta la piel del terminal como ATRIBUTO `style` del nodo, y hay que hacerlo desde acá.**
 *
 * El renderer DOM de xterm no trae sus colores en un `.css`: los compone y los mete en un
 * `<style>` que crea con `createElement`. La consola se sirve con `style-src 'self'` (ver
 * `deploy/nginx-console-tls.conf`), así que ese `<style>` es «estilo en línea» sin permiso y el
 * navegador lo RECHAZA entero: la etiqueta queda en el DOM con su texto dentro y sin aplicar una
 * sola regla. Medido en Chrome con la cabecera puesta, la TUI quedaba a 1,18:1 —negro sobre
 * negro— y en la serif por defecto del navegador.
 *
 * Las reglas viven ahora en `xterm-csp.css`, que va en el bundle y la CSP sí permite. Lo único que
 * ese fichero no puede saber es lo que cambia por sesión: el cuerpo de letra baja solo cuando la
 * pantalla estrecha lo pide. Eso viaja en variables CSS puestas en el atributo `style` del nodo,
 * que la CSP permite aparte (`style-src-attr 'unsafe-inline'`) y que es el mismo camino por el que
 * xterm ya fija anchos, altos e interletraje.
 *
 * Se llama al crear la sesión y en cada reajuste de geometría: si el cuerpo baja de 13 a 9, la
 * variable baja con él y lo pintado sigue cuadrando con lo medido.
 */
function pintarPiel(entry: PtyEntry): void {
  const estilo = entry.container.style;
  estilo.setProperty('--pty-fuente', FUENTE_TERMINAL);
  estilo.setProperty('--pty-cuerpo', `${entry.terminal.options.fontSize ?? CUERPO_BASE}px`);
  estilo.setProperty('--pty-tinta', TEMA_TERMINAL.foreground);
  estilo.setProperty('--pty-fondo', TEMA_TERMINAL.background);
  estilo.setProperty('--pty-cursor', TEMA_TERMINAL.cursor);
  estilo.setProperty('--pty-cursor-tinta', TEMA_TERMINAL.cursorAccent);
  estilo.setProperty('--pty-seleccion', TEMA_TERMINAL.selectionBackground);
}

/**
 * **Un documento que le niega a xterm el `<style>`, y nada más que eso.**
 *
 * `pintarPiel` y `xterm-csp.css` arreglaron el CONTENIDO —lo que esas reglas decían viaja ahora
 * en un fichero que la CSP permite— pero no la INYECCIÓN. El renderer DOM de xterm crea dos
 * `<style>` (`_injectCss` para tema y letra, `_updateDimensions` para la celda) y los reescribe
 * con cada cambio de tema, de fuente o de cuerpo. Con `style-src 'self'` puesta el navegador los
 * rechaza uno por uno: MEDIDO contra producción, abrir la terminal dejaba **22 violaciones**
 * `style-src` en la consola de Chrome, todas desde `assets/xterm-*.js`. Ya no rompían nada —la
 * piel viene del bundle— pero una página peleándose con su propia política tapa, entre su ruido,
 * las violaciones que sí habría que ver.
 *
 * Relajar la política estaba descartado y un hash es imposible: el texto de esos `<style>` lleva
 * el número de instancia del renderer (`.xterm-dom-renderer-owner-N`, `@keyframes blink_..._N`),
 * o sea que cambia con cada terminal que se abre. xterm 5.5 tampoco admite un `nonce` (no aparece
 * la palabra en su bundle). Lo que sí ofrece es `documentOverride`: el documento del que saca los
 * nodos que crea. Se le pasa este proxy, que devuelve un `<template>` —inerte por hoja de estilos
 * del navegador, nunca se pinta ni se interpreta como CSS— cuando le piden un `<style>`, y el
 * elemento de verdad para todo lo demás. Así no hay nada que bloquear: la política se queda como
 * está y el terminal se sigue vistiendo desde `xterm-csp.css`.
 *
 * Sólo se intercepta `createElement`; el resto de la API del documento pasa tal cual al real, con
 * `this` puesto en él (un método del DOM invocado sobre el proxy lanza «Illegal invocation»).
 */
let documentoSinEstilos: Document | undefined;

function documentoQueNiegaLosEstilos(): Document {
  documentoSinEstilos ??= new Proxy(document, {
    get(real, propiedad) {
      if (propiedad === 'createElement') {
        return (etiqueta: string, opciones?: ElementCreationOptions) => (
          String(etiqueta).toLowerCase() === 'style'
            ? real.createElement('template')
            : real.createElement(etiqueta, opciones)
        );
      }
      const valor = Reflect.get(real, propiedad, real) as unknown;
      return typeof valor === 'function' ? (valor as (...args: unknown[]) => unknown).bind(real) : valor;
    },
  });
  return documentoSinEstilos;
}

function publish(entry: PtyEntry, patch: Partial<PtySessionView>): void {
  entry.view = { ...entry.view, ...patch };
  for (const listener of listeners.get(entry.id) ?? []) listener();
}

/** The input buffer coalesces keystrokes over 8 ms so a burst is one frame, not one frame per key. */
function queueInput(entry: PtyEntry, data: string): void {
  if (entry.readOnly) {
    // `onData` mezcla entrada humana y respuestas que el parser genera al recibir DA/DSR. Un
    // visor descarta todo salvo ese juego cerrado, y lo etiqueta distinto de `input` en el wire.
    if (!esRespuestaTecnicaDelTerminal(data) || entry.socket?.readyState !== WebSocket.OPEN) return;
    entry.socket.send(JSON.stringify({ type: 'terminal_response', data }));
    return;
  }
  const bytes = UTF8_ENCODER.encode(data).byteLength;
  if (bytes > MAX_INPUT_FRAME_BYTES || entry.inputBytes + bytes > MAX_PENDING_INPUT_BYTES) {
    cancelPendingInput(entry);
    publish(entry, { state: 'error', message: PTY_CLOSE_MESSAGES[4414], closeCode: 4414 });
    if (entry.socket?.readyState === WebSocket.OPEN) entry.socket.close(4414, 'input_flood');
    return;
  }
  entry.inputChunks.push(data);
  entry.inputBytes += bytes;
  if (entry.inputTimer !== undefined) return;
  entry.inputTimer = window.setTimeout(() => {
    entry.inputTimer = undefined;
    const chunks = entry.inputChunks;
    entry.inputChunks = [];
    entry.inputBytes = 0;
    if (chunks.length === 0 || entry.socket?.readyState !== WebSocket.OPEN) return;

    // La cota es por TRAMA, no sólo por llamada a `onData`: dos pastes permitidos dentro de los
    // mismos 8 ms no pueden convertirse al unirlos en una trama que el relay deba rechazar.
    let batch: string[] = [];
    let batchBytes = 0;
    const flushBatch = (): void => {
      if (batch.length === 0 || entry.socket?.readyState !== WebSocket.OPEN) return;
      entry.socket.send(JSON.stringify({ type: 'input', data: batch.join('') }));
      batch = [];
      batchBytes = 0;
    };
    for (const chunk of chunks) {
      const chunkBytes = UTF8_ENCODER.encode(chunk).byteLength;
      if (batchBytes + chunkBytes > MAX_INPUT_FRAME_BYTES) flushBatch();
      if (entry.socket?.readyState !== WebSocket.OPEN) return;
      batch.push(chunk);
      batchBytes += chunkBytes;
    }
    flushBatch();
  }, 8);
}

/** Drops a pending keystroke batch: once the channel is gone there is nowhere to send it. */
function cancelPendingInput(entry: PtyEntry): void {
  if (entry.inputTimer !== undefined) window.clearTimeout(entry.inputTimer);
  entry.inputTimer = undefined;
  entry.inputChunks = [];
  entry.inputBytes = 0;
}

function stopViewerHeartbeat(entry: PtyEntry): void {
  if (entry.heartbeatTimer !== undefined) window.clearInterval(entry.heartbeatTimer);
  entry.heartbeatTimer = undefined;
}

function stopReconnect(entry: PtyEntry): void {
  if (entry.reconnectTimer !== undefined) window.clearTimeout(entry.reconnectTimer);
  entry.reconnectTimer = undefined;
}

function stopHandshake(entry: PtyEntry): void {
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

/**
 * Ajusta el terminal al hueco que tiene, bajando el cuerpo de letra antes que perder columnas.
 *
 * `proposeDimensions()` dice cuántas columnas entran CON EL CUERPO ACTUAL. Si no llegan a
 * `COLUMNAS_MINIMAS`, se baja proporcionalmente y se vuelve a preguntar (dos pasadas alcanzan: la
 * relación ancho/cuerpo es lineal, la segunda sólo corrige el redondeo). El suelo es
 * `CUERPO_MINIMO`: por debajo de eso no se gana legibilidad, se pierde, y entonces sí se acepta
 * quedarse corto de columnas.
 */
function ajustarGeometria(entry: PtyEntry): void {
  let cuerpo = CUERPO_BASE;
  try {
    for (let intento = 0; intento < 3; intento += 1) {
      entry.terminal.options.fontSize = cuerpo;
      const propuesta = entry.fitAddon.proposeDimensions();
      if (!propuesta || !Number.isFinite(propuesta.cols) || propuesta.cols <= 0) break;
      if (propuesta.cols >= COLUMNAS_MINIMAS || cuerpo <= CUERPO_MINIMO) break;
      const siguiente = Math.max(CUERPO_MINIMO, Math.floor((cuerpo * propuesta.cols) / COLUMNAS_MINIMAS));
      if (siguiente >= cuerpo) break;
      cuerpo = siguiente;
    }
    entry.fitAddon.fit();
  } catch {
    // Headless or hidden panel: keep the last known geometry instead of crashing the channel.
  }
  // El cuerpo de letra que acaba de decidirse tiene que llegar a lo que se PINTA, no sólo a lo que
  // se mide: la regla que lo aplica está en el bundle y lee `--pty-cuerpo` (ver `pintarPiel`).
  pintarPiel(entry);
  if (entry.terminal.cols !== entry.view.columnas) publish(entry, { columnas: entry.terminal.cols });
}

/**
 * Le dice al agente el tamaño de la ventana, **sólo cuando cambió de verdad**.
 *
 * La guarda de igualdad no es una optimización. El extremo de allá contesta cada trama con
 * `ioctl(TIOCSWINSZ)` (`ops/pty-agent/cauce_pty_agent.py`), y `TIOCSWINSZ` **manda `SIGWINCH`** al
 * grupo en primer plano aunque las medidas sean idénticas: no hay comprobación de igualdad ni en
 * el agente ni en el kernel. Y quien dispara esto es un `ResizeObserver`, que late con cada
 * cambio de disposición del hueco —incluidos los que provoca el propio terminal al repintarse—.
 * Sin guarda, arrastrar el borde de la ventana un segundo son decenas de `SIGWINCH` seguidos a la
 * TUI del agente que está trabajando, cada uno un repintado completo. Medido en pruebas: ocho
 * latidos sin un solo cambio de geometría daban ocho tramas.
 *
 * Se compara contra lo ÚLTIMO QUE SE MANDÓ, no contra lo que el terminal tenía antes: lo que el
 * agente sabe es lo que se le dijo, y el `attach` ya le dijo la primera geometría.
 */
function sendResize(entry: PtyEntry): void {
  ajustarGeometria(entry);
  mantenerElFinal(entry);
  if (entry.socket?.readyState !== WebSocket.OPEN) return;
  const { cols, rows } = entry.terminal;
  if (entry.geometriaDicha?.cols === cols && entry.geometriaDicha.rows === rows) return;
  entry.geometriaDicha = { cols, rows };
  entry.socket.send(JSON.stringify({ type: 'resize', cols, rows }));
}

/** ¿La vista está mirando el final del búfer, o el operador subió a leer? */
function alFinal(entry: PtyEntry): boolean {
  try {
    const buffer = entry.terminal.buffer.active;
    return buffer.viewportY >= buffer.baseY;
  } catch {
    // Sin renderer no hay viewport: se comporta como si estuviera al final, que es lo inocuo.
    return true;
  }
}

/**
 * **Un cambio de geometría no te mueve del sitio en el que estabas leyendo.**
 *
 * Sobre el scroll de la SALIDA no hace falta nada: xterm ya sigue el final mientras estés al final
 * y ya te deja quieto si subiste (`isUserScrolling` en su `BufferService`). Se comprobó quitando
 * el código y viendo que las dos mitades seguían cumpliéndose, así que forzarlo sería código
 * muerto con una prueba incapaz de dar rojo. Lo que xterm NO garantiza es el REDIMENSIONADO: un
 * `fit()` cambia las filas, recoloca el búfer y ahí sí te puede dejar en otro sitio. Como acá el
 * ancho se reajusta solo (bajando el cuerpo de letra hasta que entren 80 columnas), eso pasa sin
 * que el operador toque nada.
 */
function mantenerElFinal(entry: PtyEntry): void {
  if (!entry.pegadoAbajo) return;
  try {
    entry.terminal.scrollToBottom();
  } catch {
    // Headless: no hay viewport que mover.
  }
}

function writeOutput(entry: PtyEntry, data: ArrayBuffer | string): void {
  if (entry.outputFinished) return;
  if (entry.worker) {
    if (typeof data === 'string') entry.worker.postMessage({ type: 'chunk', data });
    else entry.worker.postMessage({ type: 'chunk', data }, [data]);
    return;
  }
  // No Worker available (headless test runtime): decode inline, same streaming semantics.
  entry.decoder ??= new TextDecoder();
  entry.terminal.write(typeof data === 'string' ? data : entry.decoder.decode(data, { stream: true }));
}

/** Finaliza el estado incremental: un último code point incompleto no desaparece en silencio. */
function finishOutput(entry: PtyEntry): void {
  if (entry.outputFinished) return;
  entry.outputFinished = true;
  if (entry.worker) {
    entry.worker.postMessage({ type: 'close' });
    return;
  }
  const tail = entry.decoder?.decode() ?? '';
  if (tail) entry.terminal.write(tail);
}

/** PostgreSQL `bigint` positivo, conservado como texto para no perder bits en JavaScript. */
function claimEpochCanonico(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return false;
  if (value.length !== MAX_POSTGRES_BIGINT.length) return value.length < MAX_POSTGRES_BIGINT.length;
  return value <= MAX_POSTGRES_BIGINT;
}

function claimReady(
  payload: Readonly<Record<string, unknown>>,
): { claimToken: string; claimEpoch: string; claimLeaseMs: number } | undefined {
  const claimToken = payload.claim_token;
  const claimEpoch = payload.claim_epoch;
  const claimLeaseMs = payload.claim_lease_ms;
  if (typeof claimToken !== 'string' || !UUID_CANONICO.test(claimToken) ||
      !claimEpochCanonico(claimEpoch) || typeof claimLeaseMs !== 'number' ||
      !Number.isSafeInteger(claimLeaseMs) || claimLeaseMs < 1 || claimLeaseMs > MAX_CLAIM_LEASE_MS) {
    return undefined;
  }
  return { claimToken, claimEpoch, claimLeaseMs };
}

function rejectMalformedReady(entry: PtyEntry): void {
  const socket = entry.socket;
  // Desvincular primero evita que el `close` asíncrono vuelva a finalizar/notificar el canal.
  entry.socket = undefined;
  if (socket && socket.readyState <= WebSocket.OPEN) socket.close(4400, 'invalid_ready');
  finishChannel(entry, 4400, 'invalid_ready');
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
    const claim = claimReady(payload);
    if (claim === undefined) {
      rejectMalformedReady(entry);
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
    publish(entry, { state: 'open', message: undefined });
    startViewerHeartbeat(entry);
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
    notices: [...entry.view.notices, { level: 'warn', message: `El relay mandó una trama de control que esta consola no conoce: ${String(payload.type ?? 'sin tipo')}` }],
  });
}

function finishChannel(entry: PtyEntry, code: number, reason: string): void {
  cancelPendingInput(entry);
  stopViewerHeartbeat(entry);
  stopReconnect(entry);
  stopHandshake(entry);
  finishOutput(entry);
  const explained = ptyCloseMessage(code, reason);
  publish(entry, {
    state: entry.view.state === 'closed' ? 'closed' : code === 1000 ? 'closed' : 'error',
    message: entry.view.state === 'closed' && entry.view.message ? entry.view.message : explained,
    closeCode: code,
  });
  entry.onClosed?.(entry.view);
}

function scheduleReconnect(entry: PtyEntry): boolean {
  if (entry.closed || entry.resumeToken === undefined || entry.claimToken === undefined ||
      entry.claimEpoch === undefined || entry.claimLeaseMs === undefined ||
      entry.reconnectTimer !== undefined) return false;
  const delay = PTY_RECONNECT_DELAYS_MS[entry.reconnectAttempt];
  if (delay === undefined) return false;
  entry.reconnectAttempt += 1;
  publish(entry, {
    state: 'connecting',
    message: `Canal interrumpido; reanudando el mismo PTY (${entry.reconnectAttempt}/${PTY_RECONNECT_DELAYS_MS.length}).`,
    closeCode: undefined,
  });
  entry.reconnectTimer = window.setTimeout(() => {
    entry.reconnectTimer = undefined;
    openSocket(entry, entry.options, true);
  }, delay);
  return true;
}

function openSocket(entry: PtyEntry, options: PtySessionOptions, resume = false): void {
  let socket: WebSocket;
  try {
    socket = new WebSocket(websocketUrl(options.websocketPath));
  } catch (error) {
    if (resume && scheduleReconnect(entry)) return;
    publish(entry, { state: 'error', message: error instanceof Error ? error.message : 'Endpoint PTY inválido.' });
    return;
  }
  entry.socket = socket;
  socket.binaryType = 'arraybuffer';
  stopHandshake(entry);
  entry.handshakeTimer = window.setTimeout(() => {
    if (entry.closed || entry.socket !== socket || socket.readyState !== WebSocket.CONNECTING) return;
    entry.handshakeTimer = undefined;
    // No `open` means no attach/resume frame was sent. Detach the handlers before closing so a
    // delayed browser close cannot finish the entry a second time.
    entry.socket = undefined;
    socket.close(4400, 'handshake_timeout');
    if (resume && scheduleReconnect(entry)) return;
    cancelPendingInput(entry);
    stopViewerHeartbeat(entry);
    stopReconnect(entry);
    finishOutput(entry);
    publish(entry, {
      state: 'error',
      message: `La conexión WebSocket no completó el handshake en ${Math.round(PTY_HANDSHAKE_TIMEOUT_MS / 1000)} s. `
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
    // The attach frame MUST be the first thing on the wire: the relay authorises before anything else.
    // Y ya lleva la geometría, así que cuenta como «dicha»: repetirla en un `resize` inmediato
    // sería el primer SIGWINCH gratis de la sesión (ver `sendResize`).
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
    publish(entry, {
      state: 'attaching',
      message: resume ? 'Revalidando continuidad y reanudando el mismo PTY.' : 'Ticket enviado; esperando autorización del relay.'
    });
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
    // 1006 is the browser's transport-loss sentinel. The resume token is memory-only and the
    // relay keeps the PTY for a bounded grace period; no new session, ticket or audit row is made.
    if (event.code === 1006 && scheduleReconnect(entry)) return;
    finishChannel(entry, event.code, event.reason);
  };

  socket.onerror = () => {
    if (entry.view.state === 'closed' || entry.view.closeCode !== undefined) return;
    if (resume) return;
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

  const terminal = new Terminal({
    cursorBlink: options.readOnly !== true,
    // No se puede usar `disableStdin` en el visor: xterm también silencia con él sus respuestas
    // DA/DSR. La separación se hace abajo por origen de UI + allowlist, y vuelve a validarse en
    // relay y agente antes de tocar el PTY.
    disableStdin: false,
    convertEol: false,
    // La CSP de producción no admite el `<style>` que xterm inyecta. Ver `documentoQueNiegaLosEstilos`.
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

  if (entry.readOnly) {
    // Teclado: xterm consulta este handler antes de producir su `onData`. Las respuestas del
    // parser no pasan por él, por eso DA/DSR siguen funcionando.
    terminal.attachCustomKeyEventHandler(() => false);
    // Paste/IME/drop llegan por eventos del textarea y no siempre pasan por el handler de teclas.
    // Capturarlos en el contenedor conserva scroll y selección de mouse, pero corta escritura.
    const bloquearEntradaHumana = (event: Event): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const eventos = ['beforeinput', 'input', 'paste', 'drop', 'compositionstart', 'compositionupdate', 'compositionend'] as const;
    for (const tipo of eventos) {
      container.addEventListener(tipo, bloquearEntradaHumana, true);
      entry.disposers.push(() => container.removeEventListener(tipo, bloquearEntradaHumana, true));
    }
  }
  entries.set(options.sessionId, entry);
  // Antes de abrir el renderer: el primer frame ya sale con la tinta y la letra puestas.
  pintarPiel(entry);

  try {
    terminal.open(container);
  } catch (error) {
    // The DOM renderer needs a real layout engine. The terminal core stays usable, so the
    // channel is not killed: the failure is surfaced instead of being swallowed.
    entry.view = { ...entry.view, renderError: error instanceof Error ? error.message : 'El renderer del terminal no pudo iniciar.' };
  }

  if (typeof Worker === 'function') {
    const worker = new Worker(new URL('./terminal.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ type: 'flush'; data: string } | { type: 'closed' }>) => {
      if (event.data.type === 'closed') {
        worker.terminate();
        if (entry.worker === worker) entry.worker = undefined;
        return;
      }
      if (!entry.closed) terminal.write(event.data.data);
    };
    entry.worker = worker;
  }

  const input = terminal.onData((data) => queueInput(entry, data));
  entry.disposers.push(() => input.dispose());


  // Cada movimiento del viewport —del operador o nuestro— reevalúa si seguimos pegados al final.
  const scroll = terminal.onScroll(() => {
    const abajo = alFinal(entry);
    if (abajo === entry.pegadoAbajo) return;
    entry.pegadoAbajo = abajo;
    publish(entry, { seguirAlFinal: abajo });
  });
  entry.disposers.push(() => scroll.dispose());

  openSocket(entry, options);
}

/** Vuelve al final y reengancha el seguimiento. Lo llama el botón «volver al final» de la vista. */
export function ptySessionVolverAlFinal(sessionId: string): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  entry.pegadoAbajo = true;
  try {
    entry.terminal.scrollToBottom();
  } catch {
    // Sin renderer no hay nada que mover; el estado igual queda pegado.
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

/**
 * Moves the live terminal node into the panel React just rendered.
 *
 * Y observa el HUECO, no el terminal.** El `ResizeObserver` vigilaba `entry.container`, que
 * es el nodo del propio terminal — y el alto de ese nodo lo decide xterm a partir de sus filas,
 * no el layout. O sea que se estaba observando la consecuencia en vez de la causa: el nodo nunca
 * encogía solo, el observador no disparaba nunca, y el terminal se quedaba con las filas de la
 * primera medición para siempre. Medido a 1280x900: el hueco (`.pty-mount`) medía 230 px y el
 * terminal seguía midiendo 500, desbordándolo por abajo. Vigilando el hueco, que sí lo decide el
 * layout, `fit()` se entera y las filas se ajustan.
 */
export function attachPtySession(sessionId: string, wrapper: HTMLElement): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  wrapper.appendChild(entry.container);
  entry.resizeObserver?.disconnect();
  if (typeof ResizeObserver === 'function') {
    entry.resizeObserver ??= new ResizeObserver(() => sendResize(entry));
    entry.resizeObserver.observe(wrapper);
  }
  sendResize(entry);
}

/** Parks the node off-screen; the socket and the scrollback survive. */
export function detachPtySession(sessionId: string): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  // El hueco se va con el panel: seguir observándolo mediría un elemento que ya no está en la
  // página y devolvería 0 columnas, que es peor que no medir.
  entry.resizeObserver?.disconnect();
  holder().appendChild(entry.container);
}

/** Tears the session down locally. Releasing it server-side is a separate DELETE. */
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

/**
 * Feeds keystrokes through the real `onData` path (same route as a physical keypress), so the
 * input buffering can be exercised headlessly. Diagnostics/tests only.
 */
export function ptySessionType(sessionId: string, data: string): void {
  entries.get(sessionId)?.terminal.input(data);
}

/**
 * Mueve el viewport como lo movería la rueda del operador, por el camino real de xterm.
 * Diagnóstico y pruebas: la vista nunca llama a esto.
 */
export const PTY_COLUMNAS_MINIMAS = COLUMNAS_MINIMAS;
/** Diagnóstico y pruebas: el suelo del cuerpo de letra. Ver `CUERPO_MINIMO`. */
export const PTY_CUERPO_MINIMO = CUERPO_MINIMO;
export const PTY_CUERPO_BASE = CUERPO_BASE;

export function ptySessionScroll(sessionId: string, lineas: number): void {
  entries.get(sessionId)?.terminal.scrollLines(lineas);
}

/**
 * Mueve la geometría por el camino real de xterm, el mismo que usa `fit()`. Diagnóstico y
 * pruebas: sin motor de maquetación `proposeDimensions()` no devuelve nada y `fit()` no mueve un
 * pixel, así que es la única forma honesta de que una prueba vea un cambio de tamaño de verdad.
 */
export function ptySessionRedimensionar(sessionId: string, cols: number, rows: number): void {
  entries.get(sessionId)?.terminal.resize(cols, rows);
}

/** La geometría que el terminal tiene AHORA. Es contra esto que se compara lo que se manda. */
export function ptySessionGeometria(sessionId: string): { cols: number; rows: number } | undefined {
  const entry = entries.get(sessionId);
  return entry ? { cols: entry.terminal.cols, rows: entry.terminal.rows } : undefined;
}

/**
 * Dónde está el viewport respecto del final del búfer. `viewportY === baseY` es «pegado abajo».
 * Diagnóstico y pruebas: es lo único con lo que se puede afirmar que la vista NO se movió.
 */
export function ptySessionPosicion(sessionId: string): { viewportY: number; baseY: number } {
  const entry = entries.get(sessionId);
  if (!entry) return { viewportY: 0, baseY: 0 };
  const buffer = entry.terminal.buffer.active;
  return { viewportY: buffer.viewportY, baseY: buffer.baseY };
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
