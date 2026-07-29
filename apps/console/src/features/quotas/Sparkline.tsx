import type { QuotaHistory } from '../../api/types';

/**
 * Sparkline de 24h ya submuestreada por el servidor (≤48 puntos, ver thresholds.history_*). No
 * hay eje ni tooltip: es una forma, no un instrumento de lectura exacta — para el número exacto
 * está la celda de al lado. Ventanas de sesión ("session", "5h") resetean por diseño y el trazo
 * cae a 0 en cada reset; eso NO es un bug de datos, así que el llamador debe mostrar reset_at al
 * lado para que la caída se lea como "reinició la ventana", no como "se liberó cuota sola".
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
    <span className="sparkline" title={`Consumo de ${first}% a ${last}% en la ventana observada`}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Uso: de ${first}% a ${last}% de consumo`}>
        <polyline points={coords.join(' ')} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </span>
  );
}
