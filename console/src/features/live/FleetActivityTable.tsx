import { ChevronDown, ChevronRight, Flame, Search, ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  FleetActivityAgent, FleetActivityFlag, FleetActivitySnapshot, FleetActivityThresholds,
} from '../../api/types';
import { Badge, Desplazable, EmptyState, Panel, Time, Unknown } from '../../components/ui';
import { compactId, safeJobLane } from '../../lib';
import { deliveryPolicy } from '../deliveries/delivery-policy';
import {
  FLAG_LABEL, FLAG_TONE, agentDisplayName, agentKeyOf, agentRowKey, estadoDeFila,
  formatAckAge, formatInFlightAge, presenceBadge, presenciaDeLaFila,
  resumirSenales, rowUrgency, sortByUrgency,
  type EstadosVivos,
} from './activity';

/**
 * The tabular reading of `GET /v3/console/activity`.
 *
 * This **was** a route of its own ("Fleet activity") that read exactly the same endpoint as the
 * engine room and drew it differently: two menu entries, two pollings, one single question. Now it
 * is the engine room's detail panel — the hypergraph answers *who is talking to whom*, and this
 * table answers *how long each delivery has been going and whether it advances*, which is the next
 * question, not the same one. It feeds on the snapshot the page already has: it does not ask again.
 */

const FLAG_ORDER: FleetActivityFlag[] = [
  'saturated', 'ack_stalled', 'overdue_acks', 'lease_expired', 'never_connected', 'unregistered', 'queued_without_consumer',
  'claimed_not_started',
];

interface FleetActivityTableProps {
  snapshot: FleetActivitySnapshot | undefined;
  /** Alias highlighted in the hypergraph, in `tenant/alias` format. Synchronises the two halves. */
  selectedKey?: string | null;
  /** `tenant/alias` keys to which the state filter restricts the table. `null` = no filter. */
  onlyKeys?: Set<string> | null;
  /** Name of the filtered state, only to be able to say it when the filter leaves the table empty. */
  filterLabel?: string;
  /**
   * The doll's state per alias (`tenant/alias`), as derived by the page.
   *
   * This is what prevents the row and the chip from saying different things about the same agent:
   * without it, the STATE column had to translate the server's `work_state` on its own and a
   * downed alias came out "Free" because it had no work. See `estadoDeFila`.
   */
  estados?: EstadosVivos;
  onSelect?: (key: string | null) => void;
  /** Click on the row: opens that agent's drawer on the same page, without navigating. */
  onOpen?: (key: string) => void;
}

/**
 * Table of agents with search by alias and detail per delivery.
 *
 * Search is the reason this table outlasts the card grid it replaced: with fifteen dolls in one
 * drawing, finding *one* specific one by name is the only thing the graph does worse than a list.
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
        <Desplazable etiqueta="Actividad en vuelo por agente">
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
        </Desplazable>
      )}
    </Panel>
  );
}

/**
 * Active signals: `totals.flagged`.
 *
 * Kept apart from the dolls' seven states because it is **not the same partition**: an agent that
 * is saturated AND has a stalled ACK counts in both columns, so this does not add up to
 * `totals.agents` and cannot be derived from the count by state.
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

/** The three things one needs to know to avoid misreading the table. */
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
            {/* "Stalled", the same word as the chip, the verdict, the legend and this table.
                It used to say "hung", which was the old label of the STATE column. */}
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
   * Title and signals come from TWO different places on purpose, and both are needed:
   *
   *  - the TITLE comes from `estadoDeFila`, which consumes the state already derived by the page
   *    —the same object the doll paints and the chip counts—, because `work_state` and
   *    `LiveState` are different partitions and no label translation could make them match: `iza`
   *    came out "Downed" in the chip and "Free" in its row.
   *  - the SIGNALS come from `resumirSenales`, which drops those implied by something else already
   *    visible: `midas` stacked FIVE badges to say "it is stalled" and `jarvis` said "Saturated"
   *    twice.
   *
   * The summary's title is DISCARDED and that of `estadoDeFila` is used instead: two titles for
   * the same cell would again be two words for one fact.
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
      {/* Hovering the row highlights the doll in the hypergraph above: that is what ties the list
          to the drawing without having to draw the list again. */}
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
              // Expanding the deliveries and opening the drawer are two different actions on the
              // same row: without stopping the bubble, a click on the arrow would do both.
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
            {/* A `<tr>` with `onClick` is an action that only exists for the mouse. The name becomes
                a real button so the same action is reachable from the keyboard; the row click is
                kept as a shortcut, which is why the button stops the bubble (otherwise a click on
                the name would open the drawer twice). */}
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
            <Desplazable etiqueta={`Entregas en vuelo de ${agent.alias}`}>
              <table>
                <caption className="sr-only">Entregas en vuelo de {agent.alias}</caption>
                <thead>
                  <tr>
                    <th>Delivery</th><th>Origen</th><th>Lane</th><th>Estado</th><th>Intento</th>
                    <th>En vuelo desde</th><th>Deadline ACK</th><th>Último ACK</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => {
                    const policy = deliveryPolicy(item.status);
                    return <tr key={item.delivery_id ?? index}>
                      <td><span className="mono">{compactId(item.delivery_id)}</span><small className="subline">msg {compactId(item.message_id)}</small></td>
                      <td><Unknown value={item.from_alias} />@<Unknown value={item.from_tenant} /><small className="subline"><Unknown value={item.origin_adapter} /></small></td>
                      <td><Unknown value={safeJobLane(item.lane)} /></td>
                      <td><Badge tone={policy.tone}><Unknown
                        value={policy.known ? policy.label : undefined}
                        motivo={item.status && !policy.known
                          ? `El servidor mandó un estado que esta consola no conoce: ${item.status}`
                          : undefined}
                      /></Badge></td>
                      <td><Unknown value={item.attempt} /></td>
                      <td>{formatInFlightAge(item.seconds_in_flight)}</td>
                      <td><Time value={item.ack_deadline_at} relativo /></td>
                      <td>{item.last_ack_at ? <Time value={item.last_ack_at} relativo /> : <span className="unknown">sin ACK</span>}</td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </Desplazable>
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
