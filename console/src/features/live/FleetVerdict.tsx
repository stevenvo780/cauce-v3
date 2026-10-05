import { MoreHorizontal } from 'lucide-react';
import type { FleetActivityTotals } from '../../api/types';
import { Tooltip } from '../../components/ui';
import type { Verdict, VerdictCulprit } from './agent-state';

interface FleetVerdictProps {
  verdict: Verdict;
  totals: FleetActivityTotals | null | undefined;
  onCulprit?: (culprit: VerdictCulprit) => void;
}

const TONE_LABEL: Record<Verdict['tone'], string> = {
  ok: 'Sin incidencias',
  alerta: 'Requiere atención',
  desconocido: 'Estado no acreditado',
};

export function FleetVerdict({ verdict, totals, onCulprit }: FleetVerdictProps) {
  return (
    <section className="fleet-verdict" data-tone={verdict.tone} aria-label="Veredicto de la flota">
      <div className="fleet-verdict-main">
        <span className="fleet-verdict-light" role="img" aria-label={TONE_LABEL[verdict.tone]} />
        <p className="fleet-verdict-phrase" aria-live="polite">{verdict.frase}</p>
        <details className="fleet-verdict-more">
          <summary aria-label="Detalles del estado de la flota" title="Detalles del estado de la flota"><MoreHorizontal size={18} aria-hidden="true" /></summary>
          <div className="fleet-verdict-popover">
          <p className="fleet-verdict-support">{verdict.apoyo}</p>
          {verdict.culpables.length > 0 ? (
            <div className="fleet-verdict-culprits">
              {verdict.culpables.map((culprit) => (
                <button
                  key={culprit.key}
                  type="button"
                  className="fleet-verdict-chip"
                  onClick={() => onCulprit?.(culprit)}
                >
                  <strong>{culprit.alias}</strong> · {culprit.motivo}
                </button>
              ))}
            </div>
          ) : null}
      <p className="fleet-verdict-counts">
        <span>Totales de toda la flota: </span>
        <Tooltip label={<><strong>En vuelo</strong> es lo que los agentes ya tomaron: entregas en estado <code>leased</code>, <code>accepted</code> o <code>started</code>. Cuenta trabajo tomado, no trabajo que avance.</>}>
          <strong>{cifra(totals?.in_flight)}</strong> en vuelo
        </Tooltip>
        <span aria-hidden="true"> · </span>
        <Tooltip label={<><strong>Esperando turno</strong> son entregas <code>pending</code> más <code>retry</code>: nadie las tomó todavía. Es la única definición de "en cola" que queda en la consola.</>}>
          <strong>{cifra(totals?.queued)}</strong> esperando turno
        </Tooltip>
        <span aria-hidden="true"> · </span>
        <Tooltip label={<><strong>ACK vencido</strong> es una entrega en vuelo cuyo <code>ack_deadline_at</code> ya pasó: el turno se le está muriendo al agente que la tiene.</>}>
          <strong>{cifra(totals?.overdue_in_flight)}</strong> con el ACK vencido
        </Tooltip>
      </p>
          </div>
        </details>
      </div>
    </section>
  );
}

function cifra(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
}
