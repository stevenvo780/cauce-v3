import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_RELAY_METRICS } from './metrics.js';
import {
  CLOSE_CODES,
  MAX_COLS,
  MAX_INPUT_MESSAGE_BYTES,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  SessionManager,
  parseClientMessage,
} from './sessions.js';
import {
  FakeAgentConnection,
  FakeBrowserSocket,
  FakeGateway,
  OTHER_SESSION_ID,
  SESSION_ID,
  cleanScratchDirectories,
  limits,
  openSession,
  wait,
  waitFor,
} from './relay-session-fakes.js';
import { grant, CLAIM_TOKEN } from './relay-test-fixtures.js';

afterEach(cleanScratchDirectories);

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

  it('acota el resize fuera de rango en vez de rechazarlo y matar la sesión', () => {
    expect(parseClientMessage(Buffer.from('{"type":"resize","cols":100,"rows":1}'), false))
      .toEqual({ type: 'resize', cols: 100, rows: MIN_ROWS });
    expect(parseClientMessage(Buffer.from('{"type":"resize","cols":4,"rows":30}'), false))
      .toEqual({ type: 'resize', cols: MIN_COLS, rows: 30 });
    expect(parseClientMessage(Buffer.from('{"type":"resize","cols":9999,"rows":9999}'), false))
      .toEqual({ type: 'resize', cols: MAX_COLS, rows: MAX_ROWS });
  });

  // Negative control: bounding must not become "I accept anything".
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
    const viewerPing = setInterval(() => { viewer.socket.raw('{"type":"ping"}'); }, 10);
    try {
      await wait(100);
      expect(viewer.socket.closes).toHaveLength(0);
    } finally {
      clearInterval(viewerPing);
    }

    const shell = await openSession({ idleTimeoutMs: 35 });
    const shellPing = setInterval(() => { shell.socket.raw('{"type":"ping"}'); }, 10);
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

  it('cuenta como denegado cada rechazo del gestor: sid repetido, contenedor ocupado y tope de sesiones', async () => {
    const openAttempt = vi.fn<(result: string) => void>();
    const gateway = new FakeGateway();
    const manager = new SessionManager({ gateway, limits: limits({ maxSessions: 2 }), metrics: { ...NO_RELAY_METRICS, openAttempt } });
    const agent = new FakeAgentConnection();
    const open = (sessionId: string, container: string) => manager.open({
      socket: new FakeBrowserSocket().asWebSocket(), sessionId, ticket: `ticket-${container}`,
      grant: grant({ container }), agent: agent.asAgent(), cols: 80, rows: 24,
    });
    const first = open(SESSION_ID, 'claw-one');
    await waitFor(() => agent.handlersBySession.has(SESSION_ID));
    agent.handlersBySession.get(SESSION_ID)?.onOpenOk(1);
    await first;
    await open(SESSION_ID, 'claw-one');
    await open(OTHER_SESSION_ID, 'claw-one');
    const third = open('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'claw-two');
    await waitFor(() => agent.handlersBySession.has('cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
    agent.handlersBySession.get('cccccccc-cccc-4ccc-8ccc-cccccccccccc')?.onOpenOk(2);
    await third;
    await open('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'claw-three');

    expect(openAttempt.mock.calls.map(([result]) => result))
      .toEqual(['opened', 'denied', 'denied', 'opened', 'denied']);
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
});
