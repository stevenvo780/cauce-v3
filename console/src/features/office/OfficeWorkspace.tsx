import { useEffect, useState, type ReactNode } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { ActionButton } from '../../components/action-button';
import { diffConflictFields, type ConflictFieldDiff } from '../../components/conflict';
import { ConflictNotice } from '../../components/ConflictNotice';
import { Button, Notice } from '../../components/kit';
import { ErrorNotice } from '../../components/ErrorNotice';
import type { Failure } from '../../api/error-message';
import type { OfficeRoom } from '../../api/client/company-client';
import type { TopologySnapshot } from '../../api/types';
import { onNavClick } from '../../router';
import { useQuotaAccounts } from '../../shell/fleet-context';
import { canManageCompany, useCompanyAuthority } from '../auth/company-authority';
import { agentFatigue } from '../accounts/quota-availability';
import { quotaReadFailure } from '../accounts/quota-messages';
import { FatigueIndicator } from '../accounts/FatigueIndicator';
import { OfficeLayoutEditor } from './OfficeLayoutEditor';
import { officeFailure, officeVersionConflict, planSaveUnavailableReason } from './office-errors';
import { officeLayoutProblem, officeRoomKey, officeRooms, rebaseOfficeDraft, reconcileOfficeLayout, reconcileOfficeLayoutIncludingSaved } from './office-layout';
import type { OfficeAgent } from './office-agent';

