import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:https';
import { createServer as tcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runFile = promisify(execFile);
const source = await readFile(new URL('../../deploy/console/nginx-console-tls.conf', import.meta.url), 'utf8');
const metadata = '/.well-known/oauth-authorization-server';
const selectors = [`= ${metadata}`, '^~ /oauth/'];
const owner = randomUUID();
const suite = 'nginx-oauth-proxy';
interface Container { name: string; id?: string }
const containers: Container[] = [];
let root: string | undefined;
let upstream: Server | undefined;
let origin = '';
let wrongOrigin = '';
let ca: Buffer;
let enabled = true;
const seen: { path: string; method: string; headers: Record<string, unknown>; body: string; peer: string }[] = [];
const policy = "default-src 'none'; script-src 'nonce-fixture'; connect-src 'self'; form-action 'self'";

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const body = new RegExp(`^  location ${escaped} \\{([\\s\\S]*?)^  \\}`, 'mu').exec(source)?.[1];
  if (body === undefined) throw new Error(`Missing OAuth location ${selector}`);
  return body;
}

describe('OAuth Nginx source contract', () => {
  it.each(selectors)('routes OAuth through the existing verified gateway: %s', selector => {
    const body = block(selector);
    for (const directive of ['proxy_pass https://gateway:8443;', 'proxy_set_header Host $http_host;',
      'proxy_set_header Authorization $http_authorization;', 'proxy_set_header Origin $http_origin;',
      'proxy_set_header Cookie $http_cookie;', 'proxy_set_header X-Cauce-Operator "";',
      'proxy_ssl_verify on;', 'proxy_ssl_server_name on;', 'proxy_ssl_name gateway;',
      'proxy_ssl_trusted_certificate /run/secrets/gateway_tls_ca;',
      'proxy_ssl_certificate /run/secrets/console_gateway_client_cert;',
      'proxy_ssl_certificate_key /run/secrets/console_gateway_client_key;',
      'client_max_body_size 8k;', 'proxy_cache off;', 'proxy_intercept_errors off;',
      'proxy_next_upstream off;', 'add_header Cache-Control "no-store" always;']) {
      expect(body).toContain(directive);
    }
    expect(body).not.toMatch(/\b(?:try_files|rewrite|proxy_method|proxy_set_body|error_page)\b/u);
    expect(body).not.toContain('add_header Content-Security-Policy');
    expect(body).not.toContain('proxy_hide_header Content-Security-Policy');
  });

  it('keeps the single listener and existing MCP cookie boundary', () => {
    expect(source.match(/^\s*listen /gmu)).toHaveLength(1);
    for (const selector of ['= /mcp', '= /.well-known/oauth-protected-resource/mcp']) {
      const body = block(selector);
      expect(body).toContain('proxy_set_header Cookie "";');
      expect(body).toContain('proxy_ssl_verify on;');
    }
    expect(source).toContain('try_files $uri $uri/ /index.html;');
  });
});

async function docker(args: string[]): Promise<string> {
  const result = await runFile('docker', args, { timeout: 20_000, maxBuffer: 512 * 1024 });
  return result.stdout.trim();
}

async function ownedContainer(name: string, execute = docker): Promise<string> {
  const container: unknown = JSON.parse(await execute(['inspect', '--format', '{{json .}}', name]));
  if (!container || typeof container !== 'object' || !('Name' in container) || container.Name !== `/${name}`
      || !('Id' in container) || typeof container.Id !== 'string' || !/^[a-f0-9]{64}$/u.test(container.Id)
      || !('Config' in container) || !container.Config || typeof container.Config !== 'object'
      || !('Labels' in container.Config)) throw new Error('Refusing an unowned Nginx container');
  const labels: unknown = container.Config.Labels;
  if (!labels || typeof labels !== 'object' || !('cauce.test.owner' in labels)
      || labels['cauce.test.owner'] !== owner || !('cauce.test.suite' in labels)
      || labels['cauce.test.suite'] !== suite) throw new Error('Refusing an unowned Nginx container');
  return container.Id;
}

async function createContainer(args: string[], resources = containers, execute = docker): Promise<string> {
  const container: Container = { name: `cauce-nginx-oauth-${randomUUID()}` }; resources.push(container);
  try {
    const id = await execute(['run', '--detach', '--name', container.name, '--label', `cauce.test.owner=${owner}`,
      '--label', `cauce.test.suite=${suite}`, ...args]);
    container.id = await ownedContainer(container.name, execute);
    if (id !== container.id) throw new Error('Docker create response does not match owned container');
    return container.id;
  } catch (error) {
    try { container.id = await ownedContainer(container.name, execute); }
    catch (recovery) { throw new AggregateError([error, recovery], 'Nginx container creation and recovery failed'); }
    throw error;
  }
}

