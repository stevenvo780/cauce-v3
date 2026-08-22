import { LIVE_STATE_META, humanSeconds, type LiveAgentView } from './agent-state';

/**
 * Lo que dice un muñeco cuando le pasás el puntero por encima o lo enfocás con el teclado.
 *
 * Cuatro líneas y un pie, en castellano, respondiendo la pregunta que se hace quien mira el mapa:
 * *qué tiene entre manos, quién se lo pidió, hace cuánto y cuántos esperan detrás*. Ni un
 * `delivery_id`, ni un `message_id`, ni un `lane`, ni un `epoch`: eso es material del cajón
 * lateral, donde hay sitio para leerlo despacio, y meterlo acá convierte una explicación en un
 * volcado.
 *
 * Y NUNCA el texto del encargo. No es una decisión de diseño que se pueda revisar: `/activity` no
 * selecciona cuerpos de mensaje —el dato no entra siquiera al result set del servidor— así que
 * esta tarjeta dice QUÉ entrega tiene el agente, no qué dice la entrega. Si algún día apareciera
 * un cuerpo por acá, sería un fallo del backend, no una mejora de la UI.
 */

export interface AgentTooltipCardProps {
  /** `null` = la topología declara al alias y la actividad no lo reporta. */
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
  const primerItem = view.agent.in_flight_items?.[0];
  const porPuente = primerItem?.origin_adapter && primerItem.origin_adapter !== 'bus'
    ? primerItem.origin_adapter
    : null;
  const vaMal = view.state === 'blocked' || view.state === 'down';

  return (
    <div className="agent-tip">
      <p><strong>{alias}</strong> — {meta.label}</p>

      {/* 1 — qué está haciendo, y desde cuándo. */}
      <p>{lineaTrabajo(view)}</p>

      {/* 2 — quién se lo pidió. Un encargo sin remitente visible es media respuesta. */}
      {porPuente ? (
        <p>Se lo pidió una persona, por {porPuente}.</p>
      ) : primerItem?.from_alias ? (
        <p>Se lo pidió <strong>{primerItem.from_alias}</strong>{primerItem.from_tenant ? ` (${primerItem.from_tenant})` : ''}.</p>
      ) : null}

      {/* 3 — cuántos esperan turno detrás. Se omite entera en cero: una línea que dice "0" ocupa
             el mismo sitio que una que informa, y no informa. */}
      {view.queued > 0 ? (
        <p>{view.queued === 1 ? '1 esperando turno detrás' : `${view.queued} esperando turno detrás`}.</p>
      ) : null}

      {/* 4 — sólo si va mal. En un agente sano esta línea no existe. */}
      {vaMal ? <p className="tooltip-warn">{lineaSenal(view)}</p> : null}

      <div className="tooltip-foot">
        {/* El pie de trabajo cerrado DESAPARECE si el servidor no informa el campo. Un "cerró 0
            hoy" inventado sobre un dato ausente es una acusación falsa a un agente que quizá
            cerró treinta. */}
        {typeof view.closed24h === 'number'
          ? <p>{view.closed24h === 1 ? 'Cerró 1 encargo hoy' : `Cerró ${view.closed24h} encargos hoy`}.</p>
          : null}
        <p>Enter para abrir el detalle.</p>
      </div>
    </div>
  );
}

function lineaTrabajo(view: LiveAgentView): string {
  const edad = view.oldestInFlightSeconds;
  if (view.state === 'idle') return 'Sin nada entre manos ahora mismo.';
  if (view.state === 'down') return 'Sin conexión: nadie va a tomar su trabajo.';
  if (view.inFlight <= 0) return view.reason;
  const cuanto = typeof edad === 'number' ? ` desde hace ${humanSeconds(edad)}` : '';
  return view.inFlight === 1
    ? `Con 1 entrega entre manos${cuanto}.`
    : `Con ${view.inFlight} entregas entre manos${cuanto}.`;
}

function lineaSenal(view: LiveAgentView): string {
  if (view.state === 'down') return view.reason;
  const desde = view.secondsSinceLastAck;
  // `null` no es `0`: significa "ni una señal dentro de la ventana de búsqueda", que es peor.
  if (desde === null || desde === undefined) return 'No dio ni una señal en la última hora.';
  return `Sin dar señales desde hace ${humanSeconds(desde)}.`;
}
