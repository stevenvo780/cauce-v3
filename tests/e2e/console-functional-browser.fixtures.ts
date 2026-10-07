import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Agent as HttpsAgent } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { buildGateway } from '../../services/gateway/src/app.js';
import { MtlsAuthProvider, HashedMtlsIdentityFileProvider } from '../../services/gateway/src/auth.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { startTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import { observeUiBootstrap } from './ui-bootstrap-diagnostics.js';
import { ChatLatencyCapture } from './browser-delivery-diagnostics.js';
import { isolatedBrowserNetwork, publishBrowserCdp } from './ui-bootstrap-network.js';
import { browserExec as exec, browserDocker as docker, browserErrorStderr as errorStderr, browserErrorStdout as errorStdout, ownedBrowserLifecycle, browserResourcesRetained, BrowserResourcesRetained } from './browser-owned-lifecycle.js';

const require = createRequire(join(process.cwd(), 'console/package.json'));
export interface Locator { fill(value: string): Promise<void>; type(value: string): Promise<void>; press(key: string): Promise<void>; click(): Promise<void>; count(): Promise<number>; waitFor(options?: { state?: 'visible' | 'hidden' | 'attached'; timeout?: number }): Promise<void>; selectOption(value: string): Promise<void>; filter(options: { hasText: string }): Locator; locator(selector: string): Locator; getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator; getByText(text: string | RegExp, options?: { exact?: boolean }): Locator; innerText(): Promise<string>; boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> }
export interface BrowserSocket { url(): string; on(event: 'close', handler: (socket: BrowserSocket) => void): void }
export interface BrowserRequest { method(): string }
export interface BrowserResponse { url(): string; status(): number; request(): BrowserRequest }
export interface BrowserPage { goto(url: string, options?: { waitUntil?: 'domcontentloaded' }): Promise<{ status(): number; url(): string } | null>; reload(options?: { waitUntil?: 'domcontentloaded' }): Promise<{ status(): number; url(): string } | null>; url(): string; on(event: 'websocket', handler: (value: BrowserSocket) => void): void; on(event: 'response', handler: (value: BrowserResponse) => void): void; on(event: string, handler: (value: unknown) => void): void; getByLabel(name: string, options?: { exact?: boolean }): Locator; getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator; getByText(text: string | RegExp, options?: { exact?: boolean }): Locator; locator(selector: string): Locator; evaluate<T>(callback: () => T): Promise<Awaited<T>>; evaluate<T, A>(callback: (argument: A) => T, argument: A): Promise<Awaited<T>>; viewportSize(): { width: number; height: number } | null; setViewportSize(viewport: { width: number; height: number }): Promise<void>; screenshot(options: { path: string; fullPage?: boolean }): Promise<Buffer>; context(): BrowserContext }
export interface BrowserContext { cookies(url?: string): Promise<{ name: string; value: string; httpOnly: boolean; secure: boolean }[]>; close(): Promise<void>; newPage(): Promise<BrowserPage> }
interface Browser { connectOverCDP(endpoint: string, options: { timeout: number }): Promise<ConnectedBrowser> }
export interface ConnectedBrowser { newContext(options: { viewport: { width: number; height: number }; ignoreHTTPSErrors: false; serviceWorkers: 'block'; isMobile?: boolean; hasTouch?: boolean }): Promise<BrowserContext>; close(): Promise<void> }
interface ViteServer { close(): Promise<void>; httpServer: import('node:http').Server | null; listen(): Promise<void> }
const chromium = (require('playwright') as { chromium: Browser }).chromium;

export interface FunctionalTenant { tenant: 'Isa' | 'Jhon'; operator: string; target: string; room: string; email: string; password: string; marker: string }
export const functionalTenants: FunctionalTenant[] = [
  { tenant: 'Isa', operator: 'e2eisa', target: 'e2eagentisa', room: 'e2e.isa', email: 'operator-isa@cauce.test', password: randomBytes(24).toString('base64url'), marker: 'CONTEXTO ISA DE PRUEBA' },
  { tenant: 'Jhon', operator: 'e2ejhon', target: 'e2eagentjhon', room: 'e2e.jhon', email: 'operator-jhon@cauce.test', password: randomBytes(24).toString('base64url'), marker: 'CONTEXTO JHON DE PRUEBA' },
];
function tenantAt(index: number): FunctionalTenant {
  const tenant = functionalTenants[index];
  if (!tenant) throw new Error(`missing tenant fixture at index ${String(index)}`);
  return tenant;
}
export const isaTenant = tenantAt(0);
export const jhonTenant = tenantAt(1);
export const isaSecondHuman: FunctionalTenant = {
  ...isaTenant,
  email: 'operator-isa-second@cauce.test',
  password: randomBytes(24).toString('base64url'),
};

