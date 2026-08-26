import { afterEach, beforeEach, vi } from 'vitest';
import {
  attachPtySession,
  closePtySession,
  detachPtySession,
  ensurePtySession,
  esRespuestaTecnicaDelTerminal,
  ptyCloseMessage,
  ptySessionPosicion,
  ptySessionScroll,
  ptySessionText,
  ptySessionType,
  ptySessionVolverAlFinal,
  readPtySession,
  subscribePtySession,
  websocketUrl,
  PTY_CLOSE_MESSAGES,
  PTY_HANDSHAKE_TIMEOUT_MS,
  PTY_RECONNECT_DELAYS_MS,
  PTY_VIEWER_HEARTBEAT_MS,
} from './pty-session';
import { installStubWebSocket, StubWebSocket } from './pty-socket-stub';

const SESSION = 'pty-session-1';
const CLAIM_TOKEN = '12345678-1234-4234-8234-123456789abc';
const CLAIM_EPOCH = '9007199254740993';
const CLAIM_LEASE_MS = 45_000;
let restore: () => void;

beforeEach(() => { restore = installStubWebSocket(); });
afterEach(() => {
  closePtySession(SESSION);
  vi.restoreAllMocks();
  restore();
});

function open(options: { sessionId?: string; ticket?: string; readOnly?: boolean } = {}): StubWebSocket {
  ensurePtySession({
    sessionId: options.sessionId ?? SESSION,
    websocketPath: '/v3/console/terminal/ws',
    ticket: options.ticket ?? 'single-use-ticket',
    readOnly: options.readOnly,
  });
  const socket = StubWebSocket.last();
  socket.acceptOpen();
  return socket;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

function ready(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'ready',
    claim_token: CLAIM_TOKEN,
    claim_epoch: CLAIM_EPOCH,
    claim_lease_ms: CLAIM_LEASE_MS,
    ...overrides,
  };
}

it('sends attach as the very first frame, carrying the session and the single-use ticket', () => {
  const socket = open();

  const first = socket.frames()[0];
  expect(first).toMatchObject({ type: 'attach', session_id: SESSION, ticket: 'single-use-ticket' });
  expect(typeof first.cols).toBe('number');
  expect(typeof first.rows).toBe('number');
  expect(first).not.toHaveProperty('claim_token');
  expect(first).not.toHaveProperty('claim_epoch');
  expect(first).not.toHaveProperty('prior_claim_token');
  expect(first).not.toHaveProperty('prior_claim_epoch');
  expect(readPtySession(SESSION).state).toBe('attaching');
});

it('never puts the ticket in the URL: it travels only inside the attach frame', () => {
  const socket = open();
  expect(socket.url).not.toContain('single-use-ticket');
  expect(new URL(socket.url).search).toBe('');
});

