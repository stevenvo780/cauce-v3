import { Maximize2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useApi } from '../../api/context';
import type { ConfigurationSnapshot } from '../../api/types';
import { useResource } from '../../api/use-resource';
import { DirectivaModal } from './DirectivaModal';
import { primerasLineas } from './directiva';
import { ROLE_BRIEF_MAX, contarRoleBrief, tonoRoleBrief } from './role-brief';

/**
 * LA PESTAÑA «DIRECTIVA» DEL CAJÓN: UN RESUMEN DE DOS RENGLONES Y UNA PUERTA.
 *
 * Hasta esta ronda, esta pestaña metía las cuatro secciones enteras dentro del cajón. MEDIDO en
 * Chrome contra producción, sobre `zeus`: 686 px (capa 1) + 387 (capa 2) + 368 (capa 3) + 679
 * (capa 4) = **2.120 px** de contenido dentro de una columna de **420 px** de la que se ven
 * **1.000**. Steven lo dijo antes de que nadie lo midiera: «tienen demasiados datos».
 *
 * Así que las capas se van a un diálogo ancho (`DirectivaModal`) y acá queda lo único que se
 * responde de un vistazo: **quién dice que es** este bot y **cuánto le queda de tope**. Las dos
 * cosas caben en la parte visible del cajón sin desplazarse, que es la diferencia entre un dato y
 * un dato que hay que ir a buscar.
 *
 * Lo que NO queda acá, y es a propósito: ni el editor, ni el manual, ni la memoria, ni los avisos
 * de solapamiento. Un resumen que además edita es un editor pequeño, y un editor de 420 px es
 * justamente lo que había.
 */

export interface DirectivaTabProps {
  tenantId: string;
  alias: string;
  onEditarEnPerfil: () => void;
  onEditarEnFicheros: () => void;
  onRestaurarEnPerfil: (texto: string) => void;
}

/**
 * Los tres desenlaces de buscar un alias en el registro, que NO son el mismo hecho.
 *
 * `sin-registro` = este gateway no publica la lista de agentes. `sin-fila` = la publica y este
 * alias no está en ella —apareció por entregas o por lease—. `fila` = está, con o sin texto. Los
 * tres se resolvían antes con un `undefined` y por eso `zeus`, que no tiene fila, se leía igual
 * que un alias con el rol en blanco: dos cosas distintas con la misma cara.
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
  tenantId, alias, onEditarEnPerfil, onEditarEnFicheros, onRestaurarEnPerfil,
}: DirectivaTabProps) {
  const api = useApi();
  const config = useResource(`directiva-config-${tenantId}-${alias}`, () => api.getConfiguration());
  const [abierto, setAbierto] = useState(false);
  const abridor = useRef<HTMLButtonElement>(null);

  const registro = buscarEnRegistro(config.data, tenantId, alias);
  // La columna legacy es una proyección de sólo lectura; ningún borrador alternativo la pisa.
  const texto = registro.estado === 'fila' ? registro.brief : '';
  const lineas = primerasLineas(texto, 2);
  const largo = contarRoleBrief(texto);
  const tono = tonoRoleBrief(largo);
  // El contador sólo se pinta sobre una lectura que ocurrió: «0 / 1200» encima de un GET que
  // falló, o de un alias que ni siquiera está en el registro, es una cifra inventada.
  const hayRol = registro.estado === 'fila';

  return (
    <div className="directiva-resumen">
      <p className="directiva-resumen-rotulo">Rol declarado de {alias}</p>

      {registro.estado === 'sin-registro' ? (
        /* Sin snapshot no hay rol que resumir. El botón sigue estando: el diálogo explica el fallo
           con las palabras del servidor, que es más de lo que cabe acá. */
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
        onClick={() => setAbierto(true)}
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
             * La columna legacy es de sólo lectura. Se relee al cerrar para no conservar una
             * proyección vieja después de que Perfil haya aplicado una revisión canónica.
             */
            void config.reload();
          }}
        />
      ) : null}
    </div>
  );
}