async function cleanupContainers(resources = containers, execute = docker): Promise<void> {
  const failures: unknown[] = [];
  for (const container of [...resources]) try {
    const id = await ownedContainer(container.name, execute);
    if (container.id !== undefined && container.id !== id) throw new Error('Refusing a replaced Nginx container');
    await execute(['rm', '--force', id]); resources.splice(resources.indexOf(container), 1);
  } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'Owned Nginx container cleanup failed');
}

function lostCreateFixture(foreign?: 'name' | 'owner' | 'suite') {
  const resources: Container[] = []; const calls: string[][] = [];
  const state = { created: false }; const id = 'b'.repeat(64); const lost = new Error('Docker response lost');
  const execute = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === 'run') {
      expect(resources).toHaveLength(1); expect(args[args.indexOf('--name') + 1]).toBe(resources[0]?.name);
      state.created = true; throw lost;
    }
    if (args[0] === 'inspect') {
      const container = resources[0];
      if (container === undefined) throw new Error('Missing synthetic container');
      expect(args.at(-1)).toBe(container.name);
      return JSON.stringify({ Id: id, Name: foreign === 'name' ? '/unrelated' : `/${container.name}`,
        Config: { Labels: { 'cauce.test.owner': foreign === 'owner' ? 'unrelated' : owner,
          'cauce.test.suite': foreign === 'suite' ? 'unrelated' : suite } } });
    }
    expect(args).toEqual(['rm', '--force', id]); state.created = false; return id;
  };
  return { resources, calls, state, id, lost, execute };
}

describe('Nginx fixture cleanup after a lost Docker create response', () => {
  it('recovers and removes a real owned container despite losing its create response', async () => {
    const resources: Container[] = []; const lost = new Error('Docker response lost');
    const dockerfile = await readFile(new URL('../../deploy/Dockerfile', import.meta.url), 'utf8');
    const image = /^ARG CAUCE_NGINX_BASE=(\S+@sha256:[a-f0-9]{64})$/mu.exec(dockerfile)?.[1];
    if (!image) throw new Error('No pinned Nginx image');
    const execute = async (args: string[]): Promise<string> => {
      if (args[0] === 'run') {
        expect(resources).toHaveLength(1); expect(args[args.indexOf('--name') + 1]).toBe(resources[0]?.name);
        await docker(args); throw lost;
      }
      return docker(args);
    };
    try {
      await expect(createContainer(['--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--entrypoint', 'sleep', image, '30'], resources, execute)).rejects.toBe(lost);
      const container = resources[0]; if (!container?.id) throw new Error('Lost create response was not recovered');
      await cleanupContainers(resources, execute); expect(resources).toHaveLength(0);
      await expect(docker(['inspect', container.name])).rejects.toThrow(/no such object/iu);
      console.info('OAUTH_NGINX_LOST_CREATE', JSON.stringify({ ...container, absenceVerified: true }));
    } finally { await cleanupContainers(resources); }
  }, 30_000);

  it.each(['name', 'owner', 'suite'] as const)('refuses a recovered container with a foreign %s', async foreign => {
    const fixture = lostCreateFixture(foreign);
    await expect(createContainer(['fixture-image'], fixture.resources, fixture.execute))
      .rejects.toMatchObject({ errors: [fixture.lost, expect.any(Error)] });
    await expect(cleanupContainers(fixture.resources, fixture.execute)).rejects.toThrow('Owned Nginx container cleanup failed');
    expect(fixture.state.created).toBe(true); expect(fixture.resources).toHaveLength(1);
    expect(fixture.calls.filter(args => args[0] === 'rm')).toHaveLength(0);
  });
});

async function port(): Promise<number> {
  const server = tcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  await new Promise<void>((resolve, reject) => server.close(error => { if (error) reject(error); else resolve(); }));
  return address.port;
}

