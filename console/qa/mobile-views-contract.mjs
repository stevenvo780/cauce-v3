export const VIEWPORTS = [
  { width: 360, height: 800 }, { width: 390, height: 844 },
  { width: 430, height: 932 }, { width: 760, height: 1000 },
];
export const BUDGET = { maxPrimaryTopRatio: 0.5, minVisiblePixels: 120, documentOverflow: 0 };
const tab = (name) => ({ role: 'tab', name });
const button = (name) => ({ role: 'button', name });
const view = (id, path, primary, actions = []) => ({ id, path, primary, actions });
export const VIEWS = [
  view('entry', '/', '.messenger-agent'),
  view('messages', '/messages', '.messenger-agent'),
  view('conversation', '/messages/Steven/kant', '.messenger-thread-scroll'),
  { ...view('conversation-context', '/messages/Steven/kant?view=context', '.agent-context-panel .contexto-campos'),
    ready: ['.agent-context-panel .perfil-tab .perfil-editor', '.agent-context-panel .ficheros-lista li'] },
  view('overview', '/overview', '.landing-alertas'),
  { ...view('live', '/live', '.lhg-scroll'), graph: true },
  ...[
    ['Ahora', '.live-detail dl', ['.live-reason']],
    ['Conexión', '.live-detail dl', ['.live-detail dd:last-of-type .chip']],
    ['Entregas', '.drawer-delivery', ['.drawer-delivery dl']],
    ['Contexto', '.contexto-campos', ['.perfil-tab .perfil-editor', '.ficheros-lista li']],
    ['Ficheros', '.ficheros-lista li', ['.ficheros-lista li']],
  ].map(([name, primary, ready], index) => ({
    ...view(`live-${index}`, '/live?agente=Steven%2Fkant&pestana=ahora', `.agent-drawer-body ${primary}`, [tab(name)]),
    ready: ready.map((selector) => `.agent-drawer-body ${selector}`),
  })),
  ...[['Consumo', 'consumo', '.quota-provider'], ['Inventario', 'inventario', '.panel'], ['Asignaciones', 'asignaciones', '.assignment-config-form']].map(([name, id, selector]) =>
    view(`accounts-${id}`, '/accounts', `#view-panel-${id} ${selector}`, [tab(name)])),
  view('queues', '/queues', '#view-panel-entregas tbody tr'),
  view('observability-signals', '/observability', '#view-panel-senales .metrics-grid', [tab('Señales y relays')]),
  view('observability-audit', '/observability', '#view-panel-auditoria .search-field', [tab('Auditoría')]),
  view('config-agents', '/config', '.settings-page input[type="search"]'),
  ...['Espacios y miembros', 'Permisos', 'Agentes', 'Avisos y cadena', 'Historial y JSON', 'Otros'].map((name, index) =>
    view(`config-${index}`, '/config', '.config-area', [button('Administración avanzada'), tab(name)])),
  view('terminal', '/terminal', '.ultimate-terminal-shell'),
  view('help', '/ayuda', '.help-lista'),
];

export function assertSuccessfulResponse(status, target) {
  if (!Number.isInteger(status) || status < 200 || status >= 300) throw new Error(`Unsuccessful response: ${target} (${String(status)})`);
}

export function viewportFailures(metrics, viewport) {
  return ['clientWidth', 'visualWidth'].flatMap((key) =>
    !Number.isFinite(metrics[key]) || Math.abs(metrics[key] - viewport.width) > 1 ? [`viewport width mismatch: ${key}`] : [])
    .concat(!Number.isFinite(metrics.visualHeight) || Math.abs(metrics.visualHeight - viewport.height) > 1 ? ['viewport height mismatch'] : [])
    .concat(!Number.isFinite(metrics.visualScale) || Math.abs(metrics.visualScale - 1) > 0.01 ? ['viewport scale mismatch'] : []);
}

export function failuresFor(metrics, view) {
  const failures = [];
  if (!Number.isFinite(metrics.overflow) || metrics.overflow > BUDGET.documentOverflow) failures.push('document overflow');
  if (!metrics.primary || !metrics.primary.painted) failures.push('primary object missing or hidden');
  else {
    const { top, height, visibleHeight, visibleWidth } = metrics.primary;
    const usable = metrics.contentBottom - metrics.contentTop;
    if (![top, height, visibleHeight, visibleWidth, usable].every(Number.isFinite)) failures.push('invalid primary geometry');
    if (usable <= 0 || top < metrics.contentTop - 1 || top > metrics.contentTop + usable * BUDGET.maxPrimaryTopRatio) failures.push('primary object exceeds first-screen budget');
    if (height <= 0 || visibleHeight < Math.min(height, BUDGET.minVisiblePixels) - 1 || visibleWidth <= 0) failures.push('primary object clipped or below fold');
  }
  if (view.graph && (!metrics.graphOpen || !metrics.graphNodes)) failures.push('graph must be open with nodes on arrival');
  if (metrics.internalScrollWithoutKeyboard) failures.push('internal horizontal scroll is not keyboard reachable');
  return failures;
}
