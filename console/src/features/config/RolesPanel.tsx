import type { ConfigurationSnapshot } from '../../api/types';
import { Badge, EmptyState, Panel } from '../../components/ui';
import { ROLE_BRIEF_MAX, bloqueoPorRuntimeDesplegado } from '../live/role-brief';
import { catalogoDeRoles, claveDeAlias, resumenDeRol, type RolCatalogado } from '../live/roles';
import { plural } from '../../lib';

/**
 * Catálogo de roles de agente y asignación entre alias.
 *
 * El pedido literal fue «poder crear roles como orquestador, constructor, operador y poder
 * cambiarlos entre agentes fácilmente». La mitad cara de eso —pasarle a otro bot exactamente el
 * mismo rol, sin volver a redactarlo, y que quede deshecho si sale mal— se resuelve entera acá y
 * con la mutación versionada de siempre.
 *
 * La otra mitad, el NOMBRE («orquestador»), no se puede resolver desde la consola: no hay dónde
 * guardarlo. El servidor tiene una columna de texto por alias y nada más. Antes que inventarle un
 * sitio falso —el navegador de un operador, o un marcador escondido dentro del propio texto que el
 * bot recibe— esta pantalla dice lo que hay: un rol se identifica por su texto y por quiénes lo
 * llevan. El esquema de la tabla que falta queda propuesto en el informe de este cambio.
 *
 * El medidor muestra las DOS unidades a la vez, y no es un adorno: la base cuenta puntos de código
 * y el esquema del adaptador que corre hoy en producción cuenta unidades UTF-16. Un rol de 1200
 * puntos con emojis mide 1300 en UTF-16, la base lo acepta, la pantalla diría «guardado»… y el
 * alias deja de recibir entregas sin un solo error a la vista. Por eso se enseñan las dos y se
 * bloquea con la más estricta.
 */

function Medidor({ rol }: { rol: RolCatalogado }) {
  const tono = rol.pasado ? 'pasado' : Math.max(rol.puntos, rol.utf16) > ROLE_BRIEF_MAX - 120 ? 'cerca' : 'ok';
  return (
    <p className="rol-medidor" data-tone={tono}>
      <span>{rol.puntos} / {ROLE_BRIEF_MAX} caracteres <span className="muted">(puntos de código: lo que mide la base)</span></span>
      <span>{rol.utf16} / {ROLE_BRIEF_MAX} unidades UTF-16 <span className="muted">(lo que mide el adaptador desplegado)</span></span>
    </p>
  );
}

export interface RolesPanelProps {
  snapshot?: ConfigurationSnapshot;
}

export function RolesPanel({ snapshot }: RolesPanelProps) {
  const catalogo = catalogoDeRoles(snapshot?.agents);

  if (!Array.isArray(snapshot?.agents)) {
    return (
      <Panel title="Roles de agente" subtitle="Derivados del registro de bots">
        <EmptyState>
          Este gateway no publica el registro de agentes, así que no hay roles que catalogar. Clave
          ausente no es lo mismo que lista vacía: no se pudo saber.
        </EmptyState>
      </Panel>
    );
  }

  return (
    <>
      <Panel
        title="Roles en uso"
        subtitle={plural(catalogo.roles.length, 'texto de rol', 'textos de rol')
          + ' repartidos entre ' + plural(catalogo.todos.length, 'bot registrado', 'bots registrados')}
      >
        <p className="muted">
          Agrupa el rol tal como lo recibe cada bot. Es de sólo lectura: el rol se escribe en la
          pestaña «Perfil» del bot, que es donde el cambio se confirma contra el runtime.
        </p>
        {!catalogo.roles.length ? (
          <EmptyState>Ningún bot del registro tiene rol declarado todavía.</EmptyState>
        ) : (
          <ul className="rol-lista">
            {catalogo.roles.map((rol) => {
              const bloqueo = bloqueoPorRuntimeDesplegado(rol.texto);
              return (
                <li key={rol.texto} className="rol-card">
                  <header>
                    <h3>{resumenDeRol(rol.texto)}</h3>
                    <Badge tone={rol.pasado ? 'danger' : 'info'}>{plural(rol.portadores.length, 'bot', 'bots')}</Badge>
                  </header>
                  <p className="muted rol-resumen-nota">
                    Ese título es un resumen de la primera línea del texto, no un nombre guardado: no
                    lo busques en la base porque no está.
                  </p>
                  <p className="rol-portadores">
                    Lo llevan: {rol.portadores.map((entrada) => (
                      <a
                        key={claveDeAlias(entrada)}
                        className="rol-portador"
                        href={`/live?agente=${encodeURIComponent(claveDeAlias(entrada))}&pestana=perfil`}
                      >
                        {entrada.tenantId}/{entrada.alias}
                      </a>
                    ))}
                  </p>
                  <Medidor rol={rol} />
                  {bloqueo ? <p className="notice error" role="alert">{bloqueo}</p> : null}
                  {rol.pasado ? (
                    <p className="notice error" role="alert">
                      Este rol ya está pasado del tope: aplicarlo a otro bot lo dejaría SORDO. No se
                      puede asignar hasta acortarlo desde el detalle del bot que lo lleva.
                    </p>
                  ) : null}
                  <details className="rol-texto">
                    <summary>Ver el texto completo del rol</summary>
                    <pre>{rol.texto}</pre>
                  </details>
                  <p className="notice" role="note">
                    Para cambiar o reutilizar este rol, abrí el Perfil canónico del bot destino.
                    Esta vista no envía mutaciones genéricas.
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel title="Bots sin rol declarado" subtitle="Reciben su contrato sin ninguna línea de identidad delante">
        {!catalogo.sinRol.length ? (
          <EmptyState>Todos los bots del registro tienen rol declarado.</EmptyState>
        ) : (
          <ul className="rol-sin-rol">
            {catalogo.sinRol.map((entrada) => (
              <li key={claveDeAlias(entrada)}>
                <a href={`/live?agente=${encodeURIComponent(claveDeAlias(entrada))}&pestana=perfil`}>
                  <strong>{entrada.tenantId}/{entrada.alias}</strong>
                </a>
                {entrada.displayName ? <span className="muted"> · {entrada.displayName}</span> : null}
              </li>
            ))}
          </ul>
        )}
        <p className="muted">
          Un bot sin rol no está roto: el adaptador simplemente omite la línea «Tu rol: …». Para
          darle uno, abrí el enlace del bot y redactalo desde su pestaña Perfil.
        </p>
      </Panel>
    </>
  );
}
