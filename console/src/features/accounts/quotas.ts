export const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude', codex: 'GPT / Codex', gemini: 'Antigravity', grok: 'Grok', muse: 'Muse', agy: 'Antigravity (agy)',
};

export function providerSignInTitle(providerId: string | null | undefined): string {
  const label = providerId ? PROVIDER_LABEL[providerId] ?? providerId : 'el proveedor';
  return `Iniciar sesión en ${label}`;
}

/** At most one decimal: the collectors publish ratios like `33.333333333333336`, unreadable and unactionable. */
export function formatPercent(value: number): string {
  return `${String(Math.round(value * 10) / 10)}%`;
}

/** reset_in_seconds <= 0 is explicitly shown as "expired": a slow collector clock must not be
 *  read as "resets in -3s". null stays UNKNOWN, never "right now". */
export function formatResetIn(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 'sin dato';
  if (seconds <= 0) return 'vencido';
  return `en ${humanDuration(seconds)}`;
}

function humanDuration(totalSeconds: number): string {
  const abs = Math.round(totalSeconds);
  const days = Math.floor(abs / 86_400);
  const hours = Math.floor((abs % 86_400) / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  if (days > 0) return `${String(days)}d ${String(hours)}h`;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  return `${String(minutes)}m`;
}

/** The person reads «5 h» or «Semanal», never the provider's window key («five-hour», «seven-day»). */
export function quotaWindowName(window: { window_key: string; window_minutes?: number | null }): string {
  const minutes = window.window_minutes ?? { '5h': 300, '7d': 10_080, 'five-hour': 300, 'seven-day': 10_080 }[window.window_key];
  if (minutes === 300) return '5 h';
  if (minutes === 10_080) return 'Semanal';
  if (minutes === 1440) return 'Diaria';
  return minutes ? `${String(minutes)} min` : window.window_key;
}

/** The automatic pause reason is a machine key ("quota_exhausted:<provider>/<group>/<window>"); the person reads Spanish. */
export function pauseReasonText(reason: string): string {
  const automatic = /^quota_exhausted:[a-z0-9_-]+\/[^/]+\/([^/]+)$/u.exec(reason);
  if (!automatic) return reason;
  const label: Record<string, string> = { 'five-hour': '5 h', '5h': '5 h', 'seven-day': 'semanal', '7d': 'semanal', daily: 'diaria' };
  const name = label[automatic[1]];
  return name ? `cuota agotada en la ventana ${name}` : 'cuota agotada';
}
