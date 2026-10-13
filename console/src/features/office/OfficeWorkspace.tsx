import { useState, type ReactNode } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
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
import { officeFailure, planSaveUnavailableReason } from './office-errors';
import { officeLayoutProblem, officeRoomKey, officeRooms, reconcileOfficeLayout } from './office-layout';
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
  const [draft, setDraft] = useState<{ version: number; rooms: OfficeRoom[] }>();
  const [roomKey, setRoomKey] = useState<string>();
  const [busy, setBusy] = useState(false);
  // The campus reads the saved plan once when it mounts: a new key after each save makes it read the new one.
  const [planSaves, setPlanSaves] = useState(0);
  const [error, setError] = useState<Failure>();
  const [notice, setNotice] = useState('');
  const rooms = officeRooms(topology, layout.data?.available);
  const shown = reconcileOfficeLayout(rooms, draft?.rooms ?? layout.data?.rooms ?? []);
  const writable = canManageCompany(authority?.role) && !!layout.data && !layout.error && !layout.loading && !busy;
  const failure = error ?? (layout.error ? officeFailure(layout.error) : undefined);
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
    setNotice(''); setDraft({ version: draft?.version ?? layout.data.version, rooms: shown.map(current => officeRoomKey(current.tenant_id, current.room_id)
      === officeRoomKey(room.tenant_id, room.room_id) ? room : current) });
  }
  async function save() {
    if (!writable || !draft) return;
    const problem = officeLayoutProblem(shown);
    if (problem) { setError({ message: problem }); return; }
    setBusy(true); setError(undefined); setNotice('');
    try {
      await api.saveOfficeLayout({ expected_version: draft.version, rooms: shown });
    } catch (cause) {
      setError(officeFailure(cause));
      setBusy(false);
      return;
    }
    setDraft(undefined); setPlanSaves(count => count + 1);
    const reread = await layout.reload();
    if (reread.error) {
      const failure = officeFailure(reread.error);
      setError({ ...failure, message: `El plano se guardó, pero no se pudo releer: ${failure.message}` });
    }
    else setNotice('Plano de oficina guardado para esta empresa.');
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
      <section aria-label="Cansancio de agentes del campus" className="flex shrink-0 gap-2 overflow-x-auto border-b border-line bg-subtle p-2">
        {[...new Set(rooms.flatMap(room => room.agents))].map(agentButton)}
      </section>
      <div className="min-h-0 flex-1">{campus}</div>
    </div>
    {mode === 'plan' ? <div className="grid min-h-0 flex-1 content-start gap-3 overflow-auto p-4">
      <header className="flex flex-wrap items-center justify-between gap-2"><h2 className="m-0 text-lg">Plano de oficina</h2>
        <div className="flex flex-wrap gap-2"><Button disabled={busy || layout.loading || !!draft} onClick={() => { void layout.reload(); void quotas.reload(); }}>Releer plano y cuotas</Button>
          <Button variant="primary" disabled={!writable || !draft} onClick={() => { void save(); }}>Guardar plano</Button>
          <Button disabled={busy || !draft} onClick={() => { setDraft(undefined); setError(undefined); }}>Descartar cambios de plano</Button></div></header>
      {unavailable || draft ? <p className="m-0 text-xs text-muted">{unavailable ?? 'Guarda o descarta los cambios de plano antes de releerlo.'}</p> : null}
      {layout.loading ? <p role="status">Leyendo plano…</p> : null}
      {failure ? <ErrorNotice failure={failure} /> : null}
      {quotas.error ? <ErrorNotice failure={quotaReadFailure(quotas.error, 'No se pudieron leer las cuotas de los agentes. Relee el plano y las cuotas.')} /> : null}
      {notice ? <Notice tone="ok" role="status">{notice}</Notice> : null}
      {!topology ? <p role="status" className="m-0 text-xs">Leyendo salas…</p> : null}
      {roomsRead && !rooms.length ? <Notice tone="info">Aún no hay salas. Crea una desde «Gestionar salas y asignaciones».</Notice> : null}
      {/* An empty map would only be a blank scroller with nothing to select: the notice above already says what to do. */}
      {rooms.length ? <><p className="m-0 text-xs text-muted">{authority && !canManageCompany(authority.role) ? 'Selecciona una sala para ver sus agentes y su cansancio.'
        : 'Selecciona una sala para cambiar su posición, tamaño y partes.'} Los agentes y asignaciones vienen de las salas actuales.</p>
      <div className="min-h-64 max-h-[65dvh] overflow-auto rounded-xl border border-line bg-subtle">
        <div aria-label="Mapa de salas y agentes" className="relative" style={{ width, height }}>{shown.map(room => {
          const identity = officeRoomKey(room.tenant_id, room.room_id);
          const roomInfo = rooms.find(value => officeRoomKey(value.tenant, value.id) === identity);
          return <section key={identity} aria-label={`Sala ${room.tenant_id}/${roomInfo?.label ?? room.room_id}`}
            className="absolute overflow-hidden rounded-lg border-2 border-line-strong bg-surface p-2" style={{ left: room.x - left, top: room.y - top, width: room.width, height: room.height }}>
            {room.parts.map(part => <div key={part.id} aria-label={`Parte ${part.label}`} className="pointer-events-none absolute rounded-md border border-dashed border-brand/50 bg-brand-soft p-1 text-xs text-brand-ink"
              style={{ left: part.x, top: part.y, width: part.width, height: part.height }}>{part.label}</div>)}
            <Button size="sm" className="relative z-10 w-full justify-start" aria-pressed={identity === roomKey}
              onClick={() => { setRoomKey(identity); }}>{roomInfo?.label ?? room.room_id} <span className="ml-auto text-[10px] text-muted">{room.tenant_id}</span></Button>
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
