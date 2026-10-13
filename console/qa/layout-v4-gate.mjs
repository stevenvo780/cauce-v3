import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startLayoutDevServer } from './layout-dev-server.mjs';
import { loadV4Fixtures } from './layout-v4-fixtures.mjs';
import { absoluteFailures, measureV4Layout } from './layout-v4-measure.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = resolve(HERE, 'layout-v4-baseline.json');
const REFERENCES = resolve(HERE, 'layout-v4-references');
const OUTPUT = resolve(HERE, '.test-state/layout-v4');
const CONTEXT = '/messages/Steven/jarvis?view=context';
export const V4_VIEWS = [
  { id: 'my-quotas', path: '/my-quotas', ready: 'section[aria-label="Tarjetas de Mis cuotas"] article', count: 2,
    texts: ['Consumo compartido por 2 agentes', 'Claude de coordinación'] },
  { id: 'office-plan', path: '/live', action: 'plan', ready: 'section[aria-label="Editar sala Steven/grp.steven"]',
    detail: 'section[aria-label="Editar sala Steven/grp.steven"]', texts: ['Partes de la sala'] },
  { id: 'campus', path: '/live', ready: 'main [data-objeto-principal="oficina"] canvas', campus: true },
  { id: 'computers', path: '/config?seccion=computadoras', ready: 'article[aria-labelledby^="computadora-"]', count: 2,
    texts: ['Ejecutor listo', 'Identidad confirmada; falta preparar el ejecutor'] },
  { id: 'companies', path: '/config?seccion=general', scenario: 'platform', ready: 'main li:visible',
    texts: ['Humanizar (demo)', 'Praxis (demo)'] },
  { id: 'company-admins', path: '/config?seccion=general', scenario: 'platform', action: 'admins',
    ready: 'section[aria-label="Autoridad de empresa"]', texts: ['Dueños y administradores', 'Steven (QA)', 'Andrea (QA)'] },
  { id: 'people', path: '/config?seccion=acceso', action: 'people',
    ready: 'section[aria-label="Administración de personas"] tbody tr', count: 3, texts: ['Personas y acceso web'] },
  { id: 'agent-profile', path: `${CONTEXT}&tab=perfil`, ready: 'main section[aria-label="Perfil y contexto de jarvis"] textarea' },
  { id: 'agent-history', path: `${CONTEXT}&tab=historial`, ready: 'main li[data-clase]', count: 2,
    texts: ['Steven/kant', 'Steven/zeus'] },
  { id: 'context-versions', path: `${CONTEXT}&tab=versiones`, ready: 'section[aria-label="Historial de versiones"] li', count: 2,
    detail: 'section[aria-label="Historial de versiones"]', texts: ['Steven (QA)', 'jarvis'] },
  { id: 'company-retired', path: '/messages', scenario: 'retired', ready: 'main [role="alert"]', texts: ['Tu empresa fue retirada'] },
  { id: 'registration', path: '/messages', scenario: 'register', action: 'register',
    ready: 'form[aria-label="Registro de persona y empresa"]', texts: ['Crea tu empresa en Cauce'] },
];

async function prepare(page, view) {
  if (view.action === 'plan') {
    await page.locator('main [data-objeto-principal="oficina"] canvas').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
    await page.locator('section[aria-label="Sala Steven/grp.steven"]').getByRole('button').first().click();
  } else if (view.action === 'admins') {
    await page.locator('li').filter({ hasText: 'Humanizar (demo)' }).getByRole('button', { name: 'Autoridad de empresa', exact: true }).click();
  } else if (view.action === 'people') {
    await page.getByRole('button', { name: 'Administrar personas', exact: true }).click();
  } else if (view.action === 'register') {
    await page.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  }
  const ready = page.locator(view.ready);
  await ready.first().waitFor({ state: 'visible' });
  if (view.count && await ready.count() !== view.count) throw new Error(`Expected ${view.count} populated entries for ${view.id}`);
  for (const text of view.texts ?? []) await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible' });
  if (view.id === 'agent-profile' && !(await ready.first().inputValue()).trim()) throw new Error('Agent profile is empty');
  if (view.campus) {
    if (await page.getByRole('button', { name: 'Campus', exact: true }).getAttribute('aria-pressed') !== 'true') throw new Error('Campus is not active');
    const canvas = await ready.evaluate(node => ({ width: node.width, height: node.height }));
    if (!canvas.width || !canvas.height) throw new Error('Campus canvas has no pixels');
  }
  if (view.action === 'plan' && await page.getByLabel('Posición horizontal de grp.steven', { exact: true }).isDisabled()) throw new Error('Office editor is not editable');
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
    for (const element of document.querySelectorAll('main, main *')) {
      element.scrollTop = 0;
      element.scrollLeft = 0;
    }
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}

