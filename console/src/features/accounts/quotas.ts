export const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude', codex: 'GPT / Codex', gemini: 'Antigravity', grok: 'Grok', muse: 'Muse',
};

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
