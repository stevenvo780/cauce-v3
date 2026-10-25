import { recordConnectionEvent } from './connection-diagnostics';

/** Un latido cada 3 s con 2,5 s de espera y dos fallos seguidos: el aviso sale en ~8,5 s como máximo. */
export const HEARTBEAT_INTERVAL_MS = 3_000;
export const HEARTBEAT_TIMEOUT_MS = 2_500;
export const HEARTBEAT_FAILURES_TO_ALERT = 2;

let loadRecorded = false;

export interface HeartbeatOptions {
  /** Resuelve a `true` si el servidor contestó (cualquier respuesta que no sea 502/503/504), `false` o rechaza si no. */
  readonly ping: (signal: AbortSignal) => Promise<boolean>;
  readonly onDown: () => void;
  readonly onUp: () => void;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly failuresToAlert?: number;
}

/**
 * Latido del canal de tiempo real: detecta un servidor colgado sin esperar al tiempo máximo de
 * una lectura (30 s). Evita falsos positivos exigiendo fallos consecutivos, no cuenta nada
 * mientras la pestaña está oculta (los navegadores congelan o abortan las peticiones) y
 * reinicia la cuenta al volver a primer plano.
 */
export function startHeartbeat(options: HeartbeatOptions): () => void {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  const threshold = options.failuresToAlert ?? HEARTBEAT_FAILURES_TO_ALERT;
  let failures = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let downSince: number | undefined;

  const isStopped = (): boolean => stopped;
  const hidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

  const schedule = (delay: number): void => {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => { void tick(); }, delay);
  };

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    if (hidden()) { schedule(intervalMs); return; }
    running = true;
    const started = Date.now();
    const controller = new AbortController();
    const abort = setTimeout(() => { controller.abort(); }, timeoutMs);
    let ok = false;
    let reason = 'red';
    try {
      ok = await options.ping(controller.signal);
      if (!ok) reason = 'http_5xx';
    } catch {
      reason = controller.signal.aborted ? 'timeout' : 'red';
    } finally { clearTimeout(abort); running = false; }
    if (isStopped()) return; // stop() puede llegar mientras se espera el ping
    if (hidden()) { failures = 0; schedule(intervalMs); return; } // un fallo con la pestaña oculta no cuenta
    if (ok) {
      if (downSince !== undefined) {
        recordConnectionEvent('latido-recuperado', `${String(Math.round((Date.now() - downSince) / 1000))}s`);
        downSince = undefined;
      }
      failures = 0;
      options.onUp();
    } else {
      failures += 1;
      recordConnectionEvent('latido-fallo', `${reason}:${String(failures)}`);
      if (failures >= threshold) {
        downSince ??= Date.now();
        options.onDown();
      }
    }
    schedule(Math.max(0, intervalMs - (Date.now() - started)));
  };

  const onVisibility = (): void => {
    recordConnectionEvent('visibilidad', document.visibilityState);
    if (document.visibilityState === 'visible') { failures = 0; schedule(0); }
  };
  const onPageShow = (event: PageTransitionEvent): void => {
    recordConnectionEvent('pageshow', event.persisted ? 'bfcache' : 'normal');
    failures = 0; schedule(0);
  };
  const onPageHide = (): void => { recordConnectionEvent('pagehide'); };
  const onOnline = (): void => { recordConnectionEvent('online'); failures = 0; schedule(0); };
  const onOffline = (): void => { recordConnectionEvent('offline'); };

  const navigation = typeof performance !== 'undefined' && 'getEntriesByType' in performance
    ? (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type
    : undefined;
  if (!loadRecorded) { loadRecorded = true; recordConnectionEvent('carga', navigation ?? 'desconocida'); }
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  schedule(intervalMs);

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pageshow', onPageShow);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
}
