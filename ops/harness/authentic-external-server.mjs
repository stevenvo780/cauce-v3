#!/usr/bin/env node

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';

const fixtureDir = process.env.CAUCE_FIXTURE_DIR || '/fixtures';
const httpsPort = Number(process.env.HTTPS_PORT || 9443);
const controlPort = Number(process.env.CONTROL_PORT || 9080);
const state = {
  updatesEnabled: false,
  getMe: 0,
  getUpdates: 0,
  telegramSends: [],
  webhooks: [],
};

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_048_576) throw new Error('request too large');
    chunks.push(chunk);
  }
  return size === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(response, status, value, headers = {}) {
  const encoded = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(encoded),
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(encoded);
}

const tlsServer = createHttpsServer({
  key: await readFile(`${fixtureDir}/external.key`),
  cert: await readFile(`${fixtureDir}/external.crt`),
}, async (request, response) => {
  try {
    const url = new URL(request.url, 'https://external.invalid');
    if (request.method !== 'POST') return json(response, 405, { ok: false });
    if (/^\/bot[^/]+\/getMe$/.test(url.pathname)) {
      state.getMe += 1;
      await body(request);
      return json(response, 200, { ok: true, result: { id: 900001, username: 'cauce_authentic_bot' } });
    }
    if (/^\/bot[^/]+\/getUpdates$/.test(url.pathname)) {
      state.getUpdates += 1;
      const payload = await body(request);
      const offset = Number(payload.offset || 0);
      const result = state.updatesEnabled && offset <= 101 ? [{
        update_id: 101,
        message: {
          message_id: 501,
          from: { id: 1001 },
          chat: { id: 2001, type: 'private' },
          text: 'compose authentic request',
        },
      }] : [];
      return json(response, 200, { ok: true, result });
    }
    if (/^\/bot[^/]+\/sendMessage$/.test(url.pathname)) {
      const payload = await body(request);
      state.telegramSends.push({ chatId: String(payload.chat_id), textBytes: Buffer.byteLength(String(payload.text || '')) });
      return json(response, 200, { ok: true, result: { message_id: 7000 + state.telegramSends.length } });
    }
    if (url.pathname === '/hook') {
      if (request.headers['x-cauce-signature'] !== 'compose-authentic-v1') {
        await body(request);
        return json(response, 401, { ok: false });
      }
      const payload = await body(request);
      state.webhooks.push({
        eventId: String(payload.event_id || ''),
        idempotencyKey: String(request.headers['idempotency-key'] || ''),
        encrypted: request.socket.encrypted === true,
      });
      return json(response, 202, { ok: true }, { 'x-provider-message-id': `webhook-${state.webhooks.length}` });
    }
    return json(response, 404, { ok: false });
  } catch {
    return json(response, 400, { ok: false });
  }
});

const controlServer = createHttpServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health/ready') return json(response, 200, { status: 'ready' });
  if (request.method === 'POST' && request.url === '/telegram/enable') {
    state.updatesEnabled = true;
    return json(response, 200, { enabled: true });
  }
  if (request.method === 'GET' && request.url === '/state') {
    return json(response, 200, {
      getMe: state.getMe,
      getUpdates: state.getUpdates,
      updatesEnabled: state.updatesEnabled,
      telegramSends: state.telegramSends.length,
      webhooks: state.webhooks.length,
      webhookTls: state.webhooks.every((entry) => entry.encrypted),
      webhookIdsUnique: new Set(state.webhooks.map((entry) => entry.idempotencyKey)).size === state.webhooks.length,
    });
  }
  return json(response, 404, { error: 'not_found' });
});

tlsServer.listen(httpsPort, '0.0.0.0');
controlServer.listen(controlPort, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'authentic_external_ready', httpsPort, controlPort }));
});

function stop() {
  tlsServer.close();
  controlServer.close(() => process.exit(0));
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
