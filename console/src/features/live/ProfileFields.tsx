import { useId } from 'react';
import type { AgentPerfil, AgentPerfilCampos } from '../../api/types';
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
    <div className="profile-fields">
      {GROUPS.map((group) => (
        <fieldset className="profile-field-group" key={group.title}>
          <legend>{group.title}</legend>
          <p className="muted profile-group-help">{group.help}</p>
          <details className="profile-field-examples">
            <summary>Ver ejemplos: {group.title.toLocaleLowerCase('es')}</summary>
            <p>Ejemplos orientativos; no se añaden al perfil.</p>
            <dl>
              {group.fields.map((field) => (
                <div key={field}><dt>{ETIQUETAS[field].titulo}</dt><dd>{EXAMPLES[field]}</dd></div>
              ))}
            </dl>
          </details>
          {group.fields.map((field) => <ProfileField key={field} {...props} field={field} />)}
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
  return (
    <label className="perfil-campo">
      <span className="perfil-campo-titulo" id={`${id}-title`}>{ETIQUETAS[field].titulo}</span>
      <span className="muted perfil-campo-ayuda" id={`${id}-help`}>
        {ETIQUETAS[field].ayuda}{' '}
        <em className="perfil-destino">
          →{' '}{destination.tipo === 'fichero'
            ? destination.nombre
            : <Unknown value={null} ausente={destination.ausente} motivo={destination.motivo} />}
        </em>
      </span>
      <textarea
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-help ${id}-count`}
        value={value}
        rows={textField && field !== 'purpose' ? 3 : 4}
        disabled={disabled}
        onChange={(event) => {
          if (textField) onTextChange(field, event.target.value);
          else onListChange(field, event.target.value);
        }}
      />
      <span id={`${id}-count`} className={`perfil-cuenta${limit !== undefined && count > limit ? ' perfil-cuenta-fuera' : ''}`}>
        {count}{textField ? '' : count === 1 ? ' entrada' : ' entradas'} / {limit ?? '—'}
      </span>
      {field === 'role_summary' ? <MedidorDeRol texto={value} /> : null}
    </label>
  );
}
