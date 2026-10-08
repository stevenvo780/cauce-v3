export const VIEWPORTS = [
  { width: 360, height: 800 }, { width: 390, height: 844 },
  { width: 430, height: 932 }, { width: 760, height: 1000 },
];
export const BUDGET = { maxPrimaryTopRatio: 0.5, minVisiblePixels: 120, documentOverflow: 0 };
const tab = (name) => ({ role: 'tab', name });
const view = (id, path, primary, actions = []) => ({ id, path, primary, actions });
/** The roster of the phone: bare /messages shows the agent list instead of an empty thread. */
const CHATS = 'section[aria-label="Conversaciones"] ul[aria-label="Agentes"]';
const PERFIL = 'section[aria-label^="Perfil y contexto"]';
const ESCENARIO = '[data-objeto-principal="escenario"]';
const SECCIONES_DE_AJUSTES = ['General', 'Espacios y salas', 'Agentes', 'Arneses', 'Acceso y roles', 'Avanzado'];

export const VIEWS = [
  view('entry', '/', CHATS),
  view('messages', '/messages', CHATS),
  view('conversation', '/messages/Steven/kant', '[data-objeto-principal="hilo"] [data-thread-scroll]'),
  { ...view('conversation-context', '/messages/Steven/kant?view=context', `${PERFIL} [role="tabpanel"]`),
    ready: [`${PERFIL} textarea`, `${PERFIL} [role="tab"]`] },
  { ...view('live', '/live', '[data-objeto-principal="oficina"]'), office: true },
  { ...view('live-sheet', '/live?agente=Steven%2Fkant', '[role="dialog"]'),
    ready: ['[role="dialog"] h2'] },
  ...[['Consumo', 'consumo'], ['Inventario', 'inventario'], ['Asignaciones', 'asignaciones']].map(([name, id]) =>
    view(`accounts-${id}`, '/accounts', `#view-panel-${id}`, [tab(name)])),
  view('queues', '/queues', '#view-panel-entregas tbody tr'),
  view('observability-signals', '/observability', '#view-panel-senales', [tab('Señales y relays')]),
  view('observability-audit', '/observability', '#view-panel-auditoria', [tab('Auditoría')]),
  ...SECCIONES_DE_AJUSTES.map((name, index) => view(`config-${index}`, '/config', 'main [role="tabpanel"]', [tab(name)])),
  view('terminal', '/terminal', `${ESCENARIO} h2`),
  view('terminal-stage', '/terminal/Steven/kant', ESCENARIO),
  view('help', '/ayuda', 'main h2'),
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
  if (view.office && !metrics.officeCanvas) failures.push('office must be painted on arrival');
  if (metrics.internalScrollWithoutKeyboard) failures.push('internal horizontal scroll is not keyboard reachable');
  return failures;
}
