import { Save, SearchCheck } from 'lucide-react';
import type { ConfigMutation } from '../../api/types';
import type { RegistryMutationRunner } from './use-registry-mutation';

/**
 * Barra de escritura compartida por los dos formularios del pool: dry-run primero, apply después, y
 * el apply deshabilitado hasta que el servidor validó la mutación exacta que está en pantalla.
 *
 * Desde que el inventario y la matriz viven en la MISMA vista hay dos barras en pantalla a la vez,
 * con botones de texto idéntico. Por eso los botones van dentro de un `role="group"` nombrado con
 * `previewLabel`: sin eso, "Previsualizar (dry-run)" es ambiguo para un lector de pantalla, para el
 * teclado y para los tests — y previsualizar el formulario equivocado manda una mutación que el
 * operador no pidió.
 */
export function MutationBar({ runner, mutation, invalid, previewLabel }: {
  runner: RegistryMutationRunner;
  mutation?: ConfigMutation;
  /** Motivo por el que la mutación todavía no se puede enviar (validación local). */
  invalid?: string;
  previewLabel: string;
}) {
  const blocked = !runner.canWrite || runner.busy || mutation === undefined || Boolean(invalid);
  const applicable = mutation !== undefined && !invalid && runner.isValidated(mutation);

  return <>
    {mutation ? <pre className="config-preview" aria-label={`Mutación pendiente de ${previewLabel}`}>{JSON.stringify(mutation, null, 2)}</pre> : null}
    <div className="config-actions" role="group" aria-label={`Acciones de ${previewLabel}`}>
      <button className="button secondary" type="button" disabled={blocked} onClick={() => { if (mutation) void runner.run(mutation, true); }}>
        <SearchCheck size={16} aria-hidden="true" />Previsualizar (dry-run)
      </button>
      <button className="button primary" type="button" disabled={blocked || !applicable} onClick={() => { if (mutation) void runner.run(mutation, false); }}>
        <Save size={16} aria-hidden="true" />Aplicar
      </button>
    </div>
    {/* Guía de formulario, no un rechazo del servidor: `note` evita que el lector de pantalla la
        anuncie como alerta apenas carga la pantalla, y deja `alert` para lo que el servidor negó. */}
    {invalid ? <p className="notice" role="note">{invalid}</p> : null}
    {runner.preview ? <pre className="config-preview" aria-label={`Dry-run de ${previewLabel}`}>{runner.preview}</pre> : null}
    {runner.notice ? <p
      className={runner.notice.tone === 'error' ? 'notice error' : runner.notice.tone === 'parcial' ? 'notice parcial' : 'notice success'}
      role={runner.notice.tone === 'success' ? 'status' : 'alert'}
    >{runner.notice.text}</p> : null}
  </>;
}
