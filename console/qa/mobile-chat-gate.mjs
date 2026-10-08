import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(process.env.CAUCE_MOBILE_QA_OUTPUT ?? resolve(ROOT, '../artifacts/mobile-chat'));
const ORIGIN = process.env.CAUCE_QA_ORIGIN ?? 'http://127.0.0.1:4174';
const STATES = ['seeded', 'attention', 'empty', 'keyboard', 'combined', 'combined-keyboard'];
const VIEWPORTS = [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 430, height: 932 }];
const compiled = await build({ entryPoints: [resolve(ROOT, 'src/test/mobile-chat-fixtures.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
const { mobileChatFixtures, mobileChatFailureFixtures, LONG_MOBILE_AGENT } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

function measure() {
  const box = (selector) => {
    const node = document.querySelector(selector);
    if (!node) throw new Error(`Missing ${selector}`);
    return node.getBoundingClientRect().toJSON();
  };
  const shell = box('[data-conversacion]');
  const header = box('[data-objeto-principal="hilo"] > header');
  const messages = box('[data-thread-scroll]');
  const composer = box('form[data-chat-composer]');
  const bottom = window.visualViewport.height + window.visualViewport.offsetTop;
  const visibleMessages = [...document.querySelectorAll('article[data-message-id]')].filter((node) => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > messages.top && rect.top < Math.min(messages.bottom, bottom);
  }).length;
  return {
    shell, header, messages, composer, visibleMessages, viewportBottom: bottom,
    messageRatio: messages.height / shell.height,
    overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    openTechnicalPanels: [...document.querySelectorAll('[role="dialog"], [role="menu"]')].filter((node) => node.checkVisibility()).length,
    keyboardOpen: document.querySelector('[data-conversacion]').hasAttribute('data-keyboard-open'),
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
    for (const state of STATES) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true, serviceWorkers: 'block', colorScheme: 'light' });
      const page = await context.newPage();
      const errors = [];
      const mutations = [];
      const combined = state.startsWith('combined');
      const keyboard = state.endsWith('keyboard');
      const alias = combined ? LONG_MOBILE_AGENT : 'kant';
      const fixtures = combined ? mobileChatFailureFixtures(keyboard) : mobileChatFixtures(state);
      let messageReadFails = false;
      let queueReadFails = combined;
      page.on('pageerror', (error) => { errors.push(error.message); });
      await page.route('**/v3/**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() !== 'GET') {
          mutations.push(`${request.method()} ${path}`);
          return route.abort();
        }
        if ((queueReadFails && path === '/v3/console/queues') || (messageReadFails && path === '/v3/console/messages')) {
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable', message: path.endsWith('queues') ? 'El servicio de colas no está disponible. Intentá nuevamente.' : 'El servicio de mensajes no está disponible. Intentá nuevamente.' }) });
          return;
        }
        const payload = fixtures[path];
        await route.fulfill({ status: payload ? 200 : 404, contentType: 'application/json', body: JSON.stringify(payload ?? { error: 'fixture_not_declared', path }) });
      });
      await page.goto(`${ORIGIN}/messages/Steven/${encodeURIComponent(alias)}`);
      await page.locator(`form[data-chat-composer] textarea:${state === 'combined' ? 'disabled' : 'enabled'}`).waitFor();
      if (state !== 'empty') await page.locator('article[data-message-id]').first().waitFor();
      if (combined) {
        await page.getByText('Cola sin verificar', { exact: true }).waitFor();
        await page.getByText('Lease vencido · envío en cola', { exact: true }).waitFor();
      }
      if (keyboard) {
        await page.getByRole('textbox', { name: `Mensaje para ${alias}` }).fill('Borrador conservado');
        await page.evaluate(() => {
          Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 440 });
          window.visualViewport.dispatchEvent(new Event('resize'));
        });
        await page.locator('[data-conversacion][data-keyboard-open]').waitFor();
      }
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      if (state !== 'empty' && await page.locator('article[data-message-id]').count() !== 8) throw new Error('The complete seeded conversation did not render');
      const metrics = await page.evaluate(measure);
      const failures = [];
      if (metrics.header.height > 64) failures.push('header exceeds 64px');
      // Two rows (input and toolbar) is 110px; a blocking warning above it adds one more line.
      const composerBudget = combined ? 140 : 112;
      if (metrics.composer.height > composerBudget) failures.push(`collapsed composer exceeds ${String(composerBudget)}px`);
      if (metrics.messageRatio < 0.6) failures.push('messages occupy less than 60% of app content');
      if (metrics.overflow > 0) failures.push('horizontal document overflow');
      if (state !== 'empty' && metrics.visibleMessages === 0) failures.push('no seeded message in the first viewport');
      if (metrics.composer.bottom > metrics.viewportBottom + 1) failures.push('composer extends below the visual viewport');
      if (metrics.openTechnicalPanels !== 0) failures.push('technical panels opened without intent');
      if (state === 'attention' && !(await page.getByRole('status').filter({ hasText: '1 muerta(s)' }).isVisible())) failures.push('queue warning not visible');
      if (combined && !(await page.getByRole('alert').filter({ hasText: 'Cola sin verificar' }).isVisible())) failures.push('unknown queue state not visible');
      if (combined && !(await page.getByRole('note').filter({ hasText: 'Lease vencido · envío en cola' }).isVisible())) failures.push('expired lease/enqueue state not visible');
      if (state === 'combined' && !(await page.getByText('Requiere el permiso message.publish.', { exact: false }).isVisible())) failures.push('publish permission warning not visible');
      if (state === 'empty' && !(await page.getByText(/No hay mensajes con este agente en la ventana recibida/).isVisible())) failures.push('empty conversation guidance not visible');
      failures.push(...errors, ...mutations.map((mutation) => `Unexpected mutation: ${mutation}`));
      const name = `${String(viewport.width)}x${String(viewport.height)}-${state}`;
      await page.screenshot({ path: resolve(OUTPUT, `${name}.png`), clip: { x: 0, y: 0, width: viewport.width, height: Math.min(viewport.height, metrics.viewportBottom) } });
      results.push({ name, state, viewport, metrics, failures, keyboardEvidence: keyboard ? 'Simulated visualViewport resize in Chromium; no physical OS keyboard' : undefined });
      if (combined || state === 'attention') {
        await page.getByRole('button', { name: /^Ver detalles:/ }).click();
        await page.getByRole('region', { name: 'Detalles de los avisos' }).waitFor();
        if (combined) {
          if (!(await page.getByText(/No se pudo actualizar la cola: El servicio de colas/).isVisible())) failures.push('full queue error inaccessible');
          if (!(await page.getByText(new RegExp(`El lease de ${alias} está vencido`)).isVisible())) failures.push('full lease explanation inaccessible');
          if (!(await page.getByRole('button', { name: 'Reintentar cola' }).isVisible())) failures.push('queue retry inaccessible');
        } else if (!(await page.getByRole('link', { name: 'Revisar en Colas' }).isVisible())) failures.push('queue management link inaccessible');
        await page.screenshot({ path: resolve(OUTPUT, `${name}-warnings.png`) });
        if (combined) {
          queueReadFails = false;
          await page.getByRole('button', { name: 'Reintentar cola' }).click();
          await page.getByRole('button', { name: 'Reintentar cola' }).waitFor({ state: 'detached' });
          const heading = page.getByRole('heading', { name: 'Avisos de la conversación' });
          if (!(await heading.evaluate((node) => node === document.activeElement))) failures.push('partial queue recovery did not preserve focus in the notice panel');
          if (!(await page.getByText(new RegExp(`El lease de ${alias} está vencido`)).isVisible())) failures.push('partial queue recovery hid the remaining lease warning');
          await page.screenshot({ path: resolve(OUTPUT, `${name}-queue-recovered.png`) });
        }
        await page.keyboard.press('Escape');
        if (await page.getByRole('region', { name: 'Detalles de los avisos' }).count()) failures.push('notice details did not close with Escape');
      }
      if (state === 'seeded') {
        const menu = page.getByRole('button', { name: 'Opciones de la conversación', exact: true });
        await menu.click();
        await page.getByRole('menuitem', { name: 'Perfil y contexto', exact: true }).waitFor();
        await page.screenshot({ path: resolve(OUTPUT, `${name}-menu.png`) });
        await page.keyboard.press('Escape');
        // The account lives behind «Más» on a phone: the bottom bar has no room for it.
        await page.getByRole('button', { name: 'Más', exact: true }).click();
        await page.getByRole('button', { name: 'Cuenta de Steven', exact: true }).click();
        await page.getByRole('dialog', { name: 'Cuenta y apariencia' }).waitFor();
        await page.screenshot({ path: resolve(OUTPUT, `${name}-account.png`) });
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        messageReadFails = true;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await menu.click();
          await page.getByRole('menuitem', { name: 'Sincronizar', exact: true }).click();
          await page.getByText('Historial anterior: sin actualizar', { exact: true }).waitFor();
          if (await menu.getAttribute('aria-expanded') !== 'false' || await page.getByRole('menu').count()) failures.push('the options menu stayed open after a failed synchronization');
          if (!(await menu.evaluate((node) => node === document.activeElement))) failures.push('focus did not return to the options menu after a failed synchronization');
        }
        await page.screenshot({ path: resolve(OUTPUT, `${name}-failed-sync.png`) });
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
if (results.length !== VIEWPORTS.length * STATES.length || failures.length) process.exitCode = 1;
