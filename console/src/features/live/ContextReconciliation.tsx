import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import { ContextoContaminadoError } from '../../api/client/agent-client';
import { Button, Notice, SectionCard } from '../../components/kit';
import { ReasonField } from './context-ui';
import { problemaDeMotivo } from './ficheros-motivo';
import { CONTAMINACION_ILEGIBLE, contaminacionDe, type ContaminacionDeContexto } from './perfil';
import {
  isReconciliationPreview, isReconciliationReceipt, reconciliationApply,
  type ReconciliationPreview,
} from './context-reconciliation';

interface ContextReconciliationProps {
  tenantId: string;
  alias: string;
  revision: number;
  documents: readonly string[];
  permitida: boolean;
  bloqueada: boolean;
  onVeredicto: (value: ContaminacionDeContexto) => void;
  onSettled: () => void;
  onWriteInFlightChange?: (value: boolean) => void;
}

export function ContextReconciliation(props: ContextReconciliationProps) {
  const api = useApi();
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<ReconciliationPreview>();
  const [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<'preview' | 'apply'>();
  const [error, setError] = useState<string>();
  const [written, setWritten] = useState(false);
  const latest = useRef(props);
  latest.current = props;
  const operation = useRef(0);
  const mounted = useRef(true);
  const scope = `${props.tenantId}/${props.alias}/${String(props.revision)}/${props.documents.join(',')}`;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current += 1; };
  }, []);
  useEffect(() => {
    setPreview(undefined); setConfirmed(false); setWritten(false); setError(undefined);
    operation.current += 1;
  }, [scope, props.permitida]);
  const busy = phase !== undefined;
  const disabled = !props.permitida || props.bloqueada || busy;
  const invalidReason = problemaDeMotivo(reason);

  async function run(action: 'preview' | 'apply') {
    if (disabled || invalidReason !== undefined || (action === 'apply' && (!preview || !confirmed))) return;
    const requestNumber = ++operation.current;
    const target = props;
    const snapshot = preview;
    const current = () => mounted.current && requestNumber === operation.current
      && latest.current.permitida && latest.current.tenantId === target.tenantId
      && latest.current.alias === target.alias && latest.current.revision === target.revision;
    setError(undefined); setWritten(false); setPhase(action);
    props.onWriteInFlightChange?.(true);
    try {
      if (action === 'preview') {
        setPreview(undefined); setConfirmed(false);
        const response = await api.previewContextReconciliation(target.tenantId, target.alias, reason.trim());
        if (!current()) return;
        if (!isReconciliationPreview(response, target)) {
          throw new Error('La vista previa no acredita identidad, revisión y huellas del conjunto exacto.');
        }
        setPreview(response);
      } else if (snapshot) {
        setPreview(undefined); setConfirmed(false);
        const response = await api.applyContextReconciliation(
          target.tenantId, target.alias, reconciliationApply(snapshot, reason),
        );
        if (!current()) return;
        if (!isReconciliationReceipt(response, snapshot)) {
          throw new Error('La respuesta no acredita el lote completo. El resultado de escritura no está confirmado.');
        }
        setWritten(true); setReason('');
        target.onVeredicto(response.contaminacion);
      }
    } catch (failure) {
      if (!current()) return;
      setPreview(undefined); setConfirmed(false);
      if (failure instanceof ContextoContaminadoError) {
        target.onVeredicto(contaminacionDe(failure.cuerpo) ?? CONTAMINACION_ILEGIBLE);
      }
      setError(`${failure instanceof Error ? failure.message : 'No se obtuvo un resultado verificable.'} `
        + (action === 'apply' ? 'Comprueba el estado y vuelve a medir antes de reintentar; puede haber efectos parciales.'
          : 'No se habilita la escritura sin una vista previa válida.'));
    } finally {
      if (mounted.current) setPhase(undefined);
      target.onWriteInFlightChange?.(false);
      if (action === 'apply') target.onSettled();
    }
  }

  return (
    <SectionCard
      title="Reconciliar huellas del contexto"
      description="Las huellas difieren de la expectativa registrada. Se comprueba el propietario del bloque y se reconstruye sólo el perfil gestionado desde la revisión guardada, conservando el contenido exterior que autorices. No reinicia la TUI ni acredita adopción por el modelo."
    >
      <ReasonField label="Motivo de la reconciliación" value={reason} disabled={disabled}
        onChange={(value) => { setReason(value); setPreview(undefined); setConfirmed(false); setWritten(false); }} />
      <div>
        <Button size="sm" disabled={disabled || invalidReason !== undefined} onClick={() => { void run('preview'); }}>
          {phase === 'preview' ? 'Midiendo contexto…' : 'Medir antes de reconciliar'}
        </Button>
      </div>
      {preview ? <div className="grid gap-3 rounded-lg border border-line bg-subtle p-3 text-[13px]">
        <p className="m-0">Vista previa de revisión {preview.expected_revision}. Esta vista identifica las huellas;
          no muestra ni acredita una revisión del contenido exterior.</p>
        <ul className="m-0 grid gap-1 pl-5 text-xs">{preview.documents.map((document) => <li key={document.name} className="break-all">
          <code>{document.name}</code>: huella completa <code>{document.observed_sha}</code>;{' '}
          exterior conservado <code>{document.exterior_sha}</code>.
        </li>)}</ul>
        <label className="flex items-start gap-2 font-normal">
          <input type="checkbox" checked={confirmed} disabled={disabled} className="mt-0.5"
            onChange={(event) => { setConfirmed(event.target.checked); }} />
          Autorizo conservar sin cambios el contenido exterior identificado por estas huellas.
        </label>
        <div>
          <Button size="sm" disabled={disabled || !confirmed} onClick={() => { void run('apply'); }}>
            Reconciliar el bloque gestionado
          </Button>
        </div>
      </div> : null}
      {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
      {written ? <Notice tone="warn" role="status">
        Escritura y huellas verificadas; estado pending_session_refresh. Falta el ACK de adopción
        del modelo: no se presenta como contexto ya adoptado.
      </Notice> : null}
    </SectionCard>
  );
}
