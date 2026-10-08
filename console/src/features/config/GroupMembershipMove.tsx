import { useEffect, useState } from 'react';
import type { ConfigurationSnapshot } from '../../api/types';
import { AgentLifecyclePanel } from './AgentLifecyclePanel';
import { membershipMoveIntent } from './GroupMembershipModel';
import type { ConfigMutationRunner } from './use-config-mutation';

export function GroupMembershipMove({ tenantId, roomId, snapshot, runner, busy, initialAlias = '', onDirtyChange }: {
  tenantId: string; roomId: string; snapshot: ConfigurationSnapshot; runner: ConfigMutationRunner; busy: boolean;
  initialAlias?: string; onDirtyChange?: (dirty: boolean) => void;
}) {
  const [alias, setAlias] = useState(initialAlias);
  const [destination, setDestination] = useState('');
  const [error, setError] = useState<string>();
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const members = (snapshot.memberships ?? []).filter((row) => row.tenant_id === tenantId && row.room_id === roomId && typeof row.alias === 'string');
  const rooms = (snapshot.rooms ?? []).filter((row) => row.tenant_id === tenantId && row.id !== roomId && row.enabled === true && typeof row.id === 'string');
  const pending = destination !== '' || alias !== initialAlias;
  useEffect(() => { onDirtyChange?.(pending); }, [pending, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
  const intent = alias && destination ? membershipMoveIntent(snapshot, tenantId, roomId, alias, destination) : undefined;
  async function preview() {
    if (!intent || intent.error) { setError(intent?.error ?? 'Elige miembro y grupo de destino.'); return; }
    if (intent.runtimeTarget) { setRuntimeOpen(true); setError(undefined); return; }
    if (intent.batch) { setError(undefined); await runner.run(intent.batch, true); }
  }
  return <section className="config-room-members" aria-label={`Movimiento de miembros de ${tenantId}/${roomId}`}>
    <h4>Mover miembros a otro grupo</h4>
    <p>El registro inactivo cambia membresía y grupo primario en una transacción. Un agente con runtime requiere preparar y verificar la nueva intención operativa.</p>
    <p>En el movimiento operativo, la membresía de origen se conserva deshabilitada como historial. La nueva pertenencia se acredita antes de volver a admitir entregas.</p>
    <label>Miembro a mover<select value={alias} disabled={busy || !runner.canWrite} onChange={(event) => {
      setAlias(event.target.value); setRuntimeOpen(false); setError(undefined); runner.clear();
    }}><option value="">Elige un miembro</option>{members.map((member) => <option key={String(member.alias)} value={String(member.alias)}>{String(member.alias)}</option>)}</select></label>
    <label>Grupo de destino<select value={destination} disabled={busy || !runner.canWrite} onChange={(event) => {
      setDestination(event.target.value); setRuntimeOpen(false); setError(undefined); runner.clear();
    }}><option value="">Elige otro grupo del mismo espacio</option>{rooms.map((room) =>
      <option key={String(room.id)} value={String(room.id)}>{typeof room.display_name === 'string' ? room.display_name : String(room.id)} · {JSON.stringify(room.id)}</option>)}</select></label>
    {error ? <p className="notice" role="alert">{error}</p> : null}
    <div className="config-actions"><button type="button" className="button secondary" disabled={busy || !runner.canWrite}
      onClick={() => { void preview(); }}>{intent?.runtimeTarget ? 'Preparar movimiento operativo' : 'Previsualizar movimiento atómico'}</button>
      <button type="button" className="button primary" disabled={busy || !runner.canWrite || !intent?.batch || !runner.isValidated(intent.batch)}
        onClick={() => { if (intent?.batch) void runner.run(intent.batch, false); }}>Confirmar movimiento atómico</button></div>
    {intent?.batch && runner.isValidated(intent.batch) ? <pre aria-label="Movimiento atómico propuesto">{JSON.stringify(intent.batch, null, 2)}</pre> : null}
    {runner.notice ? <p className={`notice ${runner.notice.tone}`} role={runner.notice.tone === 'success' ? 'status' : 'alert'}>{runner.notice.text}</p> : null}
    {runtimeOpen && intent?.runtimeTarget && intent.runtimeDraft ? <AgentLifecyclePanel key={JSON.stringify([tenantId, alias, destination])}
      snapshot={snapshot} target={intent.runtimeTarget} initialDraft={intent.runtimeDraft} initialOpen /> : null}
  </section>;
}
