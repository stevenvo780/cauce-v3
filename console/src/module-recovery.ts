// `window.name` is scoped to this tab and survives a reload; the browser-storage policy forbids Web Storage here.
const RELOAD_MARK = 'cauce:module-reload';
const NOTICE_ID = 'module-recovery-notice';
let reloading = false;

function showNotice(automatic: boolean): void {
  if (document.getElementById(NOTICE_ID)) return;
  const notice = document.createElement('div');
  notice.id = NOTICE_ID;
  notice.className = 'fixed inset-x-4 bottom-4 z-50 rounded-xl border border-line bg-surface p-4 text-sm text-fg shadow-pop';
  notice.setAttribute('role', automatic ? 'status' : 'alert');
  notice.textContent = automatic
    ? 'Hay una versión nueva, recargando…'
    : 'No se pudo cargar esta vista. Recarga la página para reintentar. ';
  if (!automatic) {
    const link = document.createElement('a');
    link.href = window.location.href;
    link.textContent = 'Recargar página';
    link.className = 'underline';
    notice.append(link);
  }
  document.body.append(notice);
}

export function reloadAfterModuleFailure(): boolean {
  if (reloading) return true;
  // The marker survives one reload; once it is set only a manual retry is safe.
  if (window.name === RELOAD_MARK) {
    showNotice(false);
    return false;
  }
  window.name = RELOAD_MARK;
  reloading = true;
  showNotice(true);
  window.setTimeout(() => { window.location.reload(); }, 800);
  return true;
}

export function recoverModuleLoad(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading (?:CSS )?chunk .+ failed|Unable to preload CSS/i.test(message)
    && reloadAfterModuleFailure();
}
