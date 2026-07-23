#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const compose = await readFile(new URL('../compose.authentic.yaml', import.meta.url), 'utf8');
const probePath = fileURLToPath(new URL('./authentic-control-probe.mjs', import.meta.url));

function serviceBlock(name) {
  const start = compose.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `missing ${name} service`);
  const remainder = compose.slice(start + 1);
  const nextService = remainder.search(/^  [a-z][a-z0-9-]*:\n/m);
  const nextTopLevel = remainder.search(/^(?:volumes|configs|networks):\n/m);
  const ends = [nextService, nextTopLevel].filter((value) => value >= 0);
  return compose.slice(start, start + 1 + (ends.length === 0 ? remainder.length : Math.min(...ends)));
}

function serviceNames() {
  const section = compose.match(/^services:\n([\s\S]*?)^(?:volumes|configs|networks):\n/m);
  assert.ok(section, 'missing services section');
  return [...section[1].matchAll(/^  ([a-z][a-z0-9-]*):\n/gm)].map((match) => match[1]);
}

function attachedNetworks(name) {
  const block = serviceBlock(name);
  const inline = block.match(/^    networks: \[([^\]]+)\]$/m);
  if (inline) return inline[1].split(',').map((network) => network.trim());

  const expanded = block.match(/^    networks:\n((?:      .+\n)+)/m);
  assert.ok(expanded, `missing ${name} networks`);
  const networks = [...expanded[1].matchAll(/^      (?:-\s+)?([a-z][a-z0-9-]*)(?::.*)?$/gm)]
    .map((match) => match[1]);
  assert.ok(networks.length > 0, `missing ${name} network entries`);
  return networks;
}

function publishedPorts(name) {
  const expanded = serviceBlock(name).match(/^    ports:\n((?:      .+\n)+)/m);
  if (!expanded) return [];
  return expanded[1].trimEnd().split('\n').map((line) => {
    const entry = line.match(/^      - "([^"]+)"$/);
    assert.ok(entry, `${name} ports must use quoted short syntax`);
    return entry[1];
  });
}

function healthCommand(name) {
  const match = serviceBlock(name).match(/^      test: (\[.*\])$/m);
  assert.ok(match, `missing ${name} healthcheck command`);
  return JSON.parse(match[1]);
}

const fixtureChecks = new Map([
  ['fake-external', 'http://127.0.0.1:9080/health/ready'],
  ['unix-target', 'http://127.0.0.1:9081/health/ready'],
]);
for (const [service, url] of fixtureChecks) {
  const block = serviceBlock(service);
  assert.doesNotMatch(block, /deploy\/readiness-probe\.mjs/, `${service} must not use the database-aware probe`);
  assert.match(block, /source: authentic_control_probe/, `${service} must mount the fixture probe`);
  assert.deepEqual(healthCommand(service), [
    'CMD', 'node', 'ops/harness/authentic-control-probe.mjs', url, 'ready',
  ]);
}

const databaseHttpChecks = new Map([
  ['gateway', 'http://127.0.0.1:8081/health/ready'],
  ['dispatcher', 'http://127.0.0.1:8082/health/ready'],
  ['relay-worker', 'http://127.0.0.1:8083/health/ready'],
  ['telegram-bridge', 'http://127.0.0.1:8086/health/ready'],
]);
for (const [service, url] of databaseHttpChecks) {
  assert.deepEqual(healthCommand(service), ['CMD', 'node', 'deploy/readiness-probe.mjs', url, 'ready']);
  assert.match(serviceBlock(service), /DATABASE_URL|<<: \*database-environment/);
}

assert.deepEqual(healthCommand('shadow-router'), [
  'CMD', 'node', 'deploy/unix-readiness-probe.mjs', '/sockets/router/router.sock', '/health/ready', 'ready',
]);
assert.match(serviceBlock('postgres'), /pg_isready[\s\S]*SELECT 1/);
assert.equal((compose.match(/^    healthcheck:/gm) || []).length, 8, 'every long-running service healthcheck must be classified');
assert.match(compose, /authentic_control_probe:\n    file: \.\/harness\/authentic-control-probe\.mjs/);

const controlServices = ['fake-external', 'gateway', 'unix-target'];
const services = serviceNames();
assert.match(compose, /^  authentic:\n    internal: true\n/m, 'authentic network must remain internal');
assert.match(compose, /^  control:\n    internal: false(?:\n|$)/m, 'control network must provide host port NAT');

const dualHomed = [];
for (const service of services) {
  const networks = attachedNetworks(service);
  assert.equal(networks.length, new Set(networks).size, `${service} networks must be unique`);
  assert.ok(networks.includes('authentic'), `${service} must remain on the internal data network`);
  if (networks.includes('control')) dualHomed.push(service);
  const expected = controlServices.includes(service) ? ['authentic', 'control'] : ['authentic'];
  assert.deepEqual([...networks].sort(), expected, `${service} has an unexpected network attachment`);
}
assert.deepEqual(dualHomed.sort(), controlServices, 'only localhost-published services may be dual-homed');

assert.match(
  serviceBlock('fake-external'),
  /^      authentic:\n        ipv4_address: \S+\n        aliases: \[api\.telegram\.org, webhook\.test\]$/m,
  'fake-external fixed IP and aliases must stay on authentic',
);

const servicesWithPublishedPorts = services.filter((service) => publishedPorts(service).length > 0).sort();
assert.deepEqual(servicesWithPublishedPorts, controlServices, 'only control services may publish ports');
for (const service of servicesWithPublishedPorts) {
  const ports = publishedPorts(service);
  assert.equal(ports.length, 1, `${service} must publish exactly one control port`);
  assert.match(ports[0], /^127\.0\.0\.1:.+:\d+$/, `${service} port must bind only to localhost`);
}
assert.doesNotMatch(serviceBlock('postgres'), /^    ports:/m, 'database must not publish ports');

async function runProbe(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probePath, url, 'ready'], {
      env: { PATH: process.env.PATH || '/usr/bin:/bin', NODE_ENV: 'production', HEALTH_TIMEOUT_MS: '1000' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stderr }));
  });
}

let ready = true;
const server = createServer((_request, response) => {
  response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready' }));
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
try {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/health/ready`;
  assert.deepEqual(await runProbe(url), { code: 0, signal: null, stderr: '' });
  ready = false;
  const failure = await runProbe(url);
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /fixture readiness failed: HTTP 503/);
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log('authentic healthcheck/network policy and fixture probe ok');
