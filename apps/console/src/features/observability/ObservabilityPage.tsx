import { Activity, Gauge, RadioTower, Search } from 'lucide-react';
import { useState } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import {
  Badge, EmptyState, ErrorState, LoadingState, Metric, PageHeader, Panel, RefreshButton, Time,
  Unknown, ViewTabPanel, ViewTabs,
} from '../../components/ui';
import { compactId, safeOriginRelayState } from '../../lib';
import { AuditPanel } from '../audit/AuditPanel';
import { onNavClick } from '../../navigation';

type Tab = 'senales' | 'auditoria';

const TABS = [
  { id: 'senales' as const, label: 'Señales y relays' },
  { id: 'auditoria' as const, label: 'Auditoría' },
];

/**
 * **Señales y auditoría** — las señales del gateway, el camino de vuelta al origen y quién decidió
 * qué, en una sola vista.
 *
 * Steven, 2026-08-22: *«/observability y /audit deberían ser la misma vista»*. Tenía razón y el
 * código ya lo admitía: el comentario que estaba acá decía que `request_id` y `trace_id` bajaban a
 * la tabla de relays **«para cruzarlos contra Audit»**. Una investigación que la propia consola
 * documenta como un cruce entre dos pantallas es una investigación partida en dos por accidente. Y
 * las dos leían del mismo gateway el mismo incidente visto desde dos lados: qué pasó (señales) y
 * quién lo autorizó (auditoría).
 *
 * **Por qué sobrevive `/observability` y no `/audit`.** `/relays` ya redirige acá desde el
 * 2026-08-06. Si ganara `audit`, esa redirección habría que repuntarla también, y una redirección
 * encadenada —`relays` → `observability` → `audit`— NO funciona: `matchRoute` resuelve `ROUTE_ALIASES`
 * una sola vez, así que `relays` habría caído al fallback. `/audit` queda como alias plano.
 *
 * **Qué gana el operador, además de una entrada de menú menos.** Las cuatro métricas —que salen del
 * MISMO `observed_at`, la única razón por la que esta vista existe teniendo `/queues` y la portada
 * los mismos números por separado— quedan FUERA de las pestañas, visibles se mire lo que se mire. Y
 * cada relay trae un botón que abre la auditoría filtrada por su `trace_id`: el cruce que antes era
 * copiar un identificador y cambiar de pestaña del navegador ahora es un clic.
 *
 * 🔴 **La tabla se alimenta de `GET /v3/console/origin-relays`, NO del snapshot de observabilidad**:
 * medido en `services/gateway/src/app.ts`, la ruta dedicada devuelve `visibleOriginRelays(...)` —la
 * fachada que deja pasar sólo los relays en los que el actor participa— mientras que
 * `/v3/console/observability` devuelve las filas **sin fachada**.
 *
 * La auditoría se monta sólo cuando su pestaña está activa: `useResource` pide al montar, así que
 * `GET /v3/console/audit` no se dispara en cada visita a las señales. El texto del buscador vive
 * acá, no dentro del panel, para que cambiar de pestaña no lo pierda.
 */
