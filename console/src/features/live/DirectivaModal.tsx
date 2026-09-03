import { ArrowRight, BookOpen, Brain, IdCard, X } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useApi } from '../../api/context';
import type { AgentPerfilCampos, ConfigurationSnapshot } from '../../api/types';
import { EmptyState } from '../../components/ui';
import { useResource } from '../../api/use-resource';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { PermissionState } from '../../lib';
import { HistorialDeContexto } from './HistorialDeContexto';
import { selectAgentRegistryEntry } from './agent-registry-entry';
import { ubicacionDeclarada } from './capas-pendientes';
import { avisosDeCapas } from './directiva';
import { AvisosDeSolapamiento } from './directiva-modal/AvisosDeSolapamiento';
import { CapaCabecera } from './directiva-modal/CapaCabecera';
import { CapasPendientes } from './directiva-modal/CapasPendientes';
import { CapaDeFicheros, CapaDeMemoria } from './directiva-modal/ContenidoDeCapas';
import { ROLE_BRIEF_MAX, contarRoleBrief, tonoRoleBrief } from './role-brief';

interface DirectivaModalProps {
  tenantId: string;
  alias: string;
  /**
   * The same versioned read used by the surface that opens this dialog. This layer does not
   * re-query `/config`: doing so would allow warning with revision A and showing B at once.
   */
  configuration: {
    data?: ConfigurationSnapshot;
    error?: Error;
    loading: boolean;
  };
  onEditarEnPerfil: () => void;
  onEditarEnFicheros: () => void;
  /** Carries a whole past revision into the canonical draft: the seven fields or none. */
  onRestaurarEnPerfil: (campos: AgentPerfilCampos) => void;
  configWritePermission: PermissionState;
  devolverFocoA?: RefObject<HTMLElement | null>;
  onCerrar: () => void;
}

