import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { ErrorState, LoadingState, Metric, PageHeader, Panel, PermissionBadge, RefreshButton } from '../../components/ui';
import { permissionState } from '../../lib';
import { DeliveryTable } from './DeliveryTable';

/**
 * **Queues, retries & DLQ** — el único sitio donde una entrega se mira de a una y se rescata.
 *
 * Steven preguntó el 2026-08-22 si «Queues, retries & DLQ» no era super redundante. Lo medido: NO
 * son tres vistas, son tres columnas de la misma tabla y esta ruta ya era una sola. Lo que sí
 * estaba repetido —y era lo que se veía como redundancia— es que `pending`, `retry` y `dead` se
 * dibujaban otra vez en «Observabilidad», y que el detalle por entrega estaba a punto de copiarse a
 * la vista de mensajes.
 *
 * Cómo quedó repartido, para que cada número viva en un solo sitio:
 *
 * - **Acá**: el detalle por entrega —lane, intentos, backoff, último error— y las dos únicas
 *   acciones que existen sobre una entrega, replay y cancel. Es el hogar del dato.
 * - **En «Señales y auditoría»**: los tres recuentos, pero NO como una tabla propia sino como el
 *   desglose de la métrica «Queued», y con un enlace acá. Ese panel existe por una razón que esta
 *   página no puede dar: sus cifras salen del MISMO `observed_at` que online, DLQ y outbox, o sea
 *   que se pueden comparar entre sí. Quitarlas de ahí no habría eliminado una duplicación, habría
 *   roto la única comparación instantánea de la consola.
 * - **En «Messages»**: la misma tabla, con las mismas acciones, filtrada por conversación — pero la
 *   MISMA implementación, `DeliveryTable`, no una copia. Ver el comentario de ese fichero.
 */
export function QueuesPage() {
  const api = useApi();
  const resource = useResource('queues', () => api.getQueues());
  const access = useResource('console-access', () => api.getConsoleAccess());

  if (resource.loading && !resource.data) return <LoadingState label="Leyendo queues, retries y DLQ…" />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  const snapshot = resource.data;
  const items = snapshot?.items ?? [];

  return (
    <>
      <PageHeader eyebrow="Delivery control" title="Queues, retries & DLQ" description="Observa backoff, intentos y terminales dead. Replay y cancel solicitan una transición al servidor; nunca mutan estado local como verdad." actions={<RefreshButton onClick={resource.reload} loading={resource.loading} />} />
      <PermissionBadge access={access.data} permission="delivery.replay" />
      <div className="metrics-grid three">
        <Metric label="Pendientes" value={snapshot?.pending} tone="neutral" detail="disponibles o claimed" />
        <Metric label="En retry" value={snapshot?.retrying} tone="warning" detail="backoff durable" />
        <Metric label="Dead letters" value={snapshot?.dead} tone="danger" detail="requieren revisión" />
      </div>
      <Panel title="Deliveries" subtitle={`Snapshot: ${snapshot?.observed_at ?? 'UNKNOWN'}`}>
        <DeliveryTable
          rows={items}
          canReplay={permissionState(access.data, 'delivery.replay') === 'allowed'}
          canCancel={permissionState(access.data, 'delivery.cancel') === 'allowed'}
          onChanged={resource.reload}
          empty="No hay deliveries informadas."
        />
      </Panel>
    </>
  );
}
