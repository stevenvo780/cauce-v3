import { ArchiveX, Ban, Clock, RotateCcw, Rows3 } from 'lucide-react';
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

// Los dos finales de ERROR son replayables desde este parche: 'failed' también deja fila en
// `dead_letters`. Antes el botón sólo aparecía en 'dead' y por eso 197 entregas de producción
// no tenían forma de rescate en la consola.
const replayableStates: ReadonlySet<string> = new Set(['dead', 'failed']);
// Cancelar aplica a lo que todavía está vivo: pendiente, en backoff o en manos de un adaptador.
const cancellableStates: ReadonlySet<string> = new Set(['pending', 'retry', 'leased', 'accepted', 'started']);

export function QueuesPage() {
  const api = useApi();
  const resource = useResource('queues', () => api.getQueues());
  const access = useResource('console-access', () => api.getConsoleAccess());
  const [replaying, setReplaying] = useState<string>();
  const [cancelling, setCancelling] = useState<string>();
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

  async function cancel(deliveryId: string) {
    setCancelling(deliveryId);
    setNotice(undefined);
    try {
      const result = await api.cancelDelivery(deliveryId);
      // Se dice explícitamente que sigue siendo replayable: la queja documentada del operador es
      // que cancelar a mano en la base era irreversible.
      setNotice(result.cancelled
        ? `Cancelada ${compactId(deliveryId)} (queda en DLQ, se puede replayar)`
        : `Cancelación no aplicada: ${compactId(deliveryId)}`);
      resource.reload();
    } catch (error) {
      setNotice(`Cancelación falló: ${error instanceof Error ? error.message : 'UNKNOWN'}`);
    } finally {
      setCancelling(undefined);
    }
  }

  if (resource.loading && !resource.data) return <LoadingState label="Leyendo queues, retries y DLQ…" />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  const snapshot = resource.data;
  const items = snapshot?.items ?? [];
  const canReplay = permissionState(access.data, 'delivery.replay') === 'allowed';
  const canCancel = permissionState(access.data, 'delivery.cancel') === 'allowed';

  return (
    <>
      <PageHeader eyebrow="Delivery control" title="Queues, retries & DLQ" description="Observa backoff, intentos y terminales dead. Replay y cancel solicitan una transición al servidor; nunca mutan estado local como verdad." actions={<RefreshButton onClick={resource.reload} loading={resource.loading} />} />
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
                  const deliveryId = item.delivery_id;
                  const replayable = deliveryId != null && state != null && replayableStates.has(state);
                  const cancellable = deliveryId != null && state != null && cancellableStates.has(state);
                  return <tr key={deliveryId ?? index}>
                    <td><span className="mono">{compactId(deliveryId)}</span><small className="subline">msg {compactId(item.message_id)}</small></td>
                    <td><strong><Unknown value={item.recipient_alias} /></strong><small className="subline"><Unknown value={item.tenant_id} /></small></td>
                    <td><span className="inline-icon"><Rows3 size={15} aria-hidden="true" /><Unknown value={safeJobLane(item.lane)} /></span></td>
                    <td><Badge tone={stateTone(state)}><Unknown value={state} /></Badge></td>
                    <td><Unknown value={item.attempts} /> / <Unknown value={item.max_attempts} /></td>
                    <td><span className="inline-icon"><Clock size={15} aria-hidden="true" /><Time value={item.available_at} /></span></td>
                    <td className="error-copy"><Unknown value={item.last_error} /></td>
                    <td>
                      {replayable ? (
                        <button className="button small" type="button" onClick={() => void replay(deliveryId!)} disabled={!canReplay || replaying === deliveryId} aria-label={`Replay delivery ${deliveryId}`}>
                          <RotateCcw size={15} aria-hidden="true" />{replaying === deliveryId ? 'Enviando…' : 'Replay'}
                        </button>
                      ) : cancellable ? (
                        <button className="button small" type="button" onClick={() => void cancel(deliveryId!)} disabled={!canCancel || cancelling === deliveryId} aria-label={`Cancelar delivery ${deliveryId}`}>
                          <Ban size={15} aria-hidden="true" />{cancelling === deliveryId ? 'Cancelando…' : 'Cancelar'}
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
