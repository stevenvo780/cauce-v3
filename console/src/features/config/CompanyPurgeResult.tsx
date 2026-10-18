import type { CompanyPurgeBlocker, CompanyPurgeReceipt } from '../../api/client/company-purge';
import { Notice } from '../../components/kit';

const BLOCKER_ACTION: Record<string, string> = {
  agent: 'Purga el agente y sus recursos desde Flota.',
  quota_environment: 'Elimina el entorno desde Mis cuotas y espera a que termine.',
  fleet_operation: 'Resuelve la operación pendiente desde Flota antes de reintentar.',
  quota_operation: 'Espera a que termine la operación del entorno en Mis cuotas o resuelve su fallo.',
  agent_quota_operation: 'Espera a que termine la consulta de cuota del agente o resuelve su fallo.',
  connection: 'Detén y desconecta el agente antes de reintentar.',
  space_backup: 'Espera a que termine la copia del espacio o resuelve su fallo.',
  foreign_reference: 'Pide a un administrador de plataforma que resuelva la referencia de la otra empresa.',
};

export function CompanyPurgeBlockers({ blockers }: { blockers: CompanyPurgeBlocker[] }) {
  return <Notice tone="danger" role="alert"><p>La empresa conserva recursos o referencias pendientes:</p>
    <ul>{blockers.map((blocker, index) => <li key={`${blocker.kind}:${blocker.id}:${String(index)}`}>
      <code>{blocker.kind}</code> · <code>{blocker.id}</code>: {BLOCKER_ACTION[blocker.kind] ?? 'Revisa este recurso con un administrador de plataforma antes de reintentar.'}
    </li>)}</ul></Notice>;
}

export function CompanyPurgeResult({ receipt }: { receipt: CompanyPurgeReceipt }) {
  return <Notice tone="ok" role="status"><p>Empresa <code>{receipt.company_id}</code> purgada definitivamente.</p>
    <p>Copia JSON guardada en el servidor: <code className="break-all">{receipt.backup_path}</code></p>
    <p>Filas eliminadas: {Object.values(receipt.deleted_rows).reduce((total, count) => total + count, 0)}</p>
    <details><summary>Conteos por tabla</summary><ul>{Object.entries(receipt.deleted_rows).map(([table, count]) =>
      <li key={table}><code>{table}</code>: {count}</li>)}</ul></details>
  </Notice>;
}
