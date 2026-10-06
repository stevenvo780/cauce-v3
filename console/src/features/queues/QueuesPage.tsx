import { useMemo, useState, useSyncExternalStore } from 'react';
import { cn } from '../../cn';
import { ConsoleAccessBoundary, useConsoleAccess } from '../../api/console-access';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { Button, Notice, SearchField, SectionCard, Toolbar } from '../../components/kit';
import {
  ErrorState, LoadingState, PageHeader, PermissionBadge, RefreshButton, Time, ViewTabPanel, ViewTabs,
} from '../../components/ui';
import { compactId, display, permissionState } from '../../lib';
import { DeliveryTable, EXPLICACION_CANCEL, EXPLICACION_REPLAY } from './DeliveryTable';
import { OperationalDlqPanel } from './OperationalDlqPanel';
import { enfocarEntrega, leerEntregaPedida, TEXTO_AUSENTE } from './foco-de-entrega';
import {
  contarPorGrupo, filtrarEntregas, FILTRO_VACIO, muestraRecortada, ROTULO_DEL_GRUPO, totalDelGrupo,
  type GrupoDeEstado,
} from './filtro-de-colas';

/* Two wide tables: with tabs each keeps the full width. They stay MOUNTED (`hidden`, not
   unmounted) because the DLQ panel holds the operator's note. */
const PESTANAS = [
  { id: 'entregas', label: 'Entregas' },
  { id: 'dlq', label: 'DLQ operativo' },
] as const;

type Pestana = (typeof PESTANAS)[number]['id'];

/** Control and rescue view of deliveries in queues, retries and dead letter queue. */
export function QueuesPage() {
  return <ConsoleAccessBoundary><QueuesPageContent /></ConsoleAccessBoundary>;
}

function QueuesPageContent() {
  const api = useApi();
  const resource = useResource('queues', () => api.getQueues());
  const access = useConsoleAccess();
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
  const verifiedAccess = access.error ? undefined : access.data;
  const dlqAccess = permissionState(verifiedAccess, 'dlq.resolve');

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
    <div>
      <PageHeader
        eyebrow="Control de entregas"
        title="Colas y DLQ operativo"
        description="Entregas y reintentos; incidentes DLQ por separado."
        notes={
          <>
            <p>Las entregas y los incidentes causales son fuentes distintas. Cerrar un incidente DLQ conserva su evidencia y registra una decisión; no ejecuta agentes ni reenvía mensajes.</p>
            <p><strong>Replay:</strong> {EXPLICACION_REPLAY} <strong>Cancelar:</strong> {EXPLICACION_CANCEL} Las dos piden confirmación antes de salir al servidor.</p>
            <div className="flex flex-wrap gap-2">
              <PermissionBadge access={verifiedAccess} permission="delivery.replay" />
              <PermissionBadge access={verifiedAccess} permission="dlq.resolve" />
            </div>
          </>
        }
        actions={<RefreshButton onClick={resource.reload} loading={resource.loading} compact />}
      />

      {/* The tiles are BUTTONS, and the figure is the server's TOTAL (`snapshot.totals`, a `COUNT`
          with no `LIMIT`), not what fits on this page: a dead-letter count capped at the page size
          reads as "there are 200" on a queue with thousands and hides exactly the work that has to
          be rescued. When the page holds fewer rows than the total, the tile says how many. */}
      <div role="group" aria-label="Filtrar por estado" className="mb-3 grid grid-cols-4 gap-1.5 sm:mb-4 sm:gap-2">
        <TarjetaFiltro
          etiqueta="Todas" valor={items.length} detalle="en este snapshot"
          grupo="todas" activo={filtro.grupo === 'todas'} enPagina={items.length} bloqueado={conFoco} onElegir={elegirGrupo}
        />
        <TarjetaFiltro
          etiqueta="Pendientes" valor={totalDelGrupo(snapshot, 'pendientes')} detalle="disponibles o claimed"
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

      {/* Both tabs stay mounted: the DLQ panel holds the operator's note. */}
      <ViewTabPanel id="entregas" hidden={pestana !== 'entregas'}>
        {/* Said with the server's own flag, not guessed from `items.length === LIMIT`: with
            exactly `LIMIT` deliveries that guess would announce a truncation that isn't. */}
        {muestraRecortada(snapshot) ? (
          <p className="m-0 mb-3 text-xs text-warn-ink">
            Página recortada: el servidor devolvió sólo las entregas más recientes; los totales de arriba sí cuentan todo.
          </p>
        ) : null}

        {/* The requested id is written IN FULL, not compacted: it's what the operator has to be
            able to compare against the one in the link, and `compactId` eats the middle. */}
        {foco.estado === 'encontrada' ? (
          <Notice role="status" className="mb-3 flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 basis-64">
              Filtrado a la entrega <span className="mono break-all">{foco.deliveryId}</span> ({compactId(foco.deliveryId)}), la
              que venías siguiendo desde «La flota ahora».
            </span>
            <Button size="sm" onClick={quitarElFoco}>Ver todas las entregas</Button>
          </Notice>
        ) : null}
        {foco.estado === 'ausente' ? (
          <Notice tone="danger" role="alert" className="mb-3 flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 basis-64">
              {TEXTO_AUSENTE} Pedida: <span className="mono break-all">{foco.deliveryId}</span>.
            </span>
            <Button size="sm" onClick={quitarElFoco}>Ver todas las entregas</Button>
          </Notice>
        ) : null}
        <p className={cn('m-0 mb-3 text-xs text-muted', conFoco ? '' : 'max-sm:hidden')}>
          Leído <Time value={snapshot?.observed_at} relativo />
        </p>
        {conFoco ? null : (
          <Toolbar>
            <SearchField label="Buscar entrega" value={filtro.texto} placeholder="Alias, tenant, delivery id, message id o error"
              onChange={(texto) => { setFiltro((previo) => ({ ...previo, texto })); }} />
            <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted" role="status">
              <span>
                {filas.length === items.length
                  ? `${String(items.length)} entregas en este snapshot.`
                  : `${String(filas.length)} de ${String(items.length)} entregas · ${ROTULO_DEL_GRUPO[filtro.grupo]}${filtro.texto.trim() ? ` que dicen «${filtro.texto.trim()}»` : ''}.`}
              </span>
              {filtro.grupo !== 'todas' || filtro.texto.trim() ? (
                <Button size="sm" onClick={() => { setFiltro(FILTRO_VACIO); }}>Quitar el filtro</Button>
              ) : null}
              <span className="sm:hidden">Leído <Time value={snapshot?.observed_at} relativo /></span>
            </p>
          </Toolbar>
        )}
        <DeliveryTable
          rows={filas}
          resaltada={foco.deliveryId}
          canReplay={permissionState(verifiedAccess, 'delivery.replay') === 'allowed'}
          canCancel={permissionState(verifiedAccess, 'delivery.cancel') === 'allowed'}
          onChanged={resource.reload}
          snapshotVersion={snapshot?.observed_at}
          empty={foco.estado === 'ausente'
            ? 'Este snapshot no trae ninguna fila para la entrega pedida.'
            : filas.length === 0 && items.length > 0
              ? `Ninguna de las ${String(items.length)} entregas de este snapshot es ${ROTULO_DEL_GRUPO[filtro.grupo]}${filtro.texto.trim() ? ` y dice «${filtro.texto.trim()}»` : ''}.`
              : 'No hay deliveries informadas.'}
        />
      </ViewTabPanel>

      <ViewTabPanel id="dlq" hidden={pestana !== 'dlq'}>
        {dlqAccess === 'allowed' ? <OperationalDlqPanel /> : (
          <SectionCard title="DLQ operativo" description="La reconciliación causal está separada de replay y cancelación de entregas.">
            <Notice>
              {dlqAccess === 'denied'
                ? 'Tu sesión no tiene control operativo para leer o cerrar incidentes DLQ.'
                : 'Cauce todavía no publicó un permiso verificable para el DLQ operativo; no se presume acceso.'}
            </Notice>
          </SectionCard>
        )}
      </ViewTabPanel>
    </div>
  );
}

