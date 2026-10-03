import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUDGET, VIEWS, VIEWPORTS, failuresFor, viewportFailures, assertSuccessfulResponse } from './mobile-views-contract.mjs';

export function measureView(primarySelector) {
  const viewport = window.visualViewport;
  const contentTop = viewport?.offsetTop ?? 0;
  const bottom = contentTop + (viewport?.height ?? window.innerHeight);
  const nav = document.querySelector('.sidebar');
  const navBox = nav?.getBoundingClientRect();
  const contentBottom = navBox && getComputedStyle(nav).position === 'fixed' && navBox.width >= window.innerWidth - 1
    ? Math.min(bottom, navBox.top) : bottom;
  const painted = (node) => node.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const node = [...document.querySelectorAll(primarySelector)].find(painted);
  let primary = null;
  if (node) {
    const rect = node.getBoundingClientRect();
    let top = Math.max(contentTop, rect.top);
    let end = Math.min(contentBottom, rect.bottom);
    let left = Math.max(0, rect.left);
    let right = Math.min(window.innerWidth, rect.right);
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const clip = ancestor.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, clip.top); end = Math.min(end, clip.bottom); }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
    }
    primary = { top: rect.top, height: rect.height, visibleHeight: Math.max(0, end - top), visibleWidth: Math.max(0, right - left), painted: true };
  }
  const graph = document.querySelector('details.live-mapa');
  const modal = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find(painted);
  const interactionRoot = modal ?? document.querySelector('main');
  const scrolls = [interactionRoot, ...interactionRoot?.querySelectorAll('*') ?? []].filter(Boolean).filter((element) => painted(element)
    && /auto|scroll/.test(getComputedStyle(element).overflowX) && element.scrollWidth > element.clientWidth + 1);
  return {
    contentTop, contentBottom, primary,
    clientWidth: document.documentElement.clientWidth, visualWidth: viewport?.width, visualHeight: viewport?.height, visualScale: viewport?.scale,
    overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth, document.body.scrollWidth - window.innerWidth),
    graphOpen: !!graph?.open,
    graphNodes: [...document.querySelectorAll('.lhg-bot')].filter((node) => {
      const rect = node.getBoundingClientRect();
      const clip = document.querySelector('.lhg-scroll')?.getBoundingClientRect();
      return painted(node) && clip && rect.width > 0 && rect.height > 0
        && rect.bottom > Math.max(contentTop, clip.top) && rect.top < Math.min(contentBottom, clip.bottom)
        && rect.right > Math.max(0, clip.left) && rect.left < Math.min(window.innerWidth, clip.right);
    }).length,
    internalScrollWithoutKeyboard: scrolls.filter((element) => !(element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert], [hidden]'))
      && ![...element.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')].some((control) =>
        painted(control) && control.tabIndex >= 0 && !control.matches(':disabled') && !control.closest('[inert], [hidden]'))).length,
  };
}

async function resetScroll(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
    for (const element of document.querySelectorAll('main, main *')) {
      if (element.scrollTop) element.scrollTop = 0;
      if (element.scrollLeft) element.scrollLeft = 0;
    }
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}

