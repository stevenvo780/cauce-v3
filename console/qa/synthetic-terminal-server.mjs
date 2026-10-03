// Local browser fixture only. No shell, production credentials, or real gateway authorization.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { mockTerminalGrant } from '../src/mocks/terminal-ticket.ts';

export async function syntheticTerminalServer(upstream) {
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname));
  const sessions = new Map();
  const journal = [];
  const scenario = { busyOnce: true, disabled: false, refuseOnce: false, readyDelay: 0 };
  const prefix = '/v3/console/terminal';
  const server = http.createServer(async (request, response) => {
    if (!request.url.startsWith(prefix)) {
      const proxy = http.request(new URL(request.url, upstream), { method: request.method, headers: request.headers }, incoming => {
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(response);
      });
      proxy.on('error', () => { response.writeHead(502); response.end(); });
      request.pipe(proxy);
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    journal.push({ http: request.method, path: request.url, body });
    const reply = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(value === undefined ? undefined : JSON.stringify(value));
    };
    const denied = reason => reply(403, { error: reason, reason, code: reason });
    if (request.url === `${prefix}/capability`) return reply(200, { available: true, plugin_id: 'ultimate-terminal.client', capabilities: ['terminal.pty.client'], websocket_path: `${prefix}/stream` });
    if (request.url === `${prefix}/targets`) return reply(200, {
      observed_at: new Date().toISOString(), websocket_path: `${prefix}/stream`,
      items: ['kant', 'argos'].map(alias => ({ tenant_id: 'Steven', alias, container: 'synthetic-only', runtime_user: 'dev', harness: 'claude-code', shares_container_with: [], modes: ['shell', 'harness', 'harness_rw'], writable_modes: ['harness_rw'], pty_state: 'online', last_seen: new Date().toISOString(), authorized: true, reason: 'Synthetic browser fixture' })),
    });
    if (request.url === `${prefix}/sessions` && request.method === 'POST') {
      if (!['harness', 'harness_rw'].includes(body.mode)) return denied('synthetic_fixture_disallows_shell');
      if (scenario.disabled && body.mode === 'harness_rw') return denied('writable_tui_disabled');
      const grant = { ...mockTerminalGrant({ sessionId: randomUUID(), tenantId: body.tenant_id, alias: body.alias, mode: body.mode, requestId: body.request_id, ttlSeconds: 30 }), websocket_path: `${prefix}/stream` };
      sessions.set(grant.session_id, { grant, owner: body, held: false, frames: [], output: Buffer.alloc(0), epoch: 0, resume: 'synthetic-resume-'.repeat(8) });
      return reply(201, grant);
    }
    const id = request.url.slice(`${prefix}/sessions/`.length).split('/')[0];
    const session = sessions.get(id);
    if (request.method === 'DELETE' && session) {
      session.pty?.stdin.end();
      session.socket?.close(1000);
      return reply(204);
    }
    if (request.url.endsWith('/control') && session) {
      if (body.owner_token !== session.owner.owner_token || body.request_id !== session.owner.request_id || body.owner_generation !== '1') return denied('stale_terminal_owner');
      if (body.action === 'release') {
        session.held = false;
        return reply(200, { session_id: id, released: true, hold_id: 'synthetic-hold' });
      }
      if (scenario.disabled) return denied('writable_tui_disabled');
      if (scenario.busyOnce) {
        scenario.busyOnce = false;
        return reply(409, { error: 'agent_busy', code: 'agent_busy' });
      }
      if (session.grant.target.mode !== 'harness_rw' || !session.epoch) return denied('stale_terminal_owner');
      session.held = true;
      return reply(200, { session_id: id, hold_id: 'synthetic-hold', held_by: 'synthetic-operator', expires_at: new Date(Date.now() + 300000).toISOString() });
    }
    if (request.url === `${prefix}/sessions`) return reply(200, { items: [] });
    reply(404, { error: 'unknown_synthetic_route' });
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (request.url.startsWith(`${prefix}/stream`)) return sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
    const relay = net.connect(Number(upstream.port), upstream.hostname, () => {
      relay.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${Object.entries(request.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (head.length) relay.write(head);
      socket.pipe(relay).pipe(socket);
    });
    relay.on('error', () => socket.destroy());
    socket.on('error', () => relay.destroy());
    socket.on('close', () => relay.destroy());
  });
  sockets.on('connection', socket => {
    let session;
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      journal.push({ ws: frame });
      if (frame.type === 'attach' || frame.type === 'resume') {
        session = sessions.get(frame.session_id);
        assert(session, 'Only a fixture-issued session is accepted');
        if (frame.type === 'attach') assert.equal(frame.ticket, session.grant.ticket);
        else {
          assert.equal(frame.resume_token, session.resume);
          assert.equal(frame.prior_claim_token, session.claim);
          assert.equal(frame.prior_claim_epoch, String(session.epoch));
          assert(!('ticket' in frame));
        }
        session.socket = socket;
        session.claim = randomUUID();
        session.epoch += 1;
        const ready = () => {
          socket.send(JSON.stringify({ type: 'ready', claim_token: session.claim, claim_epoch: String(session.epoch), claim_lease_ms: 45000, resume_token: session.resume }));
          if (session.output.length) socket.send(session.output.subarray(frame.after_bytes ?? 0));
          if (!session.pty) {
            session.pty = spawn('python3', [new URL('./synthetic-tui.py', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'pipe'] });
            session.pty.stdout.on('data', bytes => {
              session.output = Buffer.concat([session.output, bytes]);
              if (session.socket?.readyState === 1) session.socket.send(bytes);
            });
            session.pty.stderr.on('data', bytes => journal.push({ ptyError: bytes.toString() }));
          }
        };
        setTimeout(ready, scenario.readyDelay);
        return;
      }
      assert(session, 'Attach precedes input');
      session.frames.push(frame);
      if (frame.type === 'input') {
        if (!session.held || scenario.refuseOnce) {
          scenario.refuseOnce = false;
          socket.send(JSON.stringify({ type: 'input_refused', reason: 'control_not_held' }));
          return;
        }
        session.pty.stdin.write(`${JSON.stringify({ type: 'input', hex: Buffer.from(frame.data).toString('hex') })}\n`);
      }
      if (frame.type === 'resize' && session.held) session.pty.stdin.write(`${JSON.stringify(frame)}\n`);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`, sessions, journal, scenario,
    close() {
      for (const session of sessions.values()) session.pty?.stdin.end();
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      server.closeAllConnections();
      server.close();
    },
  };
}
