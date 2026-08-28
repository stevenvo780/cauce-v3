import { LIVE_STATE_META, humanSeconds, type LiveAgentView, type OrigenEncargo } from './agent-state';

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
  // El origen viene YA desambiguado desde `buildLiveViews`, que es el único sitio con el conjunto
  // de alias de la flota entera delante. Acá no se vuelve a mirar `origin_adapter`: ese campo se
  // copia byte a byte en cada salto y por sí solo convertía cualquier delegación entre agentes en
  // «se lo pidió una persona, por telegram».
  const origen = view.origenes[0];
  const vaMal = view.state === 'blocked' || view.state === 'down';

  return (
    <div className="agent-tip">
      <p><strong>{alias}</strong> — {meta.label}</p>

      {/* 1 — qué está haciendo, y desde cuándo. */}
      <p>{lineaTrabajo(view)}</p>

      {/* 2 — quién se lo pidió. Un encargo sin remitente visible es media respuesta; uno con un
             remitente INVENTADO es peor, así que el caso sin dato se declara en vez de omitirse. */}
      <LineaOrigen origen={origen} />

      {/* 2b — si hay más de un encargo, el globo habla de UNO y lo dice. Antes callaba, y quien
              leía "se lo pidió X" con nueve entregas en vuelo se llevaba una atribución parcial
              creyendo que era la del agente entero. El total sale de `inFlight` y no del largo de
              la lista porque el servidor la trunca (`in_flight_items_truncated`): contar los ítems
              recibidos diría "3 encargos" en un agente que tiene 41. */}
      {view.inFlight > 1 && view.origenes.length > 0 ? (
        <p className="muted">Es uno de {view.inFlight} encargos en vuelo, y cada uno tiene su propio remitente. Enter para verlos.</p>
      ) : null}

      {/* 3 — cuántos esperan turno detrás. Se omite entera en cero: una línea que dice "0" ocupa
             el mismo sitio que una que informa, y no informa. */}
      {view.queued > 0 ? (
        <p>{view.queued === 1 ? '1 esperando turno detrás' : `${String(view.queued)} esperando turno detrás`}.</p>
      ) : null}

      {/* 4 — sólo si va mal. En un agente sano esta línea no existe. */}
      {vaMal ? <p className="tooltip-warn">{lineaSenal(view)}</p> : null}

      <div className="tooltip-foot">
        {/* El pie de trabajo cerrado DESAPARECE si el servidor no informa el campo. Un "cerró 0
            hoy" inventado sobre un dato ausente es una acusación falsa a un agente que quizá
            cerró treinta. */}
        {typeof view.closed24h === 'number'
          ? <p>{view.closed24h === 1 ? 'Cerró 1 encargo hoy' : `Cerró ${String(view.closed24h)} encargos hoy`}.</p>
          : null}
        <p>Enter para abrir el detalle.</p>
      </div>
    </div>
  );
}

/**
 * La línea de "quién se lo pidió", una por cada forma de saberlo — y una para cuando no se sabe.
 *
 * Sin encargo en vuelo no hay nada que atribuir y la línea desaparece entera. Con encargo y sin
 * remitente identificable se escribe que no se sabe: callarlo dejaría al lector suponiendo que se
 * lo pidió el último nombre que vio.
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
  // `null` no es `0`: significa "ni una señal dentro de la ventana de búsqueda", que es peor.
  if (desde === null || desde === undefined) return 'No dio ni una señal en la última hora.';
  return `Sin dar señales desde hace ${humanSeconds(desde)}.`;
}
