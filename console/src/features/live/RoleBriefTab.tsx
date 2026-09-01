import { ArrowRight } from 'lucide-react';
import { useApi } from '../../api/context';
import type { ConfigurationSnapshot } from '../../api/types';
import { useResource } from '../../api/use-resource';
import { EmptyState } from '../../components/ui';
import { permissionState } from '../../lib';
import { HistorialRol } from './HistorialRol';
import { ROLE_BRIEF_MAX, contarRoleBrief, tonoRoleBrief } from './role-brief';

/** The legacy registry row for this alias, or `undefined` if it is not published. */
function filaDelAgente(
  agents: Record<string, unknown>[] | null | undefined,
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
   * The same versioned read used by the surface containing this projection. This layer does not
   * re-query `/config`: doing so would allow warning with revision A and showing B in the same
   * dialog.
   */
  configuration: {
    data?: ConfigurationSnapshot;
    error?: Error;
    loading: boolean;
  };
  /** Switches the tab of the same drawer to the canonical editor, without opening another write surface. */
  onEditarEnPerfil: () => void;
  /** Carries a historical revision into the canonical draft `role_summary` and focuses it. */
  onRestaurarEnPerfil: (texto: string) => void;
}

/**
 * Legacy projection of the role, deliberately read-only.
 *
 * `agents.role_brief` is no longer an editable source: migration 028 derives it from
 * `agent_profiles.role_summary`. The old POST `agent/update {role_brief}` only accredited a
 * generic database revision; it could leave the harness file pending and still paint success.
 * This view offers no alternative path: it directs to the canonical context PUT, which only
 * confirms success after CAS, governed batch, and convergent `applied_revision`.
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
        {' '}<code>role_summary</code> canónico. Editalo en Contexto; allí un cambio sólo figura
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
        {soloLectura ? 'Abrir los campos canónicos' : 'Editar los campos canónicos'}
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
            : 'Tu sesión puede leer el historial, pero no cargar una revisión en los campos canónicos.'}
        </p>
      ) : null}
    </div>
  );
}
