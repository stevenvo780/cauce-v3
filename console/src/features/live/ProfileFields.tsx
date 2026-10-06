import { useId } from 'react';
import type { AgentPerfil, AgentPerfilCampos } from '../../api/types';
import { cn } from '../../cn';
import { Unknown } from '../../components/ui';
import { MedidorDeRol } from './MedidorDeRol';
import {
  CAMPOS_DE_LISTA, CAMPOS_DE_TEXTO, ETIQUETAS, contarUnidades, entradasDeLista, listaALineas,
  type CampoDelPerfil, type DestinoDelCampo,
} from './perfil';

const GROUPS: readonly { title: string; help: string; fields: readonly CampoDelPerfil[] }[] = [
  {
    title: 'Identidad y relación',
    help: 'Quién es el agente, qué papel ocupa y cómo debe tratarte.',
    fields: ['purpose', 'role_summary', 'human_brief'],
  },
  {
    title: 'Responsabilidades y herramientas',
    help: 'Qué le toca hacer y con qué cuenta. Declarar herramientas no concede acceso.',
    fields: ['responsibilities', 'tools'],
  },
  {
    title: 'Límites y forma de trabajar',
    help: 'Qué debe evitar y qué reglas mantiene entre tareas.',
    fields: ['restrictions', 'operating_rules'],
  },
];

/** Orientation only, shown as placeholders: they are never added to the profile. */
const EXAMPLES: Record<CampoDelPerfil, string> = {
  purpose: 'Ayudar a mantener la documentación del proyecto clara y actualizada.',
  role_summary: 'Revisor de documentación: detecta inconsistencias y propone correcciones.',
  human_brief: 'Prefiere respuestas breves en español, con enlaces a las fuentes.',
  responsibilities: 'Revisar las instrucciones de instalación.\nSeñalar enlaces rotos.',
  tools: 'Documentación del proyecto disponible para consulta.',
  restrictions: 'No publicar cambios sin aprobación.\nNo incluir datos privados en ejemplos.',
  operating_rules: 'Leer la documentación existente antes de proponer cambios.\nExplicar cómo se verificó cada corrección.',
};

interface ProfileFieldsProps {
  fields: AgentPerfilCampos;
  destinations: Record<CampoDelPerfil, DestinoDelCampo>;
  limits: AgentPerfil['limites'];
  disabled: boolean;
  onTextChange: (field: (typeof CAMPOS_DE_TEXTO)[number], value: string) => void;
  onListChange: (field: (typeof CAMPOS_DE_LISTA)[number], value: string) => void;
}

export function ProfileFields(props: ProfileFieldsProps) {
  return (
    <div className="grid gap-7">
      {GROUPS.map((group) => (
        <fieldset className="m-0 min-w-0 border-0 p-0" key={group.title}>
          <legend className="p-0 text-sm font-semibold text-fg">{group.title}</legend>
          <p className="m-0 mt-0.5 mb-3 text-xs text-muted">{group.help}</p>
          <div className={cn('grid gap-4', group.fields.length === 2 && 'lg:grid-cols-2')}>
            {group.fields.map((field) => <ProfileField key={field} {...props} field={field} />)}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

function ProfileField({ field, fields, destinations, limits, disabled, onTextChange, onListChange }: ProfileFieldsProps & {
  field: CampoDelPerfil;
}) {
  const id = useId();
  const textField = field === 'purpose' || field === 'role_summary' || field === 'human_brief';
  const value = textField ? fields[field] : listaALineas(fields[field]);
  const count = textField ? contarUnidades(value) : entradasDeLista(fields[field]).length;
  const limit = textField ? field === 'role_summary' ? limits?.role_summary : limits?.purpose : limits?.items;
  const destination = destinations[field];
  const over = limit !== undefined && count > limit;
  return (
    <label className="min-w-0 content-start">
      <span className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span id={`${id}-title`} className="text-[13px] font-medium text-fg">{ETIQUETAS[field].titulo}</span>
        <span id={`${id}-dest`} className="font-mono text-[11px] font-normal text-muted">
          →{' '}{destination.tipo === 'fichero'
            ? destination.nombre
            : <Unknown value={null} ausente={destination.ausente} motivo={destination.motivo} />}
        </span>
      </span>
      <textarea
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-dest ${id}-help ${id}-count`}
        value={value}
        placeholder={EXAMPLES[field]}
        rows={textField ? 3 : 4}
        disabled={disabled}
        onChange={(event) => {
          if (textField) onTextChange(field, event.target.value);
          else onListChange(field, event.target.value);
        }}
      />
      <span className="flex items-start justify-between gap-3 text-xs font-normal">
        <span id={`${id}-help`} className="text-muted">{ETIQUETAS[field].ayuda}</span>
        <span id={`${id}-count`} data-over={over || undefined}
          className={cn('shrink-0 tabular-nums', over ? 'font-medium text-danger-ink' : 'text-muted')}>
          {count}{textField ? '' : count === 1 ? ' entrada' : ' entradas'} / {limit ?? '—'}
        </span>
      </span>
      {field === 'role_summary' ? <MedidorDeRol texto={value} /> : null}
    </label>
  );
}
