import { Pencil, Plus, RotateCcw, Trash2, Users } from 'lucide-react';
import type { ConfigurationSnapshot } from '../../api/types';
import { Button, Pill, SectionCard } from '../../components/kit';
import { EmptyState } from '../../components/ui';
import { retiredConfigRows } from './config-form-access';
import { type ConfigFormTarget } from './config-form-model';
import { teamBlock } from './team-access';
import { groupHasRuntime, groupOperationTarget } from './GroupMembershipModel';
import type { ConfigWrites } from './use-config-writes';

type Row = Record<string, unknown>;

function teamLabel(row: Row): string {
  return typeof row.display_name === 'string' && row.display_name.trim() ? row.display_name.trim() : String(row.id);
}

function members(snapshot: ConfigurationSnapshot, room: Row): string[] {
  return (snapshot.memberships ?? []).filter((member) => member.tenant_id === room.tenant_id && member.room_id === room.id)
    .map((member) => String(member.alias));
}

/**
 * Teams (topology rooms, «grupos») inside the Agents view: list, create, edit and delete, each opening the same typed
 * form / removal flow as «Espacios y salas», in a modal.
 */
export function TeamsPanel({ snapshot, ctx }: { snapshot: ConfigurationSnapshot; ctx: ConfigWrites }) {
  const rooms = snapshot.rooms;
  const retired = retiredConfigRows(snapshot, 'rooms') ?? [];
  const block = (target: ConfigFormTarget) => teamBlock(ctx, target.action, target.row);
  const open = (target: ConfigFormTarget) => { ctx.openForm(target, true); };
  const createBlock = !rooms ? 'El servidor no publica los equipos en esta lectura.' : block({ collection: 'rooms', action: 'create' });

  return <SectionCard level={3} title="Equipos"
    description="Un equipo es un grupo de agentes que trabajan juntos (una sala de la topología)."
    actions={<Button variant="primary" disabled={Boolean(createBlock) || ctx.busy} title={createBlock}
      onClick={() => { open({ collection: 'rooms', action: 'create' }); }}>
      <Plus size={14} aria-hidden="true" />Nuevo equipo</Button>}>
    {!rooms ? <EmptyState>El servidor no publica los equipos en esta lectura.</EmptyState>
      : !rooms.length ? <EmptyState>Todavía no hay equipos. Creá el primero con «Nuevo equipo».</EmptyState>
        : <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,26rem),1fr))] gap-2 p-0" aria-label="Equipos configurados">
          {rooms.map((room) => {
            const id = `${String(room.tenant_id)}/${String(room.id)}`;
            const names = members(snapshot, room);
            const fleetTarget = groupOperationTarget('rooms', room);
            const runtime = Boolean(fleetTarget && groupHasRuntime(snapshot, fleetTarget));
            const edit: ConfigFormTarget = { collection: 'rooms', action: 'update', row: room };
            const remove: ConfigFormTarget = { collection: 'rooms', action: 'delete', row: room };
            const editBlock = block(edit);
            const retire: ConfigFormTarget = { collection: 'rooms', action: 'retire', row: room };
            const retireBlock = block(retire);
            const removeBlock = runtime ? retireBlock : block(remove);
            return <li key={id} data-team={id} className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-line bg-surface px-3 py-2.5 shadow-card">
              <div className="flex min-w-0 flex-1 basis-40 items-center gap-2.5">
                <Users size={16} aria-hidden="true" className="shrink-0 text-muted" />
                <span className="grid min-w-0">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <strong className="truncate text-[13px]" title={teamLabel(room)}>{teamLabel(room)}</strong>
                    {room.enabled === false ? <Pill tone="warn">Deshabilitado</Pill> : null}
                  </span>
                  <span className="truncate text-xs text-muted" title={`${id} · ${names.join(', ')}`}>
                    <span className="font-mono">{String(room.id)}</span>{' · '}
                    {!snapshot.memberships ? 'miembros desconocidos'
                      : `${String(names.length)} ${names.length === 1 ? 'miembro' : 'miembros'}`}
                  </span>
                </span>
              </div>
              <div className="flex shrink-0 flex-wrap gap-1.5">
                <Button size="sm" disabled={Boolean(editBlock) || ctx.busy} title={editBlock} aria-label={`Editar equipo ${id}`}
                  onClick={() => { open(edit); }}><Pencil size={12} aria-hidden="true" />Editar</Button>
                {fleetTarget ? <Button size="sm" disabled={Boolean(retireBlock) || ctx.busy} title={retireBlock ?? 'Retirar, restaurar o purgar el equipo'}
                  aria-label={`Retiro y recuperación del equipo ${id}`}
                  onClick={() => { open(retire); }}>
                  <RotateCcw size={12} aria-hidden="true" />Retiro</Button> : null}
                <Button size="sm" variant="danger" disabled={Boolean(removeBlock) || ctx.busy}
                  title={removeBlock ?? (runtime ? 'Tiene agentes con ejecución: se retira primero y la purga es el segundo paso.' : undefined)}
                  aria-label={`Eliminar equipo ${id}`}
                  onClick={() => {
                    open(runtime ? retire : remove);
                  }}><Trash2 size={12} aria-hidden="true" />Eliminar</Button>
              </div>
            </li>;
          })}
        </ul>}
    {retired.length ? <div className="grid gap-2 rounded-lg border border-line bg-subtle p-3">
      <h3 className="m-0 text-sm font-semibold">Equipos retirados</h3>
      <ul className="m-0 grid list-none gap-1.5 p-0" aria-label="Equipos retirados">
        {retired.map((room) => {
          const id = `${String(room.tenant_id)}/${String(room.id)}`;
          const fleetTarget = groupOperationTarget('rooms', room);
          const restoreBlock = teamBlock(ctx, 'restore', room);
          return <li key={id} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
            <span className="font-mono text-xs">{id}</span>
            <span className="flex gap-1.5">
              {fleetTarget ? <Button size="sm" variant="danger" disabled={Boolean(restoreBlock) || ctx.busy}
                title={restoreBlock ?? 'Paso 2: borra la configuración retirada; los mensajes quedan como historial'}
                aria-label={`Eliminar definitivamente el equipo ${id}`}
                onClick={() => { ctx.setFormTarget(undefined); ctx.setRemoval({ target: fleetTarget, kind: 'purge' }); }}>
                <Trash2 size={12} aria-hidden="true" />Eliminar definitivamente</Button> : null}
              <Button size="sm" disabled={Boolean(restoreBlock) || ctx.busy}
                title={restoreBlock} aria-label={`Restaurar equipo ${id}`}
                onClick={() => { open({ collection: 'rooms', action: 'restore', row: room }); }}>Restaurar</Button>
            </span>
          </li>;
        })}
      </ul>
    </div> : null}
  </SectionCard>;
}
