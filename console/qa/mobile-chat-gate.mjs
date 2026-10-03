import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(process.env.CAUCE_MOBILE_QA_OUTPUT ?? resolve(ROOT, '../artifacts/mobile-chat'));
const ORIGIN = process.env.CAUCE_QA_ORIGIN ?? 'http://127.0.0.1:4174';
const VIEWPORTS = [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 430, height: 932 }];
const compiled = await build({ entryPoints: [resolve(ROOT, 'src/test/mobile-chat-fixtures.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
const { mobileChatFixtures } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

function measure() {
  const box = (selector) => {
    const node = document.querySelector(selector);
    if (!node) throw new Error(`Missing ${selector}`);
    return node.getBoundingClientRect().toJSON();
  };
  const shell = box('.messenger-shell');
  const header = box('.messenger-thread-head');
  const messages = box('.messenger-thread-scroll');
  const composer = box('.messenger-composer');
  const bottom = window.visualViewport.height + window.visualViewport.offsetTop;
  const visibleMessages = [...document.querySelectorAll('.transcript-entry')].filter((node) => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > messages.top && rect.top < Math.min(messages.bottom, bottom);
  }).length;
  return {
    shell, header, messages, composer, visibleMessages, viewportBottom: bottom,
    messageRatio: messages.height / shell.height,
    overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    openTechnicalPanels: document.querySelectorAll('.chat-more-panel, .messenger-delivery-detail, .chat-agent-details[open], .account-popover:not([hidden])').length,
    keyboardOpen: document.querySelector('.messenger-shell').hasAttribute('data-keyboard-open'),
  };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(ORIGIN)).ok) return; } catch { /* Vite is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The local fixture server did not start');
}

await mkdir(OUTPUT, { recursive: true });
const server = process.env.CAUCE_QA_ORIGIN ? undefined : spawn(process.execPath, [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '4174', '--strictPort'], {
  cwd: ROOT, env: { ...process.env, VITE_USE_MOCKS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server?.stdout.on('data', (chunk) => { serverLog += String(chunk); });
server?.stderr.on('data', (chunk) => { serverLog += String(chunk); });
let browser;
const results = [];
try {
  await waitForServer();
  browser = await chromium.launch();
  for (const viewport of VIEWPORTS) {
    for (const state of ['seeded', 'attention', 'empty', 'keyboard']) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true, serviceWorkers: 'block', colorScheme: 'light' });
      const page = await context.newPage();
      const errors = [];
      const mutations = [];
      const fixtures = mobileChatFixtures(state);
      page.on('pageerror', (error) => { errors.push(error.message); });
      await page.route('**/v3/**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() !== 'GET') {
          mutations.push(`${request.method()} ${path}`);
          return route.abort();
        }
        const payload = fixtures[path];
        await route.fulfill({ status: payload ? 200 : 404, contentType: 'application/json', body: JSON.stringify(payload ?? { error: 'fixture_not_declared', path }) });
      });
      await page.goto(`${ORIGIN}/messages/Steven/kant`);
      await page.locator('.messenger-composer textarea:enabled').waitFor();
      if (state !== 'empty') await page.locator('.transcript-entry').first().waitFor();
      if (state === 'keyboard') {
        await page.getByRole('textbox', { name: 'Mensaje para kant' }).fill('Borrador conservado con el teclado abierto');
        await page.evaluate(() => {
          Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 440 });
          window.visualViewport.dispatchEvent(new Event('resize'));
        });
        await page.locator('.messenger-shell[data-keyboard-open]').waitFor();
      }
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      if (state !== 'empty' && await page.locator('.transcript-entry').count() !== 8) throw new Error('The complete seeded conversation did not render');
      const metrics = await page.evaluate(measure);
      const failures = [];
      if (metrics.header.height > 64) failures.push('header exceeds 64px');
      if (metrics.composer.height > 96) failures.push('collapsed composer exceeds 96px');
      if (metrics.messageRatio < 0.6) failures.push('messages occupy less than 60% of app content');
      if (metrics.overflow > 0) failures.push('horizontal document overflow');
      if (state !== 'empty' && metrics.visibleMessages === 0) failures.push('no seeded message in the first viewport');
      if (metrics.composer.bottom > metrics.viewportBottom + 1) failures.push('composer extends below the visual viewport');
      if (metrics.openTechnicalPanels !== 0) failures.push('technical panels opened without intent');
      if (state === 'attention' && !(await page.getByRole('link', { name: 'Revisar en Colas' }).isVisible())) failures.push('queue warning not visible');
      if (state === 'empty' && !(await page.getByText(/No hay mensajes de este agente en la ventana recibida/).isVisible())) failures.push('empty conversation guidance not visible');
      failures.push(...errors, ...mutations.map((mutation) => `Unexpected mutation: ${mutation}`));
      const name = `${String(viewport.width)}x${String(viewport.height)}-${state}`;
      await page.screenshot({ path: resolve(OUTPUT, `${name}.png`), clip: { x: 0, y: 0, width: viewport.width, height: Math.min(viewport.height, metrics.viewportBottom) } });
      results.push({ name, state, viewport, metrics, failures, keyboardEvidence: state === 'keyboard' ? 'Simulated visualViewport resize in Chromium; no physical OS keyboard' : undefined });
      if (state === 'seeded') {
        await page.getByRole('button', { name: 'Más', exact: true }).click();
        await page.getByRole('link', { name: 'Configurar agente' }).waitFor();
        await page.screenshot({ path: resolve(OUTPUT, `${name}-menu.png`) });
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Cuenta de Steven', exact: true }).click();
        await page.getByRole('dialog', { name: 'Cuenta y apariencia' }).waitFor();
        await page.screenshot({ path: resolve(OUTPUT, `${name}-account.png`) });
      }
      await context.close();
    }
  }
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
  await writeFile(resolve(OUTPUT, 'server.log'), serverLog);
  await writeFile(resolve(OUTPUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
}
const failures = results.flatMap((result) => result.failures.map((failure) => `${result.name}: ${failure}`));
console.log(JSON.stringify({ measuredStates: results.length, failures, output: OUTPUT }, null, 2));
if (results.length !== 12 || failures.length) process.exitCode = 1;
