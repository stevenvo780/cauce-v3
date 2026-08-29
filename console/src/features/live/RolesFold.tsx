import type { ConfigurationSnapshot } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { plural } from '../../lib';
import { ROLE_BRIEF_MAX, bloqueoPorRuntimeDesplegado } from './role-brief';
import { catalogoDeRoles, claveDeAlias, resumenDeRol } from './roles';

/**
 * The fleet's role catalog: how many distinct texts there are, who shares each one, and who goes
 * out to work without any. These are SET facts, so they don't fit in any one alias's slot.
 *
 * The registry is NOT read here: it arrives from the page, which asks for it ONCE for the whole
 * view. It is a global resource, so a key per alias —the pattern the Directive tab used— made
 * each widget ask again and left both surfaces on different snapshots.
 */

function Portador({ clave, onAbrir }: { clave: string; onAbrir: (key: string) => void }) {
  return (
    <button type="button" className="rol-portador" onClick={() => { onAbrir(clave); }}>
      {clave}
    </button>
  );
}

export interface RolesFoldProps {
  configuracion: Resource<ConfigurationSnapshot>;
  onAbrirPerfil: (key: string) => void;
}

export function RolesFold({ configuracion: config, onAbrirPerfil }: RolesFoldProps) {
  const agents = config.data?.agents;
  const hayRegistro = Array.isArray(agents);
  const catalogo = catalogoDeRoles(agents);
  const resumen = !hayRegistro
    ? (config.loading ? 'leyendo el registro…' : 'registro no publicado')
    : `${plural(catalogo.roles.length, 'texto de rol', 'textos de rol')} entre `
      + plural(catalogo.todos.length, 'bot registrado', 'bots registrados');

  return (
    <details className="live-fold">
      <summary>Roles declarados · {resumen}</summary>
      {!hayRegistro ? (
        <p className="live-legend-lead">
          {config.loading
            ? 'Leyendo el registro de agentes…'
            : `Este gateway no publica el registro de agentes, así que no hay roles que catalogar${config.error ? `: ${config.error.message}` : '. Clave ausente no es lista vacía.'}`}
        </p>
      ) : (
        <>
          <p className="live-legend-lead">
            Agrupados por el texto que recibe cada bot. El título es un resumen de su primera línea,
            no un nombre guardado. El rol se escribe en la pestaña <strong>Perfil</strong> del bot, y
            eso es lo que abre cada enlace.
          </p>
          {catalogo.roles.length === 0 ? (
            <p className="live-legend-lead">Ningún bot del registro tiene rol declarado.</p>
          ) : (
            <ul className="rol-catalogo">
              {catalogo.roles.map((rol) => {
                const bloqueo = bloqueoPorRuntimeDesplegado(rol.texto);
                return (
                  <li key={rol.texto}>
                    <strong>{resumenDeRol(rol.texto)}</strong>
                    <span className="rol-medida" data-fuera={rol.pasado ? 'si' : 'no'}>
                      {rol.puntos} puntos de código · {rol.utf16} unidades UTF-16 / {ROLE_BRIEF_MAX}
                    </span>
                    <span className="rol-portadores">
                      {plural(rol.portadores.length, 'bot', 'bots')}:{' '}
                      {rol.portadores.map((entrada) => (
                        <Portador
                          key={claveDeAlias(entrada)}
                          clave={claveDeAlias(entrada)}
                          onAbrir={onAbrirPerfil}
                        />
                      ))}
                    </span>
                    {bloqueo ? <p className="notice error" role="alert">{bloqueo}</p> : null}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="rol-sin-rol">
            <strong>Sin rol declarado ({catalogo.sinRol.length}):</strong>{' '}
            {catalogo.sinRol.length === 0
              ? 'ninguno, todos los bots del registro llevan uno.'
              : 'salen a trabajar sin ninguna línea de identidad delante de su contrato.'}
          </p>
          {catalogo.sinRol.length === 0 ? null : (
            <p className="rol-portadores">
              {catalogo.sinRol.map((entrada) => (
                <Portador
                  key={claveDeAlias(entrada)}
                  clave={claveDeAlias(entrada)}
                  onAbrir={onAbrirPerfil}
                />
              ))}
            </p>
          )}
        </>
      )}
    </details>
  );
}
