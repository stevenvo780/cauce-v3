#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const config = (await readFile(new URL('../../deploy/console/nginx-console-tls.conf', import.meta.url), 'utf8'))
  .replace(/#[^\n]*/gu, '');
const routes = ['/mcp', '/.well-known/oauth-protected-resource/mcp'];

function locationBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const blocks = [...config.matchAll(new RegExp(`^  location ${escaped} \\{([\\s\\S]*?)^  \\}`, 'gmu'))];
  assert.equal(blocks.length, 1, `exactly one location ${selector}`);
  return blocks[0][1];
}

function values(body, directive) {
  return [...body.matchAll(new RegExp(`^\\s*${directive}\\s+([^;]+);`, 'gmu'))]
    .map(match => match[1].trim());
}

function expectDirective(body, name, value) {
  assert.deepEqual(values(body, name), [value], name);
}

for (const route of routes) {
  test(`static ${route}: exact HTTPS gateway route preserves the raw URI and query`, () => {
    const body = locationBody(`= ${route}`);
    expectDirective(body, 'proxy_pass', 'https://gateway:8443');
    assert.doesNotMatch(body, /\b(?:rewrite|return|try_files|index|alias|root|include|if|limit_except)\b/u);
    assert.doesNotMatch(body, /\$(?:uri|args|request_uri|request_method)\b/u);
  });

  test(`static ${route}: original Host, bearer and Origin remain the identity inputs`, () => {
    const body = locationBody(`= ${route}`);
    assert.deepEqual(values(body, 'proxy_set_header').sort(), [
      'Authorization $http_authorization',
      'Connection ""',
      'Cookie ""',
      'Host $http_host',
      'Origin $http_origin',
      'X-Cauce-Operator ""',
    ].sort());
    expectDirective(body, 'proxy_pass_request_headers', 'on');
    assert.doesNotMatch(body, /\$(?:cookie_[a-z_]+|http_cookie|host)\b/u);
  });

  test(`static ${route}: request methods and bodies are not rewritten or buffered`, () => {
    const body = locationBody(`= ${route}`);
    expectDirective(body, 'proxy_http_version', '1.1');
    expectDirective(body, 'proxy_pass_request_body', 'on');
    expectDirective(body, 'proxy_request_buffering', 'off');
    expectDirective(body, 'proxy_buffering', 'off');
    assert.deepEqual(values(body, 'proxy_method'), []);
    assert.deepEqual(values(body, 'proxy_set_body'), []);
  });

  test(`static ${route}: gateway TLS is verified with the existing client identity`, () => {
    const body = locationBody(`= ${route}`);
    const api = locationBody('/v3/');
    expectDirective(body, 'proxy_ssl_server_name', 'on');
    expectDirective(body, 'proxy_ssl_name', 'gateway');
    expectDirective(body, 'proxy_ssl_verify', 'on');
    for (const [directive, path] of [
      ['proxy_ssl_trusted_certificate', '/run/secrets/gateway_tls_ca'],
      ['proxy_ssl_certificate', '/run/secrets/console_gateway_client_cert'],
      ['proxy_ssl_certificate_key', '/run/secrets/console_gateway_client_key'],
    ]) {
      expectDirective(body, directive, path);
      assert.deepEqual(values(body, directive), values(api, directive));
    }
  });

  test(`static ${route}: proxy timeouts leave margin above the ten-second handler deadline`, () => {
    const body = locationBody(`= ${route}`);
    expectDirective(body, 'proxy_connect_timeout', '5s');
    expectDirective(body, 'proxy_read_timeout', '15s');
    expectDirective(body, 'proxy_send_timeout', '15s');
  });

  test(`static ${route}: gateway errors, including disabled 404, cannot become the SPA`, () => {
    const body = locationBody(`= ${route}`);
    expectDirective(body, 'proxy_intercept_errors', 'off');
    expectDirective(body, 'proxy_next_upstream', 'off');
    expectDirective(body, 'proxy_cache', 'off');
    assert.deepEqual(values(body, 'error_page'), []);
    assert.doesNotMatch(body, /index\.html|try_files|proxy_store/u);
  });
}

