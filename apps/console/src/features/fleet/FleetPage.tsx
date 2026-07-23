import { Activity, Clock3, Cpu, Server } from 'lucide-react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { Badge, EmptyState, ErrorState, LoadingState, Metric, PageHeader, Panel, RefreshButton, Time, Unknown } from '../../components/ui';
import { leaseExpiry, leaseState } from '../../lib';

export function FleetPage() {
  const api = useApi();
  const resource = useResource('status', () => api.getStatus());

  if (resource.loading && !resource.data) return <LoadingState label="Consultando leases y epochs…" />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;

  const status = resource.data;
  const presence = status?.presence ?? [];
  const live = status?.presence ? presence.filter((item) => leaseState(leaseExpiry(item)) === 'online').length : null;

  return (
    <>
      <PageHeader
        eyebrow="Runtime"
        title="Fleet & presencia"
        description="Presencia derivada localmente de lease_expires_at/lease_until. El flag online recibido no se usa como autoridad."
        actions={<RefreshButton onClick={resource.reload} loading={resource.loading} />}
      />
      <div className="metrics-grid">
        <Metric label="Leases vigentes" value={live} tone="positive" detail="expiry > reloj actual" />
        <Metric label="En cola" value={status?.queued} tone="warning" detail="pending + retry + claimed" />
        <Metric label="DLQ abierta" value={status?.dead_letters} tone="danger" detail="sin resolver" />
        <Metric label="Outbox pendiente" value={status?.outbox_pending} detail={`API ${status?.version ?? 'UNKNOWN'}`} />
      </div>
      <Panel title="Consumers observados" subtitle="Epoch y vencimiento son datos del servidor; nunca se infieren desde una sesión de UI.">
        {presence.length === 0 ? <EmptyState>No hay leases informados. Presencia: UNKNOWN.</EmptyState> : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Presencia de consumers por lease</caption>
              <thead><tr><th>Consumer</th><th>Tenant</th><th>Estado</th><th>Epoch</th><th>Instance</th><th>Heartbeat</th><th>Lease vence</th><th>Capabilities</th></tr></thead>
              <tbody>
                {presence.map((item, index) => {
                  const expiry = leaseExpiry(item);
                  const state = leaseState(expiry);
                  return (
                    <tr key={`${item.tenant_id ?? 'unknown'}:${item.alias ?? index}`}>
                      <td><div className="identity-cell"><span className="icon-box"><Cpu size={16} aria-hidden="true" /></span><strong><Unknown value={item.alias} /></strong></div></td>
                      <td><Unknown value={item.tenant_id} /></td>
                      <td>
                        <Badge tone={state === 'online' ? 'online' : state === 'expired' ? 'offline' : 'unknown'}>
                          {state === 'online' ? 'ONLINE' : state === 'expired' ? 'EXPIRADO' : 'UNKNOWN'}
                        </Badge>
                      </td>
                      <td><span className="mono"><Unknown value={item.epoch} /></span></td>
                      <td><span className="mono"><Unknown value={item.instance_id} /></span></td>
                      <td><Time value={item.last_heartbeat_at} /></td>
                      <td><Time value={expiry} /></td>
                      <td><div className="chip-list">{item.capabilities?.length ? item.capabilities.map((capability) => <span className="chip" key={capability}>{capability}</span>) : <span className="unknown">UNKNOWN</span>}</div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <div className="explain-grid">
        <article><Activity aria-hidden="true" /><div><strong>Lease real</strong><p>Un heartbeat no alcanza: la fecha de expiración debe seguir vigente.</p></div></article>
        <article><Clock3 aria-hidden="true" /><div><strong>Fencing por epoch</strong><p>Epoch ausente o inválido se muestra como UNKNOWN; no se reemplaza por cero.</p></div></article>
        <article><Server aria-hidden="true" /><div><strong>Solo observación</strong><p>La consola no mantiene presencia, sockets de consumers ni estado durable.</p></div></article>
      </div>
    </>
  );
}
