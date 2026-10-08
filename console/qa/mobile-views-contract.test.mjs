// @vitest-environment node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import { BUDGET, VIEWS, VIEWPORTS, failuresFor, viewportFailures, assertSuccessfulResponse } from './mobile-views-contract.mjs';
import { loadFixtures } from './mobile-views-fixtures.mjs';

const good = () => ({ overflow: 0, contentTop: 0, contentBottom: 736, primary: { top: 220, height: 300, visibleHeight: 300, visibleWidth: 360, painted: true }, officeCanvas: true, internalScrollWithoutKeyboard: 0 });
test('absolute budget rejects below-fold allowance and missing objects', () => {
  assert.deepEqual(failuresFor(good(), {}), []);
  for (const top of [737, 1583]) assert.ok(failuresFor({ ...good(), primary: { ...good().primary, top, visibleHeight: 0 } }, {}).length);
  for (const primary of [null, { ...good().primary, painted: false }]) assert.ok(failuresFor({ ...good(), primary }, {}).length);
  assert.equal(BUDGET.maxPrimaryTopRatio, 0.5);
});
test('overflow, clipping and inaccessible internal scroll fail independently', () => {
  assert.ok(failuresFor({ ...good(), overflow: 1 }, {}).includes('document overflow'));
  assert.ok(failuresFor({ ...good(), internalScrollWithoutKeyboard: 1 }, {}).length);
  for (const primary of [{ ...good().primary, visibleWidth: 0 }, { ...good().primary, visibleHeight: 20 }, { ...good().primary, height: 0 }]) assert.ok(failuresFor({ ...good(), primary }, {}).length);
  assert.deepEqual(failuresFor({ ...good(), primary: { ...good().primary, height: 44, visibleHeight: 44 } }, {}), []);
});
test('the office must be painted on arrival', () => {
  assert.ok(failuresFor({ ...good(), officeCanvas: false }, { office: true }).includes('office must be painted on arrival'));
  assert.deepEqual(failuresFor({ ...good(), officeCanvas: false }, {}), []);
  assert.deepEqual(failuresFor(good(), { office: true }), []);
});
test('matrix covers mobile widths, unique states and every nested tab', () => {
  assert.deepEqual(VIEWPORTS.map(({ width }) => width), [360, 390, 430, 760]);
  assert.equal(new Set(VIEWS.map(({ id }) => id)).size, VIEWS.length);
  for (const [path, count] of [['/accounts', 3], ['/config', 6], ['/observability', 2]]) assert.equal(VIEWS.filter((view) => view.path === path).length, count);
  assert.equal(VIEWS.filter((view) => view.id.startsWith('live')).length, 2);
  assert.ok(VIEWS.every(({ primary }) => primary && primary !== '[data-objeto-principal]'));
});
test('every settings section is reached through its own tab and renders the active panel', async () => {
  const views = VIEWS.filter(({ id }) => id.startsWith('config-'));
  assert.equal(views.length, 6);
  assert.ok(views.every(({ primary, actions }) => primary === 'main [role="tabpanel"]'
    && actions.length === 1 && actions[0].role === 'tab'));
  const source = await readFile(new URL('../src/features/config/sections.ts', import.meta.url), 'utf8');
  for (const { actions: [area] } of views) assert.ok(source.includes(`label: '${area.name}'`), area.name);
});
test('tab names agree with source, without claiming mounted UI', async () => {
  for (const [file, path] of [['accounts/AccountsPage.tsx', '/accounts'], ['observability/ObservabilityPage.tsx', '/observability'], ['config/sections.ts', '/config']]) {
    const source = await readFile(new URL(`../src/features/${file}`, import.meta.url), 'utf8');
    for (const action of VIEWS.filter((view) => view.path === path).flatMap(({ actions }) => actions).filter(({ role }) => role === 'tab')) assert.ok(source.includes(`label: '${action.name}'`), action.name);
  }
});
test('structural selectors still exist in the source that draws them', async () => {
  const read = async (file) => readFile(new URL(`../src/features/${file}`, import.meta.url), 'utf8');
  assert.ok((await read('messages/MessagesPage.tsx')).includes('aria-label="Conversaciones"'));
  assert.ok((await read('messages/ConversationPane.tsx')).includes('data-objeto-principal="hilo"'));
  assert.ok((await read('messages/ConversationPane.tsx')).includes('data-thread-scroll'));
  assert.ok((await read('messages/AgentSettingsView.tsx')).includes('aria-label={`Perfil y contexto de ${alias}`}'));
  assert.ok((await read('live/LiveFleetPage.tsx')).includes('data-objeto-principal="oficina"'));
  assert.ok((await read('terminal/OperatorWorkspace.tsx')).includes('data-objeto-principal="escenario"'));
  assert.ok((await read('terminal/TerminalHome.tsx')).includes('Elegí un agente en la barra lateral'));
  assert.ok((await readFile(new URL('../src/shell/AgentList.tsx', import.meta.url), 'utf8')).includes('aria-label="Agentes"'));
});
test('reused GET fixtures cover subviews and reject mutations/undeclared endpoints', async () => {
  const respond = await loadFixtures();
  for (const path of ['auth/session', 'console/access', 'status', 'console/topology', 'console/activity', 'console/messages', 'console/queues', 'console/dlq', 'console/quotas', 'console/config', 'console/observability', 'console/origin-relays', 'console/audit', 'console/tenants/Steven/agents/kant/perfil', 'console/tenants/Steven/agents/kant/documents']) {
    const response = await respond(`https://fixture.invalid/v3/${path}`);
    assert.equal(response?.status, 200, path);
    assert.ok(await response.json());
  }
  const config = await (await respond('https://fixture.invalid/v3/console/config')).json();
  assert.equal(config.mobile_qa_collection.length, 1);
  assert.equal(await respond('https://fixture.invalid/v3/undeclared'), undefined);
  await assert.rejects(respond('https://fixture.invalid/v3/console/config/changes', 'POST'), /Mutation blocked/);
});