test('static MCP locations do not add a listener or replace the other API and SPA routes', () => {
  assert.deepEqual(values(config, 'listen'), ['8444 ssl']);
  const locations = [...config.matchAll(/^ {2}location (.+) \{$/gmu)].map(match => match[1]);
  assert.deepEqual(locations.filter(selector => selector.includes('mcp')), routes.map(route => `= ${route}`));
  assert.ok(locations.includes('= "/v3/console/terminal/relays/${CAUCE_TERMINAL_RELAY_INSTANCE_ID}/ws"'));
  for (const selector of ['/v3/ws', '/v3/']) {
    const body = locationBody(selector);
    expectDirective(body, 'proxy_pass', 'https://gateway:8443');
    assert.ok(values(body, 'proxy_set_header').includes('Host $host'));
    assert.ok(!values(body, 'proxy_set_header').includes('Cookie ""'));
  }
  expectDirective(locationBody('/assets/'), 'try_files', '$uri =404');
  expectDirective(locationBody('/'), 'try_files', '$uri $uri/ /index.html');
});

test('only the SPA document enables its microphone and local media previews', () => {
  const spa = locationBody('/');
  assert.ok(values(spa, 'add_header').includes('Permissions-Policy "camera=(), microphone=(self), geolocation=()" always'));
  const csp = /add_header Content-Security-Policy "([^"]+)" always;/u.exec(spa)?.[1];
  assert.ok(csp);
  assert.match(csp, /img-src 'self' data: blob:;/u);
  assert.match(csp, /media-src 'self' blob:;/u);
  for (const unchanged of ["script-src 'self';", "style-src 'self';", "connect-src 'self' wss:;", "frame-ancestors 'none';"]) {
    assert.ok(csp.includes(unchanged));
  }
  const server = config.slice(0, config.indexOf('  location '));
  for (const body of [server, locationBody('/assets/'), locationBody('^~ /oauth/'), locationBody('= /.well-known/oauth-authorization-server')]) {
    assert.ok(values(body, 'add_header').includes('Permissions-Policy "camera=(), microphone=(), geolocation=()" always'));
    assert.doesNotMatch(body, /microphone=\(self\)|blob:|media-src/u);
  }
  for (const route of routes) assert.deepEqual(values(locationBody(`= ${route}`), 'add_header'), []);
});

test('large ACKs use only the two exact runtime routes with the existing verified TLS upstream', () => {
  const selector = '~ ^/v3/(ack|deliveries/[^/]+/ack)$';
  const body = locationBody(selector);
  expectDirective(body, 'client_max_body_size', '13595484');
  const pattern = new RegExp(selector.slice(2), 'u');
  for (const path of ['/v3/ack', '/v3/deliveries/20000000-0000-4000-8000-000000000001/ack']) assert.ok(pattern.test(path));
  for (const path of ['/v3/ack/', '/v3/ack/extra', '/v3/acks', '/v3/query', '/v3/heartbeat', '/v3/deliveries//ack', '/v3/deliveries/id/ack/', '/v3/deliveries/id/other/ack']) assert.ok(!pattern.test(path));
  for (const directive of ['proxy_pass', 'proxy_ssl_server_name', 'proxy_ssl_name', 'proxy_ssl_verify',
    'proxy_ssl_trusted_certificate', 'proxy_ssl_certificate', 'proxy_ssl_certificate_key', 'proxy_set_header']) {
    assert.deepEqual(values(body, directive), values(locationBody('/v3/'), directive));
  }
  assert.deepEqual(values(locationBody('/v3/'), 'client_max_body_size'), []);
  expectDirective(locationBody('~ ^/v3/console/(messages|publish-intents)$'), 'client_max_body_size', '13595484');
});
