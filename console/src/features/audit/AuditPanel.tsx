import { useEffect, useRef, useState } from 'react';
import { Info, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import type { AuditEvent, AuditPage } from '../../api/types';
import { cn } from '../../cn';
import { Button, Notice } from '../../components/form-kit';
import { SearchField, Toolbar } from '../../components/ops-kit';
import { Badge, EmptyState, ErrorState, LoadingState, Time, Unknown } from '../../components/ui';
import { TONE_CLASS, type Tone } from '../../status-tone';
import { compactId, safeAuditDecision } from '../../lib';
import { readableAuditSummary } from './audit-summary';

const DECISION_TONE: Record<string, Tone> = { allow: 'ok', deny: 'danger', info: 'info' };

/**
 * The audit log, mounted inside /observability. An investigation starts at a relay and ends here,
 * so the search text lives on the PAGE (the relay row lands here with its `trace_id` already in
 * the filter) and not in this component: switching tabs would lose it.
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
      <Toolbar className="mb-3">
        <SearchField label="Filtrar auditoría" value={query} onChange={onQuery} placeholder="Filtrar por actor, action, trace…" />
        <span className="text-xs text-muted">{String(filtered.length)} visibles de {String(events.length)}</span>
      </Toolbar>
      {needle ? (
        <Notice role="status" className="mb-3 flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 basis-64">
            Filtrando por <span className="mono">{query.trim()}</span>{busquedaParcial
              ? ` entre los ${String(events.length)} eventos ya cargados; la auditoría tiene más atrás.`
              : '.'}
          </span>
          <Button size="sm" onClick={() => { onQuery(''); }}>Quitar el filtro</Button>
        </Notice>
      ) : null}
      {filtered.length === 0 ? (
        <EmptyState>
          {busquedaParcial
            ? `Ninguno de los ${String(events.length)} eventos cargados coincide. NO quiere decir que no exista: `
              + 'la búsqueda sólo cubre lo cargado y quedan eventos anteriores sin leer — seguí con '
              + '«Cargar anteriores».'
            : 'No hay eventos que coincidan.'}
        </EmptyState>
      ) : (
        <ul className="m-0 grid list-none divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface p-0" aria-label="Eventos de auditoría">
          {filtered.map((event, index) => {
            const decision = safeAuditDecision(event.decision);
            const tone = TONE_CLASS[(decision && DECISION_TONE[decision]) || 'neutral'];
            return <li className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 px-3 py-2.5" key={event.event_id ?? index}>
              <span data-decision={decision ?? 'unknown'} className={cn('grid size-7 place-items-center rounded-md [&>svg]:size-4', tone.pill)}>
                {decision === 'allow' ? <ShieldCheck aria-hidden="true" /> : decision === 'info' ? <Info aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <strong className="text-[13px]"><Unknown value={event.action} /></strong>
                  <Badge tone={decision === 'allow' ? 'online' : decision === 'deny' ? 'danger' : decision === 'info' ? 'info' : 'unknown'}><Unknown value={decision} /></Badge>
                </div>
                <p className="m-0 mt-0.5 text-[13px] break-words text-fg-2"><Unknown value={readableAuditSummary(event.summary)} /></p>
                <dl className="m-0 mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
                  <div className="flex gap-1"><dt>Actor</dt><dd className="m-0 text-fg-2"><Unknown value={event.actor_alias} /> · <Unknown value={event.tenant_id} /></dd></div>
                  <div className="flex gap-1"><dt>Request</dt><dd className="mono m-0 text-fg-2">{compactId(event.request_id)}</dd></div>
                  <div className="flex gap-1"><dt>Trace</dt><dd className="mono m-0 text-fg-2">{compactId(event.trace_id)}</dd></div>
                  <div className="flex gap-1"><dt>Fecha</dt><dd className="m-0 text-fg-2"><Time value={event.at} /></dd></div>
                </dl>
              </div>
            </li>;
          })}
        </ul>
      )}
      {olderError ? (
        <Notice tone="danger" role="alert" className="mt-3 flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 basis-64">No se pudieron cargar eventos anteriores: {olderError.message}.</span>
          <Button size="sm" onClick={() => void loadOlder()}>Reintentar</Button>
        </Notice>
      ) : null}
      {nextCursor !== null ? (
        <div className="mt-3 flex justify-center">
          <Button disabled={olderLoading} onClick={() => void loadOlder()}>
            {olderLoading ? 'Cargando anteriores…' : 'Cargar anteriores'}
          </Button>
        </div>
      ) : null}
    </>
  );
}
