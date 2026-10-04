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