const TITULO_FOCO = 'Hay un enlace profundo abierto: quitá el foco para filtrar';

/** One of the filter tiles: a toggle that also says when the page holds fewer rows than the total. */
function TarjetaFiltro({ etiqueta, valor, tono = 'neutral', detalle, grupo, activo, enPagina, bloqueado, onElegir }: {
  etiqueta: string;
  valor: unknown;
  tono?: 'neutral' | 'warning' | 'danger';
  detalle: string;
  grupo: GrupoDeEstado;
  activo: boolean;
  enPagina: number;
  bloqueado: boolean;
  onElegir: (grupo: GrupoDeEstado) => void;
}) {
  const cifra = display(valor);
  const recortada = String(enPagina) !== cifra;
  return (
    <button
      type="button"
      aria-pressed={activo}
      disabled={bloqueado}
      title={bloqueado ? TITULO_FOCO : recortada
        ? `El servidor cuenta ${cifra} en total; en esta página caben ${String(enPagina)} porque el snapshot viene recortado por su LIMIT.`
        : `Ver ${ROTULO_DEL_GRUPO[grupo]}`}
      onClick={() => { onElegir(grupo); }}
      className={cn(
        'flex min-w-0 cursor-pointer flex-col items-start gap-0 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left font-[inherit] transition-colors sm:gap-0.5 sm:px-3 sm:py-2.5',
        'enabled:hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60',
        activo && 'border-brand bg-brand-soft',
      )}
    >
      <span className="max-w-full truncate text-[11px] text-muted sm:text-xs">{etiqueta}</span>
      <strong className={cn('text-lg leading-tight font-semibold tabular-nums sm:text-xl', INK[tono])}>{cifra}</strong>
      <span className={cn('hidden text-xs leading-snug sm:block', recortada ? 'text-warn-ink' : 'text-muted')}>
        {recortada ? `${String(enPagina)} en esta página · total ${cifra}` : detalle}
      </span>
    </button>
  );
}

const INK = { neutral: 'text-fg', warning: 'text-warn-ink', danger: 'text-danger-ink' } as const;

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
