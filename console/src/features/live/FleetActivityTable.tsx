import { ChevronDown, ChevronRight, Flame, Search, ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  FleetActivityAgent, FleetActivityFlag, FleetActivitySnapshot, FleetActivityThresholds,
} from '../../api/types';
import { Badge, EmptyState, Panel, Time, Unknown } from '../../components/ui';
import { compactId, safeDeliveryState, safeJobLane } from '../../lib';
import {
  FLAG_LABEL, FLAG_TONE, agentDisplayName, agentKeyOf, agentRowKey, estadoDeFila,
  formatAckAge, formatInFlightAge, inFlightItemTone, presenceBadge, presenciaDeLaFila,
  resumirSenales, rowUrgency, sortByUrgency,
  type EstadosVivos,
} from './activity';

/**
 * La lectura tabular de `GET /v3/console/activity`.
 *
 * Esto **era** una ruta propia ("Actividad de la flota") que leía exactamente el mismo endpoint que
 * la sala de máquinas y lo dibujaba de otra forma: dos entradas de menú, dos pollings, una sola
 * pregunta. Ahora es el panel de detalle de la sala de máquinas — el hipergrafo responde *quién le
 * habla a quién*, y esta tabla responde *cuánto lleva cada entrega y si avanza*, que es la pregunta
 * siguiente y no la misma. Se alimenta del snapshot que la página ya tiene: no vuelve a pedir nada.
 */

const FLAG_ORDER: FleetActivityFlag[] = [
  'saturated', 'ack_stalled', 'overdue_acks', 'lease_expired', 'never_connected', 'unregistered', 'queued_without_consumer',
];

export interface FleetActivityTableProps {
  snapshot: FleetActivitySnapshot | undefined;
  /** Alias resaltado en el hipergrafo, en formato `tenant/alias`. Sincroniza las dos mitades. */
  selectedKey?: string | null;
  /** Claves `tenant/alias` a las que el filtro de estado acota la tabla. `null` = sin filtro. */
  onlyKeys?: Set<string> | null;
  /** Nombre del estado filtrado, sólo para poder decirlo cuando el filtro deja la tabla vacía. */
  filterLabel?: string;
  /**
   * El estado del muñeco por alias (`tenant/alias`), tal y como lo derivó la página.
   *
   * Es lo que impide que la fila y el chip digan cosas distintas del mismo agente: sin esto, la
   * columna ESTADO tenía que traducir el `work_state` del servidor por su cuenta y un alias
   * caído salía «Libre» porque no tenía trabajo. Ver `estadoDeFila`.
   */
  estados?: EstadosVivos;
  onSelect?: (key: string | null) => void;
  /** Clic en la fila: abre el cajón de ese agente sobre la misma página, sin navegar. */
  onOpen?: (key: string) => void;
}

/**
 * Tabla de agentes con búsqueda por alias y detalle por entrega.
 *
 * La búsqueda es la razón por la que esta tabla sobrevive a la grilla de tarjetas que había antes:
 * con quince muñecos en un dibujo, encontrar a *uno* concreto por nombre es lo único que el grafo
 * hace peor que una lista.
 */