interface Identity { tenant_id: string; alias: string; session_id: string; channel: string; roles: string[]; permissions: string[] }
interface Pki { ca: { key: string; cert: string }; server: { key: string; cert: string }; consoleClient: { key: string; cert: string }; adapterCerts: { key: string; cert: string }[]; identityPath: string }
export interface BrowserRuntime { image: string; imageId: string; owned: boolean; playwrightVersion: string }
interface Fixture { database: TestDatabase; directory: string; browserRuntime: BrowserRuntime; baseUrl: string; gatewayUrl: string; pki: Pki; app: Awaited<ReturnType<typeof buildGateway>>; vite: ViteServer; browser: ConnectedBrowser; browserContainer: string; contexts: BrowserContext[]; adapters: ChildProcess[]; prompts: Record<string, string>; gatewayDiagnostics: ChatLatencyCapture; close(): Promise<void> }

async function inspectImage(image: string): Promise<string | undefined> {
  try { return (await docker(['image', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}}', image])).stdout.trim(); }
  catch (error) {
    if (/No such image/iu.test(errorStderr(error))) return undefined;
    throw error;
  }
}

async function removeBrowserImage(runtime: BrowserRuntime): Promise<void> {
  if (!runtime.owned) return;
  const current = await inspectImage(runtime.image);
  if (current === undefined) return;
  if (current !== `${runtime.imageId} ui-functional`) throw new Error(`owned image tag ${runtime.image} changed identity/ownership; refusing to remove it`);
  await docker(['image', 'rm', runtime.image]);
  if (await inspectImage(runtime.image) !== undefined) throw new Error(`owned image tag ${runtime.image} remains after cleanup`);
}

async function cleanPartialBrowserImage(image: string, playwrightVersion: string, cause: unknown, buildLog: string): Promise<void> {
  let imageInfo: string | undefined;
  try { imageInfo = await inspectImage(image); }
  catch (inspectError) { throw new AggregateError([cause, inspectError], `could not inspect possible partial browser image ${image}; build log=${buildLog}`); }
  if (imageInfo === undefined) return;
  const [imageId, owner] = imageInfo.split(' ');
  if (!imageId || owner !== 'ui-functional') throw new AggregateError([cause], `partial image ${image} exists without confirmed ownership; build log=${buildLog}`);
  try { await removeBrowserImage({ image, imageId, owned: true, playwrightVersion }); }
  catch (cleanupError) { throw new AggregateError([cause, cleanupError], `partial browser image cleanup failed for ${image}; build log=${buildLog}`); }
}

const chromePathCommand = "for base in /opt/playwright-browsers /root/.cache/ms-playwright; do if [ -d \"$base\" ]; then find \"$base\" -type f -path '*/chrome-linux*/chrome' -print -quit; fi; done | sed -n '1p'";

function expectedChromiumVersion(): string {
  const playwrightPackage = require.resolve('playwright/package.json');
  const browsers = JSON.parse(readFileSync(join(playwrightPackage, '..', '..', 'playwright-core', 'browsers.json'), 'utf8')) as { browsers?: { name?: string; browserVersion?: string }[] };
  const version = browsers.browsers?.find((browser) => browser.name === 'chromium')?.browserVersion;
  if (!version) throw new Error('Playwright lock metadata has no Chromium browserVersion');
  return version;
}

function assertChromeVersion(output: string, expected: string): void {
  const actual = /\b\d+\.\d+\.\d+\.\d+\b/u.exec(output)?.[0];
  if (!output.includes('Chrome for Testing') || actual !== expected) throw new Error(`Chromium must match Playwright ${expected}; received ${JSON.stringify(output.trim())}`);
}

async function prepareBrowserRuntime(directory: string): Promise<BrowserRuntime> {
  const playwrightVersion = (require('playwright/package.json') as { version: string }).version;
  const chromiumVersion = expectedChromiumVersion();
  const override = process.env.CAUCE_UI_FUNCTIONAL_BROWSER_IMAGE;
  if (override) {
    const imageInfo = await inspectImage(override);
    if (!imageInfo) throw new Error(`browser override image is not present locally: ${override}`);
    const [imageId] = imageInfo.split(' ');
    const capability = await docker(['run', '--rm', '--network', 'none', '--entrypoint', 'sh', override, '-lc', `node -p "require('/opt/playwright/node_modules/playwright/package.json').version+' '+require('/opt/playwright/node_modules/playwright-core/browsers.json').browsers.find(x=>x.name==='chromium').browserVersion" && command -v certutil && ${chromePathCommand}`]);
    const [versions, certutilPath, browserPath] = capability.stdout.trim().split('\n').map((line) => line.trim());
    if (versions !== `${playwrightVersion} ${chromiumVersion}` || certutilPath !== '/usr/bin/certutil') throw new Error(`browser override must use Playwright ${playwrightVersion}, Chromium ${chromiumVersion}, and certutil: ${override}`);
    if (typeof browserPath !== 'string' || !browserPath.startsWith('/') || !browserPath.endsWith('/chrome')) throw new Error(`browser override lacks certutil or Chromium: ${override}`);
    const version = await docker(['run', '--rm', '--network', 'none', '--entrypoint', browserPath, override, '--version']);
    assertChromeVersion(version.stdout, chromiumVersion);
    process.stdout.write(`E2E browser override: ${override} ${imageInfo}; Playwright=${playwrightVersion}; Chromium=${chromiumVersion}\n`);
    return { image: override, imageId: imageId ?? '', owned: false, playwrightVersion };
  }

  const image = `cauce-ui-functional:${randomUUID()}`;
  if (await inspectImage(image) !== undefined) throw new Error('random browser image tag collision; refusing to reuse it');
  const dockerfile = `FROM node@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
RUN apt-get update && apt-get install -y --no-install-recommends libnss3-tools && rm -rf /var/lib/apt/lists/*
RUN npm install --global --no-audit --no-fund playwright@${playwrightVersion}
RUN playwright install --with-deps chromium
`;
  const dockerfilePath = join(directory, 'Dockerfile.browser');
  await writeFile(dockerfilePath, dockerfile, { mode: 0o600 });
  const buildLog = join(tmpdir(), `cauce-ui-functional-build-${image.slice(image.indexOf(':') + 1)}.log`);
  try {
    const buildOutput = await docker(['build', '--progress=plain', '--label', 'cauce.e2e.owner=ui-functional', '--tag', image, '--file', dockerfilePath, directory], { timeout: 8 * 60_000, maxBuffer: 24 * 1024 * 1024 });
    await writeFile(buildLog, `${buildOutput.stdout}${buildOutput.stderr}`, { mode: 0o600 });
  } catch (error) {
    await writeFile(buildLog, `${errorStdout(error)}${errorStderr(error)}`, { mode: 0o600 }).catch(() => undefined);
    await cleanPartialBrowserImage(image, playwrightVersion, error, buildLog);
    throw new Error(`browser runtime build failed for Playwright ${playwrightVersion}; log=${buildLog}`, { cause: error });
  }
  let imageInfo: string | undefined;
  try { imageInfo = await inspectImage(image); }
  catch (error) {
    await cleanPartialBrowserImage(image, playwrightVersion, error, buildLog);
    throw error;
  }
  if (!imageInfo) throw new Error(`browser runtime build completed without image ${image}; log=${buildLog}`);
  const [imageId, owner] = imageInfo.split(' ');
  if (!imageId || owner !== 'ui-functional') throw new Error(`built image ownership label is invalid for ${image}; log=${buildLog}`);
  const runtime = { image, imageId, owned: true, playwrightVersion };
  try {
    const capability = await docker(['run', '--rm', '--network', 'none', '--entrypoint', 'sh', image, '-lc', `playwright --version && command -v certutil && ${chromePathCommand}`]);
    const lines = capability.stdout.trim().split('\n');
    if (lines[0]?.trim() !== `Version ${playwrightVersion}` || !lines.some((line) => line.trim() === '/usr/bin/certutil') || !lines.at(-1)?.trim().endsWith('/chrome')) {
      throw new Error(`built runtime failed capability validation: ${JSON.stringify(capability.stdout.trim())}`);
    }
    const version = await docker(['run', '--rm', '--network', 'none', '--entrypoint', lines.at(-1)?.trim() ?? '', image, '--version']);
    assertChromeVersion(version.stdout, chromiumVersion);
    process.stdout.write(`E2E browser runtime: ${image} ${imageId}; Playwright=${playwrightVersion}; Chromium=${chromiumVersion}; build log=${buildLog}\n`);
    return runtime;
  } catch (error) {
    try { await removeBrowserImage(runtime); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'browser runtime validation failed and its image could not be confirmed removed'); }
    throw error;
  }
}

async function startIsolatedBrowser(caCertPath: string, runtime: BrowserRuntime, ports: readonly number[]): Promise<{ browser: ConnectedBrowser; container: string; containerId: string; closeNetwork(): Promise<void>; closeContainer: () => Promise<void> }> {
  const owner = randomUUID();
  const container = `cauce-ui-browser-${owner}`;
  const network = await isolatedBrowserNetwork(docker, ports);
  const lifecycle = ownedBrowserLifecycle(docker, { name: container, owner, imageId: runtime.imageId,
    networkName: network.name, networkId: network.id, networkOwner: network.owner, directory: network.directory, socketIdentity: network.socketIdentity });
  const closeNetwork = async () => {
    if (lifecycle.retained()) { await network.closeTransport(); throw new BrowserResourcesRetained(lifecycle.descriptor); }
    await network.close();
  };
  let cdp: Awaited<ReturnType<typeof publishBrowserCdp>> | undefined;
  try {
    const containerId = await lifecycle.start();
    const containerCa = `/tmp/${container}-ca.crt`;
    await docker(['cp', caCertPath, `${container}:${containerCa}`]);
    const initializeNss = 'if [ -d "$HOME/.pki/nssdb" ]; then nssdb="$HOME/.pki/nssdb"; else nssdb="${XDG_DATA_HOME:-$HOME/.local/share}/pki/nssdb"; fi; install -d -m 700 "$nssdb" && certutil -N --empty-password -d "sql:$nssdb" && printf "%s\\n" "$nssdb"';
    const nssdb = (await docker(['exec', container, 'sh', '-lc', initializeNss])).stdout.trim();
    if (!nssdb.startsWith('/root/') || nssdb.includes(' ')) throw new Error(`isolated browser selected an unexpected NSS database path: ${JSON.stringify(nssdb)}`);
    await docker(['exec', container, 'certutil', '-A', '-f', '/dev/null', '-d', `sql:${nssdb}`, '-n', 'Cauce E2E private CA', '-t', 'C,,', '-i', containerCa], { timeout: 5_000 });
    const browserPath = (await docker(['exec', container, 'sh', '-lc', chromePathCommand])).stdout.trim();
    if (!browserPath.startsWith('/') || !browserPath.endsWith('/chrome')) {
      throw new Error(`la imagen browser no tiene un ejecutable Chrome compatible: ${JSON.stringify(browserPath)}`);
    }
    const chromeVersion = await docker(['exec', container, browserPath, '--version']);
    assertChromeVersion(chromeVersion.stdout, expectedChromiumVersion());
    const mounts = JSON.parse((await docker(['inspect', '--format', '{{json .Mounts}}', container])).stdout) as { Source: string; Destination: string; RW: boolean }[];
    if (mounts.length !== 1 || mounts[0]?.Source !== network.directory || mounts[0].Destination !== '/qa-browser-transport' || mounts[0].RW) throw new Error('Private browser transport mount differs');
    const metadata = await docker(['exec', container, 'node', '-e', "const s=require('node:fs').lstatSync('/qa-browser-transport/proxy.sock');console.log(JSON.stringify({uid:s.uid,ino:s.ino,dev:s.dev,mode:s.mode&511,socket:s.isSocket()}))"]);
    const socket = JSON.parse(metadata.stdout) as { uid: number; ino: number; dev: number; mode: number; socket: boolean };
    if (!socket.socket || socket.mode !== 0o600 || socket.uid !== network.socketIdentity.uid || socket.ino !== network.socketIdentity.ino || socket.dev !== network.socketIdentity.dev) throw new Error('Browser daemon mounted a different private socket');
    const proxyForward = "const net=require('node:net'),fs=require('node:fs');net.createServer(s=>{const u=net.connect('/qa-browser-transport/proxy.sock');s.on('error',()=>u.destroy());u.on('error',()=>s.destroy());s.on('close',()=>u.destroy());u.on('close',()=>s.destroy());s.pipe(u);u.pipe(s)}).listen(1080,'127.0.0.1',()=>fs.writeFileSync('/tmp/cauce-proxy-forward-ready','ready',{mode:384,flag:'wx'}));";
    await docker(['exec', '--detach', container, 'node', '-e', proxyForward]);
    await docker(['exec', container, 'node', '-e', "const net=require('node:net');const s=net.connect('/qa-browser-transport/proxy.sock');s.setTimeout(3000,()=>{s.destroy();process.exitCode=1});s.on('connect',()=>{s.destroy()});s.on('error',()=>{process.exitCode=1})"], { timeout: 5_000 });
    const proxyReady = await docker(['exec', container, 'cat', '/tmp/cauce-proxy-forward-ready']);
    if (proxyReady.stdout.trim() !== 'ready') throw new Error('Private proxy forwarder is not ready');
    await docker(['exec', '--detach', container, browserPath, '--no-sandbox', '--headless=new', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', `--proxy-server=${network.proxyUrl}`, '--proxy-bypass-list=<-loopback>', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=/tmp/cauce-ui-functional-chrome', 'about:blank']);
    const profile = '/tmp/cauce-ui-functional-chrome/DevToolsActivePort';
    const deadline = Date.now() + 15_000;
    let port = 0;
    while (Date.now() < deadline) {
      const activePort = await docker(['exec', container, 'cat', profile], { timeout: 2_000 }).catch(() => undefined);
      const parsedPort = activePort?.stdout.split(/\s+/u)[0];
      if (parsedPort && /^\d+$/u.test(parsedPort)) { port = Number(parsedPort); break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!port) throw new Error('Chrome aislado no publicó un puerto CDP efímero en el plazo previsto');
    if (port === 9223) throw new Error('Chromium CDP port conflicts with its private forwarder');
    const forward = `const net=require('node:net'),fs=require('node:fs');net.createServer(s=>{const u=net.connect(${String(port)},'127.0.0.1');s.on('error',()=>u.destroy());u.on('error',()=>s.destroy());s.on('close',()=>u.destroy());u.on('close',()=>s.destroy());s.pipe(u);u.pipe(s)}).listen(9223,'0.0.0.0',()=>fs.writeFileSync('/tmp/cauce-cdp-forward-ready','ready',{mode:384,flag:'wx'}));`;
    await docker(['exec', '--detach', container, 'node', '-e', forward]);
    let ready = false;
    while (Date.now() < deadline) {
      ready = (await docker(['exec', container, 'cat', '/tmp/cauce-cdp-forward-ready'], { timeout: 2_000 }).catch(() => undefined))?.stdout.trim() === 'ready';
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('Private CDP forwarder did not become ready within browser startup budget');
    const networks = JSON.parse((await docker(['inspect', '--format', '{{json .NetworkSettings.Networks}}', container])).stdout) as Record<string, { NetworkID: string; IPAddress: string }>;
    const attachment = networks[network.name];
    if (Object.keys(networks).length !== 1 || attachment?.NetworkID !== network.id || !/^\d+\.\d+\.\d+\.\d+$/u.test(attachment.IPAddress)) throw new Error('Browser network attachment differs from its owned namespace');
    cdp = await publishBrowserCdp(attachment.IPAddress);
    const endpoint = `http://127.0.0.1:${String(cdp.port)}`;
    const version = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(10_000) }).then(async (response) => response.json() as Promise<{ webSocketDebuggerUrl: string }>);
    const websocket = new URL(version.webSocketDebuggerUrl);
    if (websocket.hostname !== '127.0.0.1' || websocket.port !== String(cdp.port)) throw new Error('Published CDP websocket address differs from its private host binding');
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
    return { browser, container, containerId, closeContainer: lifecycle.close, closeNetwork: async () => {
      const errors: Error[] = [];
      await attemptCleanup(errors, 'private CDP publication', () => cdp?.close() ?? Promise.resolve());
      await attemptCleanup(errors, 'owned browser network', closeNetwork);
      if (errors.length > 0) throw new AggregateError(errors, 'Browser network cleanup incomplete');
    } };
  } catch (error) {
    const errors: Error[] = [];
    await attemptCleanup(errors, 'owned browser container', lifecycle.close);
    await attemptCleanup(errors, 'private CDP publication', () => cdp?.close() ?? Promise.resolve());
    await attemptCleanup(errors, 'owned browser network', closeNetwork);
    if (errors.length > 0) throw new AggregateError([error, ...errors], 'Browser setup failed with incomplete cleanup');
    throw error;
  }
}

export interface TrustedBrowser {
  browser: ConnectedBrowser;
  container: string;
  containerId: string;
  runtime: BrowserRuntime;
  close(): Promise<void>;
}

export async function startTrustedBrowser(caCertPath: string, directory: string, ports: readonly number[]): Promise<TrustedBrowser> {
  const runtime = await prepareBrowserRuntime(directory);
  try {
    const isolated = await startIsolatedBrowser(caCertPath, runtime, ports);
    return {
      browser: isolated.browser,
      container: isolated.container,
      containerId: isolated.containerId,
      runtime,
      close: async () => {
        const errors: Error[] = [];
        await attemptCleanup(errors, 'CDP browser', () => isolated.browser.close());
        await attemptCleanup(errors, 'owned browser container', isolated.closeContainer);
        await attemptCleanup(errors, 'owned browser network', () => isolated.closeNetwork());
        if (!browserResourcesRetained(new AggregateError(errors))) await attemptCleanup(errors, 'owned browser image', () => removeBrowserImage(runtime));
        if (errors.length > 0) throw new AggregateError(errors, 'trusted browser cleanup was incomplete');
      },
    };
  } catch (error) {
    try { if (!browserResourcesRetained(error)) await removeBrowserImage(runtime); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'trusted browser startup failed and its owned image could not be confirmed removed'); }
    throw error;
  }
}

