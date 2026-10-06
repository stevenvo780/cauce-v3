import { Time } from '../../components/ui';
import { ConfigSectionHeader } from './ConfigSectionHeader';
import { TablasDeSeccion } from './ConfigTables';
import type { ConfigSectionId } from './sections';
import type { ConfigWrites } from './use-config-writes';

/** The size of each collection of the last good read, as a way into the section that edits it. */
const RESUMEN: readonly { clave: 'tenants' | 'rooms' | 'memberships' | 'agents' | 'acl_edges'; etiqueta: string; seccion: ConfigSectionId }[] = [
  { clave: 'tenants', etiqueta: 'Clientes', seccion: 'espacios' },
  { clave: 'rooms', etiqueta: 'Salas', seccion: 'espacios' },
  { clave: 'memberships', etiqueta: 'Membresías', seccion: 'espacios' },
  { clave: 'agents', etiqueta: 'Agentes registrados', seccion: 'agentes' },
  { clave: 'acl_edges', etiqueta: 'Permisos entre clientes', seccion: 'acceso' },
];

export function GeneralSection({ ctx, onIr }: { ctx: ConfigWrites; onIr: (seccion: ConfigSectionId) => void }) {
  const snapshot = ctx.config.data;
  return <div className="grid gap-4">
    <ConfigSectionHeader seccion="general" />
    <dl aria-label="Resumen de la configuración" className="m-0 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line max-sm:[&>div:last-child]:col-span-2 sm:max-lg:[&>div:last-child]:col-span-2 sm:grid-cols-3 lg:grid-cols-5">
      {RESUMEN.map((entrada) => {
        const filas = snapshot?.[entrada.clave];
        return <div key={entrada.clave} className="grid content-start gap-0.5 bg-surface">
          <button type="button" onClick={() => { onIr(entrada.seccion); }}
            className="grid cursor-pointer content-start gap-0.5 border-0 bg-transparent p-3 text-left hover:bg-subtle">
            <dt className="text-xs text-muted">{entrada.etiqueta}</dt>
            <dd className="text-xl font-semibold tabular-nums">{Array.isArray(filas) ? filas.length : '—'}</dd>
          </button>
        </div>;
      })}
    </dl>
    <p className="m-0 text-xs text-muted">
      Revisión {String(ctx.snapshotRevision ?? 'desconocida')}
      {snapshot?.observed_at ? <> · leída <Time value={snapshot.observed_at} relativo /></> : null}
    </p>
    <TablasDeSeccion ctx={ctx} seccion="general" />
  </div>;
}
