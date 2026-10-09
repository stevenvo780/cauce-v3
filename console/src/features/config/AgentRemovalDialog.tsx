import type { ConfigurationSnapshot } from '../../api/types';
import { FormDialog } from '../../components/dialogs';
import { Pill } from '../../components/kit';
import { AgentLifecyclePanel } from './AgentLifecyclePanel';

const STEP = 'grid gap-1 rounded-lg border border-line px-3 py-2.5 data-[current]:border-brand data-[current]:bg-subtle';

/**
 * Deleting an agent that has (or had) an execution takes two fleet operations: retire, which is
 * reversible, and purge, which is final. The guide marks the next step and says what each one
 * deletes and what it keeps.
 */
export function AgentRemovalDialog({ tenantId, alias, retired, snapshot, onReloaded, onClose }: {
  tenantId: string; alias: string; retired: boolean; snapshot: ConfigurationSnapshot;
  onReloaded: (snapshot: ConfigurationSnapshot) => void; onClose: () => void;
}) {
  const kind = retired ? 'purge' : 'retire';
  return <FormDialog open wide title={`Eliminar agente ${tenantId}/${alias}`}
    description="Eliminar un agente con ejecución lleva dos pasos: retirarlo y después borrarlo definitivamente." onClose={onClose}>
    <div className="config-modal-cuerpo grid gap-3">
      <ol className="m-0 grid list-none gap-2 p-0" aria-label="Pasos para eliminar el agente">
        <li className={STEP} data-current={retired ? undefined : ''}>
          <span className="flex items-center gap-2"><strong className="text-sm">1. Retirar</strong>
            {retired ? <Pill tone="ok">Hecho</Pill> : <Pill tone="info">Paso actual</Pill>}</span>
          <span className="text-[13px] text-fg-2">Detiene la ejecución, cierra sus entregas y revoca sus credenciales.
            El registro, los mensajes y el historial se conservan, y se puede deshacer con «Restaurar».</span>
        </li>
        <li className={STEP} data-current={retired ? '' : undefined}>
          <span className="flex items-center gap-2"><strong className="text-sm">2. Eliminar definitivamente</strong>
            {retired ? <Pill tone="info">Paso actual</Pill> : <Pill tone="neutral">Después del retiro</Pill>}</span>
          <span className="text-[13px] text-fg-2">Borra el perfil, la apariencia, las cuentas vinculadas, los techos de ruteo,
            los destinos de salida, las llaves de sellado y los favoritos. Los mensajes y entregas ya enviados y las membresías
            con historial se conservan. No se puede deshacer; la previsualización muestra el detalle exacto.</span>
        </li>
      </ol>
      {retired ? null : <p className="m-0 text-xs text-muted">Cuando el retiro figure «Completada», pulsa «Releer inventario» para pasar al paso 2.</p>}
      <AgentLifecyclePanel key={kind} snapshot={snapshot} onReloaded={onReloaded} initialOpen hideTrigger embedded fixedKind
        target={{ resource: 'agent', tenant_id: tenantId, alias }} initialKind={kind} />
    </div>
    <div className="config-modal-pie config-actions">
      <button type="button" className="button secondary" onClick={onClose}>Cerrar</button>
    </div>
  </FormDialog>;
}