export function FleetActivityTable({ snapshot, selectedKey, onlyKeys, filterLabel, estados, onSelect, onOpen }: FleetActivityTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');

  const thresholds = snapshot?.thresholds;
  const agents = useMemo(() => {
    let ordered = sortByUrgency(snapshot?.agents ?? [], estados);
    if (onlyKeys) ordered = ordered.filter((agent) => onlyKeys.has(agentKeyOf(agent)));
    const needle = query.trim().toLowerCase();
    if (!needle) return ordered;
    return ordered.filter((agent) => `${agent.tenant_id} ${agent.alias} ${agent.display_name ?? ''} ${agent.harness_id ?? ''}`
      .toLowerCase().includes(needle));
  }, [snapshot, query, onlyKeys, estados]);

  function toggle(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  return (
    <Panel
      title="Agentes"
      subtitle="En el MISMO orden que los chips de arriba (caído > trabado > delegando > recibiendo > trabajando > salió de vuelo > libre), no alfabéticamente: lo que hace ruido tiene que quedar arriba. La columna «Estado» dice exactamente lo que dice el muñeco de ese alias; el subtítulo traía antes un tercer juego de rótulos. Es la misma lectura del hipergrafo, en números; no dibuja las delegaciones otra vez."
    >
      <label className="activity-search">
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder="Buscar alias, tenant o arnés…"
          aria-label="Buscar un agente por alias"
          onChange={(event) => { setQuery(event.target.value); }}
        />
      </label>
      {agents.length === 0 ? (
        <EmptyState>
          {query.trim()
            ? `Ningún alias coincide con «${query.trim()}».`
            : filterLabel
              ? `Ningún agente en estado «${filterLabel}» ahora mismo.`
              : 'Ningún alias visible: ni configurado, ni con entregas abiertas, ni con lease reciente.'}
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Actividad en vuelo por agente</caption>
            <thead>
              <tr>
                <th aria-hidden="true" />
                <th>Agente</th>
                <th>Estado</th>
                <th>Presencia</th>
                <th>En vuelo</th>
                <th>Cola</th>
                <th>Antigüedad</th>
                <th>Último ACK</th>
                <th>ACKs recientes</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => {
                const key = agentRowKey(agent);
                const estado = estadoDeFila(agent, estados);
                const urgency = rowUrgency(agent.work_state, estado.live);
                const presence = presenceBadge(agent);
                const items = agent.in_flight_items ?? [];
                const isExpanded = expanded.has(key);
                return (
                  <FragmentRow
                    key={key}
                    agent={agent}
                    estado={estado}
                    urgency={urgency}
                    presenceLabel={presence.label}
                    presenceTone={presence.tone}
                    expanded={isExpanded}
                    onToggle={() => { toggle(key); }}
                    items={items}
                    ackLookbackSeconds={thresholds?.ack_lookback_seconds}
                    highlighted={selectedKey === agentKeyOf(agent)}
                    onHover={onSelect}
                    onOpen={onOpen}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/**
 * Señales activas: `totals.flagged`.
 *
 * Se conserva aparte de los siete estados de los muñecos porque **no es la misma partición**: un
 * agente saturado Y con el ACK detenido cuenta en las dos columnas, así que esto no suma a
 * `totals.agents` y no se puede derivar del recuento por estado.
 */
export function FleetSignals({ snapshot }: { snapshot: FleetActivitySnapshot | undefined }) {
  const flagged = snapshot?.totals?.flagged;
  return (
    <Panel title="Señales activas" subtitle="totals.flagged es acumulativo: un mismo agente saturado y con ACK detenido cuenta en las dos columnas, así que esto NO suma a totals.agents.">
      {!flagged || FLAG_ORDER.every((flag) => !flagged[flag]) ? (
        <EmptyState>Ninguna señal activa: no hay agentes saturados, colgados ni con lease vencido.</EmptyState>
      ) : (
        <div className="chip-list">
          {FLAG_ORDER.filter((flag) => (flagged[flag] ?? 0) > 0).map((flag) => (
            <span className="chip" key={flag}>
              <Badge tone={FLAG_TONE[flag]}>{FLAG_LABEL[flag]}</Badge> {flagged[flag]}
            </span>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Las tres cosas que hay que saber para no malinterpretar la tabla. */
export function ActivityExplainers({ thresholds }: { thresholds: FleetActivityThresholds | null | undefined }) {
  return (
    <div className="explain-grid">
      <article>
        <Flame aria-hidden="true" />
        <div>
          <strong>Tener trabajo no es avanzar</strong>
          <p>
            «En vuelo» cuenta lo que el agente TOMÓ; «ACKs recientes» y «Último ACK» dicen si avanza. 41 en vuelo
            con cero acuses es un incendio; 3 en vuelo con nueve acuses es sano — son los dos números que
            motivaron este panel.
          </p>
        </div>
      </article>
      <article>
        <ShieldAlert aria-hidden="true" />
        <div>
          <strong>Sin cuerpos, nunca</strong>
          <p>
            Esta consulta no selecciona el texto de ningún mensaje ni el detalle de ningún error: sólo
            identificadores, estados y tiempos. Ni el operador del hub ve contenido ajeno acá.
          </p>
        </div>
      </article>
      <article>
        <ChevronDown aria-hidden="true" />
        <div>
          <strong>Umbrales del servidor</strong>
          <p>
            {/* «Trabado», la misma palabra que el chip, el veredicto, la leyenda y esta tabla.
                Decía «colgado», que era el rótulo viejo de la columna ESTADO. */}
            Saturado desde {thresholds?.saturation_in_flight ?? 'un número que el servidor no informó'} en vuelo;
            trabado tras {thresholds?.stall_after_seconds ?? 'un tiempo que el servidor no informó'}
            {thresholds?.stall_after_seconds ? 's' : ''} sin ACK aplicado. La consola no inventa estos números.
          </p>
        </div>
      </article>
    </div>
  );
}

function FragmentRow({ agent, estado, urgency, presenceLabel, presenceTone, expanded, onToggle, items, ackLookbackSeconds, highlighted, onHover, onOpen }: {
  agent: FleetActivityAgent;
  estado: ReturnType<typeof estadoDeFila>;
  urgency: 'critical' | 'warning' | undefined;
  presenceLabel: string;
  presenceTone: 'online' | 'done' | 'running' | 'warning' | 'danger' | 'offline' | 'unknown' | 'info';
  expanded: boolean;
  onToggle: () => void;
  items: NonNullable<FleetActivityAgent['in_flight_items']>;
  ackLookbackSeconds: number | null | undefined;
  highlighted?: boolean;
  onHover?: (key: string | null) => void;
  onOpen?: (key: string) => void;
}) {
  /**
   * Titular y señales salen de DOS sitios distintos a propósito, y los dos hacen falta:
   *
   *  - el TITULAR es `estadoDeFila`, que consume el estado ya derivado por la página —el mismo
   *    objeto que pinta el muñeco y cuenta el chip—, porque `work_state` y `LiveState` son
   *    particiones distintas y ninguna traducción de rótulos podía hacerlas coincidir: `iza`
   *    salía «Caído» en el chip y «Libre» en su fila.
   *  - las SEÑALES son `resumirSenales`, que quita las que otra cosa ya visible implica: `midas`
   *    apilaba CINCO insignias para decir «está trabado» y `jarvis` decía «Saturado» dos veces.
   *
   * El titular del resumen se DESCARTA y se usa el de `estadoDeFila`: dos titulares para la
   * misma celda serían otra vez dos palabras para un hecho.
   */
  const stateLabel = estado.label;
  const stateTone = estado.tone;
  const senales = resumirSenales(
    agent.work_state ?? undefined, agent.flags, presenciaDeLaFila(agent),
    { clave: estado.live ?? 'estado', label: stateLabel, tone: stateTone },
  );
  const hasItems = items.length > 0;
  return (
    <>
      {/* Pasar el puntero por la fila resalta al muñeco en el hipergrafo de arriba: es lo que ata
          la lista al dibujo sin tener que dibujar la lista otra vez. */}
      <tr
        data-state={estado.live ?? agent.work_state ?? 'unknown'}
        data-urgency={urgency}
        data-highlighted={highlighted ? 'true' : undefined}
        className={urgency ? `row-${urgency}` : undefined}
        onMouseEnter={() => onHover?.(agentKeyOf(agent))}
        onMouseLeave={() => onHover?.(null)}
        onClick={onOpen ? () => { onOpen(agentKeyOf(agent)); } : undefined}
        data-clickable={onOpen ? 'true' : undefined}
      >
        <td>
          {hasItems ? (
            <button
              type="button"
              className="row-toggle"
              // Desplegar las entregas y abrir el cajón son dos acciones distintas sobre la misma
              // fila: sin frenar la burbuja, un clic en la flecha haría las dos.
              onClick={(event) => { event.stopPropagation(); onToggle(); }}
              aria-expanded={expanded}
              aria-label={`Detalle de ${agent.alias}`}
            >
              {expanded ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
            </button>
          ) : null}
        </td>
        <td>
          <div className="identity-cell">
            {/* Un `<tr>` con `onClick` es una acción que sólo existe para el ratón. El nombre pasa
                a ser un botón real para que la misma acción esté en el tabulador; el clic en la
                fila se conserva como atajo, y por eso el botón frena la burbuja (si no, un clic
                sobre el nombre abriría el cajón dos veces). */}
            {onOpen ? (
              <button
                type="button"
                className="row-open"
                onClick={(event) => { event.stopPropagation(); onOpen(agentKeyOf(agent)); }}
              >
                {agentDisplayName(agent)}
              </button>
            ) : <strong>{agentDisplayName(agent)}</strong>}
          </div>
          <small className="subline">
            {agent.tenant_id}:{agent.alias} · <Unknown value={agent.harness_id} />
          </small>
          {agent.registered === false ? <div><Badge tone="unknown">{FLAG_LABEL.unregistered}</Badge></div> : null}
        </td>
        <td title={senales.detalle}>
          <Badge tone={senales.estado.tone}>{senales.estado.label}</Badge>
          {senales.senales.length > 0 || senales.ocultas > 0 ? (
            <div className="chip-list flag-chip-list">
              {senales.senales.map((senal) => <Badge tone={senal.tone} key={senal.clave}>{senal.label}</Badge>)}
              {senales.ocultas > 0 ? <Badge tone="unknown">+{senales.ocultas}</Badge> : null}
            </div>
          ) : null}
        </td>
        <td>
          <Badge tone={presenceTone}>{presenceLabel}</Badge>
          <small className="subline">epoch <Unknown value={agent.presence?.epoch} /></small>
        </td>
        <td>
          <strong className="mono">{agent.in_flight ?? 0}</strong>
          <small className="subline">
            {agent.started ?? 0} iniciadas · {agent.claimed_not_started ?? 0} reclamadas
            {agent.overdue_in_flight ? <span className="overdue-note"> · {agent.overdue_in_flight} vencidas</span> : null}
          </small>
        </td>
        <td>
          <strong className="mono">{agent.queued ?? 0}</strong>
          <small className="subline">
            {agent.queued_ready ?? 0} listas · {agent.retrying ?? 0} en retry
          </small>
        </td>
        <td>{formatInFlightAge(agent.oldest_in_flight_seconds)}</td>
        <td>{formatAckAge(agent.seconds_since_last_ack, ackLookbackSeconds)}</td>
        <td><Unknown value={agent.acks_recent} /></td>
      </tr>
      {expanded && hasItems ? (
        <tr className="row-detail">
          <td />
          <td colSpan={8}>
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Entregas en vuelo de {agent.alias}</caption>
                <thead>
                  <tr>
                    <th>Delivery</th><th>Origen</th><th>Lane</th><th>Estado</th><th>Intento</th>
                    <th>En vuelo desde</th><th>Deadline ACK</th><th>Último ACK</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => (
                    <tr key={item.delivery_id ?? index}>
                      <td><span className="mono">{compactId(item.delivery_id)}</span><small className="subline">msg {compactId(item.message_id)}</small></td>
                      <td><Unknown value={item.from_alias} />@<Unknown value={item.from_tenant} /><small className="subline"><Unknown value={item.origin_adapter} /></small></td>
                      <td><Unknown value={safeJobLane(item.lane)} /></td>
                      <td><Badge tone={inFlightItemTone(item.status)}><Unknown value={safeDeliveryState(item.status)} /></Badge></td>
                      <td><Unknown value={item.attempt} /></td>
                      <td>{formatInFlightAge(item.seconds_in_flight)}</td>
                      <td><Time value={item.ack_deadline_at} relativo /></td>
                      <td>{item.last_ack_at ? <Time value={item.last_ack_at} relativo /> : <span className="unknown">sin ACK</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {agent.in_flight_items_truncated ? (
              <p className="notice">
                Mostrando las {items.length} entregas en vuelo más antiguas de {agent.in_flight} totales; el resto
                comparte el mismo diagnóstico y no aporta nuevas fuentes.
              </p>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}
