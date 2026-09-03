import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_RELAY_METRICS, type SessionOpenResult } from './metrics.js';
import { SessionRecording } from './recording.js';
import { MAX_PENDING_NOTICES } from './session-limits.js';
import { CLOSE_CODES, SessionManager } from './sessions.js';
import {
  FakeAgentConnection,
  FakeBrowserSocket,
  FakeGateway,
  OTHER_SESSION_ID,
  SESSION_ID,
  cleanScratchDirectories,
  limits,
  openSession,
  recordingDir,
  wait,
  waitFor,
} from './relay-session-fakes.js';
import { grant } from './relay-test-fixtures.js';

afterEach(cleanScratchDirectories);

describe('writable TUI, recording and agent notices', () => {
  it('un TUI escribible teclea, sigue contestando DA/DSR y queda grabado', async () => {
    const directory = await recordingDir();
    const { socket, agent, gateway } = await openSession(
      { recordingDir: directory }, { mode: 'harness_rw' },
    );
    expect(agent.opens[0]).toMatchObject({ mode: 'harness_rw' });
    socket.raw(JSON.stringify({ type: 'terminal_response', data: '\x1b[?1;2c' }));
    expect(agent.terminalResponses.map((chunk) => chunk.toString('ascii'))).toEqual(['\x1b[?1;2c']);
    socket.type('ls\r');
    await wait(40);
    expect(agent.stdin[0]?.toString()).toBe('ls\r');
    agent.handlers?.onStdout(Buffer.from('total 0\r\n'));
    agent.handlers?.onClosed({ exit_code: 0, signal: null, reason: 'agent_closed' });

    await waitFor(() => gateway.closeReports.length > 0);
    const report = gateway.closeReports[0]?.report;
    expect(report?.input_batches).toBe(1);
    expect(report?.recording_sha256).toMatch(/^[0-9a-f]{64}$/u);
    const cast = await readFile(join(directory, `${SESSION_ID}.cast`), 'utf8');
    expect(cast.split('\n').filter((line) => line.length > 0)).toHaveLength(3);
    expect(cast).toContain('"i","ls\\r"');
  });

  it('rechaza abrir un TUI escribible sin grabación en vez de degradarlo', async () => {
    const { socket, agent, gateway } = await openSession({}, { mode: 'harness_rw' });
    expect(agent.opens).toHaveLength(0);
    expect(socket.closes[0]).toEqual({
      code: CLOSE_CODES.internal_error, reason: 'recording_unavailable',
    });
    await waitFor(() => gateway.closeReports.length > 0);
    expect(gateway.closeReports[0]?.report.recording_sha256).toBeUndefined();
  });

  it('no rearma el idle de un TUI escribible ni con salida ni con ping, sólo con teclado', async () => {
    const directory = await recordingDir();
    const { socket, agent } = await openSession(
      { idleTimeoutMs: 60, outputRateBytesPerSec: 10_000_000, recordingDir: directory },
      { mode: 'harness_rw' },
    );
    const noise = setInterval(() => {
      agent.handlers?.onStdout(Buffer.from('.'));
      socket.raw('{"type":"ping"}');
    }, 10);
    try {
      await waitFor(() => socket.closes.length > 0);
    } finally {
      clearInterval(noise);
    }
    expect(socket.closes[0]).toEqual({ code: CLOSE_CODES.idle_timeout, reason: 'idle_timeout' });
  });

  it('cuenta el intento vencido y no abre PTY cuando el grant ya expiró', async () => {
    const gateway = new FakeGateway();
    const attempts: SessionOpenResult[] = [];
    const manager = new SessionManager({
      gateway,
      limits: limits(),
      metrics: { ...NO_RELAY_METRICS, openAttempt: (result) => { attempts.push(result); } },
    });
    const socket = new FakeBrowserSocket();
    const agent = new FakeAgentConnection();
    await manager.open({
      socket: socket.asWebSocket(),
      sessionId: SESSION_ID,
      ticket: 'ticket-vencido',
      grant: grant({ session_expires_at: new Date(Date.now() - 1_000).toISOString() }),
      agent: agent.asAgent(),
      cols: 120,
      rows: 40,
    });

    expect(attempts).toEqual(['expired']);
    expect(agent.opens).toHaveLength(0);
    expect(socket.closes[0]).toEqual({ code: CLOSE_CODES.ttl_expired, reason: 'ttl_expired' });
  });

  it('nunca graba una sesión de sólo lectura, ni con el interruptor de shell encendido', async () => {
    const directory = await recordingDir();
    const { socket, agent, gateway } = await openSession(
      { recordingDir: directory, recordShellSessions: true }, { mode: 'harness' },
    );
    agent.handlers?.onStdout(Buffer.from('mirando\r\n'));
    agent.handlers?.onClosed({ exit_code: 0, signal: null, reason: 'agent_closed' });

    await waitFor(() => gateway.closeReports.length > 0);
    expect(gateway.closeReports[0]?.report.recording_sha256).toBeUndefined();
    expect(gateway.closeReports[0]?.report.recording_capped).toBeUndefined();
    await expect(readdir(directory)).rejects.toThrow();
    expect(socket.closes[0]?.code).toBe(CLOSE_CODES.normal);
  });

  it('graba un shell sólo con el interruptor explícito, nunca por defecto', async () => {
    const apagado = await recordingDir();
    const off = await openSession({ recordingDir: apagado });
    off.socket.type('id\r');
    await wait(40);
    off.agent.handlers?.onClosed({ exit_code: 0, signal: null, reason: 'agent_closed' });
    await waitFor(() => off.gateway.closeReports.length > 0);
    expect(off.gateway.closeReports[0]?.report.recording_sha256).toBeUndefined();
    await expect(readdir(apagado)).rejects.toThrow();

    const encendido = await recordingDir();
    const on = await openSession({ recordingDir: encendido, recordShellSessions: true });
    on.socket.type('id\r');
    await wait(40);
    on.agent.handlers?.onClosed({ exit_code: 0, signal: null, reason: 'agent_closed' });
    await waitFor(() => on.gateway.closeReports.length > 0);
    expect(on.gateway.closeReports[0]?.report.recording_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(await readdir(encendido)).toEqual([`${SESSION_ID}.cast`]);
  });

  it('cierra la sesión cuando la grabación se rompe a mitad, sin dejar pasar la ráfaga', async () => {
    const directory = await recordingDir();
    const { socket, agent, gateway } = await openSession(
      { recordingDir: directory }, { mode: 'harness_rw' },
    );
    const broken = vi.spyOn(SessionRecording.prototype, 'broken', 'get').mockReturnValue(true);
    try {
      socket.type('secreto\r');
      await waitFor(() => socket.closes.length > 0);
    } finally {
      broken.mockRestore();
    }

    expect(agent.stdin).toHaveLength(0);
    expect(socket.closes[0]).toEqual({
      code: CLOSE_CODES.internal_error, reason: 'recording_failed',
    });
    await waitFor(() => gateway.closeReports.length > 0);
    expect(gateway.closeReports[0]?.report.reason).toBe('recording_failed');
  });

  it('marca recording_capped en el informe de cierre cuando la grabación se topó', async () => {
    const directory = await recordingDir();
    const { agent, gateway } = await openSession(
      { recordingDir: directory, recordingMaxBytes: 128 }, { mode: 'harness_rw' },
    );
    for (let index = 0; index < 8; index += 1) {
      agent.handlers?.onStdout(Buffer.alloc(64, 0x41));
    }
    agent.handlers?.onClosed({ exit_code: 0, signal: null, reason: 'agent_closed' });

    await waitFor(() => gateway.closeReports.length > 0);
    expect(gateway.closeReports[0]?.report.recording_capped).toBe(true);
  });

  it('una tormenta de GEOMETRY cae por el mismo 4413 que una inundación de salida', async () => {
    const directory = await recordingDir();
    const { socket, agent } = await openSession(
      { outputWindowMs: 10, outputRateBytesPerSec: 1_000, recordingDir: directory },
      { mode: 'harness_rw' },
    );
    const storm = setInterval(() => {
      agent.handlers?.onAgentNotice('geometry', { session_id: SESSION_ID, cols: 203, rows: 51 });
    }, 2);
    try {
      await waitFor(() => socket.closes.length > 0);
    } finally {
      clearInterval(storm);
    }

    expect(socket.closes[0]?.code).toBe(CLOSE_CODES.output_flood);
    expect(socket.binary).toHaveLength(0);
  });

  it('retiene un aviso que llega antes de OPEN_OK y lo entrega detrás de ready', async () => {
    const directory = await recordingDir();
    const gateway = new FakeGateway();
    const manager = new SessionManager({ gateway, limits: limits({ recordingDir: directory }) });
    const socket = new FakeBrowserSocket();
    const agent = new FakeAgentConnection();
    const opening = manager.open({
      socket: socket.asWebSocket(),
      sessionId: SESSION_ID,
      ticket: 'ticket-under-test',
      grant: grant({ mode: 'harness_rw' }),
      agent: agent.asAgent(),
      cols: 120,
      rows: 40,
    });
    await waitFor(() => agent.handlersBySession.has(SESSION_ID));
    agent.handlers?.onAgentNotice('geometry', { session_id: SESSION_ID, cols: 203, rows: 51 });
    expect(socket.text).toHaveLength(0);
    agent.handlers?.onOpenOk(4242);
    await opening;

    expect(socket.json(0)).toMatchObject({ type: 'ready' });
    expect(socket.json(1)).toEqual({
      type: 'geometry', session_id: SESSION_ID, cols: 203, rows: 51,
    });
  });

  it('mide cada aviso reenviado en bytes_out, como cualquier salida', async () => {
    const directory = await recordingDir();
    const bytesOut = vi.fn<(bytes: number) => void>();
    const gateway = new FakeGateway();
    const manager = new SessionManager({
      gateway, limits: limits({ recordingDir: directory }), metrics: { ...NO_RELAY_METRICS, bytesOut },
    });
    const { agent } = await openSession({ recordingDir: directory }, { mode: 'harness_rw' }, SESSION_ID, { manager, gateway });
    const body = { session_id: SESSION_ID, cols: 203, rows: 51 };
    agent.handlers?.onAgentNotice('geometry', body);

    expect(bytesOut).toHaveBeenCalledWith(Buffer.byteLength(JSON.stringify({ ...body, type: 'geometry' }), 'utf8'));
  });

  it('retiene como mucho MAX_PENDING_NOTICES avisos antes de ready y descarta el resto', async () => {
    const directory = await recordingDir();
    const gateway = new FakeGateway();
    const manager = new SessionManager({ gateway, limits: limits({ recordingDir: directory }) });
    const socket = new FakeBrowserSocket();
    const agent = new FakeAgentConnection();
    const opening = manager.open({
      socket: socket.asWebSocket(), sessionId: SESSION_ID, ticket: 'ticket-under-test',
      grant: grant({ mode: 'harness_rw' }), agent: agent.asAgent(), cols: 120, rows: 40,
    });
    await waitFor(() => agent.handlersBySession.has(SESSION_ID));
    for (let index = 0; index < MAX_PENDING_NOTICES + 5; index += 1) {
      agent.handlers?.onAgentNotice('geometry', { session_id: SESSION_ID, cols: 80 + index, rows: 24 });
    }
    expect(socket.text).toHaveLength(0);
    agent.handlers?.onOpenOk(4242);
    await opening;

    expect(socket.text).toHaveLength(1 + MAX_PENDING_NOTICES);
    expect(socket.json(MAX_PENDING_NOTICES)).toMatchObject({ type: 'geometry', cols: 80 + MAX_PENDING_NOTICES - 1 });
  });

  it('reenvía INPUT_REFUSED y GEOMETRY tal cual, con el discriminador puesto por el relay', async () => {
    const directory = await recordingDir();
    const { socket, agent } = await openSession(
      { recordingDir: directory }, { mode: 'harness_rw' },
    );
    agent.handlers?.onAgentNotice('input_refused', {
      session_id: SESSION_ID, reason: 'pane_input_barrier',
    });
    agent.handlers?.onAgentNotice('geometry', {
      session_id: SESSION_ID, cols: 203, rows: 51, type: 'ready',
    });

    expect(socket.json(1)).toEqual({
      type: 'input_refused', session_id: SESSION_ID, reason: 'pane_input_barrier',
    });
    expect(socket.json(2)).toEqual({
      type: 'geometry', session_id: SESSION_ID, cols: 203, rows: 51,
    });
    expect(socket.binary).toHaveLength(0);
    expect(socket.closes).toHaveLength(0);

    socket.bufferedAmount = 8 * 1024 * 1024;
    agent.handlers?.onAgentNotice('geometry', { session_id: SESSION_ID, cols: 80, rows: 24 });
    expect(agent.pausedSessions).toEqual(new Set([SESSION_ID]));
  });

  it('cierra con 4410 cuando el gateway informa que el control se soltó', async () => {
    const directory = await recordingDir();
    const writable = await openSession(
      { authzIntervalMs: 15, recordingDir: directory }, { mode: 'harness_rw' },
    );
    writable.gateway.authz = { status: 'control_released' };
    await waitFor(() => writable.socket.closes.length > 0);
    expect(writable.socket.closes[0]).toEqual({
      code: CLOSE_CODES.control_released, reason: 'control_released',
    });

    const viewer = await openSession({ authzIntervalMs: 15 }, { mode: 'harness' }, OTHER_SESSION_ID);
    viewer.gateway.authz = { status: 'control_released' };
    await waitFor(() => viewer.socket.closes.length > 0);
    expect(viewer.socket.closes[0]?.code).toBe(CLOSE_CODES.revoked);
  });
});