export function OfficeWorkspace({ campus, topology, agents, onAgent }: {
  campus: ReactNode; topology?: TopologySnapshot; agents: readonly OfficeAgent[]; onAgent: (id: string) => void;
}) {
  const api = useApi();
  const authority = useCompanyAuthority();
  const layout = useResource('office-layout', () => api.getOfficeLayout());
  // Plan, campus strip and agent sheet read the one shared quota snapshot of the fleet provider.
  const quotas = useQuotaAccounts();
  const [mode, setMode] = useState<'campus' | 'plan'>('campus');
  // `base` is the saved plan the draft started from: after a 409 it tells what the draft changed and what the other person did.
  const [draft, setDraft] = useState<{ version: number; base: OfficeRoom[]; rooms: OfficeRoom[]; conflicted?: boolean; introduced?: readonly string[] }>();
  const [roomKey, setRoomKey] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [conflictDiffs, setConflictDiffs] = useState<ConflictFieldDiff[]>();
  // The campus reads the saved plan once when it mounts: a new key after each save makes it read the new one.
  const [planSaves, setPlanSaves] = useState(0);
  const [error, setError] = useState<Failure>();
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; text: string }>();
  const rooms = officeRooms(topology, layout.data?.available);
  // An introduced room is only bridged until the topology lists it: once listed, a later drop must not resurrect it.
  useEffect(() => {
    if (!draft?.introduced?.length) return;
    const known = new Set(rooms.map(room => officeRoomKey(room.tenant, room.id)));
    if (!draft.introduced.some(key => known.has(key))) return;
    setDraft(current => current?.introduced
      ? { ...current, introduced: current.introduced.filter(key => !known.has(key)) } : current);
  }, [draft?.introduced, rooms]);
  const shown = draft ? reconcileOfficeLayoutIncludingSaved(rooms, draft.rooms, draft.introduced ?? []) : reconcileOfficeLayout(rooms, layout.data?.rooms ?? []);
  const writable = canManageCompany(authority?.role) && !!layout.data && !layout.error && !layout.loading && !busy;
  const failure = error ?? (layout.error ? officeFailure(layout.error) : undefined);
  const quotaFailure = quotas.error ? quotaReadFailure(quotas.error, 'No se pudieron leer las cuotas de los agentes. Relee el plano y las cuotas.') : undefined;
  // Rooms are known once the topology arrived and the saved plan answered, with data or with an error.
  const roomsRead = !!topology && (!!layout.data || !!layout.error);
  const unavailable = planSaveUnavailableReason({ role: authority?.role, layoutError: !!layout.error, draft: !!draft });
  const selected = shown.find(room => officeRoomKey(room.tenant_id, room.room_id) === roomKey);
  const info = rooms.find(room => officeRoomKey(room.tenant, room.id) === roomKey);
  const left = Math.min(0, ...shown.map(room => room.x));
  const top = Math.min(0, ...shown.map(room => room.y));
  const width = Math.max(800, ...shown.map(room => room.x - left + room.width + 24));
  const height = Math.max(500, ...shown.map(room => room.y - top + room.height + 24));
  function agentButton(id: string) {
    const agent = agents.find(value => value.id === id);
    const cut = id.indexOf('/');
    const reading = quotas.loading && !quotas.data && !quotas.error;
    const fatigue = quotas.error ? 'error' : agentFatigue(quotas.data?.accounts ?? [], id.slice(0, cut), id.slice(cut + 1));
    return <Button key={id} size="sm" onClick={() => { onAgent(id); }} className="grid h-auto min-w-0 max-w-full shrink-0 gap-1 whitespace-normal bg-surface p-2" title={agent?.reason}>
      <span className="min-w-0 wrap-anywhere">{agent?.name ?? id.slice(cut + 1)}</span>{reading ? <span role="status" className="text-xs text-muted">Leyendo cuotas…</span> : <FatigueIndicator state={fatigue} />}
    </Button>;
  }
  function update(room: OfficeRoom) {
    if (!writable || !layout.data) return;
    setNotice(undefined); setDraft({ ...draft, version: draft?.version ?? layout.data.version, base: draft?.base ?? shown,
      rooms: shown.map(current => officeRoomKey(current.tenant_id, current.room_id) === officeRoomKey(room.tenant_id, room.room_id) ? room : current) });
  }
  function roomSummary(room: OfficeRoom): string {
    const parts = room.parts.map(part => part.label).join(', ');
    return `posición (${String(room.x)}, ${String(room.y)}) · tamaño ${String(room.width)}×${String(room.height)} · partes: ${parts || 'ninguna'}`;
  }
  function planDiffs(mine: readonly OfficeRoom[], theirs: readonly OfficeRoom[]): ConflictFieldDiff[] {
    const byKey = (list: readonly OfficeRoom[]) => Object.fromEntries(list.map(room => [officeRoomKey(room.tenant_id, room.room_id), roomSummary(room)]));
    const labels = Object.fromEntries([...mine, ...theirs].map(room => {
      const key = officeRoomKey(room.tenant_id, room.room_id);
      const info = rooms.find(value => officeRoomKey(value.tenant, value.id) === key);
      return [key, `${room.tenant_id}/${info?.label ?? room.room_id}`];
    }));
    return diffConflictFields(byKey(mine), byKey(theirs), labels);
  }
  async function save() {
    if (!writable || !draft || draft.conflicted) return;
    const problem = officeLayoutProblem(shown);
    if (problem) { setError({ message: problem }); return; }
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      await api.saveOfficeLayout({ expected_version: draft.version, rooms: shown });
    } catch (cause) {
      setError(officeFailure(cause));
      if (officeVersionConflict(cause)) {
        setDraft(current => current ? { ...current, conflicted: true } : current);
        const reread = await layout.reload();
        if (reread.data) {
          const freshRooms = officeRooms(topology, reread.data.available);
          setConflictDiffs(planDiffs(shown, reconcileOfficeLayoutIncludingSaved(freshRooms, reread.data.rooms)));
        } else setConflictDiffs([]);
      }
      setBusy(false);
      return;
    }
    setDraft(undefined); setConflictDiffs(undefined); setPlanSaves(count => count + 1);
    const reread = await layout.reload();
    if (reread.error) {
      const failure = officeFailure(reread.error);
      setError({ ...failure, message: `El plano se guardó, pero no se pudo releer: ${failure.message}` });
    }
    else setNotice({ tone: 'ok', text: 'Plano de oficina guardado para esta empresa.' });
    setBusy(false);
  }
  async function rereadPlan() {
    setBusy(true);
    const plan = layout.reload();
    void quotas.reload();
    const reread = await plan;
    if (reread.data) setError(undefined);
    else setError(officeFailure(reread.error));
    setBusy(false);
    return reread;
  }
  /**
   * After a 409 nothing is overwritten until the person chooses: load the other person's plan and drop the draft,
   * or reapply only what the draft changed on top of it and review the result before saving it again.
   */
  async function resolveConflict(choice: 'theirs' | 'reapply') {
    if (!draft?.conflicted) return;
    setBusy(true); setNotice(undefined);
    const plan = layout.reload();
    void quotas.reload();
    const reread = await plan;
    if (reread.data) {
      setError(undefined);
      setConflictDiffs(undefined);
      if (choice === 'theirs') {
        setDraft(undefined);
        setNotice({ tone: 'ok', text: 'Se cargó el plano que guardó la otra persona y se descartó tu borrador.' });
      } else {
        const freshRooms = officeRooms(topology, reread.data.available);
        const theirs = reconcileOfficeLayoutIncludingSaved(freshRooms, reread.data.rooms);
        const known = new Set(freshRooms.map(room => officeRoomKey(room.tenant, room.id)));
        const savable = reread.data.available && new Set(reread.data.available.map(room => officeRoomKey(room.tenant_id, room.room_id)));
        const introduced = theirs.flatMap(room => {
          const key = officeRoomKey(room.tenant_id, room.room_id);
          return known.has(key) || (savable && !savable.has(key)) ? [] : [key];
        });
        const rebased = rebaseOfficeDraft(draft.base, draft.rooms, theirs);
        setDraft({ version: reread.data.version, base: theirs, rooms: rebased.rooms, introduced });
        const labels = rebased.overridden.map(key => {
          const room = freshRooms.find(value => officeRoomKey(value.tenant, value.id) === key);
          return room ? `${room.tenant}/${room.label}` : key;
        });
        setNotice(labels.length
          ? { tone: 'warn', text: `Tu borrador se reaplicó sobre la versión nueva. En ${labels.join(', ')} tu cambio sustituye al de la otra persona; revisa el plano antes de guardarlo.` }
          : { tone: 'ok', text: 'Tu borrador se reaplicó sobre la versión nueva sin tocar lo que cambió la otra persona. Revisa el plano y guárdalo.' });
      }
    }
    setBusy(false);
  }
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2" aria-label="Vistas de oficina">
      <Button size="sm" aria-pressed={mode === 'campus'} onClick={() => { setMode('campus'); }}>Campus</Button>
      <Button size="sm" aria-pressed={mode === 'plan'} onClick={() => { setMode('plan'); }}>Plano editable</Button>
      {draft ? <span className="text-xs text-warn-ink">Plano sin guardar</span> : null}
      <a className="ml-auto text-xs text-brand-ink" href="/config?seccion=espacios" onClick={event => { onNavClick(event, '/config?seccion=espacios'); }}>Gestionar salas y asignaciones</a>
    </div>
    <div key={planSaves} className={mode === 'campus' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      {mode === 'campus' && quotaFailure ? <div className="shrink-0"><ErrorNotice failure={{ ...quotaFailure,
        message: `${quotaFailure.message}${quotaFailure.message.includes('Relee el plano y las cuotas.') ? '' : ' Relee el plano y las cuotas.'} Abre «Plano editable» para hacerlo.` }} /></div> : null}
      {/* The strip wraps instead of scrolling sideways: a wheel or a phone swipe never reveals what a horizontal
          scroller cuts. Two rows stay in view and the rest scrolls down, so the campus keeps its height. */}
      <section aria-label="Cansancio de agentes del campus" className="flex max-h-36 shrink-0 flex-wrap content-start gap-2 overflow-y-auto border-b border-line bg-subtle p-2">
        {[...new Set(rooms.flatMap(room => room.agents))].map(agentButton)}
      </section>
      <div className="min-h-0 flex-1">{campus}</div>
    </div>
    {mode === 'plan' ? <div className="grid min-h-0 flex-1 content-start gap-3 overflow-auto p-4">
      <header className="flex flex-wrap items-center justify-between gap-2"><h2 className="m-0 text-lg">Plano de oficina</h2>
        <div className="flex flex-wrap gap-2"><ActionButton label="Releer plano y cuotas" disabled={busy || !!draft} busy={layout.loading} announceError={false} action={() => rereadPlan()} />
          <Button variant="primary" disabled={!writable || !draft || draft.conflicted} onClick={() => { void save(); }}>Guardar plano</Button>
          <Button disabled={busy || !draft} onClick={() => { setDraft(undefined); setConflictDiffs(undefined); setError(undefined); }}>Descartar cambios de plano</Button></div></header>
      {unavailable || (draft && !draft.conflicted) ? <p className="m-0 text-xs text-muted">{unavailable ?? 'Guarda o descarta los cambios de plano antes de releerlo.'}</p> : null}
      {layout.loading ? <p role="status">Leyendo plano…</p> : null}
      {failure && !draft?.conflicted ? <ErrorNotice failure={failure} /> : null}
      {draft?.conflicted ? <ConflictNotice title="Otra persona guardó una versión nueva del plano."
        diffs={conflictDiffs} busy={busy || layout.loading}
        onRetry={() => { void resolveConflict('reapply'); }}
        onDiscard={() => { void resolveConflict('theirs'); }} /> : null}
      {quotaFailure ? <ErrorNotice failure={quotaFailure} /> : null}
      {notice ? <Notice tone={notice.tone} role="status">{notice.text}</Notice> : null}
      {!topology ? <p role="status" className="m-0 text-xs">Leyendo salas…</p> : null}
      {roomsRead && !rooms.length ? <Notice tone="info">Aún no hay salas. Crea una desde «Gestionar salas y asignaciones».</Notice> : null}
      {/* An empty map would only be a blank scroller with nothing to select: the notice above already says what to do. */}
      {rooms.length ? <><p className="m-0 text-xs text-muted">{authority && !canManageCompany(authority.role) ? 'Selecciona una sala para ver sus agentes y su cansancio.'
        : 'Selecciona una sala para cambiar su posición, tamaño y partes.'} Los agentes y asignaciones vienen de las salas actuales.</p>
      <div className="min-h-64 max-h-[65dvh] overflow-auto rounded-xl border border-line bg-subtle">
        <div aria-label="Mapa de salas y agentes" className="relative" style={{ width, height }}>{shown.map(room => {
          const identity = officeRoomKey(room.tenant_id, room.room_id);
          const roomInfo = rooms.find(value => officeRoomKey(value.tenant, value.id) === identity);
          const roomAgents = roomInfo?.agents ?? [];
          return <section key={identity} aria-label={`Sala ${room.tenant_id}/${roomInfo?.label ?? room.room_id}`}
            onClick={() => { setRoomKey(identity); }}
            className={`absolute cursor-pointer overflow-hidden rounded-lg border-2 bg-surface p-2 ${identity === roomKey ? 'border-brand' : 'border-line-strong'}`} style={{ left: room.x - left, top: room.y - top, width: room.width, height: room.height }}>
            {room.parts.map(part => <div key={part.id} aria-label={`Parte ${part.label}`} className="pointer-events-none absolute rounded-md border border-dashed border-brand/50 bg-brand-soft p-1 text-xs text-brand-ink"
              style={{ left: part.x, top: part.y, width: part.width, height: part.height }}>{part.label}</div>)}
            <Button size="sm" className="relative z-10 w-full min-w-0 justify-start" aria-pressed={identity === roomKey}
              onClick={(event) => { event.stopPropagation(); setRoomKey(identity); }}>
              <span className="min-w-0 truncate">{roomInfo?.label ?? room.room_id}</span>
              <span title={room.tenant_id} className="ml-auto max-w-[45%] shrink truncate text-[10px] text-muted">{room.tenant_id}</span>
            </Button>
            <div className="relative z-10 mt-2 flex max-h-[calc(100%-2.75rem)] flex-wrap content-start gap-1 overflow-y-auto"
              onClick={(event) => { event.stopPropagation(); }}>
              {roomAgents.map(agentButton)}
              {!roomAgents.length ? <p className="m-0 text-[11px] text-muted">Sin agentes en esta sala.</p> : null}
            </div>
          </section>;
        })}</div>
      </div></> : null}
      {selected && info ? <section aria-label={`Agentes de sala ${info.tenant}/${info.label}`} className="grid gap-2 rounded-xl border border-line bg-surface p-3">
        <h3 className="m-0 min-w-0 wrap-anywhere text-sm">Agentes de {info.label} <span className="text-xs text-muted">{info.tenant}</span></h3>
        <div className="flex flex-wrap gap-2">{info.agents.map(agentButton)}</div>
        {!info.agents.length ? <p className="m-0 text-xs text-muted">Esta sala no tiene agentes asignados.</p> : null}
      </section> : null}
      {selected && info && writable ? <OfficeLayoutEditor room={selected} info={info} busy={busy} update={update} /> : null}
    </div> : null}
  </div>;
}
