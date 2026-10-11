import { useState, type ReactNode } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { usePolling } from '../../api/use-polling';
import { Button, Notice } from '../../components/kit';
import type { OfficeRoom } from '../../api/client/company-client';
import type { TopologySnapshot } from '../../api/types';
import { onNavClick } from '../../router';
import { canManageCompany, useCompanyAuthority } from '../auth/company-authority';
import { agentFatigue } from '../accounts/quota-availability';
import { FatigueIndicator } from '../accounts/FatigueIndicator';
import { OfficeLayoutEditor } from './OfficeLayoutEditor';
import { officeLayoutProblem, officeRoomKey, officeRooms, reconcileOfficeLayout } from './office-layout';
import type { OfficeAgent } from './office-agent';

export function OfficeWorkspace({ campus, topology, agents, onAgent }: {
  campus: ReactNode; topology?: TopologySnapshot; agents: readonly OfficeAgent[]; onAgent: (id: string) => void;
}) {
  const api = useApi();
  const authority = useCompanyAuthority();
  const layout = useResource('office-layout', () => api.getOfficeLayout());
  const quotas = useResource('office-quota-accounts', () => api.getQuotaAccounts());
  usePolling(() => { void quotas.reload(); }, 30_000);
  const [mode, setMode] = useState<'campus' | 'plan'>('campus');
  const [draft, setDraft] = useState<{ version: number; rooms: OfficeRoom[] }>();
  const [roomKey, setRoomKey] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const rooms = officeRooms(topology);
  const shown = reconcileOfficeLayout(rooms, draft?.rooms ?? layout.data?.rooms ?? []);
  const writable = canManageCompany(authority?.role) && !!layout.data && !layout.error && !layout.loading && !busy;
  const selected = shown.find(room => officeRoomKey(room.tenant_id, room.room_id) === roomKey);
  const info = rooms.find(room => officeRoomKey(room.tenant, room.id) === roomKey);
  const left = Math.min(0, ...shown.map(room => room.x));
  const top = Math.min(0, ...shown.map(room => room.y));
  const width = Math.max(800, ...shown.map(room => room.x - left + room.width + 24));
  const height = Math.max(500, ...shown.map(room => room.y - top + room.height + 24));
  function update(room: OfficeRoom) {
    if (!writable || !layout.data) return;
    setNotice(''); setDraft({ version: draft?.version ?? layout.data.version, rooms: shown.map(current => officeRoomKey(current.tenant_id, current.room_id)
      === officeRoomKey(room.tenant_id, room.room_id) ? room : current) });
  }
  async function save() {
    if (!writable || !draft) return;
    const problem = officeLayoutProblem(shown);
    if (problem) { setError(problem); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await api.saveOfficeLayout({ expected_version: draft.version, rooms: shown });
      setDraft(undefined); const reread = await layout.reload();
      if (reread.error) throw new Error(`El plano se guardó, pero no se pudo releer: ${reread.error.message}`);
      setNotice('Plano de oficina guardado para esta empresa.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se confirmó el plano.'); }
    finally { setBusy(false); }
  }
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2" aria-label="Vistas de oficina">
      <Button size="sm" aria-pressed={mode === 'campus'} onClick={() => { setMode('campus'); }}>Campus</Button>
      <Button size="sm" aria-pressed={mode === 'plan'} onClick={() => { setMode('plan'); }}>Plano editable</Button>
      {draft ? <span className="text-xs text-warn-ink">Plano sin guardar</span> : null}
      <a className="ml-auto text-xs text-brand-ink" href="/config?seccion=espacios" onClick={event => { onNavClick(event, '/config?seccion=espacios'); }}>Gestionar salas y asignaciones</a>
    </div>
    <div className={mode === 'campus' ? 'min-h-0 flex-1' : 'hidden'}>{campus}</div>
    {mode === 'plan' ? <div className="grid min-h-0 flex-1 content-start gap-3 overflow-auto p-4">
      <header className="flex flex-wrap items-center justify-between gap-2"><h2 className="m-0 text-lg">Plano de oficina</h2>
        <div className="flex flex-wrap gap-2"><Button disabled={busy || layout.loading || !!draft} onClick={() => { void layout.reload(); void quotas.reload(); }}>Releer plano y cuotas</Button>
          <Button variant="primary" disabled={!writable || !draft} onClick={() => { void save(); }}>Guardar plano</Button>
          <Button disabled={busy || !draft} onClick={() => { setDraft(undefined); setError(''); }}>Descartar cambios de plano</Button></div></header>
      {layout.loading ? <p role="status">Leyendo plano…</p> : null}
      {layout.error || quotas.error || error ? <Notice tone="danger" role="alert">{error || layout.error?.message || quotas.error?.message}</Notice> : null}
      {notice ? <Notice tone="ok" role="status">{notice}</Notice> : null}
      {!rooms.length ? <Notice tone="info">Aún no hay salas. Crea una desde «Gestionar salas y asignaciones».</Notice> : null}
      <p className="m-0 text-xs text-muted">Selecciona una sala para cambiar su posición, tamaño y partes. Los agentes y asignaciones vienen de las salas actuales.</p>
      <div className="max-h-[65dvh] overflow-auto rounded-xl border border-line bg-subtle">
        <div aria-label="Mapa de salas y agentes" className="relative" style={{ width, height }}>{shown.map(room => {
          const identity = officeRoomKey(room.tenant_id, room.room_id);
          const roomInfo = rooms.find(value => officeRoomKey(value.tenant, value.id) === identity);
          return <section key={identity} aria-label={`Sala ${room.tenant_id}/${roomInfo?.label ?? room.room_id}`}
            className="absolute overflow-hidden rounded-lg border-2 border-line-strong bg-surface p-2" style={{ left: room.x - left, top: room.y - top, width: room.width, height: room.height }}>
            {room.parts.map(part => <div key={part.id} aria-label={`Parte ${part.label}`} className="pointer-events-none absolute rounded-md border border-dashed border-brand/50 bg-brand-soft p-1 text-xs text-brand-ink"
              style={{ left: part.x, top: part.y, width: part.width, height: part.height }}>{part.label}</div>)}
            <Button size="sm" className="relative z-10 w-full justify-start" aria-pressed={identity === roomKey} disabled={!writable}
              onClick={() => { setRoomKey(identity); }}>{roomInfo?.label ?? room.room_id} <span className="ml-auto text-[10px] text-muted">{room.tenant_id}</span></Button>
            <div className="relative z-10 mt-2 flex flex-wrap gap-2">{roomInfo?.agents.map(id => {
              const agent = agents.find(value => value.id === id);
              const cut = id.indexOf('/');
              const fatigue = quotas.error ? 'error' : agentFatigue(quotas.data?.accounts ?? [], id.slice(0, cut), id.slice(cut + 1));
              return <Button key={id} size="sm" onClick={() => { onAgent(id); }} className="grid h-auto gap-1 bg-surface p-2" title={agent?.reason}>
                <span>{agent?.name ?? id.slice(cut + 1)}</span><FatigueIndicator state={fatigue} />
              </Button>;
            })}</div>
          </section>;
        })}</div>
      </div>
      {selected && info && writable ? <OfficeLayoutEditor room={selected} info={info} busy={busy} update={update} /> : null}
    </div> : null}
  </div>;
}
