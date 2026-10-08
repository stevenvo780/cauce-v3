import type { FleetOperation, FleetOperationPreview } from '@cauce/protocol/fleet-operation';
import { FLEET_ACTION_LABELS } from './agent-lifecycle-model';
import { AuthOperationPanel } from './AuthOperationPanel';

const STATUS = { queued: 'En cola', running: 'En ejecución', awaiting_auth: 'Esperando autenticación',
  cancelling: 'Cancelación en curso', cancelled: 'Cancelada', failed: 'Fallida', succeeded: 'Completada' };
const STEPS = { prepare: 'Preparación', artifacts: 'Artefactos', credentials: 'Credenciales', runtime: 'Runtime',
  authenticate: 'Autenticación', profile: 'Perfil', verify: 'Verificación', admission: 'Admisión', fence: 'Cierre de entregas',
  stop: 'Detención', revoke: 'Revocación', purge: 'Purga' };
const STEP_STATUS = { pending: 'Pendiente', running: 'En ejecución', waiting: 'En espera', succeeded: 'Acreditado', failed: 'Fallido', compensated: 'Compensado' };
export function AgentFleetPreview({ preview }: { preview: FleetOperationPreview }) {
  return <section aria-label="Previsualización operativa" className="agent-fleet-receipt">
    <p>Acción: {FLEET_ACTION_LABELS[preview.kind]} · Revisión esperada: {preview.expected_revision}</p>
    <p>Huella exacta: <code>{preview.request_sha256}</code></p>
    <ol>{preview.steps.map((step) => <li key={step}>{STEPS[step]}</li>)}</ol>
    {preview.dependencies.length ? <ul aria-label="Dependencias operativas">{preview.dependencies.map((entry, index) =>
      <li key={index}>{entry.type} · {JSON.stringify(entry.identity)} · {entry.blocking ? 'Bloquea esta operación' : 'Referencia informativa'}</li>)}</ul>
      : <p>El servidor no informó dependencias en esta previsualización.</p>}
    {!preview.can_apply ? <p className="notice">Las dependencias impiden encolar esta operación.</p> : null}
  </section>;
}
export function AgentFleetOperation({ operation, busy, current, control, onAuthRefreshed }: {
  operation: FleetOperation; busy: boolean; current: boolean; control: (action: 'cancel' | 'resume') => void;
  onAuthRefreshed?: (value: FleetOperation) => void;
}) {
  const cancel = ['queued', 'running', 'awaiting_auth'].includes(operation.status);
  const resume = operation.status === 'awaiting_auth' || (operation.status === 'failed' && operation.error?.retryable === true);
  return <section className="agent-fleet-receipt" aria-label="Operación de flota">
    <p role="status">{FLEET_ACTION_LABELS[operation.kind]}: {STATUS[operation.status]}. La aceptación HTTP acredita el encolado; los pasos muestran el efecto verificado.</p>
    <p>ID: <code>{operation.id}</code> · Versión: {operation.version}</p>
    <p>Huella: <code>{operation.request_sha256}</code></p>
    <p>Revisión deseada: {operation.desired_revision ?? 'Sin publicar'} · Revisión aplicada: {operation.applied_revision ?? 'Sin acreditar'}</p>
    <ol>{operation.steps.map((step) => <li key={step.name}>{STEPS[step.name]}: {STEP_STATUS[step.status]}
      {step.evidence ? <pre aria-label={`Evidencia de ${STEPS[step.name]}`}>{JSON.stringify(step.evidence, null, 2)}</pre> : null}</li>)}</ol>
    {operation.error ? <p className="notice" role="alert">{operation.error.code}{operation.error.step ? ` · ${STEPS[operation.error.step]}` : ''}.
      {operation.error.retryable ? ' Admite recuperación.' : ' Requiere una nueva decisión.'}</p> : null}
    {operation.status === 'awaiting_auth' && onAuthRefreshed
      ? <AuthOperationPanel operation={operation} allowed={current} onRefreshed={onAuthRefreshed} /> : null}
    {!current ? <p className="notice">La última lectura no se pudo acreditar. Relee el estado antes de recuperar la operación.</p> : null}
    <div className="acciones">
      <button type="button" className="button secondary" disabled={busy || !current || !cancel} onClick={() => { control('cancel'); }}>Cancelar operación</button>
      <button type="button" className="button secondary" disabled={busy || !current || !resume} onClick={() => { control('resume'); }}>Reanudar operación</button>
    </div>
  </section>;
}
