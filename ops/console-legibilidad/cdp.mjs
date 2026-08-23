// Driver CDP minimo sobre el WebSocket nativo de node 22. Sin puppeteer.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function launchChrome({ port = 9333 } = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'cdp-prof-'));
  const child = spawn('/usr/bin/google-chrome', [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--no-first-run',
    '--disable-extensions',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  // esperar a que el puerto responda
  const deadline = Date.now() + 30000;
  let version = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) { version = await res.json(); break; }
    } catch { /* aun no */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!version) {
    child.kill('SIGKILL');
    throw new Error(`chrome no levanto en ${port}: ${stderr.slice(-2000)}`);
  }
  return { child, port, wsUrl: version.webSocketDebuggerUrl };
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
      } else if (msg.method) {
        const ls = this.listeners.get(msg.method) || [];
        for (const l of ls) l(msg.params);
      }
    });
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new Cdp(ws);
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() { try { this.ws.close(); } catch { /* ya cerrado */ } }
}

// Sesion sobre un target de pagina.
export class Page {
  constructor(cdp, sessionId) { this.cdp = cdp; this.sessionId = sessionId; }
  static async create(cdp, port) {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    const target = await res.json();
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.id, flatten: true });
    const page = new Page(cdp, sessionId);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    return page;
  }
  send(method, params) { return this.cdp.send(method, params, this.sessionId); }
  async setViewport(width, height, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile,
      screenWidth: width, screenHeight: height,
    });
  }
  async setColorScheme(scheme) {
    await this.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme }],
    });
  }
  async goto(url, settleMs = 1500) {
    const loaded = new Promise((resolve) => {
      const done = () => resolve();
      this.cdp.on('Page.loadEventFired', done);
      setTimeout(done, 20000);
    });
    await this.send('Page.navigate', { url });
    await loaded;
    await new Promise((r) => setTimeout(r, settleMs));
  }
  async eval(fnSource, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(${fnSource})()`,
      returnByValue: true,
      awaitPromise,
    });
    if (r.exceptionDetails) {
      throw new Error('eval: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
    }
    return r.result.value;
  }
  async screenshot(path, fullPage = true) {
    const { writeFileSync } = await import('node:fs');
    const params = { format: 'png' };
    if (fullPage) params.captureBeyondViewport = true;
    const r = await this.send('Page.captureScreenshot', params);
    writeFileSync(path, Buffer.from(r.data, 'base64'));
    return path;
  }
}
