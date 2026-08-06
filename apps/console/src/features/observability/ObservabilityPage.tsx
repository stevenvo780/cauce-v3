import { Activity, Gauge, RadioTower } from 'lucide-react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import {
  Badge, EmptyState, ErrorState, LoadingState, Metric, PageHeader, Panel, RefreshButton, Time, Unknown,
} from '../../components/ui';
import { compactId, safeOriginRelayState } from '../../lib';

/**
 * **Observabilidad y relays** — las señales del gateway y el camino de vuelta al origen.
 *
 * Hasta el 2026-08-06 "Origin relays" era una ruta propia. `GET /v3/console/observability` ya traía
 * los mismos relays y esta página los escupía como `JSON.stringify`, o sea la misma información
 * dibujada dos veces y peor en una de las dos. Ahora hay una sola entrada de menú y una sola tabla.
 *
 * 🔴 **La tabla se alimenta de `GET /v3/console/origin-relays`, NO del snapshot de observabilidad**,
 * y eso no es un detalle de implementación: medido en `services/gateway/src/app.ts`, la ruta
 * dedicada devuelve `visibleOriginRelays(...)` —la fachada que deja pasar sólo los relays en los que
 * el actor participa— mientras que `/v3/console/observability` devuelve las filas **sin fachada**.
 * El `<pre>` que se quitó estaba mostrando relays y jobs de otros tenants que las vistas propias
 * filtran a propósito. Por eso el volcado no se conserva ni "por si acaso": era el defecto.
 *
 * Los jobs quedan en su vista (`/jobs`), que los rinde por lane y también pasa por fachada
 * (`sameTenantRows`); acá se conserva sólo el recuento, que es lo que aporta un panel de señales.
 * Las cuatro métricas de arriba salen del MISMO instante (`observed_at`) — ésa es la única razón
 * por la que esta vista existe teniendo `/fleet` y `/queues` los mismos números por separado.
 */
export function ObservabilityPage() {
  const api = useApi();
  const resource = useResource('observability', () => api.getObservability());
  const relays = useResource('origin-relays', () => api.listOriginRelays());

  function reloadAll() {
    resource.reload();
    relays.reload();
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
      title="Observabilidad y relays"
      description="Snapshot real del gateway/store más el estado durable del egress al origen. Métricas ausentes permanecen UNKNOWN; no se sintetizan señales en el browser. SENT exige sent_at; FAILED nunca se presenta como entregado."
      actions={<RefreshButton onClick={reloadAll} loading={resource.loading || relays.loading} />}
    />
    <div className="observation-line"><Activity size={16} />Observado: <Time value={data?.observed_at} /></div>
    <div className="metrics-grid">
      <Metric label="Online" value={status.online} tone="positive" detail="leases vigentes" />
      <Metric label="Queued" value={status.queued} tone="warning" detail="deliveries no terminales" />
      <Metric label="DLQ" value={status.dead_letters} tone="danger" detail="dead letters abiertas" />
      <Metric label="Outbox" value={status.outbox_pending} detail="wake + origin relay" />
    </div>
    <div className="trust-grid">
      <article><Gauge /><div><strong>Queues</strong><p>pending {queues?.pending ?? 'UNKNOWN'}, retry {queues?.retrying ?? 'UNKNOWN'}, dead {queues?.dead ?? 'UNKNOWN'}. El detalle por delivery, con replay y cancel, está en «Queues &amp; DLQ».</p></div></article>
      <article><RadioTower /><div><strong>Workers</strong><p>{jobs.length} jobs en el snapshot del gateway; el detalle por lane está en «Jobs». {relayItems.length} relays al origen, abajo.</p></div></article>
    </div>
    <Panel title="Relays al canal de origen" subtitle="La consola observa; no ejecuta egress ni reintenta relays. Sólo los relays en los que este actor participa: GET /v3/console/origin-relays aplica la fachada de visibilidad que el snapshot de observabilidad no aplica.">
      {relays.error && !relays.data
        ? <p className="notice error" role="alert">No se pudieron leer los origin relays: {relays.error.message}. Las señales de arriba sí llegaron.</p>
        : relayItems.length === 0
          ? <EmptyState>No hay origin relays visibles. Estado: UNKNOWN.</EmptyState>
          : <div className="table-wrap">
            <table>
              <caption className="sr-only">Estado real de origin relays</caption>
              <thead><tr><th>Relay</th><th>Adapter</th><th>Tenant</th><th>Delivery</th><th>Estado</th><th>Intentos</th><th>Creado</th><th>Enviado</th></tr></thead>
              <tbody>{relayItems.map((item, index) => {
                const state = safeOriginRelayState(item.status);
                const actuallySent = state === 'sent' && typeof item.sent_at === 'string' && !Number.isNaN(Date.parse(item.sent_at));
                const tone = actuallySent ? 'done' : state === 'failed' ? 'danger' : state ? 'running' : 'unknown';
                return (
                  <tr key={item.id ?? index}>
                    <td>
                      <span className="inline-icon"><RadioTower size={15} aria-hidden="true" /><span className="mono">{compactId(item.id)}</span></span>
                      {/* request_id y trace_id sólo se veían en el volcado JSON que esta fusión quitó.
                          Son las dos claves con las que un relay se cruza contra Audit y contra la
                          cadena de delegación, así que bajan a la tabla en vez de perderse. */}
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
                  </tr>
                );
              })}</tbody>
            </table>
          </div>}
    </Panel>
  </>;
}
