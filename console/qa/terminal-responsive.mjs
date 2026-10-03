import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const origin = new URL(process.env.CAUCE_QA_ORIGIN ?? 'http://127.0.0.1:4198');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'This check requires a local dev:mock server');
const output = resolve(process.env.CAUCE_QA_ARTIFACTS ?? 'artifacts/terminal-responsive');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CAUCE_QA_BROWSER || undefined });
const results = [];

function measure() {
  const rect = (element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
  };
  const screen = document.querySelector('.xterm-screen');
  const box = rect(screen);
  const visible = { ...box };
  const clips = [];
  for (let parent = screen.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const bounds = rect(parent);
    if (/(hidden|auto|scroll|clip)/.test(style.overflowX)) {
      visible.left = Math.max(visible.left, bounds.left);
      visible.right = Math.min(visible.right, bounds.right);
    }
    if (/(hidden|auto|scroll|clip)/.test(style.overflowY)) {
      visible.top = Math.max(visible.top, bounds.top);
      visible.bottom = Math.min(visible.bottom, bounds.bottom);
      clips.push({ className: parent.className, ...bounds });
    }
  }
  const ratio = Math.max(0, visible.right - visible.left) * Math.max(0, visible.bottom - visible.top) / (box.width * box.height);
  const title = rect(document.querySelector('.page-title h1'));
  const eyebrow = rect(document.querySelector('.page-title > .eyebrow'));
  const overlap = Math.max(0, Math.min(title.right, eyebrow.right) - Math.max(title.left, eyebrow.left))
    * Math.max(0, Math.min(title.bottom, eyebrow.bottom) - Math.max(title.top, eyebrow.top));
  const covered = [];
  for (const x of [box.left + 2, (box.left + box.right) / 2, box.right - 2]) {
    for (const y of [box.top + 2, (box.top + box.bottom) / 2, box.bottom - 2]) {
      const hit = document.elementFromPoint(x, y);
      if (!hit || !screen.contains(hit)) covered.push({ x, y, covering: hit?.className ?? null });
    }
  }
  const header = document.querySelector('.page-header');
  const actions = [...header.querySelectorAll('button, summary')].filter(el => el.getClientRects().length);
  return {
    screen: box, visible, visibleRatio: ratio, clips, title, eyebrow, headerOverlap: overlap, covered,
    horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    headerActionOverflow: actions.map(rect).filter(r => r.left < 0 || r.right > innerWidth),
    geometry: window.__ptyFalsa.ultimaGeometria,
    narrowWarning: document.querySelector('.pty-estrecho')?.textContent ?? null,
  };
}

try {
  for (const width of [360, 900, 1440]) {
    const viewport = { width, height: width === 1440 ? 1000 : 800 };
    const context = await browser.newContext({ viewport });
    const diagnostics = { api: [], blocked: [], errors: [], console: [] };
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin.origin || url.pathname.startsWith('/v3/')) {
        diagnostics.blocked.push(url.href);
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    page.on('pageerror', error => diagnostics.errors.push(error.message));
    page.on('console', message => {
      if (['error', 'warning'].includes(message.type())) diagnostics.console.push({ type: message.type(), text: message.text() });
    });
    page.on('response', response => {
      if (new URL(response.url()).pathname.startsWith('/v3/')) diagnostics.api.push({ url: response.url(), status: response.status(), mocked: response.fromServiceWorker() });
    });
    const result = { viewport, diagnostics, failures: [] };
    results.push(result);
    try {
      await page.goto(new URL('/terminal/Steven/kant', origin).href);
      await page.getByText('MOCK API', { exact: true }).waitFor();
      await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.endsWith('/mockServiceWorker.js') && window.__ptyFalsa?.ultimaGeometria?.cols > 0);
      result.mock = await page.evaluate(() => ({ worker: navigator.serviceWorker.controller.scriptURL, fakePty: Boolean(window.__ptyFalsa) }));
      await page.locator('.xterm-screen').waitFor();
      result.beforeScroll = await page.evaluate(measure);
      await page.screenshot({ path: `${output}/${width}-initial.png` });
      await page.locator('.xterm-screen').scrollIntoViewIfNeeded();
      result.afterScroll = await page.evaluate(measure);
      await page.screenshot({ path: `${output}/${width}-terminal.png` });
      await writeFile(`${output}/${width}.aria.txt`, await page.locator('body').ariaSnapshot());
      const state = result.afterScroll;
      const checks = {
        'terminal is not clipped by ancestors': state.visibleRatio >= 0.98,
        'terminal is not covered after scrolling into view': state.covered.length === 0,
        'terminal provides at least twelve readable rows': state.geometry.rows >= 12,
        'title and subtitle do not overlap': state.headerOverlap === 0,
        'header actions fit viewport': state.headerActionOverflow.length === 0,
        'document has no horizontal overflow': state.horizontalOverflow === 0,
        'API stayed mocked': diagnostics.api.length > 0 && diagnostics.api.every(r => r.mocked && r.status < 400) && diagnostics.blocked.length === 0,
        'no page errors': diagnostics.errors.length === 0,
      };
      result.checks = checks;
      result.failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
      console.log(JSON.stringify({ width, visibleRatio: state.visibleRatio, geometry: state.geometry, failures: result.failures }));
    } catch (error) {
      result.failures.push(String(error));
    } finally {
      await context.tracing.stop({ path: `${output}/${width}-trace.zip` });
      await context.close();
    }
  }
} finally {
  await browser.close();
  await writeFile(`${output}/results.json`, JSON.stringify({ browser: browser.version(), origin: origin.origin, results }, null, 2));
}
assert.equal(results.flatMap(result => result.failures).length, 0, 'Terminal responsive regression; see results.json');
