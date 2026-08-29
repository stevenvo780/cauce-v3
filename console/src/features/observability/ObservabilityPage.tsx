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
import { onNavClick } from '../../router';

/** The durable egress states, in Spanish. `sent` is decided separately: it requires `sent_at`. */
const ESTADO_RELAY: Readonly<Record<string, string>> = {
  pending: 'EN ESPERA',
  processing: 'EN CURSO',
  failed: 'FALLÓ',
};

type Tab = 'senales' | 'auditoria';

const TABS = [
  { id: 'senales' as const, label: 'Señales y relays' },
  { id: 'auditoria' as const, label: 'Auditoría' },
];

/**
 * Unified view of observability signals, origin relays and event audit.
 */
export function ObservabilityPage({ initialTab = 'senales' }: { initialTab?: Tab }) {
  const api = useApi();
  const resource = useResource('observability', () => api.getObservability());
  const relays = useResource('origin-relays', () => api.listOriginRelays());
  const [tab, setTab] = useState<Tab>(initialTab);
  const [auditQuery, setAuditQuery] = useState('');

  function reloadAll() {
    void resource.reload();
    void relays.reload();
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
  const relayItems = relays.data?.items ?? [];

  return <>
    <PageHeader
      eyebrow="Señales del gateway"
      title="Señales y auditoría"
      description="Snapshot real del gateway/store, el estado durable del egress al origen y el registro inmutable de decisiones, en una sola vista: qué pasó y quién lo autorizó. Una métrica que no llegó se dice «sin dato»; no se sintetizan señales en el browser. SENT exige sent_at; FAILED nunca se presenta como entregado."
      actions={<RefreshButton onClick={reloadAll} loading={resource.loading || relays.loading} />}
    />
    <div className="observation-line"><Activity size={16} />Observado: <Time value={data?.observed_at} /></div>
    <div className="metrics-grid">
      <Metric label="En línea" value={status.online} tone="positive" detail="leases vigentes" />
      <Metric label="En cola" value={status.queued} tone="warning" detail="entregas no terminales" />
      <Metric label="DLQ" value={status.dead_letters} tone="danger" detail="entregas muertas abiertas" />
      <Metric label="Salida pendiente" value={status.outbox_pending} detail="despertar + relay al origen" />
    </div>

    <ViewTabs tabs={TABS} active={tab} onSelect={setTab} label="Señales y auditoría" />

    {tab === 'senales' ? <ViewTabPanel id="senales">
      <div className="trust-grid">
        <article><Gauge /><div><strong>Colas</strong><p>{queues?.pending ?? 'sin dato de'} pendientes, {queues?.retrying ?? 'sin dato de'} en reintento, {queues?.dead ?? 'sin dato de'} muertas. El detalle por entrega, con reinyectar y cancelar, está en <a href="/queues" onClick={(event) => { onNavClick(event, '/queues'); }}>Queues &amp; DLQ</a>.</p></div></article>
      </div>
      <Panel title="Relays al canal de origen" subtitle="La consola observa; no ejecuta egress ni reintenta relays. Sólo los relays en los que este actor participa: GET /v3/console/origin-relays aplica la fachada de visibilidad que el snapshot de observabilidad no aplica.">
        {relays.error && !relays.data
          ? <p className="notice error" role="alert">No se pudieron leer los origin relays: {relays.error.message}. Las señales de arriba sí llegaron.</p>
          : relayItems.length === 0
            ? <EmptyState>El servidor no devolvió ningún relay visible para tu cuenta. No es «no hay relays»: es que no se ve ninguno desde acá.</EmptyState>
            : <div className="table-wrap">
              <table>
                <caption className="sr-only">Estado real de origin relays</caption>
                <thead><tr><th>Relay</th><th>Adapter</th><th>Tenant</th><th>Delivery</th><th>Estado</th><th>Intentos</th><th>Creado</th><th>Enviado</th><th>Auditoría</th></tr></thead>
                <tbody>{relayItems.map((item, index) => {
                  const state = safeOriginRelayState(item.status);
                  const actuallySent = state === 'sent' && typeof item.sent_at === 'string' && !Number.isNaN(Date.parse(item.sent_at));
                  const tone = actuallySent ? 'done' : state === 'failed' ? 'danger' : state ? 'running' : 'unknown';
                  const traceId = item.trace_id;
                  return (
                    <tr key={item.id ?? index}>
                      <td>
                        <span className="inline-icon"><RadioTower size={15} aria-hidden="true" /><span className="mono">{compactId(item.id)}</span></span>
                        {item.request_id || item.trace_id ? (
                          <small className="subline">
                            {item.request_id ? <>petición <span className="mono">{compactId(item.request_id)}</span></> : null}
                            {item.request_id && item.trace_id ? ' · ' : null}
                            {item.trace_id ? <>traza <span className="mono">{compactId(item.trace_id)}</span></> : null}
                          </small>
                        ) : (
                          <small className="subline muted">sin petición registrada</small>
                        )}
                      </td>
                      <td><Unknown value={item.adapter} /></td>
                      <td><Unknown value={item.tenant_id} /></td>
                      <td>
                        <span className="mono">{compactId(item.delivery_id)}</span>
                        {item.message_id
                          ? <small className="subline">mensaje <span className="mono">{compactId(item.message_id)}</span></small>
                          : null}
                      </td>
                      {/* `sent` without `sent_at` is NOT a missing data point: it is a server contradiction,
                          and saying "no data" would hide it. What happens is named. */}
                      <td>
                        <Badge tone={tone}>{actuallySent ? 'ENVIADO' : state === 'sent' ? 'DICE ENVIADO, SIN HORA' : <Unknown value={ESTADO_RELAY[state ?? ''] ?? state} />}</Badge>
                      </td>
                      <td><Unknown value={item.attempts} /></td>
                      <td><Time value={item.created_at} relativo /></td>
                      {/* The dash is decorative for the listener: `Unknown` is what announces the phrase. */}
                      <td>{actuallySent
                        ? <Time value={item.sent_at} relativo />
                        : <Unknown value={null} ausente="no-aplica" motivo="El servidor no informó hora de envío para este relay." />}</td>
                      <td>
                        {typeof traceId === 'string' && traceId.length > 0
                          ? <button className="button small" type="button" onClick={() => { investigate(traceId); }} aria-label={`Ver la auditoría del trace ${traceId}`}>
                            <Search size={14} aria-hidden="true" />Ver auditoría
                          </button>
                          : <span className="muted">no hay traza que abrir</span>}
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
