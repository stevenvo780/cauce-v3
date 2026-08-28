import { Search } from 'lucide-react';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { ErrorState, LoadingState, PageHeader, Panel, PermissionBadge, RefreshButton, Time } from '../../components/ui';
import { compactId, display, permissionState } from '../../lib';
import { DeliveryTable, EXPLICACION_CANCEL, EXPLICACION_REPLAY } from './DeliveryTable';
import { OperationalDlqPanel } from './OperationalDlqPanel';
import { enfocarEntrega, leerEntregaPedida, TEXTO_AUSENTE } from './foco-de-entrega';
import {
  contarPorGrupo, filtrarEntregas, FILTRO_VACIO, ROTULO_DEL_GRUPO, type GrupoDeEstado,
} from './filtro-de-colas';
import './queues.css';

/**
 * Vista de control y rescate de entregas en colas, reintentos y dead letter queue.
 */
export function QueuesPage() {
  const api = useApi();
  const resource = useResource('queues', () => api.getQueues());
  const access = useResource('console-access', () => api.getConsoleAccess());
  const [filtro, setFiltro] = useState(FILTRO_VACIO);
  /**
   * `useSyncExternalStore` y no una lectura suelta: `App` se re-renderiza cuando cambia el
   * *pathname*, y llegar acá desde otro `?delivery=` NO lo cambia. Sin suscribirse a `popstate`,
   * el segundo enlace profundo seguido dejaría la pantalla mostrando la entrega del primero.
   * El snapshot es un string, o sea un primitivo estable: devolver un objeto nuevo en cada
   * lectura haría bucle infinito.
   */
  const search = useSyncExternalStore(suscribirseAlHistorial, () => window.location.search, () => '');
  const pedida = leerEntregaPedida(search);

  const items = useMemo(() => resource.data?.items ?? [], [resource.data]);
  const porGrupo = useMemo(() => contarPorGrupo(items), [items]);
  const dlqAccess = permissionState(access.data, 'dlq.resolve');

  if (resource.loading && !resource.data) return <LoadingState label="Leyendo queues, retries y DLQ…" />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  const snapshot = resource.data;
  const foco = enfocarEntrega(items, pedida);
  /*
   * El enlace profundo GANA sobre el filtro. Si se combinaran, un `?delivery=` de una entrega en
   * `done` mientras el filtro está en «revisión» daría cero filas y el aviso «filtrado a la
   * entrega» sobre una tabla vacía: el operador vería que la consola encontró su entrega y a la
   * vez que no está. Con foco, el filtro se apaga y se dice que se apagó.
   */
  const conFoco = foco.estado !== 'sin-foco';
  const filas = conFoco ? foco.filas : filtrarEntregas(items, filtro);

  function elegirGrupo(grupo: GrupoDeEstado) {
    setFiltro((previo) => ({ ...previo, grupo: previo.grupo === grupo ? 'todas' : grupo }));
  }

  return (
    <>
      <PageHeader eyebrow="Delivery control" title="Colas y DLQ operativo" description="Las entregas y los incidentes causales son fuentes distintas. Replay/cancel operan entregas; cerrar un incidente DLQ registra una decisión sin volver a ejecutar ni reenviar nada." actions={<RefreshButton onClick={resource.reload} loading={resource.loading} />} />
      <PermissionBadge access={access.data} permission="delivery.replay" />

      {/*
        Las tarjetas son BOTONES. El número sigue siendo el del servidor —`snapshot.pending`,
        `retrying`, `dead`, calculados sobre el mismo snapshot— y debajo va, cuando difieren,
        cuántas filas de ese grupo caben en esta página: la diferencia significa que el `LIMIT` del
        servidor recortó, y taparla prometería filas que no están.
      */}
      <div className="metrics-grid three metricas-de-cola" role="group" aria-label="Filtrar por estado">
        <TarjetaFiltro
          etiqueta="Pendientes" valor={snapshot?.pending} tono="neutral" detalle="disponibles o claimed"
          grupo="pendientes" activo={filtro.grupo === 'pendientes'} enPagina={porGrupo.pendientes}
          bloqueado={conFoco} onElegir={elegirGrupo}
        />
        <TarjetaFiltro
          etiqueta="En retry" valor={snapshot?.retrying} tono="warning" detalle="backoff durable"
          grupo="retry" activo={filtro.grupo === 'retry'} enPagina={porGrupo.retry}
          bloqueado={conFoco} onElegir={elegirGrupo}
        />
        <TarjetaFiltro
          etiqueta="Dead letters" valor={snapshot?.dead} tono="danger" detalle="requieren revisión"
          grupo="revision" activo={filtro.grupo === 'revision'} enPagina={porGrupo.revision}
          bloqueado={conFoco} onElegir={elegirGrupo}
        />
      </div>

      {/* Qué hace cada botón, ANTES de apretarlo. Las dos frases son las mismas que repite la
          confirmación, importadas del propio componente para que no puedan divergir. */}
      <p className="queues-ayuda">
        <strong>Replay:</strong> {EXPLICACION_REPLAY} <strong>Cancelar:</strong> {EXPLICACION_CANCEL} Las dos
        piden confirmación antes de salir al servidor.
      </p>

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

      {/* El `observed_at` se volcaba tal cual —«2026-08-23T02:02:29.830Z»— y era uno de los tres
          formatos de fecha que convivían en el producto. Ahora pasa por el mismo `<Time>` que el
          resto: relativa a la vista, exacta en el `title=`. */}
      <Panel title="Entregas" subtitle={undefined}>
        <p className="observation-line">Leído del servidor: <Time value={snapshot?.observed_at} relativo /></p>
        {conFoco ? null : (
          <div className="queues-filtros">
            <label className="queues-busqueda">
              <Search size={15} aria-hidden="true" />
              <span className="sr-only">Buscar entrega</span>
              <input
                type="search"
                value={filtro.texto}
                placeholder="Alias, tenant, delivery id, message id o texto del error"
                onChange={(evento) => { setFiltro((previo) => ({ ...previo, texto: evento.target.value })); }}
              />
            </label>
            <p className="queues-conteo" role="status">
              {filas.length === items.length
                ? `${String(items.length)} entregas en este snapshot.`
                : `${String(filas.length)} de ${String(items.length)} entregas · ${ROTULO_DEL_GRUPO[filtro.grupo]}${filtro.texto.trim() ? ` que dicen «${filtro.texto.trim()}»` : ''}.`}
              {filtro.grupo !== 'todas' || filtro.texto.trim() ? (
                <>{' '}<button type="button" className="button small secondary" onClick={() => { setFiltro(FILTRO_VACIO); }}>Quitar el filtro</button></>
              ) : null}
            </p>
          </div>
        )}
        <DeliveryTable
          rows={filas}
          resaltada={foco.deliveryId}
          canReplay={permissionState(access.data, 'delivery.replay') === 'allowed'}
          canCancel={permissionState(access.data, 'delivery.cancel') === 'allowed'}
          onChanged={resource.reload}
          snapshotVersion={snapshot?.observed_at}
          empty={foco.estado === 'ausente'
            ? 'Este snapshot no trae ninguna fila para la entrega pedida.'
            : filas.length === 0 && items.length > 0
              ? `Ninguna de las ${String(items.length)} entregas de este snapshot es ${ROTULO_DEL_GRUPO[filtro.grupo]}${filtro.texto.trim() ? ` y dice «${filtro.texto.trim()}»` : ''}.`
              : 'No hay deliveries informadas.'}
        />
      </Panel>

      <PermissionBadge access={access.data} permission="dlq.resolve" />
      {dlqAccess === 'allowed' ? <OperationalDlqPanel /> : (
        <Panel title="DLQ operativo" subtitle="La reconciliación causal está separada de replay y cancelación de entregas.">
          <p className="notice">
            {dlqAccess === 'denied'
              ? 'Tu sesión no tiene control operativo para leer o cerrar incidentes DLQ.'
              : 'Cauce todavía no publicó un permiso verificable para el DLQ operativo; no se presume acceso.'}
          </p>
        </Panel>
      )}
    </>
  );
}