async function attemptCleanup(errors: Error[], label: string, operation: () => Promise<unknown>): Promise<void> {
  try { await operation(); }
  catch (error) { errors.push(new Error(`cleanup failed for ${label}`, { cause: error })); }
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function certificate(directory: string, name: string, ca?: { cert: string; key: string }, san = 'DNS:localhost,IP:127.0.0.1') {
  const key = join(directory, `${name}.key`);
  const cert = join(directory, `${name}.crt`);
  const csr = join(directory, `${name}.csr`);
  const config = join(directory, `${name}.cnf`);
  await exec('openssl', ['genrsa', '-out', key, '2048']);
  const isCa = ca === undefined;
  await writeFile(config, `[req]\ndistinguished_name=dn\nprompt=no\n${isCa ? '' : 'req_extensions=ext\n'}[dn]\nCN=${name}\n${isCa ? '' : `[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=${name === 'gateway-server' ? 'serverAuth' : 'clientAuth'}\nsubjectAltName=${san}\n`}`);
  await exec('openssl', ['req', '-new', '-key', key, '-out', csr, '-config', config]);
  if (ca) await exec('openssl', ['x509', '-req', '-in', csr, '-CA', ca.cert, '-CAkey', ca.key, '-CAcreateserial', '-out', cert, '-days', '2', '-sha256', '-extfile', config, '-extensions', 'ext']);
  else await exec('openssl', ['req', '-x509', '-new', '-key', key, '-out', cert, '-days', '2', '-sha256', '-config', config, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  await chmod(key, 0o600);
  await chmod(cert, 0o600);
  return { key, cert };
}

async function createPki(directory: string) {
  const ca = await certificate(directory, 'test-ca');
  const server = await certificate(directory, 'gateway-server', ca, 'DNS:localhost,IP:127.0.0.1');
  const consoleClient = await certificate(directory, 'console-proxy', ca, 'DNS:console.test');
  const adapters = await Promise.all(functionalTenants.map((tenant) => certificate(directory, tenant.target, ca, `DNS:${tenant.target}.test`)));
  const identities = [
    { cert: consoleClient.cert, principal: { tenant_id: isaTenant.tenant, alias: 'e2eproxy', session_id: `proxy:${randomUUID()}`, channel: 'console-proxy', roles: ['adapter'], permissions: ['read'] } satisfies Identity },
    ...functionalTenants.map((tenant, index) => {
      const cert = adapters[index];
      if (!cert) throw new Error(`missing adapter certificate for ${tenant.tenant}`);
      return { cert: cert.cert, principal: { tenant_id: tenant.tenant, alias: tenant.target, session_id: `adapter:${randomUUID()}`, channel: 'agent', roles: ['agent'], permissions: ['route', 'read'] } satisfies Identity };
    }),
  ].map(({ cert, principal }) => ({ certificate_sha256: new X509Certificate(readFileSync(cert)).fingerprint256.replaceAll(':', '').toLowerCase(), expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), principal }));
  const identityPath = join(directory, 'identities.json');
  await writeFile(identityPath, JSON.stringify({ version: 1, identities }), { mode: 0o600 });
  return { ca, server, consoleClient, adapterCerts: adapters, identityPath };
}

async function seed(database: TestDatabase, directory: string) {
  for (const item of functionalTenants) {
    await database.pool.query('INSERT INTO tenants(id) VALUES ($1) ON CONFLICT DO NOTHING', [item.tenant]);
    await database.pool.query('INSERT INTO rooms(id,tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [item.room, item.tenant]);
    await database.pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory)
      VALUES ($1,$2,'codex',$2,true,$3,'stev',$4,$5) ON CONFLICT (tenant_id,alias) DO NOTHING`, [item.tenant, item.target, `cauce-e2e-${item.target}`, directory, join(directory, item.target)]);
    await database.pool.query("INSERT INTO agent_profiles(tenant_id,alias,role_summary) VALUES ($1,$2,$3) ON CONFLICT (tenant_id,alias) DO NOTHING", [item.tenant, item.target, item.marker]);
    await database.pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory)
      VALUES ($1,$2,'fake',$2,true,$3,'stev',$4,$5) ON CONFLICT (tenant_id,alias) DO NOTHING`, [item.tenant, item.operator, `cauce-e2e-${item.operator}`, directory, join(directory, item.operator)]);
    await database.pool.query('INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES ($1,$2,$3,\'operator\') ON CONFLICT DO NOTHING', [item.tenant, item.room, item.operator]);
  }
}

async function availableLoopbackPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as import('node:net').AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve(); }));
  return port;
}

