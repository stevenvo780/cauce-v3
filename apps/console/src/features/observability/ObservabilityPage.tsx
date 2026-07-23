import { Activity, Gauge, RadioTower } from 'lucide-react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { EmptyState, ErrorState, LoadingState, Metric, PageHeader, Panel, RefreshButton, Time } from '../../components/ui';

export function ObservabilityPage() {
  const api = useApi();
  const resource = useResource('observability', () => api.getObservability());
  if (resource.loading && !resource.data) return <LoadingState label="Consultando observabilidad durable…" />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  const data = resource.data;
  const status = data?.status ?? {};
  const queues = data?.queues;
  const jobs = data?.jobs?.items ?? [];
  const relays = data?.origin_relays?.items ?? [];
  return <>
    <PageHeader eyebrow="Signals" title="Observability" description="Snapshot real del gateway/store. Métricas ausentes permanecen UNKNOWN; no se sintetizan señales en el browser." actions={<RefreshButton onClick={resource.reload} loading={resource.loading} />} />
    <div className="observation-line"><Activity size={16} />Observado: <Time value={data?.observed_at} /></div>
    <div className="metrics-grid">
      <Metric label="Online" value={status.online} tone="positive" detail="leases vigentes" />
      <Metric label="Queued" value={status.queued} tone="warning" detail="deliveries no terminales" />
      <Metric label="DLQ" value={status.dead_letters} tone="danger" detail="dead letters abiertas" />
      <Metric label="Outbox" value={status.outbox_pending} detail="wake + origin relay" />
    </div>
    <div className="trust-grid"><article><Gauge /><div><strong>Queues</strong><p>pending {queues?.pending ?? 'UNKNOWN'}, retry {queues?.retrying ?? 'UNKNOWN'}, dead {queues?.dead ?? 'UNKNOWN'}.</p></div></article><article><RadioTower /><div><strong>Workers</strong><p>{jobs.length} jobs y {relays.length} relays visibles.</p></div></article></div>
    <Panel title="Lanes & relays" subtitle="Estados devueltos por PostgreSQL">
      {!jobs.length && !relays.length ? <EmptyState>Capacidad o datos UNKNOWN.</EmptyState> : <pre className="config-preview">{JSON.stringify({ jobs, origin_relays: relays }, null, 2)}</pre>}
    </Panel>
  </>;
}
