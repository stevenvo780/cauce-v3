import { Maximize2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ConfigurationSnapshot } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { DirectivaModal } from './DirectivaModal';
import { selectAgentRegistryEntry } from './agent-registry-entry';
import { primerasLineas } from './directiva';
import { ROLE_BRIEF_MAX, contarRoleBrief, tonoRoleBrief } from './role-brief';
import type { PermissionState } from '../../lib';

/**
 * Tab for summarizing an agent's declared directive and role in the side drawer.
 */

interface DirectivaTabProps {
  tenantId: string;
  alias: string;
  configuracion: Resource<ConfigurationSnapshot>;
  onEditarEnPerfil: () => void;
  onEditarEnFicheros: () => void;
  onRestaurarEnPerfil: (texto: string) => void;
  configWritePermission: PermissionState;
}

export function DirectivaTab({
  tenantId, alias, configuracion: config, onEditarEnPerfil, onEditarEnFicheros, onRestaurarEnPerfil,
  configWritePermission,
}: DirectivaTabProps) {
  const [abierto, setAbierto] = useState(false);
  const abridor = useRef<HTMLButtonElement>(null);

  const registro = selectAgentRegistryEntry(config.data, tenantId, alias);
  // The legacy column is a read-only projection; no alternative draft overwrites it.
  const texto = registro.state === 'found' ? registro.roleBrief : '';
  const lineas = primerasLineas(texto, 2);
  const largo = contarRoleBrief(texto);
  const tono = tonoRoleBrief(largo);
  // The counter is only painted over a reading that happened: "0 / 1200" over a GET that failed,
  // or over an alias that is not even in the registry, is an invented figure.
  const hayRol = registro.state === 'found';

  return (
    <div className="directiva-resumen">
      <p className="directiva-resumen-rotulo">Rol declarado de {alias}</p>

      {registro.state === 'registry-unavailable' ? (
        /* Without a snapshot there is no role to summarize. The button still exists: the dialog
           explains the failure using the server's words, which is more than fits here. */
        <p className="directiva-resumen-vacio">
          {config.loading && !config.data
            ? 'Leyendo el rol declarado desde la configuración versionada…'
            : `No se pudo leer el registro de agentes, así que el rol de este alias es un dato que no tenemos —no «vacío»—${config.error ? `: ${config.error.message}` : '.'}`}
        </p>
      ) : registro.state === 'agent-missing' ? (
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
          configWritePermission={configWritePermission}
          devolverFocoA={abridor}
          onCerrar={() => {
            setAbierto(false);
            /*
             * The legacy column is read-only. It is re-read on close to avoid keeping a stale
             * projection after Contexto has applied a canonical revision.
             */
            void config.reload();
          }}
        />
      ) : null}
    </div>
  );
}
