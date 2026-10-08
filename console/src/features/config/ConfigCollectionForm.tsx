import { useId, useState } from 'react';
import type { ConfigMutation, ConfigurationSnapshot } from '../../api/types';
import { buildFormMutation, configFormValues, type ConfigFormDefinition, type ConfigFormField, type ConfigFormTarget } from './config-form-model';
import type { ConfigMutationRunner } from './use-config-mutation';
import { canUseConfigForm, scopedFormIdentity } from './config-form-access';
import './config-form.css';

const ACTION_LABEL = { create: 'Crear', update: 'Editar', delete: 'Eliminar', retire: 'Retirar', restore: 'Restaurar' };
const CONFIRM_LABEL = { create: 'Confirmar creación', update: 'Confirmar edición', delete: 'Confirmar eliminación', retire: 'Confirmar retiro', restore: 'Confirmar restauración' };

function suggestionsFor(field: ConfigFormField, snapshot: ConfigurationSnapshot, values: Record<string, string>): string[] {
  const rows = field.suggestions ? (snapshot as unknown as Record<string, unknown>)[field.suggestions] : undefined;
  if (!Array.isArray(rows)) return [];
  const matching = rows.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object' && !Array.isArray(row))
    .filter((row) => field.suggestions !== 'rooms' || !values.tenant_id || row.tenant_id === values.tenant_id);
  return [...new Set(matching.map((row) => row[field.suggestionKey ?? field.key]).filter((value): value is string => typeof value === 'string'))];
}

