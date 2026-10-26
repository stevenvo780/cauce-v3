/**
 * Registro de eventos de conexión para diagnosticar avisos «pegados» en producción.
 *
 * Solo guarda un vocabulario cerrado (nombre de evento y un detalle corto como «visible», «503»
 * o «timeout»): nunca rutas, cuerpos, identificadores, cabeceras ni nada del usuario. Vive solo en
 * memoria (la consola no escribe en el almacenamiento del navegador) y se lee desde la consola del
 * navegador con `cauceDiagnosticoConexion()`.
 */
export interface ConnectionEvent { readonly at: string; readonly event: string; readonly detail?: string }

const MAX_EVENTS = 80;
const MAX_DETAIL = 40;
const SAFE_DETAIL = /[^a-zA-Z0-9_.:+-]/g;

let memory: ConnectionEvent[] = [];

export function recordConnectionEvent(event: string, detail?: string): void {
  const entries = memory;
  const clean = detail === undefined ? undefined : detail.replace(SAFE_DETAIL, '_').slice(0, MAX_DETAIL);
  entries.push({ at: new Date().toISOString(), event: event.slice(0, MAX_DETAIL), ...(clean ? { detail: clean } : {}) });
  if (entries.length > MAX_EVENTS) entries.splice(0, entries.length - MAX_EVENTS);
}

export function connectionEvents(): readonly ConnectionEvent[] {
  return [...memory];
}

export function resetConnectionEventsForTests(): void {
  memory = [];
}

declare global {
  interface Window { cauceDiagnosticoConexion?: () => readonly ConnectionEvent[] }
}
if (typeof window !== 'undefined') window.cauceDiagnosticoConexion = connectionEvents;
