import { useEffect, useRef, useState } from 'react';
import { Info, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useApi } from '../../api/context';
import {
  auditFilterKey, auditFilterProblem, auditServerQuery, EMPTY_AUDIT_FILTER, type AuditFilterDraft,
} from '../../api/audit-server-filters';
import type { AuditListOptions } from '../../api/client/system-client';
import { useResource } from '../../api/use-resource';
import type { AuditEvent, AuditPage } from '../../api/types';
import { cn } from '../../cn';
import { ActionButton } from '../../components/action-button';
import { Button, Notice, Toolbar } from '../../components/kit';
import { Badge, EmptyState, ErrorState, LoadingState, Time, Unknown } from '../../components/ui';
import { TONE_CLASS, type Tone } from '../../status-tone';
import { compactId, display, plural, safeAuditDecision, UNKNOWN } from '../../lib';
import { AUDIT_DECISION_LABEL, readableAuditAction, readableAuditSummary } from './audit-summary';

const DECISION_TONE: Record<NonNullable<ReturnType<typeof safeAuditDecision>>, Tone> = { allow: 'ok', deny: 'danger', info: 'info' };

/**
 * The audit log, mounted inside /observability. An investigation starts at a relay and ends here,
 * so the search text lives on the PAGE (the relay row lands here with its `trace_id` already in
 * the filter) and not in this component: switching tabs would lose it.
 */
function listOptions(filter: AuditFilterDraft, before?: string): AuditListOptions {
  return { limit: 100, ...(before === undefined ? {} : { before }), ...auditServerQuery(filter) };
}