export function DirectivaModal({
  tenantId, alias, configuration, onEditarEnPerfil, onRestaurarEnPerfil, onEditarEnFicheros,
  configWritePermission, devolverFocoA, onCerrar,
}: DirectivaModalProps) {
  const api = useApi();
  const [historialAbierto, setHistorialAbierto] = useState(false);
  const directiva = useResource(
    `directiva-ficheros-${tenantId}-${alias}`,
    () => api.getAgentDirective(tenantId, alias),
  );

  const dialogo = useRef<HTMLDivElement>(null);
  const cerrar = useRef<HTMLButtonElement>(null);
  const focoDeVuelta = useRef(devolverFocoA);
  focoDeVuelta.current = devolverFocoA;

  useEffect(() => {
    const fondo = document.querySelector('.app-shell');
    fondo?.setAttribute('inert', '');
    document.documentElement.classList.add('directiva-modal-abierta');
    cerrar.current?.focus();
    return () => {
      fondo?.removeAttribute('inert');
      document.documentElement.classList.remove('directiva-modal-abierta');
      focoDeVuelta.current?.current?.focus();
    };
  }, []);

  useEffect(() => {
    const alPulsar = (evento: globalThis.KeyboardEvent) => {
      if (evento.key !== 'Escape') return;
      evento.stopPropagation();
      onCerrar();
    };
    document.addEventListener('keydown', alPulsar, true);
    return () => { document.removeEventListener('keydown', alPulsar, true); };
  }, [onCerrar]);

  const teclado = useFocusTrap(dialogo);

  const cerrarYEnfocarCampos = () => {
    onCerrar();
    onEditarEnPerfil();
  };
  const cerrarYEnfocarManual = () => {
    onCerrar();
    onEditarEnFicheros();
  };
  const restaurarYEnfocarCampos = (campos: AgentPerfilCampos) => {
    onCerrar();
    onRestaurarEnPerfil(campos);
  };
  const soloLectura = configWritePermission !== 'allowed';

  const registro = selectAgentRegistryEntry(configuration.data, tenantId, alias);
  const avisos = avisosDeCapas(
    registro.state === 'found' ? registro.roleBrief : undefined,
    directiva.error ? undefined : directiva.data,
  );

  return createPortal(
    <div
      className="directiva-modal-fondo"
      onMouseDown={(evento) => { if (evento.target === evento.currentTarget) onCerrar(); }}
    >
      <div
        className="directiva-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="directiva-modal-titulo"
        ref={dialogo}
        onKeyDown={teclado}
      >
        <header className="directiva-modal-head">
          <div>
            <h2 id="directiva-modal-titulo">Directiva de {alias}</h2>
            <p>Las tres capas que gobiernan a este bot, una al lado de la otra.</p>
          </div>
          <button
            type="button"
            className="button small secondary"
            ref={cerrar}
            onClick={onCerrar}
            aria-label="Cerrar la directiva"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </header>

        <div className="directiva-modal-cuerpo">
          <AvisosDeSolapamiento avisos={avisos} />

          <div className="directiva-columnas">
            <section className="directiva-capa" aria-label="Capa 1: rol declarado">
              <CapaCabecera
                icono={<IdCard size={15} aria-hidden="true" />}
                numero={1}
                titulo="Rol declarado"
                fin="QUIÉN SOS y QUÉ PODÉS DECIDIR"
                fuente="agent_profiles.role_summary · role_brief es sólo su proyección"
                porque={
                  'Es la única capa que sigue siendo verdad si se recrea el contenedor o cambia el '
                  + 'arnés, así que es la única que debe fijar identidad, límites de autonomía y a '
                  + 'quién se escala.'
                }
              />
              <div className="role-brief">
                <p className="notice" role="note">
                  Solo lectura acá: el rol vive en <code>agent_profiles.role_summary</code> y se
                  edita en los campos canónicos, donde un cambio sólo figura aplicado cuando el
                  runtime acredita todos sus ficheros.
                </p>
                <ProyeccionDelRol
                  tenantId={tenantId}
                  alias={alias}
                  configuration={configuration}
                />
                <button type="button" className="button primary" onClick={cerrarYEnfocarCampos}>
                  {soloLectura ? 'Abrir los campos canónicos' : 'Editar los campos canónicos'}
                  {' '}<ArrowRight size={15} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="historial-contexto-abrir"
                  aria-expanded={historialAbierto}
                  aria-controls="historial-contexto-caja"
                  onClick={() => { setHistorialAbierto(!historialAbierto); }}
                >
                  Historial y diff del contexto
                </button>
                {/* Mounted only when opened: the journal costs two reads that nobody asked for
                    while the dialog is being used to compare the three layers. */}
                {historialAbierto ? (
                  <div id="historial-contexto-caja">
                    <HistorialDeContexto
                      tenantId={tenantId}
                      alias={alias}
                      onRestaurar={soloLectura ? undefined : restaurarYEnfocarCampos}
                    />
                  </div>
                ) : null}
              </div>
            </section>

            <section className="directiva-capa" aria-label="Capa 2: manual del sitio">
              <CapaCabecera
                icono={<BookOpen size={15} aria-hidden="true" />}
                numero={2}
                titulo="Manual del sitio"
                fin="CÓMO SE TRABAJA AQUÍ"
                fuente="CLAUDE.md / AGENTS.md dentro del runtime · no es inventario de configuración ni memoria"
                porque={
                  'Rutas, comandos, convenciones, qué no tocar, cómo se despliega. No repite '
                  + 'identidad ni autonomía: si empieza con «Sos…», está invadiendo la capa 1.'
                }
              />
              <CapaDeFicheros recurso={directiva} />
              <button
                type="button"
                className="button small directiva-editar-fichero"
                onClick={cerrarYEnfocarManual}
              >
                Editar el manual en Contexto
              </button>
              <button
                type="button"
                className="button small secondary directiva-editar-fichero"
                onClick={cerrarYEnfocarCampos}
              >
                Ir a los campos canónicos
              </button>
            </section>

            <section className="directiva-capa" aria-label="Capa 3: memoria">
              <CapaCabecera
                icono={<Brain size={15} aria-hidden="true" />}
                numero={3}
                titulo="Memoria"
                fin="LO QUE ESE AGENTE APRENDIÓ"
                fuente="~/.claude/projects · ~/.openclaw/memory · sólo lectura"
                porque={
                  'Hechos que midió él mismo. Ni identidad ni manual. Desde acá se lee el índice: el '
                  + 'contenido se edita donde se escribió, no desde la consola.'
                }
              />
              <CapaDeMemoria recurso={directiva} />
            </section>
          </div>
        </div>

        <footer className="directiva-modal-pie">
          <CapasPendientes ubicacion={ubicacionDeclarada(configuration.data, tenantId, alias)} alias={alias} />
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The legacy projection of the role, read-only and honest about what it did not manage to read.
 *
 * `agents.role_brief` is no longer an editable source: migration 028 derives it from
 * `agent_profiles.role_summary`. It is still shown here because this dialog exists to put the
 * three layers side by side, and a layer with no content is a layer nobody can compare. A failed
 * read is NOT an empty role, and neither is an alias with no row in the registry.
 */
function ProyeccionDelRol({ tenantId, alias, configuration }: {
  tenantId: string;
  alias: string;
  configuration: DirectivaModalProps['configuration'];
}) {
  const registro = selectAgentRegistryEntry(configuration.data, tenantId, alias);

  if (configuration.loading && !configuration.data) {
    return <p className="muted">Leyendo la proyección del rol desde el registro…</p>;
  }
  if (configuration.error && !configuration.data) {
    return (
      <EmptyState>
        No se pudo leer la proyección del rol; no se interpreta como un rol vacío:{' '}
        {configuration.error.message}
      </EmptyState>
    );
  }
  if (registro.state === 'registry-unavailable') {
    return (
      <EmptyState>
        Este gateway no publica el registro de agentes, así que no hay una proyección del rol que
        mostrar.
      </EmptyState>
    );
  }
  if (registro.state === 'agent-missing') {
    return (
      <EmptyState>
        {alias} no está en el registro de agentes de {tenantId}. Un alias sin fila no tiene una
        proyección declarada que mostrar.
      </EmptyState>
    );
  }

  const largo = contarRoleBrief(registro.roleBrief);
  return (
    <>
      {configuration.error ? (
        <p className="notice error" role="alert">
          La última relectura falló ({configuration.error.message}); se muestra la última lectura
          buena.
        </p>
      ) : null}
      <label className="role-brief-field">
        <span>Proyección legacy del rol</span>
        <textarea
          aria-label={`Proyección del rol de ${alias}`}
          rows={10}
          value={registro.roleBrief}
          readOnly
          spellCheck={false}
        />
      </label>
      <div className="role-brief-meter">
        <span className="role-brief-count" data-tone={tonoRoleBrief(largo)}>
          {largo} / {ROLE_BRIEF_MAX}
        </span>
      </div>
    </>
  );
}
