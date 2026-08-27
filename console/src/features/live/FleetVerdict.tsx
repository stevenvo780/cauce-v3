import type { FleetActivityTotals } from '../../api/types';
import { Tooltip } from '../../components/ui';
import type { Verdict, VerdictCulprit } from './agent-state';

/**
 * La banda de veredicto: lo primero que se lee de la página, y lo único que se lee si sólo hay
 * tres segundos.
 *
 * Lo que había acá era una fila de cinco `Metric` cuyos rótulos eran, literalmente,
 * `leased + accepted + started` y `ack_deadline_at ya pasó`. Eso son cinco números en jerga de
 * base de datos y CERO respuestas: para saber si hay que hacer algo había que sumarlos de cabeza
 * y saber qué significa cada uno. La queja del dueño —"demasiadas vistas, poco claras"— empieza
 * exactamente ahí.
 *
 * Las cifras no desaparecen: bajan una línea, en texto y con su definición del servidor a un
 * tooltip de distancia. Lo que cambia es la jerarquía. Primero la frase, después el número.
 */

export interface FleetVerdictProps {
  verdict: Verdict;
  totals: FleetActivityTotals | null | undefined;
  /** Clic en un chip de culpable: enfoca a ese agente en el mapa y en la tabla. */
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
          {/* `aria-live` educado: la banda se repinta cada cuatro segundos y anunciar cada
              refresco a gritos sería ruido. Sólo importa cuando la FRASE cambia. */}
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
        Las tres cifras, en texto corrido y con la definición EXACTA del servidor en el tooltip.
        Estaban en tarjetas grandes que competían con el veredicto por la misma atención, y su
        rótulo era la expresión SQL que las produce. Ahora el rótulo es castellano y la expresión
        —que sigue haciendo falta, porque es contra lo que se contrasta un número dudoso— vive
        donde no estorba.
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
 * Un total ausente se dice, no se rellena con cero.
 *
 * "El servidor no informó cuántas hay en vuelo" y "hay cero en vuelo" son afirmaciones distintas,
 * y en esta pantalla la segunda es tranquilizadora. Confundirlas es cómo un panel acaba
 * asegurando que todo está bien porque no midió nada.
 */
function cifra(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
}
