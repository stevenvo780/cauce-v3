import type { FleetOperation, FleetOperationPreview } from '@cauce/protocol/fleet-operation';
import { FLEET_ACTION_LABELS } from './agent-lifecycle-model';
import { AuthOperationPanel } from './AuthOperationPanel';
import { ERRORS, purgeEntries, STATUS, STEP_STATUS, STEPS } from './fleet-operation-text';

export function AgentFleetPreview({ preview }: { preview: FleetOperationPreview }) {
  const deleted = purgeEntries(preview, 'delete');
  const kept = purgeEntries(preview, 'preserve');
  const blocked = purgeEntries(preview, 'blocked');
  const other = preview.dependencies.filter((entry) => !/^purge\.(?:delete|preserve|blocked)\.[a-z0-9_]+$/u.test(entry.type));
  return <section aria-label="Previsualización operativa" className="agent-fleet-receipt">
    <p>Acción: {FLEET_ACTION_LABELS[preview.kind]} · Revisión esperada: {preview.expected_revision}</p>
    <ol>{preview.steps.map((step) => <li key={step}>{STEPS[step]}</li>)}</ol>
    {deleted.length ? <p>Se borra: {deleted.join(', ')}.</p> : null}
    {kept.length ? <p>Se conserva como historial: {kept.join(', ')}.</p> : null}
    {blocked.length ? <p className="notice">Impide la purga: {blocked.join(', ')}.</p> : null}
    {other.length ? <ul aria-label="Dependencias operativas">{other.map((entry, index) =>
      <li key={index}>{entry.type} · {JSON.stringify(entry.identity)} · {entry.blocking ? 'Bloquea esta operación' : 'Referencia informativa'}</li>)}</ul>
      : !preview.dependencies.length ? <p>El servidor no informó dependencias en esta previsualización.</p> : null}
    {!preview.can_apply ? <p className="notice">Las dependencias impiden encolar esta operación.</p> : null}
    <details><summary>Huella exacta</summary><code>{preview.request_sha256}</code></details>
  </section>;
}
export function AgentFleetOperation({ operation, busy, current, control, onAuthRefreshed }: {
  operation: FleetOperation; busy: boolean; current: boolean; control: (action: 'cancel' | 'resume') => void;
  onAuthRefreshed?: (value: FleetOperation) => void;
}) {
  const cancel = ['queued', 'running', 'awaiting_auth'].includes(operation.status);
  const resume = operation.status === 'awaiting_auth' || (operation.status === 'failed' && operation.error?.retryable === true);
  const error = operation.error;
  return <section className="agent-fleet-receipt" aria-label="Operación de flota">
    <p role="status">{FLEET_ACTION_LABELS[operation.kind]}: {STATUS[operation.status]}. La aceptación HTTP acredita el encolado; los pasos muestran el efecto verificado.</p>
    <ol>{operation.steps.map((step) => <li key={step.name} data-status={step.status}>
      {step.status === 'failed' ? <strong>{STEPS[step.name]}: {STEP_STATUS[step.status]}</strong> : <>{STEPS[step.name]}: {STEP_STATUS[step.status]}</>}
      {step.evidence ? <pre aria-label={`Evidencia de ${STEPS[step.name]}`}>{JSON.stringify(step.evidence, null, 2)}</pre> : null}</li>)}</ol>
    {error ? <p className="notice" role="alert">
      {error.step ? <>Falló en el paso «{STEPS[error.step]}». </> : null}{ERRORS[error.code]}{' '}
      {error.retryable ? 'Se puede reanudar: retoma desde el paso que falló.' : 'No se puede reanudar: hace falta una operación nueva.'}
      {' '}<span className="text-xs">Código: <code>{error.code}</code></span></p> : null}
    {operation.status === 'awaiting_auth' && onAuthRefreshed
      ? <AuthOperationPanel operation={operation} allowed={current} onRefreshed={onAuthRefreshed} /> : null}
    {!current ? <p className="notice">La última lectura no se pudo acreditar. Relee el estado antes de recuperar la operación.</p> : null}
    <div className="acciones">
      <button type="button" className={resume ? 'button primary' : 'button secondary'} disabled={busy || !current || !resume} onClick={() => { control('resume'); }}>Reanudar operación</button>
      <button type="button" className="button secondary" disabled={busy || !current || !cancel} onClick={() => { control('cancel'); }}>Cancelar operación</button>
    </div>
    <details><summary>Identidad de la operación</summary>
      <p>ID: <code>{operation.id}</code> · Versión: {operation.version}</p>
      <p>Huella: <code>{operation.request_sha256}</code></p>
      <p>Revisión deseada: {operation.desired_revision ?? 'Sin publicar'} · Revisión aplicada: {operation.applied_revision ?? 'Sin acreditar'}</p>
    </details>
  </section>;
}
