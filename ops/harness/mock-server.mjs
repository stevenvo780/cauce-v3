#!/usr/bin/env node

import http from 'node:http';
import crypto from 'node:crypto';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8080);
const presenceLeaseMs = Number(process.env.PRESENCE_LEASE_MS || 1200);
const ackTimeoutMs = Number(process.env.ACK_TIMEOUT_MS || 120);
const maxAttempts = Number(process.env.MAX_DELIVERY_ATTEMPTS || 3);

const tenantAgents = {
  steven: ['jarvis', 'kant', 'socrates', 'argos'],
  miguel: ['kratos', 'janus'],
  isa: ['salva'],
  jhon: ['hegel'],
  pablo: ['dedalo', 'midas', 'seneca', 'vulcano'],
};
const knownAgents = new Map(Object.entries(tenantAgents).flatMap(([tenant, agents]) => agents.map((agent) => [agent, tenant])));
const laneCycle = ['control', 'interactive', 'interactive', 'normal', 'normal', 'normal', 'bulk'];

const state = {
  dbUp: true,
  dispatchPaused: false,
  connections: new Map(),
  presence: new Map(),
  messages: new Map(),
  idempotency: new Map(),
  deliveries: new Map(),
  routes: [],
  dlq: [],
  wakes: [],
};

