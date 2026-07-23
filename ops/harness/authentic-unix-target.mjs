#!/usr/bin/env node

import { createServer, request as httpRequest } from 'node:http';
import { appendFile, chmod, rm } from 'node:fs/promises';

const sockets = [
  process.env.CAUCE_V2_TARGET_SOCKET || '/sockets/v2/ingress.sock',
  process.env.CAUCE_V3_TARGET_SOCKET || '/sockets/v3/ingress.sock',
];
const eventsFile = process.env.CAUCE_SHADOW_EVENTS_FILE || '/fixtures/shadow-events.jsonl';
const routerSocket = process.env.CAUCE_ROUTER_SOCKET || '/sockets/router/router.sock';
const controlPort = Number(process.env.CONTROL_PORT || 9081);
const observed = new Set();
const events = [];

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const servers = [];
for (const socketPath of sockets) {
  await rm(socketPath, { force: true });
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || !['/shadow/preview', '/shadow/cutover'].includes(request.url)) {
        response.writeHead(404).end();
        return;
      }
      const value = await readBody(request);
      const id = String(value.target_event_id || '');
      const duplicate = observed.has(id);
      if (!duplicate) {
        observed.add(id);
        const event = {
          targetEventId: id,
          socketPath,
          path: request.url,
          allowHumanReply: value.allow_human_reply === true,
          allowHarness: value.allow_harness === true,
        };
        events.push(event);
        await appendFile(eventsFile, `${JSON.stringify(event)}\n`);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ output: { accepted: true }, duplicate }));
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid' }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  servers.push(server);
}
const control = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health/ready') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ready' }));
    return;
  }
  if (request.method === 'GET' && request.url === '/state') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ events }));
    return;
  }
  if (request.method === 'POST' && request.url === '/router/ingress/v3') {
    const payload = await readBody(request);
    const encoded = JSON.stringify(payload);
    const upstream = httpRequest({
      socketPath: routerSocket,
      path: '/ingress/v3',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) },
      signal: AbortSignal.timeout(8_000),
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, { 'content-type': 'application/json' });
      upstreamResponse.pipe(response);
    });
    upstream.once('error', () => response.writeHead(502).end());
    upstream.end(encoded);
    return;
  }
  response.writeHead(404).end();
});
control.listen(controlPort, '0.0.0.0');
console.log(JSON.stringify({ event: 'authentic_unix_targets_ready', sockets: sockets.length, controlPort }));

async function stop() {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await new Promise((resolve) => control.close(resolve));
  process.exit(0);
}
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
