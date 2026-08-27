import { useEffect, useRef, useState } from 'react';
import { Info, Search, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import type { AuditEvent, AuditPage } from '../../api/types';
import { Badge, EmptyState, ErrorState, LoadingState, Panel, Time, Unknown } from '../../components/ui';
import { compactId, safeAuditDecision } from '../../lib';
import { readableAuditSummary } from './audit-summary';

/**
 * **La auditoría** — no una
 * ruta propia.
 *
 * Era `/audit`, y estaba al lado de `/observability` en el menú. Que fueran dos entradas lo tenía
 * escrito el propio código: el comentario de `ObservabilityPage` explicaba que `request_id` y
 * `trace_id` bajaban a la tabla de relays *«para cruzarlos contra Audit»*. O sea que la consola
 * documentaba que la investigación normal empieza en un relay y termina en la auditoría, y obligaba
 * a hacerla con dos pestañas del navegador y un identificador copiado a mano.
 *
 * Ahora el cruce es un clic: la fila del relay lleva un botón que trae acá con el `trace_id` ya
 * puesto en el filtro. Por eso el texto del buscador vive en la PÁGINA y no en este componente —si
 * viviera acá, cambiar de pestaña lo perdería, que es exactamente el paso a mano que la fusión
 * viene a quitar.
 *
 * Lo que se conserva entero de la vista vieja, sin excepción: el buscador sobre los seis campos
 * (action, actor, tenant, request, trace, resumen), el contador «N visibles de M», el icono según
 * la decisión, la insignia allow/deny/UNKNOWN, el resumen, y la ficha de actor · tenant · request ·
 * trace · fecha. Y sus tres estados: cargando, error con reintento, y vacío.
 */
export function AuditPanel({ query, onQuery }: { query: string; onQuery: (value: string) => void }) {
  const api = useApi();
  const resource = useResource('audit', () => api.listAudit({ limit: 100 }));
  const [pagination, setPagination] = useState<{
    source: AuditPage;
    events: AuditEvent[];
    nextCursor: string | null;
    olderLoading: boolean;
    olderError?: Error;
    requestId: number;
  }>();
  const sourceRef = useRef(resource.data);
  sourceRef.current = resource.data;
  const requestSerial = useRef(0);
  const mounted = useRef(true);

  /*
   * `resource.data` y las páginas anteriores forman UN snapshot. Antes, la primera página se
   * copiaba a dos `useState` dentro de un efecto: React alcanzaba a confirmar un frame con el
   * recurso ya resuelto pero esos estados todavía vacíos ("0 visibles de 0") y recién en el
   * commit siguiente instalaba los eventos. Además de hacer intermitente la prueba fusionada,
   * durante ese frame la consola afirmaba falsamente que el audit log estaba vacío.
   *
   * La primera página se renderiza ahora directamente. Sólo aparece estado local cuando de verdad
   * se agrega una página anterior, y queda ligado por identidad a la primera página que amplía. Si
   * una recarga reemplaza el snapshot mientras un cursor está en vuelo, esa respuesta vieja ya no
   * puede mezclarse con la nueva.
  */
  const currentPagination = pagination?.source === resource.data ? pagination : undefined;
  const events = currentPagination?.events ?? resource.data?.items ?? [];
  // `null` es el final durable de la caminata, no una ausencia que deba caer al cursor inicial.
  const nextCursor = currentPagination
    ? currentPagination.nextCursor
    : resource.data?.next_cursor ?? null;
  const olderLoading = currentPagination?.olderLoading ?? false;
  const olderError = currentPagination?.olderError;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestSerial.current += 1;
    };
  }, []);

  const loadOlder = async () => {
    const source = resource.data;
    if (!source || olderLoading || nextCursor === null) return;
    const requestId = ++requestSerial.current;
    const requestedCursor = nextCursor;
    setPagination({
      source,
      events,
      nextCursor,
      olderLoading: true,
      requestId,
    });
    try {
      const page = await api.listAudit({ limit: 100, before: requestedCursor });
      if (!mounted.current || requestId !== requestSerial.current || sourceRef.current !== source) return;
      const following = page.next_cursor ?? null;
      if (following !== null && (
        !/^[1-9][0-9]{0,18}$/u.test(following)
        || BigInt(following) >= BigInt(requestedCursor)
      )) {
        throw new Error('El servidor repitió o adelantó el cursor de auditoría');
      }
      setPagination((current) => {
        if (current?.source !== source || current.requestId !== requestId) return current;
        const seen = new Set(current.events.flatMap((event) => event.event_id ? [event.event_id] : []));
        const additions = (page.items ?? []).filter((event) => {
          if (!event.event_id) return true;
          if (seen.has(event.event_id)) return false;
          seen.add(event.event_id);
          return true;
        });
        return {
          ...current,
          events: [...current.events, ...additions],
          nextCursor: following,
          olderLoading: false,
          olderError: undefined,
        };
      });
    } catch (cause: unknown) {
      if (!mounted.current || requestId !== requestSerial.current || sourceRef.current !== source) return;
      setPagination((current) => current?.source === source && current.requestId === requestId ? {
        ...current,
        olderLoading: false,
        olderError: cause instanceof Error ? cause : new Error('No se pudo leer la página anterior'),
      } : current);
    }
  };
  const needle = query.trim().toLocaleLowerCase();
  const filtered = needle ? events.filter((event) => [event.action, event.actor_alias, event.tenant_id, event.request_id, event.trace_id, event.summary]
    .some((value) => value?.toLocaleLowerCase().includes(needle))) : events;

  if (resource.loading && !resource.data) return <LoadingState label="Leyendo audit log…" />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;

  return (
    <>
      <Panel>
        <label className="search-field"><Search size={17} aria-hidden="true" /><span className="sr-only">Filtrar auditoría</span><input type="search" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Filtrar por actor, action, trace…" /></label>
        {needle ? (
          <p className="notice" role="status">
            Filtrando por <span className="mono">{query.trim()}</span>.{' '}
            <button className="button small" type="button" onClick={() => onQuery('')}>Quitar el filtro</button>
          </p>
        ) : null}
      </Panel>
      <Panel title="Eventos" subtitle={`${filtered.length} visibles de ${events.length}`}>
        {filtered.length === 0 ? <EmptyState>No hay eventos que coincidan.</EmptyState> : (
          <div className="audit-list">
            {filtered.map((event, index) => {
              const decision = safeAuditDecision(event.decision);
              return <article className="audit-row" key={event.event_id ?? index}>
                <span className={`audit-icon ${decision ?? 'unknown'}`}>{decision === 'allow' ? <ShieldCheck aria-hidden="true" /> : decision === 'info' ? <Info aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}</span>
                <div className="audit-main"><div><strong><Unknown value={event.action} /></strong><Badge tone={decision === 'allow' ? 'online' : decision === 'deny' ? 'danger' : decision === 'info' ? 'info' : 'unknown'}><Unknown value={decision} /></Badge></div><p><Unknown value={readableAuditSummary(event.summary)} /></p></div>
                <dl><div><dt>Actor</dt><dd><Unknown value={event.actor_alias} /> · <Unknown value={event.tenant_id} /></dd></div><div><dt>Request</dt><dd className="mono">{compactId(event.request_id)}</dd></div><div><dt>Trace</dt><dd className="mono">{compactId(event.trace_id)}</dd></div><div><dt>Fecha</dt><dd><Time value={event.at} /></dd></div></dl>
              </article>;
            })}
          </div>
        )}
        {olderError ? (
          <p className="notice danger" role="alert">
            No se pudieron cargar eventos anteriores: {olderError.message}.{' '}
            <button className="button small" type="button" onClick={() => void loadOlder()}>Reintentar</button>
          </p>
        ) : null}
        {nextCursor !== null ? (
          <button className="button secondary" type="button" disabled={olderLoading} onClick={() => void loadOlder()}>
            {olderLoading ? 'Cargando anteriores…' : 'Cargar anteriores'}
          </button>
        ) : null}
      </Panel>
    </>
  );
}