export async function startConsoleFunctionalFixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-ui-functional-'));
  let setupStage = 'prepare browser runtime';
  let browserRuntime: BrowserRuntime | undefined;
  let database: TestDatabase | undefined;
  let app: Fixture['app'] | undefined;
  let vite: Fixture['vite'] | undefined;
  let browser: ConnectedBrowser | undefined;
  let closeBrowserContainer: (() => Promise<void>) | undefined;
  let closeBrowserNetwork: (() => Promise<void>) | undefined;
  let proxyAgent: HttpsAgent | undefined;
  const contexts: Fixture['contexts'] = [];
  const adapters: Fixture['adapters'] = [];
  const prompts: Record<string, string> = {};
  const gatewayDiagnostics = new ChatLatencyCapture();
  try {
    const runtime = await prepareBrowserRuntime(directory);
    browserRuntime = runtime;
    setupStage = 'start isolated PostgreSQL';
    database = await startTestDatabase();
    setupStage = 'seed fixture and create TLS material';
    await seed(database, directory);
    const pki = await createPki(directory);
    if (process.env.VITE_USE_MOCKS === 'true') throw new Error('VITE_USE_MOCKS=true no se admite en E2E contra gateway/PostgreSQL reales');
    for (const user of [...functionalTenants, isaSecondHuman]) {
      setupStage = `provision password user ${user.tenant}`;
      const provision = await exec(join(process.cwd(), 'node_modules/.bin/tsx'), [
        'services/gateway/src/console-user-cli.ts', '--email', user.email, '--name', `${user.tenant} E2E operator`,
        '--role', 'operator', '--tenant', user.tenant, '--alias', user.operator,
      ], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test', DATABASE_URL: database.url, CAUCE_CONSOLE_USER_PASSWORD: user.password }, timeout: 15_000 });
      if (!provision.stdout.includes('cuenta guardada') || provision.stdout.includes(user.password)) {
        throw new Error(`la CLI de cuentas no confirmó creación limpia; stdout sin contraseña=${JSON.stringify(provision.stdout.replaceAll(user.password, '[REDACTED]'))}`);
      }
    }
    const frontendPort = await availableLoopbackPort();
    setupStage = 'build gateway and start HTTPS listener';
    const auth = new PasswordAuthProvider({
      users: new PostgresConsoleUserStore(database.pool), signingKey: randomBytes(32), sessionTtlMs: 10 * 60_000,
      fallback: new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(pki.identityPath)),
    });
    await auth.ready();
    app = await buildGateway({ pool: database.pool, authProvider: auth, logger: { level: 'info', stream: gatewayDiagnostics }, https: {
      key: await readFile(pki.server.key), cert: await readFile(pki.server.cert), ca: await readFile(pki.ca.cert), requestCert: true, rejectUnauthorized: true,
    }, consoleOrigins: [`https://localhost:${String(frontendPort)}`] });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const gatewayAddress = app.server.address() as import('node:net').AddressInfo;
    proxyAgent = new HttpsAgent({ cert: await readFile(pki.consoleClient.cert), key: await readFile(pki.consoleClient.key), ca: await readFile(pki.ca.cert), rejectUnauthorized: true });
    const { createServer } = require('vite') as { createServer: (config: Record<string, unknown>) => Promise<ViteServer> };
    setupStage = 'start Vite HTTPS server';
    const devServer = await createServer({ configFile: join(process.cwd(), 'console/vite.config.ts'), root: join(process.cwd(), 'console'), envDir: directory, server: {
      host: '127.0.0.1', port: frontendPort, strictPort: true, https: { key: await readFile(pki.server.key), cert: await readFile(pki.server.cert) },
      proxy: { '/v3': { target: `https://localhost:${String(gatewayAddress.port)}`, agent: proxyAgent, secure: true, changeOrigin: false, ws: true } },
    } });
    vite = devServer;
    await devServer.listen();
    const address = devServer.httpServer?.address() as import('node:net').AddressInfo;
    setupStage = 'start isolated browser';
    const isolatedBrowser = await startIsolatedBrowser(pki.ca.cert, runtime, [frontendPort, gatewayAddress.port]);
    closeBrowserNetwork = () => isolatedBrowser.closeNetwork();
    const activeBrowser = isolatedBrowser.browser;
    const activeBrowserContainer = isolatedBrowser.container;
    browser = activeBrowser;
    closeBrowserContainer = isolatedBrowser.closeContainer;
    const fixture: Fixture = {
      database, directory, browserRuntime: runtime, baseUrl: `https://localhost:${String(address.port)}`, gatewayUrl: `https://localhost:${String(gatewayAddress.port)}`, pki, app, vite, browser: activeBrowser, browserContainer: activeBrowserContainer, contexts, adapters, prompts, gatewayDiagnostics,
      close: async () => {
        const cleanupErrors: Error[] = [];
        for (const [index, context] of contexts.entries()) await attemptCleanup(cleanupErrors, `browser context ${String(index)}`, () => context.close());
        await attemptCleanup(cleanupErrors, 'CDP browser', () => activeBrowser.close());
        await attemptCleanup(cleanupErrors, 'owned browser container', isolatedBrowser.closeContainer);
        await attemptCleanup(cleanupErrors, 'owned browser network', () => closeBrowserNetwork?.() ?? Promise.resolve());
        for (const child of adapters) {
          if (child.exitCode !== null || child.signalCode !== null) continue;
          await attemptCleanup(cleanupErrors, `adapter process ${String(child.pid)}`, async () => {
            child.kill('SIGTERM');
            if (!(await waitForChildExit(child, 2_000))) {
              child.kill('SIGKILL');
              if (!(await waitForChildExit(child, 2_000))) throw new Error(`process ${String(child.pid)} did not exit after SIGKILL`);
            }
          });
        }
        proxyAgent?.destroy();
        if (vite) await attemptCleanup(cleanupErrors, 'Vite server', () => vite?.close() ?? Promise.resolve());
        if (app) await attemptCleanup(cleanupErrors, 'gateway server', () => app?.close() ?? Promise.resolve());
        if (database) await attemptCleanup(cleanupErrors, 'database pool', () => database?.pool.end() ?? Promise.resolve());
        if (database) await attemptCleanup(cleanupErrors, 'owned PostgreSQL container', () => database?.container.stop() ?? Promise.resolve());
        if (!browserResourcesRetained(new AggregateError(cleanupErrors))) await attemptCleanup(cleanupErrors, 'owned browser image', () => removeBrowserImage(runtime));
        await attemptCleanup(cleanupErrors, 'fixture temporary directory', () => rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
        if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'functional E2E cleanup was incomplete');
      },
    };
    return fixture;
  } catch (error) {
    process.stderr.write(`functional fixture setup failed at: ${setupStage}\n`);
    const cleanupErrors: Error[] = [];
    if (browser) await attemptCleanup(cleanupErrors, 'CDP browser', () => browser?.close() ?? Promise.resolve());
    if (closeBrowserContainer) await attemptCleanup(cleanupErrors, 'owned browser container', closeBrowserContainer);
    await attemptCleanup(cleanupErrors, 'owned browser network', () => closeBrowserNetwork?.() ?? Promise.resolve());
    proxyAgent?.destroy();
    if (vite) await attemptCleanup(cleanupErrors, 'Vite server', () => vite?.close() ?? Promise.resolve());
    if (app) await attemptCleanup(cleanupErrors, 'gateway server', () => app?.close() ?? Promise.resolve());
    if (database) await attemptCleanup(cleanupErrors, 'database pool', () => database?.pool.end() ?? Promise.resolve());
    if (database) await attemptCleanup(cleanupErrors, 'owned PostgreSQL container', () => database?.container.stop() ?? Promise.resolve());
    if (browserRuntime && !browserResourcesRetained(error) && !browserResourcesRetained(new AggregateError(cleanupErrors))) {
      const ownedRuntime = browserRuntime;
      await attemptCleanup(cleanupErrors, 'owned browser image', () => removeBrowserImage(ownedRuntime));
    }
    await attemptCleanup(cleanupErrors, 'fixture temporary directory', () => rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], 'functional fixture startup failed and cleanup was incomplete', { cause: error });
    throw error;
  }
}