test('HTTP failures and missing navigation/fixture responses cannot pass', () => {
  assert.doesNotThrow(() => assertSuccessfulResponse(200, 'fixture'));
  for (const status of [undefined, null, 0, 301, 404, 500, NaN]) assert.throws(() => assertSuccessfulResponse(status, 'fixture'), /Unsuccessful response/);
});
test('mobile viewport rejects a desktop layout viewport and mismatched scale', () => {
  const viewport = { width: 360, height: 800 };
  const metrics = { clientWidth: 360, visualWidth: 360, visualHeight: 800, visualScale: 1 };
  assert.deepEqual(viewportFailures(metrics, viewport), []);
  for (const change of [{ clientWidth: 980 }, { visualWidth: 980 }, { visualHeight: 1000 }, { visualScale: 0.36 }, { visualWidth: undefined }]) assert.ok(viewportFailures({ ...metrics, ...change }, viewport).length);
});
test('the agent sheet waits for its populated header instead of the dialog wrapper', () => {
  const view = VIEWS.find(({ id }) => id === 'live-sheet');
  assert.equal(view.primary, '[role="dialog"]');
  assert.deepEqual(view.ready, ['[role="dialog"] h2']);
});
test('live fixture actually supplies deliveries, capabilities, a verified profile and files', async () => {
  const respond = await loadFixtures();
  const read = async (path) => (await respond(`https://fixture.invalid/v3/${path}`)).json();
  const activity = await read('console/activity');
  assert.ok(activity.agents.find(({ alias }) => alias === 'kant').in_flight_items.length);
  const status = await read('status');
  assert.ok(status.presence.find(({ alias }) => alias === 'kant').capabilities.length);
  const profile = await read('console/tenants/Steven/agents/kant/perfil');
  assert.ok(profile.perfil.purpose);
  assert.equal(profile.publicado, true);
  assert.equal(profile.runtime_state, 'applied');
  assert.equal(profile.revision, profile.applied_revision);
  const documents = await read('console/tenants/Steven/agents/kant/documents');
  assert.ok(documents.items.length);
});

test('conversation context also requires a loaded profile editor', () => {
  const view = VIEWS.find(({ id }) => id === 'conversation-context');
  assert.equal(view.primary, 'section[aria-label^="Perfil y contexto"] [role="tabpanel"]');
  assert.deepEqual(view.ready, ['section[aria-label^="Perfil y contexto"] textarea', 'section[aria-label^="Perfil y contexto"] [role="tab"]']);
});

test('account inventory and queue triage selectors point at real operator surfaces', async () => {
  assert.equal(VIEWS.find(({ id }) => id === 'accounts-inventario').primary, '#view-panel-inventario');
  assert.equal(VIEWS.find(({ id }) => id === 'queues').primary, '#view-panel-entregas tbody tr');
  const gate = await readFile(new URL('./mobile-views-gate.mjs', import.meta.url), 'utf8');
  assert.ok(gate.includes("view.id === 'accounts-inventario'"));
  assert.ok(gate.includes("page.locator('#view-panel-inventario table').first()"));
  assert.ok(gate.includes('inventory.firstRow?.painted'));
  const ui = await readFile(new URL('../src/components/ui.tsx', import.meta.url), 'utf8');
  assert.ok(ui.includes('view-panel-'));
  assert.ok(ui.includes('view-tab-'));
});

test('the operator-facing refresh control preserves its loading announcement', async () => {
  const accounts = await readFile(new URL('../src/features/accounts/AccountsPage.tsx', import.meta.url), 'utf8');
  assert.ok(accounts.includes('<RefreshButton'));
  const ui = await readFile(new URL('../src/components/ui.tsx', import.meta.url), 'utf8');
  assert.ok(ui.includes("const label = loading ? 'Actualizando…' : 'Actualizar'"));
  assert.ok(ui.includes("...(compact ? { 'aria-label': label, title: label } : {})"));
});

test('keyboard scan is scoped to the active modal, preserving inert checks inside it', async () => {
  const source = await readFile(new URL('./mobile-views-gate.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("document.querySelectorAll('[role=\"dialog\"]')"));
  assert.ok(source.includes("const interactionRoot = modal ?? document.querySelector('main')"));
  assert.ok(source.includes("interactionRoot?.querySelectorAll('*')"));
  assert.ok(source.includes("!element.closest('[inert], [hidden]')"));
  assert.ok(source.includes("!control.closest('[inert], [hidden]')"));
});

test('the gate measures the bottom bar and the office canvas of the current shell', async () => {
  const source = await readFile(new URL('./mobile-views-gate.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('nav[aria-label="Navegación principal"]'));
  assert.ok(source.includes('[data-objeto-principal="oficina"] canvas'));
  for (const retired of ['.sidebar', '.lhg-', '.messenger-', '.agent-drawer', '.ultimate-terminal']) {
    assert.ok(!source.includes(retired), `${retired} belongs to the retired DOM`);
  }
});
