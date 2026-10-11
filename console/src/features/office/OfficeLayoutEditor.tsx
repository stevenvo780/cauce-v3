import type { OfficePart, OfficeRoom } from '../../api/client/company-client';
import { Button } from '../../components/kit';
import { randomUuid } from '../../random-id';
import { officeRoomKey, type OfficeRoomInfo } from './office-layout';

export function OfficeLayoutEditor({ room, info, busy, update }: { room: OfficeRoom; info: OfficeRoomInfo; busy: boolean; update: (room: OfficeRoom) => void }) {
  function part(index: number, patch: Partial<OfficePart>) { update({ ...room, parts: room.parts.map((value, at) => at === index ? { ...value, ...patch } : value) }); }
  return <section aria-label={`Editar sala ${info.tenant}/${info.label}`} className="grid gap-3 rounded-xl border border-line bg-surface p-4">
    <h3 className="m-0 text-base">{info.label} <span className="text-xs text-muted">{info.tenant}</span></h3>
    <GeometryFields label={info.label} item={room} busy={busy} update={patch => { update({ ...room, ...patch }); }} />
    <div className="flex items-center justify-between gap-2"><h4 className="m-0 text-sm">Partes de la sala</h4>
      <Button size="sm" disabled={busy} onClick={() => { update({ ...room, parts: [...room.parts, { id: randomUuid(), label: 'Nueva parte', x: 12, y: 42, width: 100, height: 60 }] }); }}>Añadir parte</Button></div>
    {room.parts.map((value, index) => <div key={officeRoomKey(info.tenant, value.id)} className="grid gap-2 rounded-lg border border-line p-3">
      <label>Nombre de parte<input required maxLength={120} value={value.label} disabled={busy} onChange={event => { part(index, { label: event.target.value }); }} /></label>
      <GeometryFields label={value.label} item={value} busy={busy} update={patch => { part(index, patch); }} />
      <Button size="sm" variant="danger" disabled={busy} onClick={() => { update({ ...room, parts: room.parts.filter((_, at) => at !== index) }); }}>Quitar parte {value.label}</Button>
    </div>)}
  </section>;
}
function GeometryFields({ label, item, busy, update }: {
  label: string; item: { x: number; y: number; width: number; height: number }; busy: boolean; update: (patch: Partial<typeof item>) => void;
}) {
  return <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{(['x', 'y', 'width', 'height'] as const).map(key => <label key={key}>
    {{ x: 'Posición horizontal', y: 'Posición vertical', width: 'Ancho', height: 'Alto' }[key]}
    <input aria-label={`${{ x: 'Posición horizontal', y: 'Posición vertical', width: 'Ancho', height: 'Alto' }[key]} de ${label}`} type="number" step="1" min={key === 'width' || key === 'height' ? 1 : -100_000} max={100_000}
      value={Number.isFinite(item[key]) ? item[key] : ''} disabled={busy} onChange={event => { update({ [key]: Number.isFinite(event.target.valueAsNumber)
        ? event.target.valueAsNumber : key === 'width' || key === 'height' ? 1 : 0 }); }} />
  </label>)}</div>;
}