it('sale de CONNECTING si el upgrade nunca responde y no reutiliza el ticket de un solo uso', () => {
  vi.useFakeTimers();
  try {
    const closed: string[] = [];
    ensurePtySession({
      sessionId: SESSION,
      websocketPath: '/v3/console/terminal/ws',
      ticket: 'single-use-ticket',
      onClosed: (view) => closed.push(view.message ?? ''),
    });
    const socket = StubWebSocket.last();
    expect(readPtySession(SESSION).state).toBe('connecting');
    expect(socket.frames()).toEqual([]);

    vi.advanceTimersByTime(PTY_HANDSHAKE_TIMEOUT_MS);

    expect(socket.frames()).toEqual([]);
    expect(socket.closeCode).toBe(4400);
    expect(socket.closeReason).toBe('handshake_timeout');
    expect(readPtySession(SESSION)).toMatchObject({
      state: 'error',
      message: expect.stringMatching(/no completó el handshake.*sesión nueva/iu),
    });
    expect(closed).toHaveLength(1);

    // A late network event cannot resurrect the timed-out socket or replay its ticket.
    socket.acceptOpen();
    vi.advanceTimersByTime(PTY_HANDSHAKE_TIMEOUT_MS * 2);
    expect(StubWebSocket.instances).toHaveLength(1);
    expect(socket.frames()).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it('guarda el fence de ready sólo en memoria, nunca en storage, URL ni logs de la vista', () => {
  const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
  const socket = open();
  socket.emitControl(ready());

  expect(readPtySession(SESSION).state).toBe('open');
  expect(storageWrite).not.toHaveBeenCalled();
  expect(socket.url).not.toContain(CLAIM_TOKEN);
  expect(new URL(socket.url).search).toBe('');
  expect(JSON.stringify(readPtySession(SESSION))).not.toContain(CLAIM_TOKEN);
  expect(JSON.stringify(readPtySession(SESSION))).not.toContain(CLAIM_EPOCH);
});

it.each([
  ['claim_token ausente', { claim_token: undefined }],
  ['claim_token no canónico', { claim_token: CLAIM_TOKEN.toUpperCase() }],
  ['claim_epoch ausente', { claim_epoch: undefined }],
  ['claim_epoch numérico', { claim_epoch: 7 }],
  ['claim_epoch con cero inicial', { claim_epoch: '01' }],
  ['claim_epoch cero', { claim_epoch: '0' }],
  ['claim_epoch fuera de bigint', { claim_epoch: '9223372036854775808' }],
  ['claim_lease_ms ausente', { claim_lease_ms: undefined }],
  ['claim_lease_ms cero', { claim_lease_ms: 0 }],
  ['claim_lease_ms fraccionario', { claim_lease_ms: 1.5 }],
  ['claim_lease_ms fuera de cota', { claim_lease_ms: 300_001 }],
])('falla cerrado y no abre ante ready con %s', (_label, malformed) => {
  const socket = open();
  socket.emitControl(ready(malformed));

  expect(socket.closeCode).toBe(4400);
  expect(socket.closeReason).toBe('invalid_ready');
  expect(readPtySession(SESSION)).toMatchObject({ state: 'error', closeCode: 4400 });
});

it('writes binary frames to the terminal and keeps text frames out of the output', async () => {
  const socket = open();
  socket.emitControl(ready());
  socket.emitOutput('claw@kratos:~$ id -un\r\nclaw\r\n');
  socket.emitControl({ type: 'notice', level: 'warn', message: 'El contenedor está compartido.' });
  await settle();

  const text = ptySessionText(SESSION);
  expect(text).toContain('claw@kratos:~$ id -un');
  expect(text).toContain('claw');
  // Control frames are protocol, not shell output: they must never be echoed into the terminal.
  expect(text).not.toContain('notice');
  expect(text).not.toContain('El contenedor está compartido');
  expect(readPtySession(SESSION).notices).toEqual([{ level: 'warn', message: 'El contenedor está compartido.' }]);
  expect(readPtySession(SESSION).state).toBe('open');
});

it('coalesces a burst of keystrokes into a single input frame after the 8 ms buffer', async () => {
  const socket = open();
  socket.emitControl(ready());

  ptySessionType(SESSION, 'l');
  ptySessionType(SESSION, 's');
  ptySessionType(SESSION, '\r');
  expect(socket.framesOfType('input')).toHaveLength(0);

  await settle();
  expect(socket.framesOfType('input')).toEqual([{ type: 'input', data: 'ls\r' }]);
});

it('divide el burst en tramas acotadas sin perder orden cuando dos chunks juntos exceden 16 KiB', async () => {
  const socket = open();
  socket.emitControl(ready());
  const first = 'a'.repeat(10 * 1024);
  const second = 'b'.repeat(10 * 1024);

  ptySessionType(SESSION, first);
  ptySessionType(SESSION, second);
  await settle();

  const frames = socket.framesOfType('input');
  expect(frames).toHaveLength(2);
  expect(frames.every((frame) => new TextEncoder().encode(String(frame.data)).byteLength <= 16 * 1024)).toBe(true);
  expect(frames.map((frame) => frame.data).join('')).toBe(first + second);
  expect(socket.closeCode).toBeUndefined();
});

it('en solo lectura responde DA/DSR por un tipo propio y nunca abre input humano', async () => {
  const socket = open({ readOnly: true });
  socket.emitControl(ready());

  // Teclado, paste textual, ANSI genérico y mouse no se parecen a una respuesta técnica válida.
  ptySessionType(SESSION, 'whoami\r');
  ptySessionType(SESSION, '\x1b[31m');
  ptySessionType(SESSION, '\x1b[<0;1;1M');
  await settle();
  expect(socket.framesOfType('input')).toHaveLength(0);
  expect(socket.framesOfType('terminal_response')).toHaveLength(0);

  // Son consultas que xterm procesa al pintar salida remota. Sus respuestas salen por onData,
  // pero ya etiquetadas como emulador, no como teclado/paste.
  socket.emitOutput('\x1b[c\x1b[>c\x1b[5n\x1b[6n\x1b[?6n');
  await settle();
  expect(socket.framesOfType('terminal_response').map((frame) => frame.data)).toEqual([
    '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[0n', '\x1b[1;1R', '\x1b[?1;1R'
  ]);
  expect(socket.framesOfType('input')).toHaveLength(0);
});

it('un viewer read-only demuestra presencia con ping sin abrir input', () => {
  vi.useFakeTimers();
  try {
    const socket = open({ readOnly: true });
    socket.emitControl(ready());
    expect(socket.framesOfType('ping')).toHaveLength(0);
    vi.advanceTimersByTime(PTY_VIEWER_HEARTBEAT_MS);
    expect(socket.framesOfType('ping')).toEqual([{ type: 'ping' }]);
    expect(socket.framesOfType('input')).toHaveLength(0);
    socket.emitClose(1000);
    vi.advanceTimersByTime(PTY_VIEWER_HEARTBEAT_MS * 2);
    expect(socket.framesOfType('ping')).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it('corta localmente un paste que supera la cota antes de acumularlo', () => {
  const socket = open();
  socket.emitControl(ready());
  ptySessionType(SESSION, 'x'.repeat(16 * 1024 + 1));
  expect(socket.framesOfType('input')).toHaveLength(0);
  expect(socket.closeCode).toBe(4414);
  expect(readPtySession(SESSION)).toMatchObject({ state: 'error', closeCode: 4414 });
});

it('finaliza TextDecoder al cerrar y no pierde un code point multibyte incompleto', async () => {
  const socket = open();
  socket.emitControl(ready());
  socket.emitBytes(new Uint8Array([0xe2, 0x82]));
  socket.emitClose(1000);
  await settle();
  expect(ptySessionText(SESSION)).toContain('\ufffd');
});

it.each([
  ['', false],
  ['\x1b[?1;2c', true],
  ['\x1b[>0;276;0c', true],
  ['\x1b[0n\x1b[24;80R\x1b[?24;80R', true],
  ['whoami\r', false],
  ['\x1b[31m', false],
  ['\x1b[<0;1;1M', false],
  ['\x1b[201;1R', false],
  ['\x1b[1;501R', false],
  ['\x1b[0;1R', false],
  ['á', false],
  ['\x1b[0n'.repeat(100), false],
])('valida fail-closed la respuesta técnica %#', (data, expected) => {
  expect(esRespuestaTecnicaDelTerminal(data)).toBe(expected);
});

it.each([
  [4400, 'Error de protocolo'],
  [4401, 'Ticket inválido o vencido'],
  [4403, 'Permiso revocado'],
  [4404, 'El agente PTY no está conectado'],
  [4408, 'inactividad'],
  [4409, 'Ya hay una sesión abierta'],
  [4413, 'exceso de salida'],
  [4414, 'exceso de entrada'],
  [4415, 'no alcanzó a consumir'],
  [4423, 'tiempo máximo de sesión'],
  [1011, 'Error interno del relay'],
])('explains close code %s to the operator', (code, expected) => {
  expect(ptyCloseMessage(code)).toContain(expected);
  expect(PTY_CLOSE_MESSAGES[code]).toBeDefined();
});

it('surfaces a revoked permission mid-session and notifies the owner once', () => {
  const socket = open();
  socket.emitControl(ready());
  const closed: string[] = [];
  ensurePtySession({
    sessionId: SESSION,
    websocketPath: '/v3/console/terminal/ws',
    ticket: 'single-use-ticket',
    onClosed: (view) => closed.push(view.message ?? ''),
  });

  socket.emitClose(4403, 'grant revoked');

  const view = readPtySession(SESSION);
  expect(view.state).toBe('error');
  expect(view.closeCode).toBe(4403);
  expect(view.message).toContain('Permiso revocado');
  expect(closed).toEqual([view.message]);
});

it('keeps a server-sent closed frame explanation instead of overwriting it with the code', () => {
  const socket = open();
  socket.emitControl(ready());
  socket.emitControl({ type: 'closed', reason: 'El shell terminó solo.', exit_code: 0 });
  socket.emitClose(1000);

  expect(readPtySession(SESSION).message).toContain('El shell terminó solo.');
  expect(readPtySession(SESSION).message).toContain('exit 0');
});

it('does not reconnect an explicit server close or replay the one-shot ticket', () => {
  open();
  socket_count_is(1);
  StubWebSocket.last().emitClose(4401);
  // Only 1006 is a recoverable transport loss; an explicit close ended the server-side session.
  socket_count_is(1);

  function socket_count_is(expected: number) {
    expect(StubWebSocket.instances).toHaveLength(expected);
  }
});

it('reanuda con el fence exacto y conserva como string un epoch mayor a MAX_SAFE_INTEGER', () => {
  vi.useFakeTimers();
  try {
    const first = open();
    const resumeToken = `r1.${'a'.repeat(96)}.${'b'.repeat(43)}`;
    first.emitControl(ready({ resume_token: resumeToken }));
    first.emitOutput('tres');

    first.emitClose(1006, 'network_lost');
    expect(readPtySession(SESSION)).toMatchObject({
      state: 'connecting',
      message: expect.stringContaining('reanudando el mismo PTY'),
    });
    expect(StubWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(PTY_RECONNECT_DELAYS_MS[0]);
    expect(StubWebSocket.instances).toHaveLength(2);
    const resumed = StubWebSocket.last();
    resumed.acceptOpen();
    const firstResume = resumed.frames()[0];
    expect(firstResume).toMatchObject({
      type: 'resume',
      session_id: SESSION,
      resume_token: resumeToken,
      prior_claim_token: CLAIM_TOKEN,
      prior_claim_epoch: CLAIM_EPOCH,
      after_bytes: 4,
    });
    expect(typeof firstResume.prior_claim_epoch).toBe('string');
    expect(firstResume).not.toHaveProperty('ticket');
    expect(first.framesOfType('attach')).toHaveLength(1);

    resumed.emitControl(ready({
      resumed: true,
      stream_offset: 4,
      resume_token: resumeToken,
      claim_token: 'abcdefab-cdef-4def-8def-abcdefabcdef',
      claim_epoch: '9007199254740994',
    }));
    expect(readPtySession(SESSION)).toMatchObject({ state: 'open', closeCode: undefined });

    // Un relay distinto puede emitir una generación nueva. El navegador reemplaza la anterior
    // sólo en esta PtyEntry y devuelve exactamente esa continuidad en el siguiente transporte.
    resumed.emitClose(1006, 'network_lost_again');
    vi.advanceTimersByTime(PTY_RECONNECT_DELAYS_MS[0]);
    const third = StubWebSocket.last();
    third.acceptOpen();
    expect(third.frames()[0]).toMatchObject({
      type: 'resume',
      prior_claim_token: 'abcdefab-cdef-4def-8def-abcdefabcdef',
      prior_claim_epoch: '9007199254740994',
    });
  } finally {
    vi.useRealTimers();
  }
});

it('falla cerrado ante 1006 sin token: nunca reutiliza el ticket para crear otro PTY', () => {
  vi.useFakeTimers();
  try {
    const socket = open();
    socket.emitControl(ready());
    socket.emitClose(1006, 'network_lost');
    vi.advanceTimersByTime(PTY_RECONNECT_DELAYS_MS.reduce((sum, delay) => sum + delay, 0) + 1);
    expect(StubWebSocket.instances).toHaveLength(1);
    expect(readPtySession(SESSION)).toMatchObject({ state: 'error', closeCode: 1006 });
  } finally {
    vi.useRealTimers();
  }
});

it('survives reparenting: the live node moves between panels without losing the scrollback', async () => {
  const socket = open();
  socket.emitControl(ready());
  socket.emitOutput('linea-que-sobrevive\r\n');
  await settle();

  const first = document.createElement('div');
  const second = document.createElement('div');
  document.body.append(first, second);
  attachPtySession(SESSION, first);
  const node = first.firstElementChild;
  expect(node).not.toBeNull();

  detachPtySession(SESSION);
  expect(first.firstElementChild).toBeNull();
  attachPtySession(SESSION, second);

  // Same DOM node, same socket, same scrollback: the session never restarted.
  expect(second.firstElementChild).toBe(node);
  expect(StubWebSocket.instances).toHaveLength(1);
  expect(ptySessionText(SESSION)).toContain('linea-que-sobrevive');
});

it('notifies subscribers registered before the session exists', () => {
  let notifications = 0;
  const unsubscribe = subscribePtySession(SESSION, () => { notifications += 1; });
  open();
  expect(notifications).toBeGreaterThan(0);
  unsubscribe();
});

it('rejects endpoints that are not a bare same-origin path', () => {
  expect(() => websocketUrl('wss://elsewhere.example/v3/console/terminal/ws')).toThrow(/same-origin/);
  expect(() => websocketUrl('/v3/console/terminal/ws?ticket=leaked')).toThrow(/query/);
  expect(() => websocketUrl('/v3/console/terminal/ws#fragment')).toThrow(/fragment/);
  expect(websocketUrl('/v3/console/terminal/ws')).toMatch(/^ws:\/\/localhost/);
});

/* ============================================================================================= *
 * EL SCROLL. Steven, textual: «scroll que se queda abajo si estabas abajo y NO te arrastra si
 * habías subido a leer».
 *
 * Son DOS afirmaciones y hacen falta las dos pruebas: una sola no distingue «sigue el final» de
 * «siempre salta al final», que es justo el defecto. La segunda es el control negativo de la
 * primera: mismo canal, misma salida, lo único que cambia es que el operador subió a leer.
 * ============================================================================================= */

it('mientras estás al final, la vista sigue el final y NO se ofrece «volver al final»', async () => {
  const socket = open();
  socket.emitControl(ready());
  socket.emitOutput(Array.from({ length: 120 }, (_, i) => `linea ${i}`).join('\r\n') + '\r\n');
  await settle();

  const antes = ptySessionPosicion(SESSION);
  expect(antes.baseY).toBeGreaterThan(0);
  expect(antes.viewportY).toBe(antes.baseY);
  expect(readPtySession(SESSION).seguirAlFinal).toBe(true);

  socket.emitOutput('lo ultimo que dijo el agente\r\n');
  await settle();
  const despues = ptySessionPosicion(SESSION);
  expect(despues.baseY).toBeGreaterThan(antes.baseY);
  expect(despues.viewportY).toBe(despues.baseY);
  // Y la vista lo sabe: sin esto el aviso de «hay salida nueva abajo» saldría estando ya abajo.
  expect(readPtySession(SESSION).seguirAlFinal).toBe(true);
});

it('si subiste a leer, la salida nueva NO te arrastra — y se te ofrece volver al final', async () => {
  const socket = open();
  socket.emitControl(ready());
  socket.emitOutput(Array.from({ length: 120 }, (_, i) => `linea ${i}`).join('\r\n') + '\r\n');
  await settle();

  // El operador sube 40 filas a leer algo.
  ptySessionScroll(SESSION, -40);
  await settle();
  const arriba = ptySessionPosicion(SESSION);
  expect(arriba.viewportY).toBeLessThan(arriba.baseY);
  expect(readPtySession(SESSION).seguirAlFinal).toBe(false);

  // Llega salida nueva: el búfer crece y la vista se queda EXACTAMENTE donde estaba.
  socket.emitOutput('mas salida del agente\r\n');
  await settle();
  const tras = ptySessionPosicion(SESSION);
  expect(tras.baseY).toBeGreaterThan(arriba.baseY);
  expect(tras.viewportY).toBe(arriba.viewportY);

  // Y el botón devuelve el seguimiento.
  ptySessionVolverAlFinal(SESSION);
  await settle();
  const final = ptySessionPosicion(SESSION);
  expect(final.viewportY).toBe(final.baseY);
  expect(readPtySession(SESSION).seguirAlFinal).toBe(true);
});
