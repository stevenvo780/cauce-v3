import { LIVE_STATE_META, humanSeconds, type LiveAgentView, type OrigenEncargo } from './agent-state';

/**
 * What a doll says when you hover it with the pointer or focus it with the keyboard.
 *
 * Four lines and a footer, in Spanish, answering the question of whoever looks at the map: *what
 * it has in hand, who asked for it, how long ago, and how many are queued behind it*. Not a
 * single `delivery_id`, not a `message_id`, not a `lane`, not an `epoch`: that is material for
 * the side drawer, where there is room to read it slowly, and putting it here turns an
 * explanation into a dump.
 *
 * And NEVER the text of the task. It is not a design decision that can be revisited: `/activity`
 * does not select message bodies — the data does not even enter the server's result set — so this
 * card says WHICH delivery the agent has, not what the delivery says. If a body ever shows up
 * here, it would be a backend failure, not a UI improvement.
 */

export interface AgentTooltipCardProps {
  /** `null` = the topology declares the alias and activity does not report it. */
  view: LiveAgentView | null;
  alias: string;
}

export function AgentTooltipCard({ view, alias }: AgentTooltipCardProps) {
  if (!view) {
    return (
      <div className="agent-tip">
        <p><strong>{alias}</strong></p>
        <p className="tooltip-warn">Sin reportar.</p>
        <p>La topología lo declara y la actividad no dice nada de él. No se asume que esté sano.</p>
      </div>
    );
  }

  const meta = LIVE_STATE_META[view.state];
  // The origin arrives ALREADY disambiguated from `buildLiveViews`, which is the only place that
  // has the whole fleet's alias set in front of it. `origin_adapter` is not consulted again here:
  // that field is copied byte-for-byte on every hop and on its own turned any inter-agent delegation
  // into "someone asked for it, via telegram".
  const origen = view.origenes[0];
  const vaMal = view.state === 'blocked' || view.state === 'down';

  return (
    <div className="agent-tip">
      <p><strong>{alias}</strong> — {meta.label}</p>

      {/* 1 — what it is doing, and since when. */}
      <p>{lineaTrabajo(view)}</p>

      {/* 2 — who asked for it. A task without a visible sender is half an answer; one with an
             INVENTED sender is worse, so the missing-data case is declared rather than omitted. */}
      <LineaOrigen origen={origen} />

      {/* 2b — if there is more than one task, the tooltip speaks about ONE of them and says so.
              Before it was silent, and whoever read "X asked for it" while nine deliveries were
              in flight walked away with a partial attribution thinking it belonged to the whole
              agent. The total comes from `inFlight`, not from the list length, because the
              server truncates it (`in_flight_items_truncated`), so counting received items
              would say "3 tasks" on an agent with 41. */}
      {view.inFlight > 1 && view.origenes.length > 0 ? (
        <p className="muted">Es uno de {view.inFlight} encargos en vuelo, y cada uno tiene su propio remitente. Enter para verlos.</p>
      ) : null}

      {/* 3 — how many are waiting in line behind. Omitted entirely at zero: a line that says
             "0" takes the same space as one that informs, and does not inform. */}
      {view.queued > 0 ? (
        <p>{view.queued === 1 ? '1 esperando turno detrás' : `${String(view.queued)} esperando turno detrás`}.</p>
      ) : null}

      {/* 4 — only if something is wrong. On a healthy agent this line does not exist. */}
      {vaMal ? <p className="tooltip-warn">{lineaSenal(view)}</p> : null}

      <div className="tooltip-foot">
        {/* The closed-work footer DISAPPEARS if the server does not report the field. An invented
            "closed 0 today" over missing data is a false accusation against an agent that may
            have closed thirty. */}
        {typeof view.closed24h === 'number'
          ? <p>{view.closed24h === 1 ? 'Cerró 1 encargo hoy' : `Cerró ${String(view.closed24h)} encargos hoy`}.</p>
          : null}
        <p>Enter para abrir el detalle.</p>
      </div>
    </div>
  );
}

/**
 * The "who asked for it" line, one for each way to know it — and one for when it is unknown.
 *
 * Without a task in flight there is nothing to attribute and the line disappears entirely. With
 * a task and without an identifiable sender, it is written that it is unknown: staying silent
 * would leave the reader assuming the last name they saw is the one who asked.
 */
function LineaOrigen({ origen }: { origen: OrigenEncargo | undefined }) {
  if (!origen) return null;
  if (origen.tipo === 'puente') return <p>Se lo pidió una persona, por {origen.adapter}.</p>;
  if (origen.tipo === 'agente') {
    return <p>Se lo pidió <strong>{origen.alias}</strong>{origen.tenant ? ` (${origen.tenant})` : ''}, que es otro agente.</p>;
  }
  if (origen.tipo === 'actor') {
    return <p>Lo publicó <strong>{origen.alias}</strong>{origen.tenant ? ` (${origen.tenant})` : ''}, que no es un alias de la flota.</p>;
  }
  return <p className="tooltip-warn">No se sabe quién se lo pidió: la entrega no trae remitente identificable.</p>;
}

function lineaTrabajo(view: LiveAgentView): string {
  const edad = view.oldestInFlightSeconds;
  if (view.state === 'idle') return 'Sin nada entre manos ahora mismo.';
  if (view.state === 'down') return 'Sin conexión: nadie va a tomar su trabajo.';
  if (view.inFlight <= 0) return view.reason;
  const cuanto = typeof edad === 'number' ? ` desde hace ${humanSeconds(edad)}` : '';
  return view.inFlight === 1
    ? `Con 1 entrega entre manos${cuanto}.`
    : `Con ${String(view.inFlight)} entregas entre manos${cuanto}.`;
}

function lineaSenal(view: LiveAgentView): string {
  if (view.state === 'down') return view.reason;
  const desde = view.secondsSinceLastAck;
  // `null` is not `0`: it means "not a single signal within the search window", which is worse.
  if (desde === null || desde === undefined) return 'No dio ni una señal en la última hora.';
  return `Sin dar señales desde hace ${humanSeconds(desde)}.`;
}
