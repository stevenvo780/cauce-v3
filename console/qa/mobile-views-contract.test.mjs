// @vitest-environment node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
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
test('advanced configuration states open the workspace before selecting each real area tab', async () => {
  const views = VIEWS.filter(({ id }) => id.startsWith('config-') && id !== 'config-agents');
  assert.equal(views.length, 6);
  assert.ok(views.every(({ primary, actions }) => primary === '.config-area'
    && actions.length === 2
    && actions[0].role === 'button' && actions[0].name === 'Administración avanzada'
    && actions[1].role === 'tab'));
  const source = await readFile(new URL('../src/features/config/areas.ts', import.meta.url), 'utf8');
  for (const { actions: [, area] } of views) assert.ok(source.includes(`label: '${area.name}'`), area.name);
});
test('tab names and selectors agree with source, without claiming mounted UI', async () => {
  for (const [file, path] of [['accounts/AccountsPage.tsx', '/accounts'], ['observability/ObservabilityPage.tsx', '/observability'], ['config/areas.ts', '/config'], ['live/AgentDrawer.tsx', '/live?agente=Steven%2Fkant&pestana=ahora']]) {
    const source = await readFile(new URL(`../src/features/${file}`, import.meta.url), 'utf8');
    for (const action of VIEWS.filter((view) => view.path === path).flatMap(({ actions }) => actions).filter(({ role }) => role === 'tab')) assert.ok(source.includes(`label: '${action.name}'`), action.name);
  }
  for (const [file, selector] of [['messages/AgentRoster.tsx', 'messenger-agent'], ['live/LiveHypergraph.tsx', 'lhg-scroll'], ['live/ContextoTab.tsx', 'contexto-campos'], ['config/ConfigPage.tsx', 'config-area'], ['config/AgentSettings.tsx', 'settings-agent'], ['accounts/ConsumptionSection.tsx', 'quota-provider'], ['audit/AuditPanel.tsx', 'audit-row']]) assert.ok((await readFile(new URL(`../src/features/${file}`, import.meta.url), 'utf8')).includes(selector));
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
  assert.equal(view.primary, '.agent-context-panel .contexto-campos');
  assert.deepEqual(view.ready, ['.agent-context-panel .perfil-tab .perfil-editor', '.agent-context-panel .ficheros-lista li']);
  const drawer = VIEWS.find(({ id }) => id === 'live-3');
  assert.equal(drawer.primary, '.agent-drawer-body .contexto-campos');
});

test('observability primary signals are scoped to the selected signals panel', async () => {
  const view = VIEWS.find(({ id }) => id === 'observability-signals');
  assert.equal(view.primary, '#view-panel-senales .metrics-grid');
  const source = await readFile(new URL('../src/features/observability/ObservabilityPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /tab === 'senales'[\s\S]*?className="metrics-grid"/);
});

test('audit and agent configuration expose their real first investigation controls', async () => {
  const audit = VIEWS.find(({ id }) => id === 'observability-audit');
  const agents = VIEWS.find(({ id }) => id === 'config-agents');
  assert.equal(audit.primary, '#view-panel-auditoria .search-field');
  assert.equal(agents.primary, '.settings-page input[type="search"]');
  const auditSource = await readFile(new URL('../src/features/audit/AuditPanel.tsx', import.meta.url), 'utf8');
  const settingsSource = await readFile(new URL('../src/features/config/AgentSettings.tsx', import.meta.url), 'utf8');
  assert.ok(auditSource.includes('className="search-field"'));
  assert.ok(settingsSource.includes('type="search"'));
});

test('account inventory and queue triage selectors point at real operator surfaces', async () => {
  assert.equal(VIEWS.find(({ id }) => id === 'accounts-inventario').primary, '#view-panel-inventario .panel');
  assert.equal(VIEWS.find(({ id }) => id === 'accounts-asignaciones').primary, '#view-panel-asignaciones .assignment-config-form');
  assert.equal(VIEWS.find(({ id }) => id === 'queues').primary, '#view-panel-entregas tbody tr');
  const inventory = await readFile(new URL('../src/features/accounts/AccountsInventory.tsx', import.meta.url), 'utf8');
  const gate = await readFile(new URL('./mobile-views-gate.mjs', import.meta.url), 'utf8');
  const assignments = await readFile(new URL('../src/features/accounts/AssignmentMatrix.tsx', import.meta.url), 'utf8');
  const queues = await readFile(new URL('../src/features/queues/QueuesPage.tsx', import.meta.url), 'utf8');
  assert.ok(inventory.includes('title="Inventario de cuentas"'));
  assert.ok(gate.includes("view.id === 'accounts-inventario'"));
  assert.ok(gate.includes("page.locator('#view-panel-inventario table').first()"));
  assert.ok(gate.includes('inventory.firstRow?.painted'));
  assert.ok(assignments.includes('className="config-form assignment-config-form"'));
  assert.ok(assignments.includes('Matriz de techo y fallback por agente y cuenta'));
  assert.ok(assignments.includes('Cada cambio muestra una vista previa antes de confirmarlo.'));
  assert.ok(!/alias_routing_ceiling|agent_account_binding/.test(assignments.slice(assignments.indexOf('const operationLabels'), assignments.indexOf('interface Assignment'))));
  assert.ok(queues.includes('className="metrics-grid three metricas-de-cola"'));
  assert.ok(queues.includes('<DeliveryTable'));
});

test('the operator-facing refresh control preserves its loading announcement', async () => {
  const accounts = await readFile(new URL('../src/features/accounts/AccountsPage.tsx', import.meta.url), 'utf8');
  assert.ok(accounts.includes('<RefreshButton onClick={reloadAll} loading={quotas.loading || config.loading} compact />'));
  const ui = await readFile(new URL('../src/components/ui.tsx', import.meta.url), 'utf8');
  assert.ok(ui.includes("const label = loading ? 'Actualizando…' : 'Actualizar'"));
  assert.ok(ui.includes("...(compact ? { 'aria-label': label, title: label } : {})"));
});

test('keyboard scan is scoped to the active modal, preserving inert checks inside it', async () => {
  const source = await readFile(new URL('./mobile-views-gate.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("document.querySelectorAll('[role=\"dialog\"][aria-modal=\"true\"]')"));
  assert.ok(source.includes("const interactionRoot = modal ?? document.querySelector('main')"));
  assert.ok(source.includes("interactionRoot?.querySelectorAll('*')"));
  assert.ok(source.includes("!element.closest('[inert], [hidden]')"));
  assert.ok(source.includes("!control.closest('[inert], [hidden]')"));
});
