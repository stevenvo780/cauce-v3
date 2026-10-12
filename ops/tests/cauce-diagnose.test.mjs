import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../cli/cauce-diagnose', import.meta.url));
const cookie = 'cauce_session=synthetic-diagnostic-session';
const secret = 'synthetic-token-never-print';

function execute(arguments_, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script, ...arguments_], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...environment } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function fixture(t, response) {
  const root = await mkdtemp(path.join(tmpdir(), 'cauce-diagnose-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = path.join(root, 'console-session.json');
  await writeFile(session, JSON.stringify({ cookie }), { mode: 0o600 });
  const requests = [];
  const server = createServer((request, reply) => {
    requests.push({ method: request.method, path: request.url, headers: request.headers });
    response(request, reply);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const options = ['--gateway', origin, '--origin', origin, '--session-file', session];
  return { root, session, origin, options, requests };
}

test('real HTTP returns the full projected chain for every identifier type with the existing console cookie', async t => {
  const document = { id: 'fixture', company_id: 'alpha', items: [{ source: 'audit', host_id: 'host-alpha', action: 'read' }], next_cursor: 'cursor' };
  const context = await fixture(t, (_request, reply) => {
    reply.writeHead(200, { 'Content-Type': 'application/json' });
    reply.end(JSON.stringify(document));
  });
  for (const id of ['trace-fixture', 'operation-fixture', 'session-fixture', 'delivery-fixture', 'backup-fixture']) {
    const result = await execute([id, ...context.options]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), document);
    assert.equal(result.stderr, '');
    const observed = context.requests.at(-1);
    assert.equal(observed.method, 'GET');
    assert.equal(observed.path, `/v3/console/diagnose/${id}`);
    assert.equal(observed.headers.cookie, cookie);
    assert.equal(observed.headers.origin, context.origin);
    assert.equal(observed.headers['x-csrf-token'], undefined);
    assert.ok(!result.stdout.includes(cookie));
  }
});

test('identifier remains one encoded URL segment', async t => {
  const context = await fixture(t, (_request, reply) => reply.end('{"company_id":"alpha","items":[]}'));
  const result = await execute(['trace/a?b#c %á', ...context.options]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(context.requests[0].path, '/v3/console/diagnose/trace%2Fa%3Fb%23c%20%25%C3%A1');
});

test('environment proxies never receive the console cookie intended for the gateway', async t => {
  const document = { company_id: 'alpha', items: [] };
  const gateway = await fixture(t, (_request, reply) => reply.end(JSON.stringify(document)));
  const proxy = await fixture(t, (_request, reply) => reply.end('{"received_by_proxy":true}'));
  const environment = { http_proxy: proxy.origin, HTTP_PROXY: proxy.origin,
    https_proxy: proxy.origin, HTTPS_PROXY: proxy.origin, all_proxy: proxy.origin, ALL_PROXY: proxy.origin,
    no_proxy: '', NO_PROXY: '' };
  const result = await execute(['trace-fixture', ...gateway.options], environment);
  assert.deepEqual(proxy.requests, []);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), document);
  assert.equal(gateway.requests.length, 1);
  assert.equal(gateway.requests[0].headers.cookie, cookie);
  assert.ok(!result.stdout.includes(cookie) && !result.stderr.includes(cookie));
});

test('protocol-length Unicode traces reach HTTP and oversized identifiers do not', async t => {
  const context = await fixture(t, (_request, reply) => reply.end('{}'));
  for (const id of ['a'.repeat(256), '界'.repeat(256), '😀'.repeat(128)]) {
    const result = await execute([id, ...context.options]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(decodeURIComponent(context.requests.at(-1).path.slice('/v3/console/diagnose/'.length)), id);
  }
  const count = context.requests.length;
  for (const id of ['a'.repeat(257), '😀'.repeat(129)]) {
    const result = await execute([id, ...context.options]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
  }
  assert.equal(context.requests.length, count);
});

test('HTTP rejections never echo the response body or console cookie', async t => {
  const context = await fixture(t, (_request, reply) => {
    reply.writeHead(404);
    reply.end(JSON.stringify({ error: secret, cookie }));
  });
  const result = await execute(['other-company-id', ...context.options]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'diagnostic request rejected with HTTP 404');
  assert.ok(!result.stderr.includes(secret) && !result.stderr.includes(cookie));
});

test('redirects are rejected before a cookie can reach another origin', async t => {
  const receiver = await fixture(t, (_request, reply) => reply.end('{}'));
  const context = await fixture(t, (_request, reply) => {
    reply.writeHead(302, { Location: `${receiver.origin}/cookie-receiver` });
    reply.end(secret);
  });
  const result = await execute(['trace-fixture', ...context.options]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr.trim(), 'diagnostic request rejected with HTTP 302');
  assert.deepEqual(receiver.requests, []);
});

test('invalid and oversized responses fail without echoing their contents', async t => {
  for (const body of [secret, '[]', JSON.stringify({ value: secret.repeat(100_000) })]) {
    const context = await fixture(t, (_request, reply) => reply.end(body));
    const result = await execute(['trace-fixture', ...context.options]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(secret) && !result.stderr.includes(cookie));
  }
});

test('session privacy, destination trust and identifiers are checked before HTTP', async t => {
  const context = await fixture(t, (_request, reply) => reply.end('{}'));
  await writeFile(context.session, JSON.stringify({ cookie }));
  const publicSession = path.join(context.root, 'public-session.json');
  await writeFile(publicSession, JSON.stringify({ cookie }), { mode: 0o644 });
  const cases = [
    ['trace-fixture', '--gateway', context.origin, '--origin', context.origin, '--session-file', publicSession],
    ['trace-fixture', '--gateway', 'http://external.example', '--origin', context.origin, '--session-file', context.session],
    ['trace-fixture', '--gateway', `http://operator:${secret}@127.0.0.1`, '--origin', context.origin, '--session-file', context.session],
    ['..', ...context.options],
    ['trace\nfixture', ...context.options],
  ];
  for (const arguments_ of cases) {
    const result = await execute(arguments_);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(secret) && !result.stderr.includes(cookie));
  }
  assert.deepEqual(context.requests, []);
});

test('invalid session JSON and unreachable gateway are reported without raw errors', async t => {
  const context = await fixture(t, (_request, reply) => reply.end('{}'));
  await writeFile(context.session, secret);
  const invalid = await execute(['trace-fixture', ...context.options]);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stdout, '');
  assert.ok(!invalid.stderr.includes(secret));
  await writeFile(context.session, JSON.stringify({ cookie }));
  const closed = createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const unavailable = `http://127.0.0.1:${closed.address().port}`;
  await new Promise(resolve => closed.close(resolve));
  const network = await execute(['trace-fixture', '--gateway', unavailable, '--origin', context.origin, '--session-file', context.session]);
  assert.equal(network.code, 1);
  assert.equal(network.stdout, '');
  assert.equal(network.stderr.trim(), 'diagnostic gateway is unavailable');
});