const keyOf = (tenant, agent) => `${tenant}/${agent}`;
const sendJson = (response, status, body) => {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(encoded),
    'cache-control': 'no-store',
  });
  response.end(encoded);
};

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1_048_576) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  if (!length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function laneRank(connection, lane) {
  for (let offset = 0; offset < laneCycle.length; offset += 1) {
    if (laneCycle[(connection.laneCursor + offset) % laneCycle.length] === lane) return offset;
  }
  return laneCycle.length;
}

function schedule(recipientKey) {
  if (!state.dbUp || state.dispatchPaused) return;
  const connection = state.connections.get(recipientKey);
  if (!connection || connection.inflight) return;
  const candidates = state.routes.filter((route) => route.recipientKey === recipientKey && route.status === 'queued');
  if (!candidates.length) return;
  candidates.sort((left, right) => {
    const laneDelta = laneRank(connection, left.message.lane) - laneRank(connection, right.message.lane);
    return laneDelta || left.queuedAt - right.queuedAt;
  });
  const route = candidates[0];
  const matchedOffset = laneRank(connection, route.message.lane);
  connection.laneCursor = (connection.laneCursor + matchedOffset + 1) % laneCycle.length;
  deliver(connection, route);
}

function deliver(connection, route) {
  route.attempt += 1;
  route.status = 'inflight';
  route.currentDeliveryId = crypto.randomUUID();
  state.deliveries.set(route.currentDeliveryId, route);
  connection.inflight = route;
  connection.ws.send({
    type: 'message',
    messageId: route.message.messageId,
    deliveryId: route.currentDeliveryId,
    attempt: route.attempt,
    lane: route.message.lane,
    origin: route.message.origin,
    recipient: route.recipient,
    payload: route.message.payload,
  });
  clearTimeout(route.timer);
  route.timer = setTimeout(() => {
    if (route.status !== 'inflight') return;
    const active = state.connections.get(route.recipientKey);
    if (active?.inflight === route) active.inflight = null;
    if (route.attempt >= maxAttempts) {
      route.status = 'dlq';
      route.message.state = 'dlq';
      state.dlq.push({
        messageId: route.message.messageId,
        tenant: route.recipient.tenant,
        recipient: route.recipient,
        attempts: route.attempt,
        reason: 'ack_timeout',
      });
    } else {
      route.status = 'queued';
      route.queuedAt = Date.now();
    }
    schedule(route.recipientKey);
  }, ackTimeoutMs);
}

function acknowledge(connection, frame) {
  const route = state.deliveries.get(frame.deliveryId);
  if (!route || frame.messageId !== route.message.messageId) {
    connection.ws.send({ type: 'ack_result', status: 'unknown', deliveryId: frame.deliveryId });
    return;
  }
  if (route.status === 'acked') {
    connection.ws.send({ type: 'ack_result', status: 'duplicate', deliveryId: frame.deliveryId });
    return;
  }
  if (route.currentDeliveryId !== frame.deliveryId || route.status !== 'inflight') {
    connection.ws.send({ type: 'ack_result', status: 'out_of_order', deliveryId: frame.deliveryId });
    return;
  }
  clearTimeout(route.timer);
  route.status = 'acked';
  route.message.state = 'acked';
  if (connection.inflight === route) connection.inflight = null;
  connection.ws.send({ type: 'ack_result', status: 'accepted', deliveryId: frame.deliveryId });
  schedule(route.recipientKey);
}

function handleWsMessage(connection, raw) {
  let frame;
  try { frame = JSON.parse(raw); } catch { connection.ws.send({ type: 'error', code: 'invalid_json' }); return; }
  if (frame.type === 'ack') acknowledge(connection, frame);
  else if (frame.type === 'heartbeat') {
    connection.leaseUntil = Date.now() + presenceLeaseMs;
    state.presence.set(connection.key, { ...state.presence.get(connection.key), leaseUntil: connection.leaseUntil });
    connection.ws.send({ type: 'heartbeat_ack', leaseUntil: connection.leaseUntil });
  } else connection.ws.send({ type: 'error', code: 'unsupported_frame' });
}

class WsPeer {
  constructor(socket, onMessage, onClose) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    socket.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.parse(onMessage); });
    socket.on('close', () => { if (!this.closed) { this.closed = true; onClose(); } });
    socket.on('error', () => { if (!this.closed) { this.closed = true; onClose(); } });
  }

  parse(onMessage) {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const largeLength = this.buffer.readBigUInt64BE(2);
        if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) { this.socket.destroy(); return; }
        length = Number(largeLength); offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskLength;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      if (opcode === 0x1) onMessage(payload.toString('utf8'));
      else if (opcode === 0x8) { this.close(); return; }
      else if (opcode === 0x9) this.frame(payload, 0xA);
    }
  }

  frame(payload, opcode = 0x1) {
    if (this.closed || this.socket.destroyed) return;
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    let header;
    if (body.length < 126) {
      header = Buffer.from([0x80 | opcode, body.length]);
    } else if (body.length <= 65535) {
      header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(body.length, 2);
    } else {
      header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2);
    }
    this.socket.write(Buffer.concat([header, body]));
  }

  send(value) { this.frame(JSON.stringify(value)); }
  close() { if (!this.closed) { this.frame(Buffer.alloc(0), 0x8); this.socket.end(); } }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (request.method === 'GET' && url.pathname === '/health/live') return sendJson(response, 200, { status: 'live' });
    if (request.method === 'GET' && url.pathname === '/health/ready') {
      return sendJson(response, state.dbUp ? 200 : 503, { status: state.dbUp ? 'ready' : 'not_ready', dependencies: { db: state.dbUp } });
    }
    if (request.method === 'GET' && url.pathname === '/metrics') {
      const body = `# TYPE cauce_ws_connections gauge\ncauce_ws_connections ${state.connections.size}\n# TYPE cauce_dlq_messages gauge\ncauce_dlq_messages ${state.dlq.length}\n`;
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); response.end(body); return;
    }
    if (!state.dbUp && !url.pathname.startsWith('/__control/')) return sendJson(response, 503, { code: 'db_unavailable' });

    if (request.method === 'POST' && url.pathname === '/v3/messages') {
      const body = await readJson(request);
      if (!body.tenant || !body.originAgent || !body.idempotencyKey || !Array.isArray(body.recipients)) {
        return sendJson(response, 400, { code: 'invalid_request' });
      }
      if (body.recipients.length === 0) return sendJson(response, 422, { code: 'no_route', routeCount: 0 });
      if (knownAgents.get(body.originAgent) !== body.tenant) return sendJson(response, 422, { code: 'unknown_origin' });
      for (const recipient of body.recipients) {
        if (!recipient || knownAgents.get(recipient.agent) !== recipient.tenant) return sendJson(response, 422, { code: 'no_route' });
        if (recipient.tenant !== body.tenant) return sendJson(response, 403, { code: 'acl_denied' });
      }
      const idempotencyKey = `${body.tenant}/${body.idempotencyKey}`;
      const previous = state.idempotency.get(idempotencyKey);
      if (previous) return sendJson(response, 200, { messageId: previous.messageId, duplicate: true, routeCount: previous.recipients.length });
      const message = {
        messageId: body.messageId || crypto.randomUUID(),
        tenant: body.tenant,
        origin: { tenant: body.tenant, agent: body.originAgent },
        recipients: body.recipients,
        payload: body.payload ?? null,
        lane: laneCycle.includes(body.lane) ? body.lane : 'normal',
        state: 'queued',
      };
      state.messages.set(message.messageId, message);
      state.idempotency.set(idempotencyKey, message);
      for (const recipient of message.recipients) {
        const route = {
          message,
          recipient,
          recipientKey: keyOf(recipient.tenant, recipient.agent),
          status: 'queued',
          attempt: 0,
          queuedAt: Date.now(),
        };
        state.routes.push(route);
        schedule(route.recipientKey);
      }
      return sendJson(response, 202, { messageId: message.messageId, duplicate: false, routeCount: message.recipients.length });
    }

    const presenceMatch = url.pathname.match(/^\/v3\/presence\/([^/]+)$/);
    if (request.method === 'GET' && presenceMatch) {
      const agent = decodeURIComponent(presenceMatch[1]);
      const tenant = url.searchParams.get('tenant');
      const key = keyOf(tenant, agent);
      const entry = state.presence.get(key);
      const connected = state.connections.has(key);
      const now = Date.now();
      const status = connected ? 'online' : entry && entry.leaseUntil > now ? 'stale' : 'offline';
      return sendJson(response, 200, { tenant, agent, status, leaseUntil: entry?.leaseUntil || null, harnessKind: entry?.harnessKind || null });
    }

    const wakeMatch = url.pathname.match(/^\/v3\/agents\/([^/]+)\/wake$/);
    if (request.method === 'POST' && wakeMatch) {
      const agent = decodeURIComponent(wakeMatch[1]);
      const body = await readJson(request);
      if (knownAgents.get(agent) !== body.tenant) return sendJson(response, 422, { code: 'no_route' });
      const wake = { wakeId: crypto.randomUUID(), tenant: body.tenant, agent, reason: body.reason || 'message_pending', delivered: false };
      state.wakes.push(wake);
      const connection = state.connections.get(keyOf(body.tenant, agent));
      if (connection) { connection.ws.send({ type: 'wake', ...wake }); wake.delivered = true; }
      return sendJson(response, 202, { wakeId: wake.wakeId, status: wake.delivered ? 'dispatched' : 'pending' });
    }

    const dlqMatch = url.pathname.match(/^\/v3\/dlq\/([^/]+)$/);
    if (request.method === 'GET' && dlqMatch) {
      const tenant = decodeURIComponent(dlqMatch[1]);
      return sendJson(response, 200, { items: state.dlq.filter((entry) => entry.tenant === tenant) });
    }

    if (request.method === 'POST' && url.pathname === '/__control/db') {
      const body = await readJson(request); state.dbUp = Boolean(body.up);
      if (state.dbUp) for (const key of state.connections.keys()) schedule(key);
      return sendJson(response, 200, { dbUp: state.dbUp });
    }
    if (request.method === 'POST' && url.pathname === '/__control/dispatch') {
      const body = await readJson(request); state.dispatchPaused = Boolean(body.paused);
      if (!state.dispatchPaused) for (const key of state.connections.keys()) schedule(key);
      return sendJson(response, 200, { dispatchPaused: state.dispatchPaused });
    }
    if (request.method === 'GET' && url.pathname === '/__control/stats') {
      return sendJson(response, 200, {
        connections: state.connections.size,
        messages: state.messages.size,
        routes: state.routes.length,
        dlq: state.dlq.length,
      });
    }
    if (request.method === 'POST' && url.pathname === '/__control/shutdown') {
      sendJson(response, 202, { stopping: true });
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 20);
      return;
    }
    return sendJson(response, 404, { code: 'not_found' });
  } catch (error) {
    const status = error.message === 'body_too_large' ? 413 : error instanceof SyntaxError ? 400 : 500;
    sendJson(response, status, { code: status === 500 ? 'internal_error' : error.message });
  }
});