/**
 * Una de las tres tarjetas de arriba, ahora pulsable.
 *
 * No reusa `<Metric>` porque `Metric` es un `<article>` y esto tiene que ser un `<button>` de
 * verdad: un `div` con `onClick` no se alcanza con el teclado, no se anuncia como control y no
 * puede llevar `aria-pressed`. La clase `.metric` sí se reusa —el aspecto es el mismo a propósito,
 * lo único que cambia es que ahora lleva a algún sitio.
 */
function TarjetaFiltro({ etiqueta, valor, tono, detalle, grupo, activo, enPagina, bloqueado, onElegir }: {
  etiqueta: string;
  valor: unknown;
  tono: 'neutral' | 'warning' | 'danger';
  detalle: string;
  grupo: GrupoDeEstado;
  activo: boolean;
  enPagina: number;
  bloqueado: boolean;
  onElegir: (grupo: GrupoDeEstado) => void;
}) {
  const cifra = display(valor);
  return (
    <button
      className={`metric metric-${tono} metrica-filtro`}
      type="button"
      aria-pressed={activo}
      disabled={bloqueado}
      onClick={() => { onElegir(grupo); }}
      title={bloqueado ? 'Hay un enlace profundo abierto: quitá el foco para filtrar' : `Ver ${ROTULO_DEL_GRUPO[grupo]}`}
    >
      <p>{etiqueta}</p>
      <strong>{cifra}</strong>
      <span>{detalle}</span>
      {/*
        La cifra de arriba la calcula el SERVIDOR sobre todo lo que ve; la de acá es cuántas filas
        de ese grupo trae esta página. Sólo se escribe cuando NO coinciden, y entonces dice el
        porqué: el `LIMIT` del snapshot dejó fuera al resto.
      */}
      {String(enPagina) !== cifra ? (
        <span
          className="metrica-en-pagina"
          title={`El servidor cuenta ${cifra} en total; en esta página caben ${String(enPagina)} porque el snapshot viene recortado por su LIMIT.`}
        >{enPagina} acá · snapshot recortado</span>
      ) : null}
    </button>
  );
}

function suscribirseAlHistorial(callback: () => void): () => void {
  window.addEventListener('popstate', callback);
  return () => { window.removeEventListener('popstate', callback); };
}

/**
 * Quita `?delivery=` y avisa a quien escucha `popstate`.
 *
 * No usa `redirect()` de `router.ts` a propósito: esa función compara `location.pathname`
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
