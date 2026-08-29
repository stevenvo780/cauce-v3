import { useEffect, useRef, useState } from 'react';
import { Info, Search, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import type { AuditEvent, AuditPage } from '../../api/types';
import { Badge, EmptyState, ErrorState, LoadingState, Panel, Time, Unknown } from '../../components/ui';
import { compactId, safeAuditDecision } from '../../lib';
import { readableAuditSummary } from './audit-summary';

/**
 * **The audit** — not a
 * route of its own.
 *
 * An investigation starts at a relay and ends at the audit, and it used to take two browser tabs
 * and an identifier copied by hand. The relay row now carries a button that lands here with the
 * `trace_id` already in the filter, which is why the search text lives on the PAGE and not in this
 * component: here, switching tabs would lose it.
 *
 * What is preserved in full from the old view, without exception: the search over the six fields
 * (action, actor, tenant, request, trace, summary), the "N visible of M" counter, the icon by
 * decision, the allow/deny/UNKNOWN badge, the summary, and the actor · tenant · request · trace ·
 * timestamp card. Plus its three states: loading, error with retry, and empty.
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
   * `resource.data` and the older pages form ONE snapshot. Before, the first page was copied
   * into two `useState` slots inside an effect: React managed to commit a frame with the resource
   * already resolved but those states still empty ("0 visible of 0"), and only on the next
   * commit installed the events. Besides making the merged test flaky, during that frame the
   * console falsely claimed the audit log was empty.
   *
   * The first page now renders directly. Local state only appears when an older page is actually
   * appended, and stays linked by identity to the first page it extends. If a reload replaces
   * the snapshot while a cursor is in flight, that older response can no longer mix with the
   * new one.
  */
  const currentPagination = pagination?.source === resource.data ? pagination : undefined;
  const events = currentPagination?.events ?? resource.data?.items ?? [];
  // `null` is the durable end of the walk, not an absence that has to fall back to the initial cursor.
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
  /* The search runs in the browser over what is LOADED —the server takes no filter—, so with pages
     left to walk "no events match" is a claim about the whole log that cannot be made here. */
  const busquedaParcial = needle.length > 0 && nextCursor !== null;

  if (resource.loading && !resource.data) return <LoadingState label="Leyendo audit log…" />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;

  return (
    <>
      <Panel>
        <label className="search-field"><Search size={17} aria-hidden="true" /><span className="sr-only">Filtrar auditoría</span><input type="search" value={query} onChange={(event) => { onQuery(event.target.value); }} placeholder="Filtrar por actor, action, trace…" /></label>
        {needle ? (
          <p className="notice" role="status">
            Filtrando por <span className="mono">{query.trim()}</span>{busquedaParcial
              ? ` entre los ${String(events.length)} eventos ya cargados; la auditoría tiene más atrás.`
              : '.'}{' '}
            <button className="button small" type="button" onClick={() => { onQuery(''); }}>Quitar el filtro</button>
          </p>
        ) : null}
      </Panel>
      <Panel title="Eventos" subtitle={`${String(filtered.length)} visibles de ${String(events.length)}`}>
        {filtered.length === 0 ? (
          <EmptyState>
            {busquedaParcial
              ? `Ninguno de los ${String(events.length)} eventos cargados coincide. NO quiere decir que no exista: `
                + 'la búsqueda sólo cubre lo cargado y quedan eventos anteriores sin leer — seguí con '
                + '«Cargar anteriores».'
              : 'No hay eventos que coincidan.'}
          </EmptyState>
        ) : (
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
