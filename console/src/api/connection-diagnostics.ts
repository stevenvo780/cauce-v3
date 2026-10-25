/**
 * Registro de eventos de conexión para diagnosticar avisos «pegados» en producción.
 *
 * Solo guarda un vocabulario cerrado (nombre de evento y un detalle corto como «visible», «503»
 * o «timeout»): nunca rutas, cuerpos, identificadores, cabeceras ni nada del usuario. Se conserva
 * en `sessionStorage` para sobrevivir a una recarga y se lee desde la consola del navegador con
 * `cauceDiagnosticoConexion()`.
 */
export interface ConnectionEvent { readonly at: string; readonly event: string; readonly detail?: string }

const STORAGE_KEY = 'cauce.diagnostico.conexion';
const MAX_EVENTS = 80;
const MAX_DETAIL = 40;
const SAFE_DETAIL = /[^a-zA-Z0-9_.:+-]/g;

let memory: ConnectionEvent[] | undefined;

function load(): ConnectionEvent[] {
  if (memory) return memory;
  memory = [];
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      memory = parsed.filter((item): item is ConnectionEvent => typeof item === 'object' && item !== null
        && typeof (item as ConnectionEvent).at === 'string' && typeof (item as ConnectionEvent).event === 'string')
        .slice(-MAX_EVENTS);
    }
  } catch { /* sin almacenamiento: el registro vive solo en memoria */ }
  return memory;
}

export function recordConnectionEvent(event: string, detail?: string): void {
  const entries = load();
  const clean = detail === undefined ? undefined : detail.replace(SAFE_DETAIL, '_').slice(0, MAX_DETAIL);
  entries.push({ at: new Date().toISOString(), event: event.slice(0, MAX_DETAIL), ...(clean ? { detail: clean } : {}) });
  if (entries.length > MAX_EVENTS) entries.splice(0, entries.length - MAX_EVENTS);
  try { window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch { /* ignorado */ }
}

export function connectionEvents(): readonly ConnectionEvent[] {
  return [...load()];
}

export function resetConnectionEventsForTests(): void {
  memory = undefined;
  try { window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignorado */ }
}

declare global {
  interface Window { cauceDiagnosticoConexion?: () => readonly ConnectionEvent[] }
}
if (typeof window !== 'undefined') window.cauceDiagnosticoConexion = connectionEvents;
