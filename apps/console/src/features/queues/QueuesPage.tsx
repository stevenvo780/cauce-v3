import { ArchiveX, Clock, RotateCcw, Rows3 } from 'lucide-react';
import { useState } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import type { DeliveryState } from '../../api/types';
import { Badge, EmptyState, ErrorState, LoadingState, Metric, PageHeader, Panel, PermissionBadge, RefreshButton, Time, Unknown } from '../../components/ui';
import { compactId, permissionState, safeDeliveryState, safeJobLane } from '../../lib';

function stateTone(state?: DeliveryState | null): 'done' | 'danger' | 'warning' | 'running' | 'unknown' {
  if (state === 'done') return 'done';
  if (state === 'dead' || state === 'failed') return 'danger';
  if (state === 'retry') return 'warning';
  if (state) return 'running';
  return 'unknown';
}

export function QueuesPage() {
  const api = useApi();
  const resource = useResource('queues', () => api.getQueues());
  const access = useResource('console-access', () => api.getConsoleAccess());
  const [replaying, setReplaying] = useState<string>();
  const [notice, setNotice] = useState<string>();

  async function replay(deliveryId: string) {
    setReplaying(deliveryId);
    setNotice(undefined);
    try {
      const result = await api.replayDelivery(deliveryId);
      setNotice(result.replayed ? `Replay encolado para ${compactId(deliveryId)}` : `Replay no aplicado: ${compactId(deliveryId)}`);
      resource.reload();
    } catch (error) {
      setNotice(`Replay falló: ${error instanceof Error ? error.message : 'UNKNOWN'}`);
    } finally {
      setReplaying(undefined);
    }
  }

  if (resource.loading && !resource.data) return <LoadingState label="Leyendo queues, retries y DLQ…" />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  const snapshot = resource.data;
  const items = snapshot?.items ?? [];
  const canReplay = permissionState(access.data, 'delivery.replay') === 'allowed';

  return (
    <>
      <PageHeader eyebrow="Delivery control" title="Queues, retries & DLQ" description="Observa backoff, intentos y terminales dead. Replay solicita una transición al servidor; nunca muta estado local como verdad." actions={<RefreshButton onClick={resource.reload} loading={resource.loading} />} />
      <PermissionBadge access={access.data} permission="delivery.replay" />
      <div className="metrics-grid three">
        <Metric label="Pendientes" value={snapshot?.pending} tone="neutral" detail="disponibles o claimed" />
        <Metric label="En retry" value={snapshot?.retrying} tone="warning" detail="backoff durable" />
        <Metric label="Dead letters" value={snapshot?.dead} tone="danger" detail="requieren revisión" />
      </div>
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      <Panel title="Deliveries" subtitle={`Snapshot: ${snapshot?.observed_at ?? 'UNKNOWN'}`}>
        {items.length === 0 ? <EmptyState>No hay deliveries informadas.</EmptyState> : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Colas, retries y dead letters</caption>
              <thead><tr><th>Delivery</th><th>Destino</th><th>Lane</th><th>Estado</th><th>Intentos</th><th>Disponible</th><th>Último error</th><th>Acción</th></tr></thead>
              <tbody>
                {items.map((item, index) => {
                  const state = safeDeliveryState(item.state);
                  return <tr key={item.delivery_id ?? index}>
                    <td><span className="mono">{compactId(item.delivery_id)}</span><small className="subline">msg {compactId(item.message_id)}</small></td>
                    <td><strong><Unknown value={item.recipient_alias} /></strong><small className="subline"><Unknown value={item.tenant_id} /></small></td>
                    <td><span className="inline-icon"><Rows3 size={15} aria-hidden="true" /><Unknown value={safeJobLane(item.lane)} /></span></td>
                    <td><Badge tone={stateTone(state)}><Unknown value={state} /></Badge></td>
                    <td><Unknown value={item.attempts} /> / <Unknown value={item.max_attempts} /></td>
                    <td><span className="inline-icon"><Clock size={15} aria-hidden="true" /><Time value={item.available_at} /></span></td>
                    <td className="error-copy"><Unknown value={item.last_error} /></td>
                    <td>
                      {state === 'dead' && item.delivery_id ? (
                        <button className="button small" type="button" onClick={() => void replay(item.delivery_id!)} disabled={!canReplay || replaying === item.delivery_id} aria-label={`Replay delivery ${item.delivery_id}`}>
                          <RotateCcw size={15} aria-hidden="true" />{replaying === item.delivery_id ? 'Enviando…' : 'Replay'}
                        </button>
                      ) : <span className="muted"><ArchiveX size={15} aria-hidden="true" /> No aplica</span>}
                    </td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
