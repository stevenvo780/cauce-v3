import type { QuotaHistory } from '../../api/types';

/**
 * 24h sparkline already subsampled by the server (≤48 points, see thresholds.history_*). There is
 * no axis or tooltip: it is a shape, not an instrument for exact reading — for the exact number
 * there is the cell next to it. Session windows ("session", "5h") reset by design and the trace
 * falls to 0 on each reset; that is NOT a data bug, so the caller must show reset_at alongside so
 * the drop reads as "the window restarted", not as "quota was freed on its own".
 */
export function Sparkline({ history, width = 108, height = 26 }: { history?: QuotaHistory | null; width?: number; height?: number }) {
  const points = (history?.points ?? []).filter((point): point is { at?: string | null; used_percent: number } =>
    typeof point.used_percent === 'number' && Number.isFinite(point.used_percent));

  if (points.length < 2) {
    return <span className="sparkline-empty">Sin histórico suficiente</span>;
  }

  const stepX = width / (points.length - 1);
  const coords = points.map((point, index) => {
    const x = index * stepX;
    const y = height - (Math.min(100, Math.max(0, point.used_percent)) / 100) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const first = points[0].used_percent;
  const last = points[points.length - 1].used_percent;

  return (
    <span className="sparkline" title={`Consumo de ${String(first)}% a ${String(last)}% en la ventana observada`}>
      <svg width={width} height={height} viewBox={`0 0 ${String(width)} ${String(height)}`} role="img" aria-label={`Uso: de ${String(first)}% a ${String(last)}% de consumo`}>
        <polyline points={coords.join(' ')} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </span>
  );
}