export async function runGate() {
  const output = resolve(process.env.CAUCE_MOBILE_QA_OUTPUT ?? 'artifacts/mobile-views');
  const startedAt = new Date().toISOString();
  const results = [];
  const setupErrors = [];
  let browser;
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ startedAt, passed: false, status: 'running', results: [] }));
  try {
  const origin = process.env.CAUCE_QA_ORIGIN;
  if (!origin || process.env.CAUCE_MOBILE_VIEWS_BROWSER !== '1') throw new Error('Provide CAUCE_QA_ORIGIN for an authorized test server and CAUCE_MOBILE_VIEWS_BROWSER=1; this gate never starts a server.');
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('CAUCE_QA_ORIGIN must be a bare HTTP(S) origin without credentials');
  const { chromium } = await import('playwright');
  const { loadFixtures } = await import('./mobile-views-fixtures.mjs');
  const respond = await loadFixtures();
  browser = await chromium.launch();
    for (const viewport of VIEWPORTS) for (const colorScheme of ['light', 'dark']) for (const view of VIEWS) {
      const context = await browser.newContext({ viewport, colorScheme, reducedMotion: 'reduce', isMobile: true, hasTouch: true, serviceWorkers: 'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('requestfailed', (request) => errors.push(`Request failed: ${request.url()} ${request.failure()?.errorText}`));
      page.on('response', (response) => {
        if (response.status() >= 400) errors.push(`HTTP failure: ${response.status()} ${response.url()}`);
      });
      await context.routeWebSocket('**/*', (socket) => { errors.push(`Unexpected WebSocket: ${socket.url()}`); socket.close(); });
      await context.route('**/*', async (route) => {
        const request = route.request();
        const target = new URL(request.url());
        if (target.origin !== url.origin || request.method() !== 'GET') {
          errors.push(`Blocked request: ${request.method()} ${target.pathname}`);
          return route.abort();
        }
        if (!target.pathname.startsWith('/v3/')) return route.continue();
        try {
          const response = await respond(request.url());
          assertSuccessfulResponse(response?.status, `fixture ${target.pathname}`);
          await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      const result = { id: view.id, viewport, colorScheme, path: view.path, errors, failures: [] };
      try {
        const response = await page.goto(`${url.origin}${view.path}`, { waitUntil: 'networkidle' });
        assertSuccessfulResponse(response?.status(), view.path);
        for (const action of view.actions) {
          const control = page.getByRole(action.role, { name: action.name, exact: true });
          await control.click();
          if (action.role === 'tab') await page.waitForFunction(({ name }) => [...document.querySelectorAll('[role="tab"]')].some((node) => node.textContent.trim() === name && node.getAttribute('aria-selected') === 'true'), action);
        }
        for (const selector of view.ready ?? []) await page.locator(selector).first().waitFor({ state: 'visible' });
        await page.waitForLoadState('networkidle');
        await page.locator(view.primary).first().waitFor({ state: 'visible' });
        await resetScroll(page);
        result.metrics = await page.evaluate(measureView, view.primary);
        result.failures.push(...viewportFailures(result.metrics, viewport), ...failuresFor(result.metrics, view));
        if (view.id === 'accounts-inventario') {
          const table = page.locator('#view-panel-inventario table').first();
          await table.waitFor({ state: 'visible' });
          const inventory = await table.evaluate((node) => {
            const firstRow = node.querySelector('tbody tr');
            const box = (element) => {
              if (!element) return null;
              const rect = element.getBoundingClientRect();
              return {
                x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                painted: element.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
              };
            };
            return { table: box(node), firstRow: box(firstRow) };
          });
          result.inventory = inventory;
          if (!inventory.table?.painted || inventory.table.width <= 0 || inventory.table.height <= 0
            || !inventory.firstRow?.painted || inventory.firstRow.width <= 0 || inventory.firstRow.height <= 0) {
            throw new Error(`Inventory table or first row is not visibly rendered: ${JSON.stringify(inventory)}`);
          }
        }
        if (view.path === '/accounts') {
          const refresh = page.getByRole('button', { name: 'Actualizar', exact: true });
          result.refreshButton = await refresh.evaluate((button) => {
            const buttonBox = button.getBoundingClientRect();
            const icon = button.querySelector('svg');
            if (!icon) return { buttonPainted: false, iconPainted: false, iconFits: false, buttonInViewport: false };
            const iconBox = icon.getBoundingClientRect();
            const content = icon.getBBox();
            const [viewX, viewY, viewWidth, viewHeight] = (icon.getAttribute('viewBox') ?? '').split(/\s+/).map(Number);
            const buttonStyle = getComputedStyle(button);
            const iconStyle = getComputedStyle(icon);
            const painted = (node, style) => node.checkVisibility({ opacityProperty: true, visibilityProperty: true })
              && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
            return {
              buttonPainted: painted(button, buttonStyle) && buttonBox.width > 0 && buttonBox.height > 0,
              iconPainted: painted(icon, iconStyle) && iconBox.width > 0 && iconBox.height > 0,
              iconInsideButton: iconBox.left >= buttonBox.left - 1 && iconBox.top >= buttonBox.top - 1
                && iconBox.right <= buttonBox.right + 1 && iconBox.bottom <= buttonBox.bottom + 1,
              iconFits: content.width > 0 && content.height > 0 && viewWidth > 0 && viewHeight > 0
                && content.x >= viewX - 0.5 && content.y >= viewY - 0.5
                && content.x + content.width <= viewX + viewWidth + 0.5
                && content.y + content.height <= viewY + viewHeight + 0.5,
              buttonInViewport: buttonBox.left >= -1 && buttonBox.top >= -1
                && buttonBox.right <= window.innerWidth + 1 && buttonBox.bottom <= window.innerHeight + 1,
              buttonBox: { x: buttonBox.x, y: buttonBox.y, width: buttonBox.width, height: buttonBox.height },
              iconBox: { x: iconBox.x, y: iconBox.y, width: iconBox.width, height: iconBox.height },
              iconContent: { x: content.x, y: content.y, width: content.width, height: content.height },
            };
          });
          if (!result.refreshButton.buttonPainted || !result.refreshButton.iconPainted || !result.refreshButton.iconInsideButton
            || !result.refreshButton.iconFits || !result.refreshButton.buttonInViewport) {
            throw new Error(`Accounts refresh control is clipped or not painted: ${JSON.stringify(result.refreshButton)}`);
          }
        }
        if (view.id === 'config-agents' && viewport.width === 360 && colorScheme === 'light') {
          const search = page.getByRole('searchbox', { name: 'Buscar agente o grupo' });
          await search.fill('kant');
          await page.getByRole('button', { name: 'Abrir contexto de Steven/kant', exact: true }).click();
          await page.locator('.agent-context-panel .perfil-editor').waitFor({ state: 'visible' });
          const purpose = page.getByRole('textbox', { name: 'Propósito' });
          const editable = await purpose.isEnabled();
          if (editable) {
            const initialValue = await purpose.inputValue();
            await purpose.fill(`${initialValue} `);
            await purpose.fill(initialValue);
          }
          result.interaction = { flow: 'filter agent, open context, inspect canonical profile field', editable, submission: 'none' };
          await page.screenshot({ path: resolve(output, '360-light-config-agents-flow.png'), fullPage: false, timeout: 10000 });
        }
        if (view.id === 'live' && viewport.width === 360) {
          const capas = page.getByRole('group', { name: 'Capa del mapa' });
          const visible = await Promise.all(['Ahora', 'Permisos'].map(async (name) => {
            const box = await capas.getByRole('button', { name, exact: true }).boundingBox();
            return box !== null && box.y >= 0 && box.y + box.height <= viewport.height;
          }));
          result.layerControlsVisible = visible.every(Boolean);
          if (!result.layerControlsVisible) throw new Error('Ahora and Permisos must both be visible in the first mobile viewport');
        }
        if (viewport.width === 360 && colorScheme === 'light' && view.id === 'queues') {
          const deliveries = page.locator('#view-panel-entregas .queues-conteo');
          const before = await deliveries.textContent();
          const pending = page.getByRole('button', { name: /Pendientes/ }).first();
          await pending.click();
          if (await pending.getAttribute('aria-pressed') !== 'true') throw new Error('Pending delivery filter did not activate');
          const after = await deliveries.textContent();
          if (before === after || !after?.toLocaleLowerCase().includes('pendientes')) throw new Error('Pending filter did not update delivery table status');
          result.interaction = { flow: 'filter pending deliveries and verify table status', before, after, submission: 'none' };
          await page.screenshot({ path: resolve(output, '360-light-queues-flow.png'), fullPage: false, timeout: 10000 });
        }
        if (viewport.width === 360 && colorScheme === 'light' && view.id === 'accounts-asignaciones') {
          const form = page.locator('#view-panel-asignaciones .assignment-config-form');
          await form.getByLabel('Agente').selectOption({ label: 'Steven/kant' });
          await form.locator('label').filter({ hasText: /^Cuenta/ }).locator('select').selectOption('codex-steven');
          const labels = await form.getByLabel('Operación').locator('option').allTextContents();
          if (labels.some((label) => /alias_routing_ceiling|agent_account_binding/.test(label))) {
            throw new Error('Backend operation names are visible to operators');
          }
          const matrix = page.getByRole('group', { name: 'Matriz de techo y fallback por agente y cuenta' });
          const columns = await matrix.locator('thead th').allTextContents();
          if (!columns.some((column) => column.includes('Agente')) || columns.length < 4) {
            throw new Error(`Assignment matrix columns are missing: ${JSON.stringify(columns)}`);
          }
          const beforeScroll = await matrix.evaluate((node) => node.scrollLeft);
          await matrix.focus();
          await matrix.press('End');
          const afterScroll = await matrix.evaluate((node) => node.scrollLeft);
          if (afterScroll <= beforeScroll) throw new Error('Assignment matrix cannot be horizontally reached and scrolled by keyboard');
          const lastColumnVisible = await matrix.locator('thead th').last().evaluate((node) => {
            const box = node.getBoundingClientRect();
            const viewport = node.closest('[role="group"]')?.getBoundingClientRect();
            return !!viewport && box.left >= viewport.left - 1 && box.right <= viewport.right + 1;
          });
          if (!lastColumnVisible) throw new Error('End did not reveal the last account column');
          result.interaction = { flow: 'select agent and account; inspect assignment matrix columns and keyboard-scroll to the final account', agent: 'Steven/kant', account: 'codex-steven', columns: columns.length, keyboardScroll: afterScroll, lastColumnVisible, submission: 'none' };
          await page.screenshot({ path: resolve(output, '360-light-accounts-assignments-flow.png'), fullPage: false, timeout: 10000 });
        }
        if (view.graph) {
          const reloaded = await page.reload({ waitUntil: 'networkidle' });
          assertSuccessfulResponse(reloaded?.status(), `${view.path} reload`);
          await page.locator('.lhg-bot').first().waitFor({ state: 'attached' });
          await resetScroll(page);
          result.reloadMetrics = await page.evaluate(measureView, view.primary);
          result.failures.push(...[...viewportFailures(result.reloadMetrics, viewport), ...failuresFor(result.reloadMetrics, view)].map((failure) => `reload: ${failure}`));
        }
      } catch (error) {
        result.failures.push(`Unmeasured state: ${error.message}`);
      } finally {
        const screenshot = `${viewport.width}-${colorScheme}-${view.id}.png`;
        try {
          await page.screenshot({ path: resolve(output, screenshot), fullPage: false, timeout: 10000 });
          result.screenshot = screenshot;
        } catch (error) { result.failures.push(`Screenshot failed: ${error.message}`); }
        results.push(result);
        try { await context.close(); } catch (error) { result.failures.push(`Context close failed: ${error.message}`); }
      }
    }
  } catch (error) {
    setupErrors.push(error.message);
  } finally {
    try { await browser?.close(); } catch (error) { setupErrors.push(`Browser close failed: ${error.message}`); }
    const failed = results.some((result) => result.failures.length || result.errors.length);
    const expected = VIEWPORTS.length * 2 * VIEWS.length;
    await writeFile(resolve(output, 'report.json'), JSON.stringify({ startedAt, setupErrors, status: 'finished', evidence: 'real Chromium geometry; synthetic GET data, not production validation', budget: BUDGET, expected, measured: results.length, passed: results.length === expected && !failed && setupErrors.length === 0, results }, null, 2));
    if (failed || setupErrors.length || results.length !== expected) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runGate();
}
