import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { realV4Image, currentV4TestContext, digest, type V4Image } from './v4-terminal-v4-image-real-browser.image.js';
import { packageSdk, startV4Runtime, type V4Harness } from './v4-terminal-v4-image-real-browser.runtime.js';
import { asV4Page, type V4Page } from './v4-console-real-browser.helpers.js';
import { observeUiBootstrap } from './ui-bootstrap-diagnostics.js';

const context = currentV4TestContext();
const { evidence, runId } = context;
const diagnostics = context.owner === 'h8d-regresion-tui-1025';

let image: V4Image;
let sdk: string;
beforeAll(async () => {
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const started = Date.now();
  let complete = false;
  try {
  image = await realV4Image(context);
  expect(image.id).toMatch(/^sha256:[a-f0-9]{64}$/u);
  for (const value of ['/usr/local/bin/node', '/usr/bin/tmux', '1.4.10', '2026.7.1-2']) expect(image.versions).toContain(value);
  sdk = await packageSdk(context);
  const files: Record<string, string> = {};
  for (const name of await readdir('tests/e2e')) if (name.startsWith('v4-terminal-v4-image-real-browser.')) files[`tests/e2e/${name}`] = digest(await readFile(join('tests/e2e', name)));
  for (const name of ['tests/e2e/console-functional-browser.fixtures.ts', 'tests/e2e/ui-bootstrap-network.ts', 'tests/e2e/lab-private-socket.ts',
    'tests/e2e/browser-owned-lifecycle.ts', 'tests/e2e/ui-bootstrap-diagnostics.ts', 'tests/e2e/port-reservation.ts', 'tests/e2e/docker-network-subnet.ts',
    'ops/pty-agent/cauce-pty-launcher.sh', 'ops/pty-agent/cauce_pty_agent/session_recovery.py',
    'ops/pty-agent/cauce_pty_agent/tui_environment.py', 'ops/pty-agent/cauce_pty_agent/tmux.py',
    'packages/adapter-sdk/src/bin/shared.ts', 'packages/adapter-sdk/src/shared-session/config.ts',
    'packages/adapter-sdk/src/shared-session/muse-profile.ts', 'packages/adapter-sdk/src/shared-session/types.ts',
    'packages/adapter-sdk/src/shared-session/session/readiness.ts', 'packages/adapter-sdk/src/sdk/types.ts',
    'packages/adapter-sdk/src/shared-session/session.ts']) files[name] = digest(await readFile(name));
  const visit = async (directory: string): Promise<void> => {
    for (const row of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, row.name);
      if (row.isDirectory()) await visit(path);
      else if (row.isFile() && row.name.endsWith('.ts')) files[path] = digest(await readFile(path));
    }
  };
  await visit('packages/adapter-sdk/src');
  await visit('packages/adapter-sdk/test');
  for (const name of await readdir('ops/cli')) if (name.startsWith('fleet_executor_') && name.endsWith('.py')) {
    const path = join('ops/cli', name);
    files[path] = digest(await readFile(path));
  }
  await writeFile(join(evidence, 'manifest.json'), JSON.stringify({ run_id: runId, image, files }, null, 2));
  complete = true;
  } finally {
    await writeFile(join(evidence, 'setup-process.json'), JSON.stringify({ started_at: new Date(started).toISOString(),
      elapsed_ms: Date.now() - started, exit_code: complete ? 0 : 1 }, null, 2));
  }
}, 1_800_000);
afterAll(async () => { if (sdk) await rm(dirname(dirname(sdk)), { recursive: true, force: true }); });

