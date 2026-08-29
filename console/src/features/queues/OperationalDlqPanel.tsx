import { CheckCircle2, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import type {
  DlqDisposition, DlqItem, DlqPage, DlqTarget, ResolveDlqWithoutReplayResult,
} from '../../api/types';
import { useResource } from '../../api/use-resource';
import { Badge, EmptyState, ErrorState, LoadingState, Panel, RefreshButton, Time, Unknown } from '../../components/ui';
import { compactId } from '../../lib';

const DISPOSITION: Readonly<Record<DlqDisposition, string>> = {
  ambiguous: 'EFECTO INCIERTO',
  safe_retry: 'REINTENTO SEGURO',
  missing_final: 'FINAL AUSENTE',
  auth: 'AUTORIZACIÓN',
  expected_offline: 'OFFLINE ESPERADO',
  unclassified: 'SIN CLASIFICAR',
};

const RESOLVABLE: ReadonlySet<DlqDisposition> = new Set([
  'ambiguous', 'safe_retry', 'missing_final', 'auth',
]);
const DUPLICATE_RISK: ReadonlySet<DlqDisposition> = new Set(['ambiguous', 'missing_final']);
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CURSOR = /^(?:[a-f0-9]{2}){1,512}$/u;
const NO_ADDITIONAL_ITEMS: DlqItem[] = [];

interface ResolutionDraft {
  item: DlqItem;
  reason: string;
  possibleDuplicate: boolean;
  possibleNoDelivery: boolean;
}

function disposition(value: unknown): DlqDisposition | undefined {
  return typeof value === 'string' && Object.hasOwn(DISPOSITION, value)
    ? value as DlqDisposition
    : undefined;
}

function target(value: unknown): DlqTarget | undefined {
  return value === 'delivery' || value === 'outbox' ? value : undefined;
}

function pageCursor(value: unknown): string | undefined {
  return typeof value === 'string' && CURSOR.test(value) ? value : undefined;
}

function incidentKey(item: DlqItem): string | undefined {
  const itemTarget = target(item.target);
  return itemTarget !== undefined && typeof item.id === 'string' && UUID.test(item.id)
    ? `${itemTarget}:${item.id}`
    : undefined;
}

function canResolve(item: DlqItem): boolean {
  const kind = disposition(item.disposition);
  return item.open === true
    && item.actionable === true
    && kind !== undefined
    && RESOLVABLE.has(kind)
    && target(item.target) !== undefined
    && typeof item.id === 'string'
    && UUID.test(item.id)
    && typeof item.evidenceSha256 === 'string'
    && SHA256.test(item.evidenceSha256);
}

function exactResolutionReceipt(
  result: ResolveDlqWithoutReplayResult,
  draft: ResolutionDraft,
): boolean {
  const duplicateRequired = DUPLICATE_RISK.has(disposition(draft.item.disposition) ?? 'unclassified');
  const countMatchesReceipt = (result.appliedCount === 1 && result.alreadyApplied === false)
    || (result.appliedCount === 0 && result.alreadyApplied === true);
  return result.schemaVersion === 1
    && result.suite === 'cauce-v3-dlq-no-replay-resolution'
    && result.phase === 'resolved'
    && countMatchesReceipt
    && result.evidenceSha256 === draft.item.evidenceSha256
    && typeof result.reasonSha256 === 'string'
    && SHA256.test(result.reasonSha256)
    && result.possibleDuplicateAcknowledged === (duplicateRequired && draft.possibleDuplicate)
    && result.possibleNoDeliveryAcknowledged === draft.possibleNoDelivery;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function tone(value: DlqDisposition | undefined): 'danger' | 'warning' | 'info' | 'done' | 'unknown' {
  if (value === 'ambiguous' || value === 'missing_final') return 'danger';
  if (value === 'safe_retry' || value === 'auth') return 'warning';
  if (value === 'expected_offline') return 'done';
  if (value === 'unclassified') return 'info';
  return 'unknown';
}

export function OperationalDlqPanel() {
  const api = useApi();
  const resource = useResource('operational-dlq', () => api.getDlq());
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [selectedDisposition, setSelectedDisposition] = useState<'all' | DlqDisposition>('all');
  const [draft, setDraft] = useState<ResolutionDraft>();
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [pagination, setPagination] = useState<{
    source: DlqPage;
    additionalItems: DlqItem[];
    nextCursor?: string;
    loadingMore: boolean;
    error?: string;
  }>();
  /**
   * Each first page opens a generation. A `loadMore` from the previous one cannot append rows
   * nor replace the cursor of the new one even if its response arrives late. The in-flight ref
   * also closes the window between two clicks of the same tick, before React paints
   * `loadingMore=true`.
   */
  const paginationGeneration = useRef(0);
  const paginationRequest = useRef<AbortController | undefined>(undefined);
  const paginationInFlight = useRef(false);
  const firstPageRef = useRef(resource.data);
  firstPageRef.current = resource.data;

  /*
   * The first page is already a complete snapshot: rows, `truncated` and cursor arrived together.
   * Before, rows were rendered directly from `resource.data`, but the cursor was copied to another
   * state in an effect. React therefore committed an impossible frame: the row was already on
   * screen and "Load more" was not yet, even though that same response declared pages remained.
   *
   * Only ADDITIONAL pages live in local state. That state is fenced by identity against the first
   * page it extends; a new first page becomes fully visible again in its first commit and an old
   * response cannot be mixed into it.
   */
  const currentPagination = pagination?.source === resource.data ? pagination : undefined;
  const firstPageCursor = pageCursor(resource.data?.nextCursor);
  const additionalItems = currentPagination?.additionalItems ?? NO_ADDITIONAL_ITEMS;
  const nextCursor = currentPagination ? currentPagination.nextCursor : firstPageCursor;
  const loadingMore = currentPagination?.loadingMore ?? false;
  const paginationError = currentPagination
    ? currentPagination.error
    : resource.data?.truncated === true && firstPageCursor === undefined
      ? 'El servidor indicó que quedan incidentes, pero no entregó un cursor válido. Se detuvo la paginación para no saltar filas.'
      : undefined;

  const invalidatePagination = useCallback(() => {
    paginationGeneration.current += 1;
    paginationRequest.current?.abort();
    paginationRequest.current = undefined;
    paginationInFlight.current = false;
    setPagination((current) => current ? { ...current, loadingMore: false } : current);
  }, []);

  const reloadFirstPage = useCallback(async () => {
    // Invalidated when the refresh STARTS. Waiting for the new first page to arrive would leave a
    // window in which the old page can still win the race and contaminate the view.
    invalidatePagination();
    return resource.reload();
  }, [invalidatePagination, resource]);

  useEffect(() => () => {
    paginationGeneration.current += 1;
    paginationRequest.current?.abort();
    paginationRequest.current = undefined;
    paginationInFlight.current = false;
  }, []);

  const allItems = useMemo(
    () => [...(resource.data?.items ?? []), ...additionalItems],
    [additionalItems, resource.data],
  );

  const rows = useMemo(() => allItems.filter((item) => {
    if (onlyOpen && item.open !== true) return false;
    if (selectedDisposition !== 'all' && item.disposition !== selectedDisposition) return false;
    return true;
  }), [allItems, onlyOpen, selectedDisposition]);

  async function loadMore() {
    const source = resource.data;
    const requestedCursor = nextCursor;
    if (!source || requestedCursor === undefined || paginationInFlight.current) return;
    const generation = paginationGeneration.current;
    const controller = new AbortController();
    paginationRequest.current = controller;
    paginationInFlight.current = true;
    setPagination({
      source,
      additionalItems,
      nextCursor: requestedCursor,
      loadingMore: true,
    });
    try {
      const page = await api.getDlq(200, requestedCursor, controller.signal);
      if (
        controller.signal.aborted
        || generation !== paginationGeneration.current
        || firstPageRef.current !== source
      ) return;
      const incoming = page.items ?? [];
      const followingCursor = pageCursor(page.nextCursor);
      let cursorAfterPage = followingCursor;
      let errorAfterPage: string | undefined;
      if (page.truncated === true && followingCursor === undefined) {
        cursorAfterPage = undefined;
        errorAfterPage = 'La página llegó recortada sin un cursor válido. No se harán consultas ambiguas ni se ocultará el fallo.';
      } else if (followingCursor === requestedCursor) {
        cursorAfterPage = undefined;
        errorAfterPage = 'El servidor repitió el mismo cursor. La paginación se detuvo para evitar un bucle.';
      }
      setPagination((current) => {
        if (
          controller.signal.aborted
          || generation !== paginationGeneration.current
          || firstPageRef.current !== source
          || current?.source !== source
        ) return current;
        const known = new Set(
          [...(source.items ?? []), ...current.additionalItems]
            .map(incidentKey)
            .filter((key): key is string => key !== undefined),
        );
        const additions = incoming.filter((item) => {
          const key = incidentKey(item);
          if (key === undefined) return true;
          if (known.has(key)) return false;
          known.add(key);
          return true;
        });
        return {
          ...current,
          additionalItems: [...current.additionalItems, ...additions],
          nextCursor: cursorAfterPage,
          loadingMore: false,
          error: errorAfterPage,
        };
      });
    } catch (error) {
      if (
        controller.signal.aborted
        || generation !== paginationGeneration.current
        || firstPageRef.current !== source
      ) return;
      setPagination((current) => current?.source === source ? {
        ...current,
        loadingMore: false,
        error: `No se pudo cargar la página siguiente: ${error instanceof Error ? error.message : 'el servidor no dijo por qué'}`,
      } : current);
    } finally {
      if (paginationRequest.current === controller) paginationRequest.current = undefined;
      if (generation === paginationGeneration.current) paginationInFlight.current = false;
    }
  }

  async function resolveWithoutReplay() {
    if (!draft || !canResolve(draft.item)) return;
    const itemTarget = target(draft.item.target);
    const itemDisposition = disposition(draft.item.disposition);
    if (!itemTarget || !itemDisposition || !draft.item.id || !draft.item.evidenceSha256) return;
    const reason = draft.reason.trim();
    const duplicateRequired = DUPLICATE_RISK.has(itemDisposition);
    if (!reason || reason.length > 1_000 || hasControlCharacter(reason)
        || !draft.possibleNoDelivery || (duplicateRequired && !draft.possibleDuplicate)) return;

    setSubmitting(true);
    setNotice(undefined);
    try {
      const result = await api.resolveDlqWithoutReplay({
        target: itemTarget,
        id: draft.item.id,
        evidenceSha256: draft.item.evidenceSha256,
        reason,
        possibleDuplicateAcknowledged: duplicateRequired && draft.possibleDuplicate,
        possibleNoDeliveryAcknowledged: draft.possibleNoDelivery,
      });
      if (!exactResolutionReceipt(result, draft)) {
        throw new Error('el gateway no devolvió un recibo durable exacto; el estado se conserva como desconocido');
      }
      setNotice(result.alreadyApplied
        ? `El incidente ${compactId(draft.item.id)} ya estaba cerrado con esta misma evidencia.`
        : `Incidente ${compactId(draft.item.id)} cerrado sin replay; Cauce no reinyectó ningún efecto.`);
      setDraft(undefined);
      await reloadFirstPage();
    } catch (error) {
      setNotice(`No se pudo cerrar el incidente: ${error instanceof Error ? error.message : 'el servidor no dijo por qué'}`);
    } finally {
      setSubmitting(false);
    }
  }

  if (resource.loading && !resource.data) {
    return <Panel title="DLQ operativo"><LoadingState label="Leyendo la reconciliación causal…" /></Panel>;
  }
  if (resource.error && !resource.data) {
    return <Panel title="DLQ operativo"><ErrorState error={resource.error} onRetry={reloadFirstPage} /></Panel>;
  }

  const duplicateRequired = draft ? DUPLICATE_RISK.has(disposition(draft.item.disposition) ?? 'unclassified') : false;
  const validReason = draft !== undefined && draft.reason.trim().length > 0
    && draft.reason.trim().length <= 1_000
    && !hasControlCharacter(draft.reason.trim());
  const confirmationReady = draft !== undefined && validReason && draft.possibleNoDelivery
    && (!duplicateRequired || draft.possibleDuplicate);

  return (
    <Panel
      title="DLQ operativo"
      subtitle="Incidentes causales separados de las entregas. Cerrar aquí registra una decisión sin replay; nunca reenvía Telegram ni vuelve a ejecutar un agente."
    >
      <div className="dlq-toolbar">
        <label><input type="checkbox" checked={onlyOpen} onChange={(event) => { setOnlyOpen(event.target.checked); }} /> Sólo abiertos</label>
        <label>
          Disposición
          <select value={selectedDisposition} onChange={(event) => { setSelectedDisposition(event.target.value as 'all' | DlqDisposition); }}>
            <option value="all">Todas</option>
            {Object.entries(DISPOSITION).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <span className="dlq-total">{rows.length} visibles · {allItems.length} cargados de <Unknown value={resource.data?.total} />{nextCursor ? ' · quedan páginas' : ''}</span>
        <div className="dlq-toolbar-actions">
          {nextCursor ? (
            <button type="button" className="button small secondary" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? 'Cargando…' : 'Cargar más'}
            </button>
          ) : null}
          <RefreshButton onClick={reloadFirstPage} loading={resource.loading} />
        </div>
      </div>

      {notice ? <p className="notice" role="status">{notice}</p> : null}
      {paginationError ? <p className="notice danger" role="alert">{paginationError}</p> : null}

      {draft ? (
        <div className="dlq-confirmation" role="alertdialog" aria-label="Cerrar incidente DLQ sin replay">
          <p className="confirmacion-titulo"><TriangleAlert size={16} aria-hidden="true" /> Cerrar {compactId(draft.item.id)} sin replay</p>
          <p>Esta acción conserva la carta muerta y su evidencia, registra quién tomó la decisión y no vuelve a enviar ni ejecutar nada.</p>
          <label>
            Motivo operativo
            <textarea
              aria-label="Motivo operativo"
              rows={3}
              maxLength={1_000}
              value={draft.reason}
              onChange={(event) => { setDraft({ ...draft, reason: event.target.value }); }}
            />
          </label>
          <label className="dlq-ack">
            <input
              type="checkbox"
              checked={draft.possibleNoDelivery}
              onChange={(event) => { setDraft({ ...draft, possibleNoDelivery: event.target.checked }); }}
            />
            Entiendo que cerrar sin replay puede dejar el efecto sin entregar.
          </label>
          {duplicateRequired ? (
            <label className="dlq-ack">
              <input
                type="checkbox"
                checked={draft.possibleDuplicate}
                onChange={(event) => { setDraft({ ...draft, possibleDuplicate: event.target.checked }); }}
              />
              La evidencia es incierta: entiendo que el efecto pudo haberse entregado y existir duplicado fuera de Cauce.
            </label>
          ) : null}
          <div className="confirmacion-acciones">
            <button type="button" className="button primary" disabled={!confirmationReady || submitting} onClick={() => void resolveWithoutReplay()}>
              <CheckCircle2 size={15} aria-hidden="true" /> {submitting ? 'Cerrando…' : 'Cerrar sin replay'}
            </button>
            <button type="button" className="button small secondary" disabled={submitting} onClick={() => { setDraft(undefined); }}>No hacer nada</button>
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? <EmptyState>No hay incidentes que coincidan con el filtro.</EmptyState> : (
        <div className="table-wrap">
          <table className="tabla-dlq">
            <caption className="sr-only">Incidentes de DLQ con clasificación causal</caption>
            <thead><tr><th>Incidente</th><th>Tenant</th><th>Origen</th><th>Disposición</th><th>Intentos</th><th>Evidencia</th><th>Creado</th><th>Resolución</th><th>Acción</th></tr></thead>
            <tbody>{rows.map((item, index) => {
              const itemDisposition = disposition(item.disposition);
              const resolvable = canResolve(item);
              return (
                <tr key={`${item.target ?? 'unknown'}:${String(item.id ?? index)}`}>
                  <td data-label="Incidente"><span className="mono" title={item.id ?? undefined}>{compactId(item.id)}</span><small className="subline"><Unknown value={target(item.target)} /></small></td>
                  <td data-label="Tenant"><Unknown value={item.tenantId} /></td>
                  <td data-label="Origen"><Unknown value={item.kind} /><small className="subline"><Unknown value={item.adapter} ausente="no-aplica" /></small></td>
                  <td data-label="Disposición"><Badge tone={tone(itemDisposition)}><Unknown value={itemDisposition ? DISPOSITION[itemDisposition] : undefined} /></Badge></td>
                  <td data-label="Intentos"><Unknown value={item.attempts} /></td>
                  <td data-label="Evidencia"><span className="mono" title={item.evidenceSha256 ?? undefined}>{item.evidenceSha256?.slice(0, 12) ?? 'UNKNOWN'}</span></td>
                  <td data-label="Creado"><Time value={item.createdAt} relativo /></td>
                  <td data-label="Resolución"><Unknown value={item.resolutionRule} ausente={item.open ? 'todavia-no' : 'sin-dato'} /><small className="subline"><Time value={item.resolvedAt} relativo /></small></td>
                  <td data-label="Acción">
                    {resolvable ? (
                      <button type="button" className="button small" onClick={() => { setDraft({ item, reason: '', possibleDuplicate: false, possibleNoDelivery: false }); }}>
                        <ShieldAlert size={15} aria-hidden="true" /> Cerrar sin replay
                      </button>
                    ) : <span className="muted">{item.open ? 'Requiere evidencia causal' : 'Cerrado'}</span>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