export async function startBoundedAdapter(fixture: Fixture, tenant: FunctionalTenant): Promise<ChildProcess> {
  const index = functionalTenants.indexOf(tenant);
  const tls = fixture.pki.adapterCerts[index];
  if (!tls) throw new Error(`no TLS material for ${tenant.tenant}`);
  const capture = join(fixture.directory, `${tenant.tenant}-captured-prompt.txt`);
  const harness = join(fixture.directory, `${tenant.tenant}-codex-shim.mjs`);
  const home = join(fixture.directory, `${tenant.tenant}-adapter-home`);
  const codexHome = join(fixture.directory, `${tenant.tenant}-codex-home`);
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(codexHome, { mode: 0o700 })]);
  await writeFile(harness, `#!/usr/bin/env node\nimport { randomUUID } from 'node:crypto';\nimport { appendFile } from 'node:fs/promises';\nconst args=process.argv.slice(2);\nconst resumeIndex=args.indexOf('resume');\nconst resumedId=resumeIndex<0?null:args[resumeIndex+2]||null;\nif(resumeIndex>=0&&!resumedId){process.stderr.write('FIXTURE_CODEX_RESUME_ID_MISSING\\n');process.exit(86);}\nconst chunks=[];for await(const item of process.stdin){chunks.push(Buffer.from(item));if(Buffer.concat(chunks).length>1048576){process.stderr.write('FIXTURE_CODEX_PROMPT_LIMIT\\n');process.exit(86);}}\nconst prompt=Buffer.concat(chunks).toString('utf8');\nconst contextMatch=/--- BEGIN TRUSTED DELIVERY CONTEXT ---\\n([\\s\\S]*?)\\n--- END TRUSTED DELIVERY CONTEXT ---/u.exec(prompt);\nlet context;try{context=JSON.parse(contextMatch?.[1]??'null');}catch{context=null;}\nif(!context||typeof context!=='object'||Array.isArray(context)){process.stderr.write('FIXTURE_CODEX_CONTEXT_MISSING\\n');process.exit(86);}\nawait appendFile(${JSON.stringify(capture)},prompt+'\\n---TURN---\\n',{mode:0o600});\nconst humanMarker=/UI-HUMAN-[A-Z0-9-]+/u.exec(prompt)?.[0];\nconst reply=${JSON.stringify(`respuesta sintética ${tenant.tenant}`)}+(humanMarker?' '+humanMarker:'');\nconst threadId=resumedId??randomUUID();\nconst result=JSON.stringify({reply,messages:[],notify:[],status:'done',retryable:false,artifacts:[]});\nprocess.stdout.write(JSON.stringify({type:'thread.started',thread_id:threadId})+'\\n');\nprocess.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:result}})+'\\n');\n`);
  await chmod(harness, 0o700);
  const child = spawn(process.execPath, ['packages/adapter-sdk/dist/src/bin/codex.js'], {
    cwd: process.cwd(), env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test', HOME: home, CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
      CAUCE_TENANT: tenant.tenant, CAUCE_ROOM: tenant.room, CAUCE_ALIAS: tenant.target,
      CAUCE_INSTANCE_ID: `ui-e2e-${tenant.tenant.toLowerCase()}`, CAUCE_STATE_DIR: join(fixture.directory, `${tenant.tenant}-state`),
      CAUCE_RELAY_URL: `${fixture.gatewayUrl.replace('https:', 'wss:')}/v3/ws`, CAUCE_ENVIRONMENT: 'test',
      CAUCE_HARNESS_COMMAND: harness, CAUCE_HEARTBEAT_MS: '250',
      CAUCE_TLS_CERT_FILE: tls.cert, CAUCE_TLS_KEY_FILE: tls.key, CAUCE_TLS_CA_FILE: fixture.pki.ca.cert,
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const appendBounded = (key: string, chunk: Buffer) => {
    const combined = (fixture.prompts[key] ?? '') + chunk.toString('utf8');
    fixture.prompts[key] = combined.slice(-64 * 1024);
  };
  child.stdout.on('data', (chunk: Buffer) => { appendBounded(`${tenant.tenant}:stdout`, chunk); });
  child.stderr.on('data', (chunk: Buffer) => { appendBounded(`${tenant.tenant}:stderr`, chunk); });
  fixture.adapters.push(child);
  fixture.prompts[`${tenant.tenant}:capture`] = capture;
  return child;
}

export async function newTrustedPage(fixture: Fixture, viewport: { width: number; height: number }): Promise<BrowserPage> {
  const context = await fixture.browser.newContext({ viewport, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
  fixture.contexts.push(context);
  const page = await context.newPage();
  observeUiBootstrap(page);
  return page;
}
