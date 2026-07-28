import { ChevronDown, ChevronRight, Flame, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import type { FleetActivityAgent, FleetActivityFlag, FleetWorkState } from '../../api/types';
import {
  Badge, EmptyState, ErrorState, LoadingState, Metric, PageHeader, Panel, RefreshButton, Time, Unknown,
} from '../../components/ui';
import { compactId, safeDeliveryState, safeJobLane } from '../../lib';
import {
  FLAG_LABEL, FLAG_TONE, WORK_STATE_LABEL, WORK_STATE_TONE, agentDisplayName, agentRowKey,
  formatAckAge, formatInFlightAge, inFlightItemTone, presenceBadge, rowUrgency, sortByUrgency,
} from './activity';

const REFRESH_MS = 10_000;
const WORK_STATE_ORDER: FleetWorkState[] = ['stalled', 'saturated', 'working', 'queued', 'idle'];
const FLAG_ORDER: FleetActivityFlag[] = [
  'saturated', 'ack_stalled', 'overdue_acks', 'lease_expired', 'never_connected', 'unregistered', 'queued_without_consumer',
];

export function ActivityPage() {
  const api = useApi();
  const resource = useResource('fleet-activity', () => api.getFleetActivity());
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = window.setInterval(resource.reload, REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [autoRefresh, resource.reload]);

  if (resource.loading && !resource.data) return <LoadingState label="Leyendo entregas en vuelo de toda la flota…" />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;

  const snapshot = resource.data;
  const agents = sortByUrgency(snapshot?.agents ?? []);
  const totals = snapshot?.totals;
  const thresholds = snapshot?.thresholds;

  function toggle(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  return (
    <>
      <PageHeader
        eyebrow="Runtime"
        title="Actividad de la flota"
        description="GET /v3/console/activity: entregas en vuelo, en cola y renovación de ACK por alias, agregadas en vivo desde deliveries/delivery_acks/connection_leases para los tenants que este actor puede leer (mismas aristas allow_read que Fleet & Topología). Nunca incluye el cuerpo de un mensaje, un resultado ni un error: para eso está Messages/Chains."
        actions={<RefreshButton onClick={resource.reload} loading={resource.loading} />}
      />
      {resource.error ? (
        <p className="notice error" role="alert">
          La última actualización falló ({resource.error.message}); mostrando el último snapshot bueno.
        </p>
      ) : null}
      <label className="auto-refresh-toggle">
        <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
        Auto-refrescar cada {REFRESH_MS / 1000}s
      </label>

      <div className="metrics-grid">
        <Metric label="Agentes visibles" value={totals?.agents} detail="propio tenant + ACL allow_read" />
        <Metric label="En vuelo" value={totals?.in_flight} tone="warning" detail="leased + accepted + started" />
        <Metric label="En cola" value={totals?.queued} detail="pending + retry" />
        <Metric label="Vencidas en vuelo" value={totals?.overdue_in_flight} tone="danger" detail="ack_deadline_at ya pasó" />
      </div>

      <Panel title="Por estado" subtitle="totals.by_state es excluyente: cada agente cuenta en exactamente un balde y suma a totals.agents.">
        <div className="chip-list">
          {WORK_STATE_ORDER.map((state) => (
            <span className="chip" key={state}>
              <Badge tone={WORK_STATE_TONE[state]}>{WORK_STATE_LABEL[state]}</Badge> {totals?.by_state?.[state] ?? 0}
            </span>
          ))}
        </div>
      </Panel>

      <Panel title="Señales activas" subtitle="totals.flagged es acumulativo: un mismo agente saturado y con ACK detenido cuenta en las dos columnas, así que esto NO suma a totals.agents.">
        {!totals?.flagged || FLAG_ORDER.every((flag) => !totals.flagged?.[flag]) ? (
          <EmptyState>Ninguna señal activa: no hay agentes saturados, colgados ni con lease vencido.</EmptyState>
        ) : (
          <div className="chip-list">
            {FLAG_ORDER.filter((flag) => (totals.flagged?.[flag] ?? 0) > 0).map((flag) => (
              <span className="chip" key={flag}>
                <Badge tone={FLAG_TONE[flag]}>{FLAG_LABEL[flag]}</Badge> {totals.flagged?.[flag]}
              </span>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="Agentes"
        subtitle="Ordenados por urgencia (colgado > saturado > trabajando > en cola > inactivo), no alfabéticamente: lo que hace ruido tiene que quedar arriba."
      >
        {agents.length === 0 ? (
          <EmptyState>Ningún alias visible: ni configurado, ni con entregas abiertas, ni con lease reciente.</EmptyState>
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
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

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
    </>
  );
}

function FragmentRow({ agent, urgency, presenceLabel, presenceTone, expanded, onToggle, items, ackLookbackSeconds }: {
  agent: FleetActivityAgent;
  urgency: 'critical' | 'warning' | undefined;
  presenceLabel: string;
  presenceTone: 'online' | 'done' | 'running' | 'warning' | 'danger' | 'offline' | 'unknown' | 'info';
  expanded: boolean;
  onToggle: () => void;
  items: NonNullable<FleetActivityAgent['in_flight_items']>;
  ackLookbackSeconds: number | null | undefined;
}) {
  const state = agent.work_state ?? undefined;
  const stateLabel = state ? WORK_STATE_LABEL[state] : 'UNKNOWN';
  const stateTone = state ? WORK_STATE_TONE[state] : 'unknown';
  const flags = agent.flags ?? [];
  const hasItems = items.length > 0;
  return (
    <>
      <tr data-state={agent.work_state ?? 'unknown'} data-urgency={urgency} className={urgency ? `row-${urgency}` : undefined}>
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