export function ConfigCollectionForm({ definition, target, snapshot, runner, busy, onCancel, onRelated }: {
  definition: ConfigFormDefinition;
  target: ConfigFormTarget;
  snapshot: ConfigurationSnapshot;
  runner: ConfigMutationRunner;
  busy: boolean;
  onCancel: () => void;
  onRelated: (target: ConfigFormTarget) => void;
}) {
  const formId = useId();
  const scopedIdentity = scopedFormIdentity(snapshot, definition);
  const [initial] = useState(() => ({ ...configFormValues(definition, target.action, target.row), ...(target.action === 'create' ? scopedIdentity : {}) }));
  const [values, setValues] = useState(initial);
  const [validationError, setValidationError] = useState<string>();
  const title = `${ACTION_LABEL[target.action]} ${definition.label}`;
  const disabled = busy || !runner.canWrite || !canUseConfigForm(snapshot, definition, target.action, values);
  const identityOnly = ['delete', 'retire', 'restore'].includes(target.action);
  let mutation: ConfigMutation | undefined;
  try { mutation = buildFormMutation(definition, target.action, values, initial); } catch { mutation = undefined; }

  function edit(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setValidationError(undefined);
    runner.clear();
  }

  async function submit(dryRun: boolean) {
    try {
      const next = buildFormMutation(definition, target.action, values, initial);
      setValidationError(undefined);
      await runner.run(next, dryRun);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'Revisá los campos de configuración.');
    }
  }

  const members = definition.resource === 'room'
    ? (snapshot.memberships ?? []).filter((row) => row.tenant_id === values.tenant_id && row.room_id === values.id)
    : [];

  return <form className="config-form config-collection-form" aria-label={title}
    onSubmit={(event) => { event.preventDefault(); void submit(true); }}>
    <h3>{title}</h3>
    {target.action === 'delete' ? <p className="notice" role="note">
      Se solicita eliminar este registro de configuración. El servidor comprueba sus dependencias y puede rechazarlo.
      Revisá el dry-run antes de confirmar.
    </p> : null}
    {target.action === 'retire' ? <p className="notice" role="note">El retiro lógico cierra este registro para nuevas entregas. El servidor comprueba las dependencias antes de aplicar.</p> : null}
    {target.action === 'restore' ? <p className="notice" role="note">La restauración recupera el estado de habilitación previo al retiro, según el registro durable del servidor.</p> : null}
    <div className="config-form-fields">
      {definition.fields.filter((field) => !identityOnly || field.identity).map((field) => {
        const id = `${formId}-${field.key}`;
        const options = suggestionsFor(field, snapshot, values);
        const fixed = field.identity && (target.action !== 'create' || Object.hasOwn(scopedIdentity, field.key));
        const fieldDisabled = disabled || fixed;
        return <label key={field.key} htmlFor={id}>
          <span id={`${id}-label`}>{field.label}</span>
          {field.kind === 'boolean' || field.kind === 'select' ? <select id={id} aria-labelledby={`${id}-label`} value={values[field.key]} disabled={fieldDisabled}
            onChange={(event) => { edit(field.key, event.target.value); }}>
            <option value="">{target.action === 'create' ? 'Elegir…' : 'Sin dato publicado'}</option>
            {field.kind === 'boolean' ? <><option value="true">Sí</option><option value="false">No</option></>
              : field.choices?.map((choice) => <option key={choice} value={choice}>{choice === 'dm' ? 'Mensaje directo' : choice === 'group' ? 'Grupo' : choice}</option>)}
          </select> : <input id={id} aria-labelledby={`${id}-label`} value={values[field.key]} disabled={fieldDisabled}
            type={field.kind === 'number' ? 'number' : 'text'}
            min={field.min} max={field.max} step={field.kind === 'number' ? 1 : undefined}
            list={options.length ? `${id}-suggestions` : undefined}
            onChange={(event) => { edit(field.key, event.target.value); }} />}
          {options.length ? <datalist id={`${id}-suggestions`}>
            {options.map((option) => <option key={option} value={option} />)}
          </datalist> : null}
          {field.min !== undefined ? <small>Entre {field.min} y {field.max}{field.nullable ? '; vacío desactiva este límite' : ''}.</small> : null}
        </label>;
      })}
    </div>
    {validationError ? <p className="notice error" role="alert">{validationError}</p> : null}
    {mutation ? <details className="config-raw"><summary>Ver los datos del cambio</summary>
      <pre className="config-preview" aria-label="Mutación propuesta">{JSON.stringify(mutation, null, 2)}</pre>
    </details> : null}
    <div className="config-actions">
      <button className="button secondary" type="submit" disabled={disabled}>Previsualizar cambio</button>
      <button className="button primary" type="button" disabled={disabled || !mutation || !runner.isValidated(mutation)}
        onClick={() => void submit(false)}>{CONFIRM_LABEL[target.action]}</button>
      <button className="button small" type="button" disabled={busy} onClick={onCancel}>Cancelar</button>
    </div>
    {runner.preview && mutation && runner.isValidated(mutation) ? <pre className="config-preview" aria-label="Resultado del dry-run del formulario">{runner.preview}</pre> : null}
    {runner.notice ? <p className={`notice ${runner.notice.tone}`} data-canal="formulario"
      role={runner.notice.tone === 'success' ? 'status' : 'alert'}>{runner.notice.text}</p> : null}
    {definition.resource === 'room' && target.action === 'update' ? <div className="config-room-members">
      <h4>Miembros de esta sala/grupo</h4>
      {members.length ? <ul>{members.map((row) => <li key={String(row.alias)}>
        <span>{String(row.alias)} · {typeof row.role === 'string' ? row.role : 'sin rol publicado'}</span>
        <button type="button" className="button small" disabled={disabled}
          onClick={() => { onRelated({ collection: 'memberships', action: 'update', row }); }}>Editar miembro {String(row.alias)}</button>
        <button type="button" className="button small" disabled={disabled}
          onClick={() => { onRelated({ collection: 'memberships', action: 'delete', row }); }}>Eliminar miembro {String(row.alias)}</button>
      </li>)}</ul> : <p>{snapshot.memberships ? 'Sin miembros registrados.' : 'El servidor no publica las membresías.'}</p>}
      <button type="button" className="button secondary" disabled={disabled || !snapshot.memberships}
        onClick={() => { onRelated({ collection: 'memberships', action: 'create', row: { tenant_id: values.tenant_id, room_id: values.id } }); }}>Añadir miembro a esta sala/grupo</button>
    </div> : null}
  </form>;
}
