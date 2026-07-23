import { RadioTower } from 'lucide-react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel, RefreshButton, Time, Unknown } from '../../components/ui';
import { compactId, safeOriginRelayState } from '../../lib';

export function RelaysPage() {
  const api = useApi();
  const resource = useResource('origin-relays', () => api.listOriginRelays());
  if (resource.loading && !resource.data) return <LoadingState label="Leyendo origin relays durables…" />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  const items = resource.data?.items ?? [];

  return (
    <>
      <PageHeader eyebrow="Return path" title="Origin relays" description="Estados durables observados del egress al origen. SENT exige sent_at; FAILED nunca se presenta como entregado." actions={<RefreshButton onClick={resource.reload} loading={resource.loading} />} />
      <Panel title="Relays al canal de origen" subtitle="La consola observa; no ejecuta egress ni reintenta relays.">
        {items.length === 0 ? <EmptyState>No hay origin relays visibles. Estado: UNKNOWN.</EmptyState> : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Estado real de origin relays</caption>
              <thead><tr><th>Relay</th><th>Adapter</th><th>Tenant</th><th>Delivery</th><th>Estado</th><th>Intentos</th><th>Creado</th><th>Enviado</th></tr></thead>
              <tbody>{items.map((item, index) => {
                const status = safeOriginRelayState(item.status);
                const actuallySent = status === 'sent' && typeof item.sent_at === 'string' && !Number.isNaN(Date.parse(item.sent_at));
                const tone = actuallySent ? 'done' : status === 'failed' ? 'danger' : status ? 'running' : 'unknown';
                return (
                  <tr key={item.id ?? index}>
                    <td><span className="inline-icon"><RadioTower size={15} aria-hidden="true" /><span className="mono">{compactId(item.id)}</span></span></td>
                    <td><Unknown value={item.adapter} /></td>
                    <td><Unknown value={item.tenant_id} /></td>
                    <td><span className="mono">{compactId(item.delivery_id)}</span></td>
                    <td><Badge tone={tone}>{actuallySent ? 'SENT' : status === 'sent' ? 'UNKNOWN' : <Unknown value={status} />}</Badge></td>
                    <td><Unknown value={item.attempts} /></td>
                    <td><Time value={item.created_at} /></td>
                    <td><Time value={actuallySent ? item.sent_at : null} /></td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
