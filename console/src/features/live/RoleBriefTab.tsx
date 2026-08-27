import { ArrowRight } from 'lucide-react';
import { useApi } from '../../api/context';
import type { ConfigurationSnapshot } from '../../api/types';
import { useResource } from '../../api/use-resource';
import { EmptyState } from '../../components/ui';
import { permissionState } from '../../lib';
import { HistorialRol } from './HistorialRol';
import { ROLE_BRIEF_MAX, contarRoleBrief, tonoRoleBrief } from './role-brief';

/** La fila legacy del registro para este alias, o `undefined` si no está publicada. */
function filaDelAgente(
  agents: Array<Record<string, unknown>> | null | undefined,
  tenantId: string,
  alias: string,
): Record<string, unknown> | undefined {
  if (!Array.isArray(agents)) return undefined;
  return agents.find((row) => row.tenant_id === tenantId && row.alias === alias);
}

export interface RoleBriefTabProps {
  tenantId: string;
  alias: string;
  /**
   * La misma lectura versionada que usa la superficie que contiene esta proyección. La capa no
   * vuelve a consultar `/config`: hacerlo permitiría advertir con la revisión A y mostrar la B
   * dentro del mismo diálogo.
   */
  configuration: {
    data?: ConfigurationSnapshot;
    error?: Error;
    loading: boolean;
  };
  /** Cambia la pestaña del mismo cajón al editor canónico, sin abrir otra superficie de escritura. */
  onEditarEnPerfil: () => void;
  /** Lleva una revisión histórica al `role_summary` del borrador canónico y abre Perfil. */
  onRestaurarEnPerfil: (texto: string) => void;
}

/**
 * Proyección legacy del rol, deliberadamente de sólo lectura.
 *
 * `agents.role_brief` dejó de ser una fuente editable: la migración 028 lo deriva de
 * `agent_profiles.role_summary`. El antiguo POST `agent/update {role_brief}` sólo acreditaba una
 * revisión genérica de base de datos; podía dejar el fichero del arnés pendiente y, aun así,
 * pintar éxito. Esta vista no ofrece ningún camino alternativo: dirige al PUT canónico de Perfil,
 * que sólo confirma éxito tras CAS, batch gobernado y `applied_revision` convergente.
 */
export function RoleBriefTab({
  tenantId, alias, configuration, onEditarEnPerfil, onRestaurarEnPerfil,
}: RoleBriefTabProps) {
  const api = useApi();
  const access = useResource('console-access', () => api.getConsoleAccess());
  const estadoPermiso = permissionState(access.data, 'config.write');
  const soloLectura = estadoPermiso !== 'allowed';

  const fila = filaDelAgente(configuration.data?.agents, tenantId, alias);
  const texto = typeof fila?.role_brief === 'string' ? fila.role_brief : '';
  const largo = contarRoleBrief(texto);
  const tono = tonoRoleBrief(largo);

  return (
    <div className="role-brief">
      <p className="notice" role="note">
        Solo lectura: <code>agents.role_brief</code> es una proyección corta del
        {' '}<code>role_summary</code> canónico. Editalo en Perfil; allí un cambio sólo figura
        aplicado cuando el runtime acredita todos sus ficheros.
      </p>

      {configuration.loading && !configuration.data ? (
        <p className="muted">Leyendo la proyección del rol desde el registro…</p>
      ) : configuration.error && !configuration.data ? (
        <EmptyState>
          No se pudo leer la proyección del rol; no se interpreta como un rol vacío: {configuration.error.message}
        </EmptyState>
      ) : !Array.isArray(configuration.data?.agents) ? (
        <EmptyState>
          Este gateway no publica el registro de agentes, así que no hay una proyección del rol que mostrar.
        </EmptyState>
      ) : !fila ? (
        <EmptyState>
          {alias} no está en el registro de agentes de {tenantId}. Un alias sin fila no tiene una
          proyección declarada que mostrar.
        </EmptyState>
      ) : (
        <>
          {configuration.error ? (
            <p className="notice error" role="alert">
              La última relectura falló ({configuration.error.message}); se muestra la última lectura buena.
            </p>
          ) : null}

          <label className="role-brief-field">
            <span>Proyección legacy del rol</span>
            <textarea
              aria-label={`Proyección del rol de ${alias}`}
              rows={14}
              value={texto}
              readOnly
              spellCheck={false}
            />
          </label>

          <div className="role-brief-meter">
            <span className="role-brief-count" data-tone={tono}>{largo} / {ROLE_BRIEF_MAX}</span>
          </div>
        </>
      )}

      <button type="button" className="button primary" onClick={onEditarEnPerfil}>
        {soloLectura ? 'Abrir el perfil canónico' : 'Editar el perfil canónico'}
        {' '}<ArrowRight size={15} aria-hidden="true" />
      </button>

      <details className="historial-rol-caja">
        <summary>Historial de la proyección y restauración</summary>
        <HistorialRol
          tenantId={tenantId}
          alias={alias}
          onRestaurar={soloLectura ? undefined : onRestaurarEnPerfil}
        />
      </details>

      {soloLectura ? (
        <p className="muted">
          {estadoPermiso === 'unknown'
            ? 'No se pudo acreditar config.write: el historial sigue visible, pero restaurar queda bloqueado.'
            : 'Tu sesión puede leer el historial, pero no cargar una revisión en el editor de Perfil.'}
        </p>
      ) : null}
    </div>
  );
}
