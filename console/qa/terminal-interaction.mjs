// Run with: node --import tsx console/qa/terminal-interaction.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { syntheticTerminalServer } from './synthetic-terminal-server.mjs';

const output = resolve(process.env.CAUCE_QA_ARTIFACTS ?? 'artifacts/terminal-interaction');
await mkdir(output, { recursive: true });
const fixture = await syntheticTerminalServer(new URL(process.env.CAUCE_QA_ORIGIN ?? 'http://127.0.0.1:4198'));
const browser = await chromium.launch({ executablePath: process.env.CAUCE_QA_BROWSER || undefined });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
await context.addInitScript(() => { window.__qaNativeSocket = window.WebSocket; });
const report = { scope: 'Real Chromium DOM input → native local WebSocket → Python raw PTY byte recorder. Synthetic authorization only; no shell and no live gateway.', checks: [], errors: [], blocked: [] };
const check = (name, passed, details) => {
  report.checks.push({ name, passed, details });
  console.log(JSON.stringify({ name, passed, details }));
};
const waitUntil = async predicate => {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  return false;
};
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== fixture.origin || (url.pathname.startsWith('/v3/') && !url.pathname.startsWith('/v3/console/terminal/'))) {
    report.blocked.push(url.href);
    await route.abort('blockedbyclient');
  } else await route.continue();
});
await context.tracing.start({ screenshots: true, snapshots: true });
const page = await context.newPage();
page.on('pageerror', error => report.errors.push(error.message));
const focus = () => page.evaluate(() => ({ tag: document.activeElement?.tagName, className: document.activeElement?.className }));
const terminal = () => page.locator('.xterm-screen');
const key = async (session, name, expected, action) => {
  const before = session.frames.filter(frame => frame.type === 'input').length;
  const outputOffset = session.output.length;
  await (action ? action() : page.keyboard.press(name));
  await waitUntil(() => session.frames.filter(frame => frame.type === 'input').length > before);
  const data = session.frames.filter(frame => frame.type === 'input').slice(before).map(frame => frame.data).join('');
  const hex = Buffer.from(expected).toString('hex');
  const effect = await waitUntil(() => session.output.subarray(outputOffset).toString().includes(`KEY ${hex}`));
  check(name, data === expected && effect, { expectedHex: hex, receivedHex: Buffer.from(data).toString('hex'), ptyEffect: effect, focus: await focus() });
};
try {
  await page.goto(`${fixture.origin}/messages/Steven/argos`);
  await page.getByText('MOCK API', { exact: true }).waitFor();
  await page.evaluate(async () => {
    const { worker } = await import('/src/mocks/browser.ts');
    const { http, passthrough } = await import('/node_modules/.vite/deps/msw.js');
    worker.use(http.all('*/v3/console/terminal/*', () => passthrough()));
    window.WebSocket = window.__qaNativeSocket;
    history.pushState({}, '', '/terminal/Steven/kant');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await terminal().waitFor();
  // The TUI opens in the writable mode straight away, and stays read-only until the keyboard is taken.
  assert(await waitUntil(() => [...fixture.sessions.values()].some(session => session.grant.target.mode === 'harness_rw')), 'the writable TUI session was never requested');
  const writable = [...fixture.sessions.values()].find(session => session.grant.target.mode === 'harness_rw');
  const readonly = writable;
  await waitUntil(() => readonly.output.length > 0);
  await terminal().click();
  await page.keyboard.press('ArrowDown');
  const readonlyResizes = readonly.frames.filter(frame => frame.type === 'resize').length;
  await page.setViewportSize({ width: 1440, height: 1100 });
  await new Promise(resolve => setTimeout(resolve, 100));
  check('readonly DOM key sends no input', !readonly.frames.some(frame => frame.type === 'input'));
  check('readonly resize does not resize remote PTY', readonly.frames.filter(frame => frame.type === 'resize').length === readonlyResizes);
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Attaching takes the keyboard by itself; the fixture answers «agent busy» once, so the retry is explicit.
  await page.getByRole('button', { name: 'Reintentar la toma', exact: true }).waitFor();
  await waitUntil(() => writable.output.length > 0);
  await page.getByRole('button', { name: 'Reintentar la toma', exact: true }).click();
  await page.locator('[data-sostenido]').waitFor();
  await key(writable, 'ArrowDown after explicit retry without clicking terminal', '\x1b[B', () => page.keyboard.press('ArrowDown'));
  check('retry reuses ready session', [...fixture.sessions.values()].filter(session => session.grant.target.mode === 'harness_rw').length === 1);
  // Continue coverage even when the focus regression above fails; this click is recorded separately.
  await terminal().click();
  for (const [name, bytes] of [['ArrowUp', '\x1b[A'], ['ArrowDown', '\x1b[B'], ['ArrowLeft', '\x1b[D'], ['ArrowRight', '\x1b[C'], ['Enter', '\r'], ['Escape', '\x1b'], ['Control+c', '\x03'], ['Control+l', '\x0c'], ['Control+u', '\x15']]) await key(writable, name, bytes);
  await page.evaluate(() => navigator.clipboard.writeText('synthetic-paste'));
  await key(writable, 'browser clipboard paste (Ctrl+Shift+V)', 'synthetic-paste', () => page.keyboard.press('Control+Shift+v'));
  const cdp = await context.newCDPSession(page);
  await key(writable, 'Blink IME composition (not an OS IME)', 'á漢', async () => {
    await cdp.send('Input.imeSetComposition', { text: 'á漢', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: 'á漢' });
  });
  const previousRows = writable.frames.filter(frame => frame.type === 'resize').at(-1)?.rows;
  await page.setViewportSize({ width: 1440, height: 1200 });
  await waitUntil(() => writable.frames.filter(frame => frame.type === 'resize').at(-1)?.rows !== previousRows);
  const resized = writable.frames.filter(frame => frame.type === 'resize').at(-1);
  check('writable resize reaches PTY ioctl', await waitUntil(() => writable.output.toString().includes(`RESIZE ${resized.cols} ${resized.rows}`)), resized);
  fixture.scenario.refuseOnce = true;
  const refusedOffset = writable.output.length;
  await page.keyboard.press('F2');
  await page.getByText(/El relay rechazó|entrada.*rechaz|no.*control/i).first().waitFor();
  await new Promise(resolve => setTimeout(resolve, 150));
  check('refused batch has no PTY effect', !writable.output.subarray(refusedOffset).toString().includes('KEY'));
  await key(writable, 'output and later accepted input continue', 'z', () => page.keyboard.press('z'));
  fixture.scenario.readyDelay = 700;
  writable.socket.terminate();
  await waitUntil(() => fixture.journal.some(event => event.ws?.type === 'resume'));
  const reconnectOffset = writable.output.length;
  const reconnectInputCount = writable.frames.filter(frame => frame.type === 'input').length;
  await page.keyboard.press('F3');
  await waitUntil(() => writable.epoch === 2);
  await new Promise(resolve => setTimeout(resolve, 800));
  fixture.scenario.readyDelay = 0;
  check('keys during resume are discarded, not sent or replayed', writable.frames.filter(frame => frame.type === 'input').length === reconnectInputCount && !writable.output.subarray(reconnectOffset).toString().includes('KEY 1b4f52'));
  await key(writable, 'key after reconnect', 'r', () => page.keyboard.press('r'));
  check('reconnect resumes without ticket replay', fixture.journal.filter(event => event.ws?.session_id === writable.grant.session_id && event.ws.type === 'attach').length === 1 && fixture.journal.some(event => event.ws?.type === 'resume'));
  await writeFile(`${output}/before-tab.aria.txt`, await page.locator('body').ariaSnapshot());
  await page.screenshot({ path: `${output}/writable.png` });
  // Switching real fleet selection unmounts SessionStage and must release the hold.
  await page.getByRole('link', { name: /^argos/ }).click();
  await waitUntil(() => !writable.held);
  check('switching agent explicitly releases hold', !writable.held);
  const search = page.getByRole('searchbox', { name: 'Buscar agente', exact: true });
  await search.focus();
  const epochBeforeHiddenResume = writable.epoch;
  writable.socket.terminate();
  await waitUntil(() => writable.epoch > epochBeforeHiddenResume);
  await new Promise(resolve => setTimeout(resolve, 150));
  check('hidden reconnect does not steal search focus', await search.evaluate(element => element === document.activeElement));
  await page.getByRole('link', { name: /^kant/ }).click();
  // Opening an agent again asks for a new session and takes the keyboard on its own, with its audit.
  await page.locator('[data-sostenido]').waitFor();
  const reopened = [...fixture.sessions.values()].filter(session => session.grant.target.mode === 'harness_rw').at(-1);
  check('return reopens the TUI and takes the keyboard on its own', reopened !== writable && reopened.held);
  await terminal().click();
  await key(reopened, 'key after automatic reacquisition', 't', () => page.keyboard.press('t'));
  await page.getByRole('button', { name: 'Devolver el control', exact: true }).click();
  await waitUntil(() => !reopened.held);
  check('giving the keyboard back releases the hold', !reopened.held);
  fixture.scenario.disabled = true;
  await page.getByRole('button', { name: 'Tomar el control', exact: true }).click();
  await page.getByText('La escritura sobre la TUI está apagada en este gateway', { exact: true }).waitFor();
  check('disabled switch has explicit reason and grants no control', !reopened.held);
  check('disabled switch does not offer retry', await page.getByRole('button', { name: 'Reintentar la toma', exact: true }).count() === 0);
  check('disabled switch action is unavailable', await page.getByRole('button', { name: 'Escritura no disponible', exact: true }).isDisabled());
  await page.screenshot({ path: `${output}/disabled.png` });
  await page.getByRole('link', { name: /^argos/ }).click();
  const takesBeforeDenial = fixture.journal.filter(event => event.path?.endsWith('/control') && event.body.action === 'take').length;
  // Opening argos asks for a writable session on its own; the gateway refuses it, and says why.
  await page.getByText('La escritura sobre la TUI está apagada en este gateway', { exact: true }).waitFor();
  check('disabled session admission explains the actual reason and offers neither a take nor a retry', await page.getByRole('button', { name: /Tomar el control|Reintentar la toma/ }).count() === 0 && await page.locator('[data-sostenido]').count() === 0);
  check('denied admission never posts control take', fixture.journal.filter(event => event.path?.endsWith('/control') && event.body.action === 'take').length === takesBeforeDenial);
  check('refused batch never reappears in PTY output', !writable.output.toString().includes('KEY 1b4f51'));
  await page.screenshot({ path: `${output}/disabled-admission.png` });
} catch (error) {
  report.errors.push(String(error));
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => undefined);
  await writeFile(`${output}/failure.aria.txt`, await page.locator('body').ariaSnapshot()).catch(() => undefined);
} finally {
  report.journal = fixture.journal;
  report.sessions = [...fixture.sessions.values()].map(session => ({ mode: session.grant.target.mode, frames: session.frames, output: session.output.toString(), epoch: session.epoch }));
  await context.tracing.stop({ path: `${output}/trace.zip` });
  await browser.close();
  fixture.close();
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2));
}
assert(report.errors.length === 0 && report.blocked.length === 0 && report.checks.every(item => item.passed), 'Synthetic browser/PTY regression; see results.json');