interface Target { tenant_id: string; alias: string; modes: string[]; pty_state: string; authorized: boolean }
async function targets(page: V4Page): Promise<Target[]> {
  return page.evaluate(async () => {
    const response = await fetch('/v3/console/terminal/targets');
    const result = await response.json() as { items?: Target[] };
    return result.items ?? [];
  });
}
function authorizationPending(text: string): boolean {
  return /Waiting for approval|Approve in your browser|Make sure your browser shows|device_code|user_code|sign in|log in|login to|authentication required|not authenticated/iu.test(text);
}
async function safeScreenshot(page: V4Page, name: string): Promise<void> {
  if (authorizationPending(await page.locator('body').innerText())) throw new Error('external authorization prompt; capture omitted');
  await page.screenshot({ path: join(evidence, name), fullPage: true });
}
function publicUrl(value: string) {
  const url = new URL(value);
  return { origin: url.origin, path: ['localhost', '127.0.0.1', '::1'].includes(url.hostname) ? url.pathname : '[external path omitted]' };
}
function vmSample() {
  const sample: Record<string, string[] | { error_type: string }> = {};
  for (const name of ['stat', 'loadavg', 'meminfo', 'pressure/cpu', 'pressure/memory', 'pressure/io']) {
    try {
      let lines = readFileSync(join('/proc', name), 'utf8').trim().split('\n');
      if (name === 'stat') lines = lines.slice(0, 1);
      if (name === 'meminfo') lines = lines.filter(line => /^(?:MemTotal|MemAvailable|Dirty|Writeback|SwapFree):/u.test(line));
      sample[name] = lines;
    } catch (error) { sample[name] = { error_type: error instanceof Error ? error.name : 'unknown' }; }
  }
  return sample;
}
function observePage(page: V4Page, harness: string, width: number) {
  let phase = 'page-created';
  const record = (event: string, fields: Record<string, unknown> = {}) => {
    if (diagnostics) appendFileSync(join(evidence, `${harness}-${String(width)}-browser.jsonl`),
      JSON.stringify({ at: new Date().toISOString(), phase, event, ...fields }) + '\n', { mode: 0o600 });
  };
  if (diagnostics) {
    observeUiBootstrap(page);
    for (const event of ['request', 'requestfinished', 'requestfailed']) page.on(event, (value: unknown) => {
      const request = value as { url(): string; method(): string; resourceType(): string; failure(): { errorText: string } | null };
      record(event, { ...publicUrl(request.url()), method: request.method(), resource_type: request.resourceType(),
        ...(event === 'requestfailed' ? { code: request.failure()?.errorText.match(/net::ERR_[A-Z_]+/u)?.[0] ?? 'unknown' } : {}) });
    });
    page.on('response', (value: unknown) => {
      const response = value as { url(): string; status(): number };
      record('response', { ...publicUrl(response.url()), status: response.status() });
    });
    for (const event of ['domcontentloaded', 'load', 'crash', 'close']) page.on(event, () => { record(event); });
  }
  return { record, mark: (name: string) => { phase = name; record('phase', diagnostics ? { vm: vmSample() } : {}); } };
}
async function navigate(page: V4Page, url: string, trace: ReturnType<typeof observePage>, phase: string) {
  trace.mark(phase);
  const started = performance.now();
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    trace.record('navigation-finished', { ...publicUrl(url), status: response?.status(), elapsed_ms: performance.now() - started });
  } catch (error) {
    trace.record('navigation-failed', { ...publicUrl(url), error_type: error instanceof Error ? error.name : 'unknown', elapsed_ms: performance.now() - started,
      ...(diagnostics ? { vm: vmSample() } : {}) });
    throw error;
  }
}

