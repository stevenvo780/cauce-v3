import { ChevronDown, ChevronRight, Flame, Search, ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  FleetActivityAgent, FleetActivityFlag, FleetActivitySnapshot, FleetActivityThresholds,
} from '../../api/types';
import { Badge, EmptyState, Panel, Time, Unknown } from '../../components/ui';
import { compactId, safeDeliveryState, safeJobLane } from '../../lib';
import {
  FLAG_LABEL, FLAG_TONE, WORK_STATE_LABEL, WORK_STATE_TONE, agentDisplayName, agentKeyOf, agentRowKey,
  formatAckAge, formatInFlightAge, inFlightItemTone, presenceBadge, rowUrgency, sortByUrgency,
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
  onSelect?: (key: string | null) => void;
}

/**
 * Tabla de agentes con búsqueda por alias y detalle por entrega.
 *
 * La búsqueda es la razón por la que esta tabla sobrevive a la grilla de tarjetas que había antes:
 * con quince muñecos en un dibujo, encontrar a *uno* concreto por nombre es lo único que el grafo
 * hace peor que una lista.
 */
export function FleetActivityTable({ snapshot, selectedKey, onlyKeys, filterLabel, onSelect }: FleetActivityTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');

  const thresholds = snapshot?.thresholds;
  const agents = useMemo(() => {
    let ordered = sortByUrgency(snapshot?.agents ?? []);
    if (onlyKeys) ordered = ordered.filter((agent) => onlyKeys.has(agentKeyOf(agent)));
    const needle = query.trim().toLowerCase();
    if (!needle) return ordered;
    return ordered.filter((agent) => `${agent.tenant_id} ${agent.alias} ${agent.display_name ?? ''} ${agent.harness_id ?? ''}`
      .toLowerCase().includes(needle));
  }, [snapshot, query, onlyKeys]);

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
      subtitle="Ordenados por urgencia (colgado > saturado > trabajando > en cola > inactivo), no alfabéticamente: lo que hace ruido tiene que quedar arriba. Es la misma lectura del hipergrafo de arriba, en números; no dibuja las delegaciones otra vez."
    >
      <label className="activity-search">
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder="Buscar alias, tenant o arnés…"
          aria-label="Buscar un agente por alias"
          onChange={(event) => setQuery(event.target.value)}
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
                const urgency = rowUrgency(agent.work_state);
                const presence = presenceBadge(agent);
                const items = agent.in_flight_items ?? [];
                const isExpanded = expanded.has(key);
                return (
                  <FragmentRow
                    key={key}
                    agent={agent}
                    urgency={urgency}
                    presenceLabel={presence.label}
                    presenceTone={presence.tone}
                    expanded={isExpanded}
                    onToggle={() => toggle(key)}
                    items={items}
                    ackLookbackSeconds={thresholds?.ack_lookback_seconds}
                    highlighted={selectedKey === agentKeyOf(agent)}
                    onHover={onSelect}
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
          <strong>En vuelo vs. avanzando</strong>
          <p>
            in_flight cuenta cuánto tomó el agente; acks_recent y "último ACK" dicen si avanza. 41 en vuelo con
            acks_recent=0 es un incendio; 3 en vuelo con acks_recent=9 es sano — son los dos números que motivaron
            este panel.
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
            Saturación desde {thresholds?.saturation_in_flight ?? 'UNKNOWN'} en vuelo; colgado tras{' '}
            {thresholds?.stall_after_seconds ?? 'UNKNOWN'}s sin ACK aplicado. La UI no hardcodea estos números.
          </p>
        </div>
      </article>
    </div>
  );
}

function FragmentRow({ agent, urgency, presenceLabel, presenceTone, expanded, onToggle, items, ackLookbackSeconds, highlighted, onHover }: {
  agent: FleetActivityAgent;
  urgency: 'critical' | 'warning' | undefined;
  presenceLabel: string;
  presenceTone: 'online' | 'done' | 'running' | 'warning' | 'danger' | 'offline' | 'unknown' | 'info';
  expanded: boolean;
  onToggle: () => void;
  items: NonNullable<FleetActivityAgent['in_flight_items']>;
  ackLookbackSeconds: number | null | undefined;
  highlighted?: boolean;
  onHover?: (key: string | null) => void;
}) {
  const state = agent.work_state ?? undefined;
  const stateLabel = state ? WORK_STATE_LABEL[state] : 'UNKNOWN';
  const stateTone = state ? WORK_STATE_TONE[state] : 'unknown';
  const flags = agent.flags ?? [];
  const hasItems = items.length > 0;
  return (
    <>
      {/* Pasar el puntero por la fila resalta al muñeco en el hipergrafo de arriba: es lo que ata
          la lista al dibujo sin tener que dibujar la lista otra vez. */}
      <tr
        data-state={agent.work_state ?? 'unknown'}
        data-urgency={urgency}
        data-highlighted={highlighted ? 'true' : undefined}
        className={urgency ? `row-${urgency}` : undefined}
        onMouseEnter={() => onHover?.(agentKeyOf(agent))}
        onMouseLeave={() => onHover?.(null)}
      >
        <td>
          {hasItems ? (
            <button type="button" className="row-toggle" onClick={onToggle} aria-expanded={expanded} aria-label={`Detalle de ${agent.alias}`}>
              {expanded ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
            </button>
          ) : null}
        </td>
        <td>
          <div className="identity-cell">
            <strong>{agentDisplayName(agent)}</strong>
          </div>
          <small className="subline">
            {agent.tenant_id}:{agent.alias} · <Unknown value={agent.harness_id} />
          </small>
          {agent.registered === false ? <div><Badge tone="unknown">{FLAG_LABEL.unregistered}</Badge></div> : null}
        </td>
        <td>
          <Badge tone={stateTone}>{stateLabel}</Badge>
          {flags.length > 0 ? (
            <div className="chip-list flag-chip-list">
              {flags.map((flag) => <Badge tone={FLAG_TONE[flag]} key={flag}>{FLAG_LABEL[flag]}</Badge>)}
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
                      <td><Unknown value={item.from_alias} />@<Unknown value={item.from_tenant} /><small className="subline">{item.origin_adapter ?? 'UNKNOWN'}</small></td>
                      <td><Unknown value={safeJobLane(item.lane)} /></td>
                      <td><Badge tone={inFlightItemTone(item.status)}><Unknown value={safeDeliveryState(item.status)} /></Badge></td>
                      <td><Unknown value={item.attempt} /></td>
                      <td>{formatInFlightAge(item.seconds_in_flight)}</td>
                      <td><Time value={item.ack_deadline_at} /></td>
                      <td>{item.last_ack_at ? <Time value={item.last_ack_at} /> : <span className="unknown">sin ACK</span>}</td>
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