server.on('upgrade', (request, socket) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname !== '/v3/ws') { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
  const tenant = url.searchParams.get('tenant');
  const agent = url.searchParams.get('agent');
  const harnessKind = url.searchParams.get('kind');
  if (knownAgents.get(agent) !== tenant || !harnessKind) { socket.end('HTTP/1.1 422 Unprocessable Entity\r\n\r\n'); return; }
  const key = keyOf(tenant, agent);
  if (state.connections.has(key)) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return; }
  const wsKey = request.headers['sec-websocket-key'];
  if (!wsKey) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(`${wsKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');

  const connection = { key, tenant, agent, harnessKind, laneCursor: 0, inflight: null, leaseUntil: Date.now() + presenceLeaseMs };
  const cleanup = () => {
    if (state.connections.get(key) !== connection) return;
    state.connections.delete(key);
    if (connection.inflight) {
      clearTimeout(connection.inflight.timer);
      connection.inflight.status = 'queued';
      connection.inflight.queuedAt = Date.now();
      connection.inflight = null;
    }
    const previous = state.presence.get(key);
    if (previous) state.presence.set(key, { ...previous, leaseUntil: Date.now() + presenceLeaseMs });
  };
  connection.ws = new WsPeer(socket, (raw) => handleWsMessage(connection, raw), cleanup);
  state.connections.set(key, connection);
  state.presence.set(key, { tenant, agent, harnessKind, leaseUntil: connection.leaseUntil });
  connection.ws.send({ type: 'connected', tenant, agent, harnessKind, leaseUntil: connection.leaseUntil });
  for (const wake of state.wakes.filter((item) => !item.delivered && item.tenant === tenant && item.agent === agent)) {
    connection.ws.send({ type: 'wake', ...wake }); wake.delivered = true;
  }
  schedule(key);
});

const leaseTimer = setInterval(() => {
  const now = Date.now();
  for (const connection of state.connections.values()) {
    connection.leaseUntil = now + presenceLeaseMs;
    state.presence.set(connection.key, {
      tenant: connection.tenant,
      agent: connection.agent,
      harnessKind: connection.harnessKind,
      leaseUntil: connection.leaseUntil,
    });
  }
}, Math.max(100, Math.floor(presenceLeaseMs / 3)));
leaseTimer.unref();

function shutdown() {
  for (const connection of state.connections.values()) connection.ws.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(port, host, () => {
  const address = server.address();
  console.log(JSON.stringify({ event: 'mock_ready', host, port: address.port }));
});
