import { Maximize2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ConfigurationSnapshot } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { DirectivaModal } from './DirectivaModal';
import { primerasLineas } from './directiva';
import { ROLE_BRIEF_MAX, contarRoleBrief, tonoRoleBrief } from './role-brief';

/**
 * Tab for summarizing an agent's declared directive and role in the side drawer.
 */

export interface DirectivaTabProps {
  tenantId: string;
  alias: string;
  configuracion: Resource<ConfigurationSnapshot>;
  onEditarEnPerfil: () => void;
  onEditarEnFicheros: () => void;
  onRestaurarEnPerfil: (texto: string) => void;
}

/**
 * The three outcomes of looking up an alias in the registry, which are NOT the same fact.
 *
 * `sin-registro` = this gateway does not publish the agent list. `sin-fila` = it does and this
 * alias is not in it — it appeared via deliveries or via lease. `fila` = it is there, with or
 * without text. All three used to resolve to `undefined`, which is why `zeus`, which has no row,
 * was read the same way as an alias with a blank role: two different things with the same face.
 */
type Registro =
  | { estado: 'sin-registro' }
  | { estado: 'sin-fila' }
  | { estado: 'fila'; brief: string };

function buscarEnRegistro(snapshot: ConfigurationSnapshot | undefined, tenantId: string, alias: string): Registro {
  const agents = snapshot?.agents;
  if (!Array.isArray(agents)) return { estado: 'sin-registro' };
  const fila = agents.find((row) => row.tenant_id === tenantId && row.alias === alias);
  if (!fila) return { estado: 'sin-fila' };
  return { estado: 'fila', brief: typeof fila.role_brief === 'string' ? fila.role_brief : '' };
}

export function DirectivaTab({
  tenantId, alias, configuracion: config, onEditarEnPerfil, onEditarEnFicheros, onRestaurarEnPerfil,
}: DirectivaTabProps) {
  const [abierto, setAbierto] = useState(false);
  const abridor = useRef<HTMLButtonElement>(null);

  const registro = buscarEnRegistro(config.data, tenantId, alias);
  // The legacy column is a read-only projection; no alternative draft overwrites it.
  const texto = registro.estado === 'fila' ? registro.brief : '';
  const lineas = primerasLineas(texto, 2);
  const largo = contarRoleBrief(texto);
  const tono = tonoRoleBrief(largo);
  // The counter is only painted over a reading that happened: "0 / 1200" over a GET that failed,
  // or over an alias that is not even in the registry, is an invented figure.
  const hayRol = registro.estado === 'fila';

  return (
    <div className="directiva-resumen">
      <p className="directiva-resumen-rotulo">Rol declarado de {alias}</p>

      {registro.estado === 'sin-registro' ? (
        /* Without a snapshot there is no role to summarize. The button still exists: the dialog
           explains the failure using the server's words, which is more than fits here. */
        <p className="directiva-resumen-vacio">
          {config.loading && !config.data
            ? 'Leyendo el rol declarado desde la configuración versionada…'
            : `No se pudo leer el registro de agentes, así que el rol de este alias es un dato que no tenemos —no «vacío»—${config.error ? `: ${config.error.message}` : '.'}`}
        </p>
      ) : registro.estado === 'sin-fila' ? (
        <p className="directiva-resumen-vacio">
          {alias} no está en el registro de agentes de {tenantId}: apareció por entregas o por
          lease. Un alias sin fila en el registro no tiene rol declarado que resumir, que no es lo
          mismo que tenerlo en blanco.
        </p>
      ) : lineas.length === 0 ? (
        <p className="directiva-resumen-vacio">
          El registro lo publica VACÍO: {alias} sale a trabajar sin ninguna línea de identidad.
        </p>
      ) : (
        <div className="directiva-resumen-lineas">
          {lineas.map((linea, indice) => <p key={indice}>{linea}</p>)}
        </div>
      )}

      {hayRol ? (
        <p className="directiva-resumen-contador" data-tono={tono}>
          <strong>{largo}</strong> / {ROLE_BRIEF_MAX} caracteres
        </p>
      ) : null}

      <button
        type="button"
        className="button primary directiva-abrir"
        ref={abridor}
        onClick={() => { setAbierto(true); }}
      >
        <Maximize2 size={16} aria-hidden="true" /> Abrir directiva completa
      </button>

      {abierto ? (
        <DirectivaModal
          tenantId={tenantId}
          alias={alias}
          configuration={config}
          onEditarEnPerfil={onEditarEnPerfil}
          onEditarEnFicheros={onEditarEnFicheros}
          onRestaurarEnPerfil={onRestaurarEnPerfil}
          devolverFocoA={abridor}
          onCerrar={() => {
            setAbierto(false);
            /*
             * The legacy column is read-only. It is re-read on close to avoid keeping a stale
             * projection after Perfil has applied a canonical revision.
             */
            void config.reload();
          }}
        />
      ) : null}
    </div>
  );
}