async function certificates(directory: string): Promise<void> {
  const openssl = async (...args: string[]) => { await runFile('openssl', args, { cwd: directory, timeout: 10_000 }); };
  for (const name of ['ca', 'wrong-ca']) {
    await openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-days', '1', '-keyout', `${name}.key`, '-out', `${name}.pem`, '-subj', `/CN=${name}-fixture`,
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  }
  for (const [name, cn, purpose] of [['server', 'gateway', 'serverAuth'], ['client', 'oauth-proxy-fixture', 'clientAuth']] as const) {
    await openssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${cn}`);
    await writeFile(join(directory, `${name}.ext`), `basicConstraints=critical,CA:FALSE\nextendedKeyUsage=${purpose}\nsubjectAltName=DNS:gateway,DNS:localhost,IP:127.0.0.1\n`, { mode: 0o600 });
    await openssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key',
      '-set_serial', name === 'server' ? '101' : '102', '-days', '1', '-extfile', `${name}.ext`, '-out', `${name}.pem`);
  }
  for (const name of ['ca', 'wrong-ca', 'server', 'client']) await chmod(join(directory, `${name}.key`), 0o600);
}

async function startProxy(image: string, directory: string, gatewayPort: number, wrong: boolean): Promise<string> {
  const proxyPort = await port();
  const config = source.replaceAll('${CAUCE_TERMINAL_RELAY_INSTANCE_ID}', 'a'.repeat(64))
    .replaceAll('listen 8444 ssl;', `listen 127.0.0.1:${String(proxyPort)} ssl;`)
    .replaceAll('root /usr/share/nginx/html;', 'root /tmp/fixture/spa;')
    .replaceAll('https://gateway:8443', `https://127.0.0.1:${String(gatewayPort)}`)
    .replaceAll('/run/secrets/console_tls_cert', '/tmp/fixture/server.pem')
    .replaceAll('/run/secrets/console_tls_key', '/tmp/fixture/server.key')
    .replaceAll('/run/secrets/gateway_tls_ca', `/tmp/fixture/${wrong ? 'wrong-ca' : 'ca'}.pem`)
    .replaceAll('/run/secrets/console_gateway_client_cert', '/tmp/fixture/client.pem')
    .replaceAll('/run/secrets/console_gateway_client_key', '/tmp/fixture/client.key');
  const configPath = join(directory, wrong ? 'wrong.conf' : 'primary.conf');
  await writeFile(configPath, config, { mode: 0o444 });
  const uid = process.getuid?.(); const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error('Nginx fixture requires POSIX UID and GID');
  const id = await createContainer([
    '--network', 'host', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--user', `${String(uid)}:${String(gid)}`, '--mount', `type=bind,src=${configPath},dst=/etc/nginx/conf.d/default.conf,readonly`,
    '--mount', `type=bind,src=${directory},dst=/tmp/fixture,readonly`,
    '--tmpfs', `/tmp:rw,noexec,nosuid,size=16m,uid=${String(uid)},gid=${String(gid)},mode=0700`,
    '--tmpfs', `/var/cache/nginx:rw,noexec,nosuid,size=32m,uid=${String(uid)},gid=${String(gid)},mode=0755`,
    '--tmpfs', `/var/run:rw,noexec,nosuid,size=8m,uid=${String(uid)},gid=${String(gid)},mode=0755`,
    '--tmpfs', `/var/log/nginx:rw,noexec,nosuid,size=8m,uid=${String(uid)},gid=${String(gid)},mode=0755`,
    '--entrypoint', 'sleep', image, '300']);
  await docker(['exec', id, 'nginx', '-t']);
  await docker(['exec', '--detach', id, 'sh', '-c',
    'exec nginx -g "daemon off;" > /var/log/nginx/fixture-stdout.log 2> /var/log/nginx/fixture-stderr.log']);
  const result = `https://localhost:${String(proxyPort)}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    let ready = false;
    try { ready = (await send(result, '/')).status === 200; } catch { ready = false; }
    if (ready) return result;
    await delay(100);
  }
  throw new Error('Nginx fixture did not become ready');
}

function send(target: string, path: string, method = 'GET', headers: Record<string, string> = {}, body = '') {
  return new Promise<{ status: number; headers: Record<string, unknown>; rawHeaders: string[]; body: string }>((resolve, reject) => {
    const outgoing = request(new URL(path, target), { ca, servername: 'localhost', rejectUnauthorized: true,
      method, headers }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk)); incoming.once('error', reject);
      incoming.once('end', () => { resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers,
        rawHeaders: incoming.rawHeaders, body: Buffer.concat(chunks).toString() }); });
    });
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error('Nginx fixture request timeout')));
    outgoing.once('error', reject); outgoing.end(body);
  });
}

describe.sequential('OAuth through real pinned Nginx with fixture mTLS', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'cauce-nginx-oauth-')); await chmod(root, 0o755);
    await mkdir(join(root, 'spa')); await writeFile(join(root, 'spa/index.html'), 'SPA_FIXTURE_SENTINEL');
    await certificates(root); ca = await readFile(join(root, 'ca.pem'));
    upstream = createServer({ key: await readFile(join(root, 'server.key')), cert: await readFile(join(root, 'server.pem')),
      ca, requestCert: true, rejectUnauthorized: true }, (incoming, response) => {
      const chunks: Buffer[] = []; incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.once('end', () => {
        const path = incoming.url ?? ''; const method = incoming.method ?? '';
        const peer = (incoming.socket as TLSSocket).getPeerCertificate().subject.CN;
        if (typeof peer !== 'string') { response.writeHead(500); response.end(); return; }
        seen.push({ path, method, headers: incoming.headers, body: Buffer.concat(chunks).toString(), peer });
        const status = !enabled || path.startsWith('/oauth/missing') ? 404 : method === 'DELETE' ? 405 : path.startsWith('/oauth/denied') ? 403 : 200;
        response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
          'content-security-policy': policy, 'set-cookie': '__Host-fixture=session; Path=/; Secure; HttpOnly; SameSite=Strict' });
        response.end(JSON.stringify({ upstream: true, path, method }));
      });
    });
    await new Promise<void>((resolve, reject) => { upstream?.once('error', reject); upstream?.listen(0, '127.0.0.1', resolve); });
    const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('No fixture gateway port');
    const dockerfile = await readFile(new URL('../../deploy/Dockerfile', import.meta.url), 'utf8');
    const image = /^ARG CAUCE_NGINX_BASE=(\S+@sha256:[a-f0-9]{64})$/mu.exec(dockerfile)?.[1];
    if (!image) throw new Error('No pinned Nginx image'); await docker(['image', 'inspect', image]);
    origin = await startProxy(image, root, address.port, false); wrongOrigin = await startProxy(image, root, address.port, true);
    console.info('OAUTH_NGINX_FIXTURE', JSON.stringify({ sourceSha256: createHash('sha256').update(source).digest('hex'),
      owner, image, containers, syntaxExit: 0, adaptations: ['loopback ports', 'fixture certificate paths', 'fixture SPA root', 'fixture relay pin'] }));
  }, 60_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    if (upstream) try { await new Promise<void>((resolve, reject) => upstream?.close(error => { if (error) reject(error); else resolve(); })); } catch (error) { failures.push(error); }
    try { await cleanupContainers(); } catch (error) { failures.push(error); }
    if (root) try { await rm(root, { recursive: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'OAuth Nginx fixture cleanup failed');
    console.info('OAUTH_NGINX_CLEANUP', 'owned containers removed');
  });

  it.each([metadata, '/oauth/authorize?state=FIXTURE_QUERY&client_id=https%3A%2F%2Fclient.example%2Fdoc',
    '/oauth/continue?request_id=fixture', '/oauth/login', '/oauth/consent', '/oauth/token', '/oauth/jwks',
    '/oauth/grants', '/oauth/grants/fixture-id/revoke'])('forwards registered OAuth path and query instead of SPA: %s', async path => {
    const result = await send(origin, path); expect(result.status).toBe(200);
    expect(result.body).not.toContain('SPA_FIXTURE_SENTINEL');
    expect(seen.at(-1)?.path).toBe(path); expect(seen.at(-1)?.peer).toBe('oauth-proxy-fixture');
    expect(result.headers['cache-control']).toContain('no-store');
  });

  it.each(['GET', 'HEAD', 'POST', 'OPTIONS', 'DELETE'])('preserves method %s and the upstream result', async method => {
    const result = await send(origin, '/oauth/token', method);
    expect(seen.at(-1)?.method).toBe(method); expect(result.status).toBe(method === 'DELETE' ? 405 : 200);
    expect(result.body).not.toContain('SPA_FIXTURE_SENTINEL');
  });

  it('preserves Host with port, Origin, cookie, Authorization, form bytes and response cookie', async () => {
    const headers = { host: 'oauth.example.invalid:9444', origin: 'https://other.example.invalid',
      cookie: '__Host-fixture=session', authorization: 'Bearer fixture', 'x-cauce-operator': 'spoofed',
      'content-type': 'application/x-www-form-urlencoded' };
    const body = 'grant_type=authorization_code&code=fixture&code_verifier=fixture';
    const result = await send(origin, '/oauth/token?state=FIXTURE_QUERY', 'POST', headers, body);
    expect(seen.at(-1)).toMatchObject({ headers: { host: headers.host, origin: headers.origin,
      cookie: headers.cookie, authorization: headers.authorization, 'content-type': headers['content-type'] }, body });
    expect(seen.at(-1)?.headers['x-cauce-operator']).toBeUndefined();
    expect(result.headers['set-cookie']).toEqual(['__Host-fixture=session; Path=/; Secure; HttpOnly; SameSite=Strict']);
  });

  it('passes one upstream nonce CSP without adding the SPA script policy', async () => {
    const result = await send(origin, '/oauth/continue');
    expect(result.headers['content-security-policy']).toBe(policy);
    expect(result.rawHeaders.filter(value => value.toLowerCase() === 'content-security-policy')).toHaveLength(1);
    expect(result.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(result.headers['referrer-policy']).toContain('no-referrer');
  });

  it.each(['/oauth/missing', '/oauth/denied', metadata])('never turns upstream negative/off responses into SPA: %s', async path => {
    enabled = path !== metadata;
    try {
      const result = await send(origin, path);
      expect(result.status).toBe(path === '/oauth/denied' ? 403 : 404);
      expect(result.body).not.toContain('SPA_FIXTURE_SENTINEL'); expect(result.headers['cache-control']).toContain('no-store');
    } finally { enabled = true; }
  });

  it('rejects bodies above 8 KiB without forwarding or caching them', async () => {
    const before = seen.length; const body = 'x'.repeat(8193);
    const result = await send(origin, '/oauth/token', 'POST', { 'content-length': String(Buffer.byteLength(body)) }, body);
    expect(result.status).toBe(413); expect(seen).toHaveLength(before); expect(result.headers['cache-control']).toContain('no-store');
  });

  it.each(['/v3/console/messages', '/v3/console/publish-intents'])('forwards the full attachment envelope and bounds the next byte: %s', async path => {
    const { MAX_PUBLISH_BODY_BYTES } = await import('@cauce/protocol');
    const body = 'x'.repeat(MAX_PUBLISH_BODY_BYTES);
    const headers = { 'content-length': String(body.length), 'x-cauce-operator': 'spoofed', 'content-type': 'application/json' };
    expect((await send(origin, path, 'POST', headers, body)).status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ path, method: 'POST', body, peer: 'oauth-proxy-fixture' });
    expect(seen.at(-1)?.headers['x-cauce-operator']).toBeUndefined();
    const before = seen.length;
    expect((await send(origin, path, 'POST', { ...headers, 'content-length': String(body.length + 1) }, body + 'x')).status).toBe(413);
    expect(seen).toHaveLength(before);
  });

  it.each(['/v3/console/publish-intents/confirm', '/v3/console/messages/other'])('retains the smaller limit outside publish routes: %s', async path => {
    const before = seen.length;
    const body = 'x'.repeat(1_048_577);
    expect((await send(origin, path, 'POST', { 'content-length': String(body.length) }, body)).status).toBe(413);
    expect(seen).toHaveLength(before);
  });

  it('rejects an untrusted upstream CA without accepting SPA as success', async () => {
    const before = seen.length; const result = await send(wrongOrigin, metadata);
    expect(result.status).toBe(502); expect(seen).toHaveLength(before);
    expect(result.body).not.toContain('SPA_FIXTURE_SENTINEL'); expect(result.headers['cache-control']).toContain('no-store');
  });

  it('does not log OAuth query or credential markers, including upstream TLS failure', async () => {
    const marker = `fixture-${randomUUID()}`;
    const control = `control-${randomUUID()}`;
    await send(wrongOrigin, `/mcp?state=${control}`);
    for (const target of [origin, wrongOrigin]) {
      await send(target, `${metadata}?state=${marker}`, 'GET', { authorization: `Bearer ${marker}`, cookie: `fixture=${marker}` });
    }
    let captured = '';
    for (const container of containers) {
      const id = await ownedContainer(container.name);
      for (const log of ['access.log', 'error.log', 'fixture-stdout.log', 'fixture-stderr.log']) {
        const content = await docker(['exec', id, 'cat', `/var/log/nginx/${log}`]);
        expect(content).not.toContain(marker);
        captured += content;
      }
    }
    expect(captured).toContain(control);
  });

  it('keeps the existing MCP cookie stripping and unrelated SPA route', async () => {
    const result = await send(origin, '/mcp', 'POST', { cookie: 'fixture=session', authorization: 'Bearer fixture' });
    expect(result.status).toBe(200); expect(seen.at(-1)?.headers.cookie).toBeUndefined();
    expect(seen.at(-1)?.headers.authorization).toBe('Bearer fixture');
    const spa = await send(origin, '/operator-route'); expect(spa.body).toBe('SPA_FIXTURE_SENTINEL');
  });
});