describe.sequential('TUI del launcher real con adaptador e imagen V4 reales', () => {
  it.each<V4Harness>(['openclaw', 'muse', 'grok'])('%s publica harness y abre la TUI nativa en Chromium', async harness => {
    const started = Date.now();
    let passed = false;
    try {
    const runtime = await startV4Runtime(image, sdk, harness, { context, diagnostics });
    try {
      if (harness === 'openclaw') {
        expect(runtime.binding.openclaw_help?.measured).toMatchObject({ exit: 0, session_flag: true, history_limit_flag: true, local_flag: true });
        expect(runtime.binding.openclaw_help?.legacy).toMatchObject({ exit: 1, session_flag: false, history_limit_flag: false, local_flag: false });
      }
      for (const width of [1440, 390]) {
        const page = asV4Page(await runtime.page(width));
        const trace = observePage(page, harness, width);
        try {
          await navigate(page, runtime.baseUrl, trace, 'initial-navigation');
          trace.mark('console-login');
          await page.getByLabel('Correo', { exact: true }).fill(runtime.email);
          await page.getByLabel('Contraseña', { exact: true }).fill(runtime.password);
          await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
          await expect.poll(async () => (await page.context().cookies(runtime.baseUrl)).some(cookie => cookie.name === '__Host-cauce_session'), { timeout: 30_000 }).toBe(true);
          trace.mark('terminal-target-publication');
          await expect.poll(async () => {
            const target = (await targets(page)).find(row => row.tenant_id === 'Steven' && row.alias === runtime.alias);
            return target?.pty_state === 'online' && target.authorized && target.modes.includes('harness') && target.modes.includes('shell');
          }, { timeout: 45_000 }).toBe(true);
          await navigate(page, `${runtime.baseUrl}/terminal/Steven/${runtime.alias}?modo=tui`, trace, 'terminal-navigation');
          trace.mark('terminal-attachment');
          await page.locator('[data-pty-shell][data-state="open"]').waitFor({ timeout: 30_000 });
          const sessionId = await page.locator('[data-session-id]').evaluate(element => element.getAttribute('data-session-id') ?? '');
          const text = () => page.locator('.xterm-rows').innerText();
          if (harness === 'openclaw') {
            await expect.poll(text, { timeout: 90_000 }).toContain('CAUCE-CANARY-EXISTING-HISTORY');
            await expect.poll(text, { timeout: 30_000 }).toMatch(/local ready/iu);
            if (width === 1440) expect(await text()).toContain(`session agent:${runtime.key}:canary`);
          } else {
            await expect.poll(text, { timeout: 30_000 }).toMatch(harness === 'muse' ? /Muse/iu : /│\s*❯/u);
            const native = await runtime.capture();
            expect(authorizationPending(native)).toBe(false);
            if (harness === 'muse') expect(native).toMatch(/echo/iu);
            else {
              expect(native).toMatch(/│\s*❯/u);
              expect(native).toMatch(/canary/iu);
              expect(native).toMatch(/Ctrl\+x:shortcuts/iu);
              expect(native).not.toMatch(/fatal error|authentication failed|failed to initialize/iu);
            }
            await writeFile(join(evidence, `${harness}-${String(width)}-native.txt`), native);
          }
          expect(authorizationPending(await text())).toBe(false);
          const observation = await runtime.observe();
          expect(observation).toEqual({ id: runtime.binding.container_id, image: image.id, started_at: runtime.binding.started_at, read_only: true });
          const nativeProcesses = await runtime.nativeProcesses();
          await writeFile(join(evidence, `${harness}-${String(width)}-processes.json`), JSON.stringify(nativeProcesses, null, 2));
          expect(nativeProcesses.length).toBeGreaterThan(0);
          expect(nativeProcesses.every(row => row.uid === 1000 && row.profile_matches)).toBe(true);
          if (harness === 'openclaw') expect(nativeProcesses.some(row => row.comm === 'openclaw-tui')).toBe(true);
          const sessions = await runtime.database.pool.query<{ mode: string }>('SELECT mode FROM terminal_sessions WHERE id=$1', [sessionId]);
          expect(sessions.rows[0]?.mode).toBe('harness');
          const deliveries = await runtime.database.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM deliveries');
          expect(deliveries.rows[0]?.count).toBe('0');
          await safeScreenshot(page, `${harness}-${String(width)}-tui.png`);
          const markers = harness === 'openclaw' ? undefined : await runtime.tmuxMarkers();
          if (markers) expect(markers).toEqual({ alias: runtime.key, harness, window: 'agente', dead: '0' });
          await writeFile(join(evidence, `${harness}-${String(width)}.json`), JSON.stringify({ harness, width, markers,
            binding: runtime.binding, observation, native_processes: nativeProcesses, targets: await targets(page), session_id: sessionId, mode: 'harness', deliveries: 0, inference: false }, null, 2));
          await page.getByRole('button', { name: 'Más acciones', exact: true }).click();
          await page.getByRole('menuitem', { name: 'Cerrar sesión PTY', exact: true }).click();
          await expect.poll(async () => (await runtime.database.pool.query<{ closed: boolean }>('SELECT closed_at IS NOT NULL AS closed FROM terminal_sessions WHERE id=$1', [sessionId])).rows[0]?.closed,
            { timeout: 15_000 }).toBe(true);
        } catch (error) {
          trace.record('test-failed', { error_type: error instanceof Error ? error.name : 'unknown' });
          if (diagnostics) await runtime.diagnoseBrowser(width).catch(() => undefined);
          await safeScreenshot(page, `${harness}-${String(width)}-failed.png`).catch(() => undefined);
          await writeFile(join(evidence, `${harness}-launcher.log`), runtime.launcherLog());
          await writeFile(join(evidence, `${harness}-adapter.log`), await runtime.adapterLog());
          throw error;
        } finally { await page.context().close(); }
      }
    } finally {
      try {
        await writeFile(join(evidence, `${harness}-launcher.log`), runtime.launcherLog());
        await writeFile(join(evidence, `${harness}-adapter.log`), await runtime.adapterLog());
      } finally { await runtime.close(); }
    }
    passed = true;
    } finally {
      await writeFile(join(evidence, `${harness}-test-process.json`), JSON.stringify({ started_at: new Date(started).toISOString(),
        elapsed_ms: Date.now() - started, exit_code: passed ? 0 : 1 }, null, 2));
    }
  }, 600_000);
});