export function ObservabilityPage() {
  const api = useApi();
  const resource = useResource('observability', () => api.getObservability());
  const relays = useResource('origin-relays', () => api.listOriginRelays());
  const [tab, setTab] = useState<Tab>('senales');
  const [auditQuery, setAuditQuery] = useState('');

  function reloadAll() {
    resource.reload();
    relays.reload();
  }

  function investigate(traceId: string) {
    setAuditQuery(traceId);
    setTab('auditoria');
  }

  if (resource.loading && !resource.data) return <LoadingState label="Consultando observabilidad durable…" />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={reloadAll} />;

  const data = resource.data;
  const status = data?.status ?? {};
  const queues = data?.queues;
  const jobs = data?.jobs?.items ?? [];
  const relayItems = relays.data?.items ?? [];

  return <>
    <PageHeader
      eyebrow="Signals"
      title="Señales y auditoría"
      description="Snapshot real del gateway/store, el estado durable del egress al origen y el registro inmutable de decisiones, en una sola vista: qué pasó y quién lo autorizó. Métricas ausentes permanecen UNKNOWN; no se sintetizan señales en el browser. SENT exige sent_at; FAILED nunca se presenta como entregado."
      actions={<RefreshButton onClick={reloadAll} loading={resource.loading || relays.loading} />}
    />
    <div className="observation-line"><Activity size={16} />Observado: <Time value={data?.observed_at} /></div>
    {/* Las cuatro métricas quedan fuera de las pestañas: salen del mismo instante y compararlas
        entre sí es lo único que esta vista hace y ninguna otra puede. Esconder la mitad detrás de
        una pestaña rompería justamente eso. */}
    <div className="metrics-grid">
      <Metric label="Online" value={status.online} tone="positive" detail="leases vigentes" />
      <Metric label="Queued" value={status.queued} tone="warning" detail="deliveries no terminales" />
      <Metric label="DLQ" value={status.dead_letters} tone="danger" detail="dead letters abiertas" />
      <Metric label="Outbox" value={status.outbox_pending} detail="wake + origin relay" />
    </div>

    <ViewTabs tabs={TABS} active={tab} onSelect={setTab} label="Señales y auditoría" />

    {tab === 'senales' ? <ViewTabPanel id="senales">
      <div className="trust-grid">
        {/* Desglose de la métrica «Queued» de arriba, del mismo observed_at — no una segunda tabla
            de colas. El detalle por entrega, con replay y cancel, vive SÓLO en «Queues & DLQ», y se
            va desde acá con un enlace en vez de con el nombre de la vista escrito en prosa. */}
        <article><Gauge /><div><strong>Queues</strong><p>pending {queues?.pending ?? 'UNKNOWN'}, retry {queues?.retrying ?? 'UNKNOWN'}, dead {queues?.dead ?? 'UNKNOWN'}. El detalle por delivery, con replay y cancel, está en <a href="/queues" onClick={(event) => onNavClick(event, '/queues')}>Queues &amp; DLQ</a>.</p></div></article>
        <article><RadioTower /><div><strong>Workers</strong><p>{jobs.length} jobs en el snapshot del gateway; el detalle por lane está en <a href="/jobs" onClick={(event) => onNavClick(event, '/jobs')}>Jobs</a>. {relayItems.length} relays al origen, abajo.</p></div></article>
      </div>
      <Panel title="Relays al canal de origen" subtitle="La consola observa; no ejecuta egress ni reintenta relays. Sólo los relays en los que este actor participa: GET /v3/console/origin-relays aplica la fachada de visibilidad que el snapshot de observabilidad no aplica.">
        {relays.error && !relays.data
          ? <p className="notice error" role="alert">No se pudieron leer los origin relays: {relays.error.message}. Las señales de arriba sí llegaron.</p>
          : relayItems.length === 0
            ? <EmptyState>No hay origin relays visibles. Estado: UNKNOWN.</EmptyState>
            : <div className="table-wrap">
              <table>
                <caption className="sr-only">Estado real de origin relays</caption>
                <thead><tr><th>Relay</th><th>Adapter</th><th>Tenant</th><th>Delivery</th><th>Estado</th><th>Intentos</th><th>Creado</th><th>Enviado</th><th>Auditoría</th></tr></thead>
                <tbody>{relayItems.map((item, index) => {
                  const state = safeOriginRelayState(item.status);
                  const actuallySent = state === 'sent' && typeof item.sent_at === 'string' && !Number.isNaN(Date.parse(item.sent_at));
                  const tone = actuallySent ? 'done' : state === 'failed' ? 'danger' : state ? 'running' : 'unknown';
                  return (
                    <tr key={item.id ?? index}>
                      <td>
                        <span className="inline-icon"><RadioTower size={15} aria-hidden="true" /><span className="mono">{compactId(item.id)}</span></span>
                        {/* request_id y trace_id sólo se veían en el volcado JSON que la fusión de
                            2026-08-06 quitó. Son las dos claves con las que un relay se cruza contra
                            la auditoría, así que bajaron a la tabla en vez de perderse — y desde el
                            2026-08-22 el cruce se hace con el botón de la última columna. */}
                        <small className="subline">req <span className="mono">{compactId(item.request_id)}</span> · trace <span className="mono">{compactId(item.trace_id)}</span></small>
                      </td>
                      <td><Unknown value={item.adapter} /></td>
                      <td><Unknown value={item.tenant_id} /></td>
                      <td>
                        <span className="mono">{compactId(item.delivery_id)}</span>
                        <small className="subline">msg <span className="mono">{compactId(item.message_id)}</span></small>
                      </td>
                      <td><Badge tone={tone}>{actuallySent ? 'SENT' : state === 'sent' ? 'UNKNOWN' : <Unknown value={state} />}</Badge></td>
                      <td><Unknown value={item.attempts} /></td>
                      <td><Time value={item.created_at} /></td>
                      <td><Time value={actuallySent ? item.sent_at : null} /></td>
                      <td>
                        {typeof item.trace_id === 'string' && item.trace_id
                          ? <button className="button small" type="button" onClick={() => investigate(item.trace_id!)} aria-label={`Ver la auditoría del trace ${item.trace_id}`}>
                            <Search size={14} aria-hidden="true" />Ver auditoría
                          </button>
                          : <span className="muted">sin trace</span>}
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>}
      </Panel>
    </ViewTabPanel> : null}

    {tab === 'auditoria' ? <ViewTabPanel id="auditoria">
      <AuditPanel query={auditQuery} onQuery={setAuditQuery} />
    </ViewTabPanel> : null}
  </>;
}
