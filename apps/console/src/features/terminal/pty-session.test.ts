import { afterEach, beforeEach } from 'vitest';
import {
  attachPtySession,
  closePtySession,
  detachPtySession,
  ensurePtySession,
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
} from './pty-session';
import { installStubWebSocket, StubWebSocket } from './pty-socket-stub';

const SESSION = 'pty-session-1';
let restore: () => void;

beforeEach(() => { restore = installStubWebSocket(); });
afterEach(() => { closePtySession(SESSION); restore(); });

function open(options: { sessionId?: string; ticket?: string } = {}): StubWebSocket {
  ensurePtySession({
    sessionId: options.sessionId ?? SESSION,
    websocketPath: '/v3/console/terminal/ws',
    ticket: options.ticket ?? 'single-use-ticket',
  });
  const socket = StubWebSocket.last();
  socket.acceptOpen();
  return socket;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

it('sends attach as the very first frame, carrying the session and the single-use ticket', () => {
  const socket = open();

  const first = socket.frames()[0];
  expect(first).toMatchObject({ type: 'attach', session_id: SESSION, ticket: 'single-use-ticket' });
  expect(typeof first.cols).toBe('number');
  expect(typeof first.rows).toBe('number');
  expect(readPtySession(SESSION).state).toBe('attaching');
});

it('never puts the ticket in the URL: it travels only inside the attach frame', () => {
  const socket = open();
  expect(socket.url).not.toContain('single-use-ticket');
  expect(new URL(socket.url).search).toBe('');
});

it('writes binary frames to the terminal and keeps text frames out of the output', async () => {
  const socket = open();
  socket.emitControl({ type: 'ready' });
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
  socket.emitControl({ type: 'ready' });

  ptySessionType(SESSION, 'l');
  ptySessionType(SESSION, 's');
  ptySessionType(SESSION, '\r');
  expect(socket.framesOfType('input')).toHaveLength(0);

  await settle();
  expect(socket.framesOfType('input')).toEqual([{ type: 'input', data: 'ls\r' }]);
});

it.each([
  [4400, 'Error de protocolo'],
  [4401, 'Ticket inválido o vencido'],
  [4403, 'Permiso revocado'],
  [4404, 'El agente PTY no está conectado'],
  [4408, 'inactividad'],
  [4409, 'Ya hay una sesión abierta'],
  [4413, 'exceso de salida'],
  [4423, 'tiempo máximo de sesión'],
  [1011, 'Error interno del relay'],
])('explains close code %s to the operator', (code, expected) => {
  expect(ptyCloseMessage(code)).toContain(expected);
  expect(PTY_CLOSE_MESSAGES[code]).toBeDefined();
});

it('surfaces a revoked permission mid-session and notifies the owner once', () => {
  const socket = open();
  socket.emitControl({ type: 'ready' });
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
  socket.emitControl({ type: 'ready' });
  socket.emitControl({ type: 'closed', reason: 'El shell terminó solo.', exit_code: 0 });
  socket.emitClose(1000);

  expect(readPtySession(SESSION).message).toContain('El shell terminó solo.');
  expect(readPtySession(SESSION).message).toContain('exit 0');
});

it('does not reconnect on its own: a closed channel opens no second socket', () => {
  open();
  socket_count_is(1);
  StubWebSocket.last().emitClose(4401);
  // A single-use ticket cannot be replayed, so nothing may reconnect behind the operator's back.
  socket_count_is(1);

  function socket_count_is(expected: number) {
    expect(StubWebSocket.instances).toHaveLength(expected);
  }
});

it('survives reparenting: the live node moves between panels without losing the scrollback', async () => {
  const socket = open();
  socket.emitControl({ type: 'ready' });
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
  socket.emitControl({ type: 'ready' });
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
  socket.emitControl({ type: 'ready' });
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
