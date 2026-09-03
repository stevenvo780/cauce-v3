import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type {
  AgentDocumentKind, AgentPerfilCampos, ConfigurationSnapshot,
} from '../../api/types';
import { ConsoleAccessBoundary, useConsoleAccess } from '../../api/console-access';
import type { Resource } from '../../api/use-resource';
import { permissionState } from '../../lib';
import { DirectivaTab } from './DirectivaTab';
import { FicherosTab, type BorradorDeFichero } from './FicherosTab';
import { PerfilTab } from './PerfilTab';

interface ContextoTabProps {
  tenantId: string;
  alias: string;
  configuracion: Resource<ConfigurationSnapshot>;
  borradorPerfil?: Partial<AgentPerfilCampos>;
  onBorradorPerfil: (campos: Partial<AgentPerfilCampos> | undefined) => void;
  borradoresFicheros?: Partial<Record<AgentDocumentKind, BorradorDeFichero>>;
  onBorradorFichero: (kind: AgentDocumentKind, borrador: BorradorDeFichero | undefined) => void;
  focusTarget?: 'campos' | 'manual';
  profileWriteInFlight: boolean;
  onProfileWriteInFlightChange: (inFlight: boolean) => void;
  runtimeRefreshRevision: number;
  onRuntimeRefresh: () => void;
}

/**
 * The single authoring surface for an agent's context.
 *
 * Canonical fields and the site manual keep their separate API contracts and acknowledgements;
 * putting them in one place does not pretend that one write applies the other.
 */
export function ContextoTab(props: ContextoTabProps) {
  return <ConsoleAccessBoundary><ContextoTabContent {...props} /></ConsoleAccessBoundary>;
}

function ContextoTabContent({
  tenantId, alias, configuracion, borradorPerfil, onBorradorPerfil,
  borradoresFicheros, onBorradorFichero, focusTarget, profileWriteInFlight,
  onProfileWriteInFlightChange, runtimeRefreshRevision, onRuntimeRefresh,
}: ContextoTabProps) {
  const access = useConsoleAccess();
  const configWritePermission = permissionState(access.error ? undefined : access.data, 'config.write');
  const campos = useRef<HTMLElement>(null);
  const manual = useRef<HTMLElement>(null);
  const [manualAppliedNotice, setManualAppliedNotice] = useState<string>();
  const [restauraciones, setRestauraciones] = useState(0);

  const enfocar = useCallback((destino: RefObject<HTMLElement | null>) => {
    // The directive dialog restores focus to its opener while unmounting. Waiting one frame lets
    // this explicit navigation win after the modal has released the drawer.
    requestAnimationFrame(() => {
      const seccion = destino.current;
      if (typeof seccion?.scrollIntoView === 'function') {
        seccion.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
      seccion?.focus({ preventScroll: true });
    });
  }, []);

  const refrescarLectores = useCallback(() => {
    onRuntimeRefresh();
    void configuracion.reload();
  }, [configuracion, onRuntimeRefresh]);

  const alAplicarManual = useCallback((message: string) => {
    setManualAppliedNotice(message);
    refrescarLectores();
  }, [refrescarLectores]);

  const alCambiarEscrituraPerfil = useCallback((inFlight: boolean) => {
    if (inFlight) setManualAppliedNotice(undefined);
    onProfileWriteInFlightChange(inFlight);
  }, [onProfileWriteInFlightChange]);

  useEffect(() => {
    if (focusTarget === 'campos') enfocar(campos);
    if (focusTarget === 'manual') enfocar(manual);
  }, [enfocar, focusTarget]);

  useEffect(() => {
    if (borradoresFicheros?.directive !== undefined) setManualAppliedNotice(undefined);
  }, [borradoresFicheros?.directive]);

  return (
    <div className="contexto-tab">
      <section className="contexto-seccion contexto-efectivo" aria-labelledby="contexto-efectivo-titulo">
        <header className="contexto-cabecera">
          <h3 id="contexto-efectivo-titulo">Contexto efectivo</h3>
          <p>
            Resumen y capas que gobiernan hoy a {alias}. Esta lectura no es otro editor.
          </p>
        </header>
        <DirectivaTab
          key={`${tenantId}/${alias}/lectura/${String(runtimeRefreshRevision)}`}
          tenantId={tenantId}
          alias={alias}
          configuracion={configuracion}
          onEditarEnPerfil={() => { enfocar(campos); }}
          onEditarEnFicheros={() => { enfocar(manual); }}
          onRestaurarEnPerfil={(restaurado) => {
            // A restore replays the SEVEN authored fields, the unit the profile is saved in, and
            // writes nothing: the manual drafts stay as the operator left them.
            onBorradorPerfil(restaurado);
            setRestauraciones((n) => n + 1);
            enfocar(campos);
          }}
          configWritePermission={configWritePermission}
        />
      </section>

      <section
        className="contexto-seccion contexto-campos"
        aria-labelledby="contexto-campos-titulo"
        ref={campos}
        tabIndex={-1}
      >
        <header className="contexto-cabecera">
          <h3 id="contexto-campos-titulo">Campos canónicos</h3>
          <p>
            Identidad, rol y reglas persistidas como un lote. Sólo se muestran aplicados tras el
            ACK completo del runtime y su relectura convergente.
          </p>
        </header>
        <PerfilTab
          tenantId={tenantId}
          alias={alias}
          borrador={borradorPerfil}
          onBorrador={onBorradorPerfil}
          onMutationSettled={refrescarLectores}
          onWriteInFlightChange={alCambiarEscrituraPerfil}
          writeInFlight={profileWriteInFlight}
          blockedByManualDraft={borradoresFicheros?.directive !== undefined}
          runtimeRefreshRevision={runtimeRefreshRevision}
          restauracion={restauraciones}
          configWritePermission={configWritePermission}
        />
      </section>

      <section
        className="contexto-seccion contexto-manual"
        aria-labelledby="contexto-manual-titulo"
        ref={manual}
        tabIndex={-1}
      >
        <header className="contexto-cabecera">
          <h3 id="contexto-manual-titulo">Manual del arnés</h3>
          <p>
            Instrucciones locales de trabajo. Podés cambiar el texto libre, pero los bloques CAUCE
            de los campos canónicos están protegidos. Esta escritura sólo se afirma aplicada cuando
            la sonda devuelve su ACK verificable.
          </p>
        </header>
        {manualAppliedNotice ? (
          <p className="ficheros-ok" role="status">{manualAppliedNotice}</p>
        ) : null}
        <FicherosTab
          key={`${tenantId}/${alias}/manual/${String(runtimeRefreshRevision)}`}
          tenantId={tenantId}
          alias={alias}
          borradores={borradoresFicheros}
          onBorrador={onBorradorFichero}
          mode="manual-editor"
          onApplied={alAplicarManual}
          mutationBlocked={profileWriteInFlight}
          configWritePermission={configWritePermission}
        />
      </section>
    </div>
  );
}
