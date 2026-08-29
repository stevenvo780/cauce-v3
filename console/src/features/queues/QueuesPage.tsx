import { Search } from 'lucide-react';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import {
  ErrorState, LoadingState, PageHeader, Panel, PermissionBadge, RefreshButton, Time, ViewTabPanel, ViewTabs,
} from '../../components/ui';
import { compactId, display, permissionState } from '../../lib';
import { DeliveryTable, EXPLICACION_CANCEL, EXPLICACION_REPLAY } from './DeliveryTable';
import { OperationalDlqPanel } from './OperationalDlqPanel';
import { enfocarEntrega, leerEntregaPedida, TEXTO_AUSENTE } from './foco-de-entrega';
import {
  contarPorGrupo, filtrarEntregas, FILTRO_VACIO, muestraRecortada, ROTULO_DEL_GRUPO, totalDelGrupo,
  type GrupoDeEstado,
} from './filtro-de-colas';
import './queues.css';

/* Two tables of EIGHT columns: side by side they would push the "Estado" column off-screen —the
   flaw `queues.css` documents for the phone— and stacked, the second one lived below the fold
   at 1080. With tabs each keeps the full width. They stay MOUNTED (`hidden`, not unmounted)
   because the DLQ panel holds a form with the operator's note. */
const PESTANAS = [
  { id: 'entregas', label: 'Entregas' },
  { id: 'dlq', label: 'DLQ operativo' },
] as const;

type Pestana = (typeof PESTANAS)[number]['id'];

/** Control and rescue view of deliveries in queues, retries and dead letter queue. */
export function QueuesPage() {
  const api = useApi();
  const resource = useResource('queues', () => api.getQueues());
  const access = useResource('console-access', () => api.getConsoleAccess());
  const [filtro, setFiltro] = useState(FILTRO_VACIO);
  const [pestana, setPestana] = useState<Pestana>('entregas');
  /**
   * `useSyncExternalStore` and not a loose read: `App` re-renders when the *pathname* changes,
   * and arriving here from another `?delivery=` does NOT change it. Without subscribing to
   * `popstate`, a second deep link in a row would leave the screen showing the delivery from
   * the first one. The snapshot is a string, i.e. a stable primitive: returning a fresh object
   * on each read would cause an infinite loop.
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
   * The deep link WINS over the filter. If combined, a `?delivery=` for a delivery in `done`
   * while the filter is on "review" would yield zero rows and the "filtered to delivery"
   * notice over an empty table: the operator would see the console found their delivery and
   * at the same time that it isn't there. With focus, the filter turns off and the UI says so.
   */
  const conFoco = foco.estado !== 'sin-foco';
  const filas = conFoco ? foco.filas : filtrarEntregas(items, filtro);

  function elegirGrupo(grupo: GrupoDeEstado) {
    setFiltro((previo) => ({ ...previo, grupo: previo.grupo === grupo ? 'todas' : grupo }));
    // The cards filter the deliveries table: from the other tab they would filter something invisible.
    setPestana('entregas');
  }

  return (
    <>
      <PageHeader
        eyebrow="Control de entregas"
        title="Colas y DLQ operativo"
        description="Las entregas y los incidentes causales son fuentes distintas. Replay/cancel operan entregas; cerrar un incidente DLQ registra una decisión sin volver a ejecutar ni reenviar nada."
        notes={
          <>
            <p><strong>Replay:</strong> {EXPLICACION_REPLAY} <strong>Cancelar:</strong> {EXPLICACION_CANCEL} Las dos piden confirmación antes de salir al servidor.</p>
            <div className="queues-permisos">
              <PermissionBadge access={access.data} permission="delivery.replay" />
              <PermissionBadge access={access.data} permission="dlq.resolve" />
            </div>
          </>
        }
        actions={<RefreshButton onClick={resource.reload} loading={resource.loading} />}
      />

      {/*
        The cards are BUTTONS, and the number is the server's TOTAL —`snapshot.totals`, a `COUNT`
        with no `LIMIT` and with the same visibility filters as the listing—, not what fits on this
        page: a dead-letter count capped at the page size reads as "there are 200" on a queue with
        thousands and hides exactly the work that has to be rescued. Below it goes, when they
        differ, how many rows of that group DID fit here: that difference is the page truncation,
        and hiding it would promise rows the table below does not have. */}
      <div className="metrics-grid three metricas-de-cola" role="group" aria-label="Filtrar por estado">
        <TarjetaFiltro
          etiqueta="Pendientes" valor={totalDelGrupo(snapshot, 'pendientes')} tono="neutral" detalle="disponibles o claimed"
          grupo="pendientes" activo={filtro.grupo === 'pendientes'} enPagina={porGrupo.pendientes}
          bloqueado={conFoco} onElegir={elegirGrupo}
        />
        <TarjetaFiltro
          etiqueta="En retry" valor={totalDelGrupo(snapshot, 'retry')} tono="warning" detalle="backoff durable"
          grupo="retry" activo={filtro.grupo === 'retry'} enPagina={porGrupo.retry}
          bloqueado={conFoco} onElegir={elegirGrupo}
        />
        <TarjetaFiltro
          etiqueta="Dead letters" valor={totalDelGrupo(snapshot, 'revision')} tono="danger" detalle="requieren revisión"
          grupo="revision" activo={filtro.grupo === 'revision'} enPagina={porGrupo.revision}
          bloqueado={conFoco} onElegir={elegirGrupo}
        />
      </div>

      <ViewTabs tabs={PESTANAS} active={pestana} onSelect={setPestana} label="Colas y DLQ operativo" />

      <ViewTabPanel id="entregas" hidden={pestana !== 'entregas'}>
        {/* `observed_at` was dumped as-is —"2026-08-23T02:02:29.830Z"— and it was one of three
            date formats that coexisted in the product. Now it goes through the same `<Time>` as
            the rest: relative to the view, exact in `title=`. */}
        <Panel title="Entregas" subtitle={undefined}>
          <p className="observation-line">
            Leído del servidor: <Time value={snapshot?.observed_at} relativo />
            {/* Said with the server's own flag, not guessed from `items.length === LIMIT`: with
                exactly `LIMIT` deliveries that guess would announce a truncation that isn't. */}
            {muestraRecortada(snapshot)
              ? ' · Página recortada: el servidor devolvió sólo las entregas más recientes; las tarjetas de arriba sí cuentan todo.'
              : null}
          </p>

          {/* The requested id is written IN FULL, not compacted: it's what the operator has to be
              able to compare against the one in the link, and `compactId` eats the middle. */}
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
      </ViewTabPanel>

      <ViewTabPanel id="dlq" hidden={pestana !== 'dlq'}>
        {dlqAccess === 'allowed' ? <OperationalDlqPanel /> : (
          <Panel title="DLQ operativo" subtitle="La reconciliación causal está separada de replay y cancelación de entregas.">
            <p className="notice">
              {dlqAccess === 'denied'
                ? 'Tu sesión no tiene control operativo para leer o cerrar incidentes DLQ.'
                : 'Cauce todavía no publicó un permiso verificable para el DLQ operativo; no se presume acceso.'}
            </p>
          </Panel>
        )}
      </ViewTabPanel>
    </>
  );
}