export function AuditPanel({ query, onQuery }: { query: string; onQuery: (value: string) => void }) {
  const api = useApi();
  const [draft, setDraft] = useState<AuditFilterDraft>({ ...EMPTY_AUDIT_FILTER, trace: query });
  const [applied, setApplied] = useState<AuditFilterDraft>(EMPTY_AUDIT_FILTER);
  const [filterError, setFilterError] = useState<string>();
  const appliedRef = useRef(applied);
  appliedRef.current = applied;
  const resource = useResource(`audit:${auditFilterKey(applied)}`, () => api.listAudit(listOptions(applied)));
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

  useEffect(() => {
    const trace = query.trim();
    setDraft((current) => current.trace === query ? current : { ...current, trace: query });
    const next = { ...appliedRef.current, trace };
    const problem = auditFilterProblem(next);
    if (problem !== undefined) {
      setFilterError(problem);
      return;
    }
    setFilterError(undefined);
    setApplied((current) => current.trace === trace ? current : { ...current, trace });
  }, [query]);

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
      const page = await api.listAudit(listOptions(applied, requestedCursor));
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
      const error = cause instanceof Error ? cause : new Error('No se pudo leer la página anterior');
      setPagination((current) => current?.source === source && current.requestId === requestId ? {
        ...current,
        olderLoading: false,
        olderError: error,
      } : current);
      return { error };
    }
  };
  const filtered = events;
  const serverFilter = [applied.trace, applied.alias, applied.action, applied.from, applied.to].some((value) => value !== '');

  function applyFilters() {
    const next: AuditFilterDraft = {
      trace: draft.trace.trim(),
      alias: draft.alias.trim(),
      action: draft.action.trim(),
      from: draft.from.trim(),
      to: draft.to.trim(),
    };
    const problem = auditFilterProblem(next);
    if (problem !== undefined) {
      setFilterError(problem);
      return;
    }
    setFilterError(undefined);
    setDraft(next);
    setApplied(next);
    if (next.trace !== query.trim()) onQuery(next.trace);
  }

  function clearFilters() {
    setDraft(EMPTY_AUDIT_FILTER);
    setApplied(EMPTY_AUDIT_FILTER);
    setFilterError(undefined);
    if (query !== '') onQuery('');
  }

  const filterFields: readonly { key: keyof AuditFilterDraft; label: string; placeholder: string }[] = [
    { key: 'trace', label: 'Traza', placeholder: 'identificador exacto' },
    { key: 'alias', label: 'Alias', placeholder: 'alias exacto' },
    { key: 'action', label: 'Acción', placeholder: 'delivery.cancel' },
    { key: 'from', label: 'Desde', placeholder: '2020-01-01T00:00:00Z' },
    { key: 'to', label: 'Hasta', placeholder: '2020-01-02T00:00:00Z' },
  ];

  return (
    <>
      <form className="mb-3 grid gap-2" onSubmit={(event) => { event.preventDefault(); applyFilters(); }}>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {filterFields.map((field) => (
            <label key={field.key} className="grid gap-1 text-xs text-muted">
              {field.label}
              <input
                value={draft[field.key]}
                placeholder={field.placeholder}
                spellCheck={false}
                className="w-full"
                onChange={(event) => {
                  const value = event.target.value;
                  setDraft((current) => ({ ...current, [field.key]: value }));
                }}
              />
            </label>
          ))}
        </div>
        <Toolbar className="mb-0">
          <Button type="submit" size="sm">Aplicar filtros</Button>
          {serverFilter || draft.trace !== '' || draft.alias !== '' || draft.action !== '' || draft.from !== '' || draft.to !== '' ? (
            <Button type="button" size="sm" onClick={clearFilters}>Quitar filtros</Button>
          ) : null}
          {resource.data ? <span className="text-xs text-muted">{plural(filtered.length, 'visible', 'visibles')} de {String(events.length)}</span> : null}
          <ActionButton size="sm" label="Releer auditoría" busy={resource.loading} announceError={false} action={() => resource.reload()} />
        </Toolbar>
      </form>
      {filterError ? <Notice tone="danger" role="alert" className="mb-3">{filterError}</Notice> : null}
      {resource.loading && !resource.data ? <LoadingState label="Leyendo la auditoría…" /> : null}
      {resource.error && !resource.data ? <ErrorState error={resource.error} onRetry={resource.reload} /> : null}
      {resource.error && resource.data ? (
        <Notice tone="danger" role="alert" className="mb-3 flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 basis-64">No se pudo actualizar la auditoría: {resource.error.message} Se muestran los eventos ya cargados.</span>
          <ActionButton size="sm" label="Reintentar" pendingLabel="Reintentando…" done={false} announceError={false} action={() => resource.reload()} />
        </Notice>
      ) : null}
      {serverFilter ? (
        <Notice role="status" className="mb-3 flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 basis-64">
            El servidor filtró esta lectura
            {applied.trace ? <> por la traza <span className="mono">{applied.trace}</span></> : null}
            {applied.alias ? <> por el alias <span className="mono">{applied.alias}</span></> : null}
            {applied.action ? <> por la acción <span className="mono">{applied.action}</span></> : null}
            {applied.from ? <> desde <span className="mono">{applied.from}</span></> : null}
            {applied.to ? <> hasta <span className="mono">{applied.to}</span></> : null}.
          </span>
          <Button size="sm" onClick={clearFilters}>Quitar filtros</Button>
        </Notice>
      ) : null}
      {resource.data && filtered.length === 0 ? (
        <EmptyState>
          {serverFilter
            ? 'No hay eventos que coincidan con el filtro del servidor.'
            : 'Todavía no hay eventos de auditoría en esta lectura. Cuando el servidor registre decisiones, aparecerán aquí; si esperabas eventos, pulsa «Releer auditoría».'}
        </EmptyState>
      ) : null}
      {resource.data && filtered.length > 0 ? (
        <ul className="m-0 grid list-none divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface p-0" aria-label="Eventos de auditoría">
          {filtered.map((event, index) => {
            const decision = safeAuditDecision(event.decision);
            const tone = TONE_CLASS[decision ? DECISION_TONE[decision] : 'neutral'];
            const actionLabel = readableAuditAction(event.action);
            const resumen = readableAuditSummary(event.summary);
            const actor = [display(event.actor_alias), display(event.tenant_id)].filter((part) => part !== UNKNOWN).join(' · ');
            const request = display(event.request_id);
            const trace = display(event.trace_id);
            return <li className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 px-3 py-2.5" key={event.event_id ?? index}>
              <span data-decision={decision ?? 'unknown'} className={cn('grid size-7 place-items-center rounded-md [&>svg]:size-4', tone.pill)}>
                {decision === 'allow' ? <ShieldCheck aria-hidden="true" /> : decision === 'info' ? <Info aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <strong className="text-[13px]">{actionLabel ?? <Unknown value={event.action} />}</strong>
                  {actionLabel && typeof event.action === 'string' && event.action.trim() !== ''
                    ? <span className="mono text-[11px] text-muted">{event.action}</span>
                    : null}
                  <Badge tone={decision === 'allow' ? 'online' : decision === 'deny' ? 'danger' : decision === 'info' ? 'info' : 'unknown'}>
                    {decision ? AUDIT_DECISION_LABEL[decision] : <Unknown value={decision} />}
                  </Badge>
                </div>
                {resumen ? <p className="m-0 mt-0.5 text-[13px] break-words text-fg-2">{resumen}</p> : null}
                <dl className="m-0 mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
                  {actor ? <div className="flex gap-1"><dt>Actor</dt><dd className="m-0 text-fg-2">{actor}</dd></div> : null}
                  {request !== UNKNOWN ? <div className="flex gap-1"><dt>Petición</dt><dd className="mono m-0 text-fg-2">{compactId(event.request_id)}</dd></div> : null}
                  {trace !== UNKNOWN ? <div className="flex gap-1"><dt>Traza</dt><dd className="mono m-0 text-fg-2">{compactId(event.trace_id)}</dd></div> : null}
                  <div className="flex gap-1"><dt>Fecha</dt><dd className="m-0 text-fg-2"><Time value={event.at} /></dd></div>
                </dl>
              </div>
            </li>;
          })}
        </ul>
      ) : null}
      {olderError ? (
        <Notice tone="danger" role="alert" className="mt-3 flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 basis-64">No se pudieron cargar eventos anteriores: {olderError.message}.</span>
          <ActionButton size="sm" label="Reintentar" pendingLabel="Reintentando…" done={false} announceError={false} action={() => loadOlder()} />
        </Notice>
      ) : null}
      {nextCursor !== null ? (
        <div className="mt-3 flex justify-center">
          <ActionButton label="Cargar anteriores" pendingLabel="Cargando anteriores…" busy={olderLoading} done={false} announceError={false} action={() => loadOlder()} />
        </div>
      ) : null}
    </>
  );
}