async function measureState(browser, origin, respond, width, theme, view) {
  const key = `${width}-${theme}-${view.id}`;
  const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const result = { key, width, theme, path: view.path, failures: [], errors: [], screenshots: [] };
  page.on('pageerror', error => result.errors.push(error.message));
  await context.addInitScript(theme => { localStorage.setItem('cauce.tema', theme === 'light' ? 'claro' : 'oscuro'); }, theme);
  await page.clock.setFixedTime(new Date('2026-10-12T10:00:00.000Z'));
  await context.routeWebSocket('**/*', socket => {
    const target = new URL(socket.url());
    if (target.host === new URL(origin).host && target.pathname === '/') return socket.connectToServer();
    result.errors.push(`Unexpected WebSocket: ${target.pathname}`);
    socket.close();
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const target = new URL(request.url());
    if (target.origin !== origin || request.method() !== 'GET') {
      result.errors.push(`Blocked request: ${request.method()} ${target.pathname}`);
      return route.abort();
    }
    if (!target.pathname.startsWith('/v3/')) return route.continue();
    try {
      const response = await respond(request.url(), request.method(), view.scenario ?? 'company');
      if (!response?.ok) throw new Error(`Fixture missing or failed: ${target.pathname} (${response?.status})`);
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    } catch (error) {
      result.errors.push(error.message);
      await route.abort();
    }
  });
  try {
    await page.goto(origin + view.path, { waitUntil: 'domcontentloaded' });
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    await prepare(page, view);
    result.metrics = await page.evaluate(measureV4Layout);
    result.failures.push(...absoluteFailures(result.metrics, theme));
    if (view.scenario !== 'retired' && await page.locator('main [role="alert"]').count()) {
      throw new Error(`Unexpected alert: ${await page.locator('main [role="alert"]').first().innerText()}`);
    }
    await page.screenshot({ path: resolve(OUTPUT, `${key}.png`), fullPage: true });
    result.screenshots.push(`${key}.png`);
    if (view.detail) {
      await page.locator(view.detail).scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(OUTPUT, `${key}-detail.png`), fullPage: false });
      result.screenshots.push(`${key}-detail.png`);
      result.detailMetrics = await page.evaluate(measureV4Layout);
      result.failures.push(...absoluteFailures(result.detailMetrics, theme).map(failure => `detail: ${failure}`));
    }
  } catch (error) {
    result.failures.push(`Unmeasured or invalid state: ${error.message}`);
  } finally {
    if (!result.screenshots.length) {
      try {
        await page.screenshot({ path: resolve(OUTPUT, `${key}.png`), fullPage: true });
        result.screenshots.push(`${key}.png`);
      } catch (error) { result.errors.push(`Screenshot failed: ${error.message}`); }
    }
    await context.close();
  }
  return result;
}

export async function runV4Layout({ update = false } = {}) {
  await mkdir(OUTPUT, { recursive: true });
  const report = { status: 'running', passed: false, expected: V4_VIEWS.length * 4, results: [] };
  await writeFile(resolve(OUTPUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const respond = await loadV4Fixtures();
  const server = await startLayoutDevServer({ root: resolve(HERE, '..'), viteEntry: resolve(HERE, '../node_modules/vite/bin/vite.js') });
  let browser;
  try {
    browser = await chromium.launch();
    for (const width of [390, 1440]) for (const theme of ['light', 'dark']) for (const view of V4_VIEWS) {
      const result = await measureState(browser, server.origin, respond, width, theme, view);
      report.results.push(result);
      console.log(`layout V4: ${result.key} ${result.failures.length + result.errors.length ? 'FAIL' : 'PASS'}`);
      await writeFile(resolve(OUTPUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    }
  } finally {
    await browser?.close();
    await server.close();
  }
  let base = {};
  try { base = JSON.parse(await readFile(BASELINE, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const result of report.results) {
    if (result.errors.length || result.failures.length) continue;
    const expected = base[result.key];
    if (!expected && update) {
      base[result.key] = { contentHeight: result.metrics.contentHeight, screenshots: result.screenshots };
      await mkdir(REFERENCES, { recursive: true });
      for (const screenshot of result.screenshots) await copyFile(resolve(OUTPUT, screenshot), resolve(REFERENCES, screenshot));
    } else if (!expected) result.failures.push('Missing V4 reference; run pnpm qa:layout:update --v4-only');
    else if (result.metrics.contentHeight > expected.contentHeight + 64) result.failures.push(`Content grew: ${result.metrics.contentHeight} against ${expected.contentHeight}px`);
  }
  if (update) await writeFile(BASELINE, `${JSON.stringify(base, null, 2)}\n`);
  report.status = 'finished';
  report.passed = report.results.length === report.expected && report.results.every(result => !result.failures.length && !result.errors.length);
  await writeFile(resolve(OUTPUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  for (const result of report.results) for (const failure of [...result.errors, ...result.failures]) console.error(`layout V4: ${result.key}: ${failure}`);
  console.log(`layout V4: ${report.results.filter(result => !result.failures.length && !result.errors.length).length}/${report.expected}; evidence ${OUTPUT}`);
  if (!report.passed) process.exitCode = 1;
  return report;
}