/**
 * One of the three cards above, now pressable.
 *
 * Does not reuse `<Metric>` because `Metric` is an `<article>` and this has to be a real
 * `<button>`: a `div` with `onClick` isn't reachable by keyboard, isn't announced as a control
 * and can't carry `aria-pressed`. The `.metric` class IS reused —the look is the same on
 * purpose; the only thing that changes is that it now leads somewhere.
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
        The number above is the SERVER's total over everything it sees; this one is how many rows of
        that group fit on this page. It's only shown when they DON'T match, and then it says why:
        the snapshot's `LIMIT` left the rest out. */}
      {String(enPagina) !== cifra ? (
        <span
          className="metrica-en-pagina"
          title={`El servidor cuenta ${cifra} en total; en esta página caben ${String(enPagina)} porque el snapshot viene recortado por su LIMIT.`}
        >{enPagina} en esta página · total {cifra}</span>
      ) : null}
    </button>
  );
}

function suscribirseAlHistorial(callback: () => void): () => void {
  window.addEventListener('popstate', callback);
  return () => { window.removeEventListener('popstate', callback); };
}

/**
 * Removes `?delivery=` and notifies whoever listens to `popstate`.
 *
 * It doesn't use `redirect()` from `router.ts` on purpose: that function compares
 * `location.pathname` against the destination and here the pathname does NOT change —it stays
 * `/queues`—, so it would bail out at the early `return` and the filter would stay set with a
 * button that looks like it works. It's `replaceState` and not `pushState` for the same reason
 * as the fleet drawer: removing a filter isn't a new place the "back" button should return to.
 */
function quitarElFoco(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('delivery');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
