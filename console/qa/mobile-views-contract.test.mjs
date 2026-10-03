import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BUDGET, VIEWS, VIEWPORTS, failuresFor, viewportFailures, assertSuccessfulResponse } from './mobile-views-contract.mjs';
import { loadFixtures } from './mobile-views-fixtures.mjs';

const good = () => ({ overflow: 0, contentTop: 0, contentBottom: 736, primary: { top: 220, height: 300, visibleHeight: 300, visibleWidth: 360, painted: true }, graphOpen: true, graphNodes: 4, internalScrollWithoutKeyboard: 0 });
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
test('graph must be open and populated on arrival', () => {
  for (const override of [{ graphOpen: false }, { graphNodes: 0 }]) assert.ok(failuresFor({ ...good(), ...override }, { graph: true }).length);
});
test('matrix covers mobile widths, unique states and every nested tab', () => {
  assert.deepEqual(VIEWPORTS.map(({ width }) => width), [360, 390, 430, 760]);
  assert.equal(new Set(VIEWS.map(({ id }) => id)).size, VIEWS.length);
  for (const [path, count] of [['/accounts', 3], ['/config', 7], ['/observability', 2]]) assert.equal(VIEWS.filter((view) => view.path === path).length, count);
  assert.equal(VIEWS.filter((view) => view.id.startsWith('live-')).length, 5);
  assert.ok(VIEWS.every(({ primary }) => primary && primary !== '[data-objeto-principal]'));
});
test('tab names and selectors agree with source, without claiming mounted UI', async () => {
  for (const [file, path] of [['accounts/AccountsPage.tsx', '/accounts'], ['observability/ObservabilityPage.tsx', '/observability'], ['config/areas.ts', '/config'], ['live/AgentDrawer.tsx', '/live?agente=Steven%2Fkant&pestana=ahora']]) {
    const source = await readFile(new URL(`../src/features/${file}`, import.meta.url), 'utf8');
    for (const action of VIEWS.filter((view) => view.path === path).flatMap(({ actions }) => actions).filter(({ role }) => role === 'tab')) assert.ok(source.includes(`label: '${action.name}'`), action.name);
  }
  for (const [file, selector] of [['messages/AgentRoster.tsx', 'messenger-agent'], ['live/LiveHypergraph.tsx', 'lhg-scroll'], ['config/ConfigPage.tsx', 'config-area'], ['config/AgentSettings.tsx', 'settings-agent'], ['accounts/ConsumptionSection.tsx', 'quota-provider'], ['audit/AuditPanel.tsx', 'audit-row']]) assert.ok((await readFile(new URL(`../src/features/${file}`, import.meta.url), 'utf8')).includes(selector));
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
test('each live tab waits for populated content instead of a loading/error wrapper', () => {
  for (const view of VIEWS.filter(({ id }) => id.startsWith('live-'))) {
    assert.notEqual(view.primary, '.agent-drawer-body');
    assert.ok(view.ready.length > 0);
    assert.ok(view.ready.every((selector) => selector.startsWith('.agent-drawer-body ') && !selector.endsWith('.agent-context-panel')));
  }
});
test('live fixture actually supplies deliveries, capabilities, profile and files', async () => {
  const respond = await loadFixtures();
  const read = async (path) => (await respond(`https://fixture.invalid/v3/${path}`)).json();
  const activity = await read('console/activity');
  assert.ok(activity.agents.find(({ alias }) => alias === 'kant').in_flight_items.length);
  const status = await read('status');
  assert.ok(status.presence.find(({ alias }) => alias === 'kant').capabilities.length);
  const profile = await read('console/tenants/Steven/agents/kant/perfil');
  assert.ok(profile.perfil.purpose);
  const documents = await read('console/tenants/Steven/agents/kant/documents');
  assert.ok(documents.items.length);
});

test('conversation context also requires loaded profile and documents', () => {
  const view = VIEWS.find(({ id }) => id === 'conversation-context');
  assert.equal(view.primary, '.agent-context-panel .directiva-resumen');
  assert.deepEqual(view.ready, ['.agent-context-panel .perfil-tab .perfil-editor', '.agent-context-panel .ficheros-lista li']);
});

test('keyboard scan is scoped to the active modal, preserving inert checks inside it', async () => {
  const source = await readFile(new URL('./mobile-views-gate.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("document.querySelectorAll('[role=\"dialog\"][aria-modal=\"true\"]')"));
  assert.ok(source.includes("const interactionRoot = modal ?? document.querySelector('main')"));
  assert.ok(source.includes("interactionRoot?.querySelectorAll('*')"));
  assert.ok(source.includes("!element.closest('[inert], [hidden]')"));
  assert.ok(source.includes("!control.closest('[inert], [hidden]')"));
});
