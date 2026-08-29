import type { FleetActivityTotals } from '../../api/types';
import { Tooltip } from '../../components/ui';
import type { Verdict, VerdictCulprit } from './agent-state';

/**
 * The verdict band: the first thing read on the page, and the only thing read if there are
 * only three seconds.
 *
 * What used to be here was a row of five `Metric`s whose labels were, literally,
 * `leased + accepted + started` and `ack_deadline_at ya pasó`. Those are five numbers in
 * database jargon and ZERO answers: to know whether something has to be done, one had to add
 * them up in their head and know what each one means. The owner's complaint —"too many views,
 * not clear enough"— starts exactly there.
 *
 * The figures do not disappear: they drop one line, in prose and with their server definition a
 * tooltip away. What changes is the hierarchy. First the sentence, then the number.
 */

export interface FleetVerdictProps {
  verdict: Verdict;
  totals: FleetActivityTotals | null | undefined;
  /** Click on a culprit chip: focuses that agent on the map and on the table. */
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
        <div>
          {/* `aria-live` educated: the band repaints every four seconds and announcing every refresh
              would be noise. It only matters when the SENTENCE changes. */}
          <p className="fleet-verdict-phrase" aria-live="polite">{verdict.frase}</p>
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
        </div>
      </div>

      {/*
        The three figures, in running prose and with the EXACT server definition in the tooltip.
        They were in big cards that competed with the verdict for the same attention, and their
        label was the SQL expression that produces them. Now the label is English and the
        expression —which is still needed, because it is what a doubtful number is checked
        against— lives where it does not get in the way.
      */}
      <p className="fleet-verdict-counts">
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
    </section>
  );
}

/**
 * An absent total is stated, not filled with zero.
 *
 * "The server did not report how many are in flight" and "there are zero in flight" are
 * different claims, and on this screen the second is reassuring. Confusing them is how a
 * dashboard ends up assuring everything is fine because it measured nothing.
 */
function cifra(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
}
