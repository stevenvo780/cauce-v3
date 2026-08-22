import { useSyncExternalStore } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { ErrorState, LoadingState, Metric, PageHeader, Panel, PermissionBadge, RefreshButton } from '../../components/ui';
import { compactId, permissionState } from '../../lib';
import { DeliveryTable } from './DeliveryTable';
import { enfocarEntrega, leerEntregaPedida, TEXTO_AUSENTE } from './foco-de-entrega';

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
 *
 * 🔴 **`?delivery=<uuid>` es un destino de verdad desde el 2026-08-22.** El cajón de «La flota
 * ahora» lo enlazaba desde `d3411de` y esta página no leía `location.search`: se aterrizaba en la
 * lista genérica, sin el id por ningún lado y sin una fila marcada. Ver `foco-de-entrega.ts`, que
 * es también donde está escrito lo que la consola NO puede saber cuando la entrega no figura.
 */
export function QueuesPage() {
  const api = useApi();
  const resource = useResource('queues', () => api.getQueues());
  const access = useResource('console-access', () => api.getConsoleAccess());
  /**
   * `useSyncExternalStore` y no una lectura suelta: `App` se re-renderiza cuando cambia el
   * *pathname*, y llegar acá desde otro `?delivery=` NO lo cambia. Sin suscribirse a `popstate`,
   * el segundo enlace profundo seguido dejaría la pantalla mostrando la entrega del primero.
   * El snapshot es un string, o sea un primitivo estable: devolver un objeto nuevo en cada
   * lectura haría bucle infinito.
   */
  const search = useSyncExternalStore(suscribirseAlHistorial, () => window.location.search, () => '');
  const pedida = leerEntregaPedida(search);

  if (resource.loading && !resource.data) return <LoadingState label="Leyendo queues, retries y DLQ…" />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  const snapshot = resource.data;
  const items = snapshot?.items ?? [];
  const foco = enfocarEntrega(items, pedida);

  return (
    <>
      <PageHeader eyebrow="Delivery control" title="Queues, retries & DLQ" description="Observa backoff, intentos y terminales dead. Replay y cancel solicitan una transición al servidor; nunca mutan estado local como verdad." actions={<RefreshButton onClick={resource.reload} loading={resource.loading} />} />
      <PermissionBadge access={access.data} permission="delivery.replay" />
      <div className="metrics-grid three">
        <Metric label="Pendientes" value={snapshot?.pending} tone="neutral" detail="disponibles o claimed" />
        <Metric label="En retry" value={snapshot?.retrying} tone="warning" detail="backoff durable" />
        <Metric label="Dead letters" value={snapshot?.dead} tone="danger" detail="requieren revisión" />
      </div>

      {/* El id pedido se escribe COMPLETO, no compactado: es lo que el operador tiene que poder
          comparar contra el que traía en el enlace, y `compactId` le come el medio. */}
      {foco.estado === 'encontrada' ? (
        <p className="notice" role="status">
          Filtrado a la entrega <span className="mono">{foco.deliveryId}</span> ({compactId(foco.deliveryId)}), la
          que venías siguiendo desde «La flota ahora».{' '}
          <button type="button" className="button small secondary" onClick={quitarElFoco}>Ver todas las entregas</button>
        </p>
      ) : null}
      {foco.estado === 'ausente' ? (
        <p className="notice error" role="alert">
          {TEXTO_AUSENTE} Pedida: <span className="mono">{foco.deliveryId}</span>.{' '}
          <button type="button" className="button small secondary" onClick={quitarElFoco}>Ver todas las entregas</button>
        </p>
      ) : null}

      <Panel title="Deliveries" subtitle={`Snapshot: ${snapshot?.observed_at ?? 'UNKNOWN'}`}>
        <DeliveryTable
          rows={foco.filas}
          resaltada={foco.deliveryId}
          canReplay={permissionState(access.data, 'delivery.replay') === 'allowed'}
          canCancel={permissionState(access.data, 'delivery.cancel') === 'allowed'}
          onChanged={resource.reload}
          empty={foco.estado === 'ausente'
            ? 'Este snapshot no trae ninguna fila para la entrega pedida.'
            : 'No hay deliveries informadas.'}
        />
      </Panel>
    </>
  );
}

function suscribirseAlHistorial(callback: () => void): () => void {
  window.addEventListener('popstate', callback);
  return () => window.removeEventListener('popstate', callback);
}

/**
 * Quita `?delivery=` y avisa a quien escucha `popstate`.
 *
 * No usa `redirect()` de `navigation.ts` a propósito: esa función compara `location.pathname`
 * contra el destino y acá el pathname NO cambia —sigue siendo `/queues`—, así que se saldría por
 * el `return` temprano y el filtro quedaría puesto con un botón que parece funcionar. Es
 * `replaceState` y no `pushState` por lo mismo que el cajón de la flota: quitar un filtro no es un
 * sitio nuevo al que el botón "atrás" deba volver.
 */
function quitarElFoco(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('delivery');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
