import { BookOpen, Brain, IdCard, X } from 'lucide-react';
import { useEffect, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useApi } from '../../api/context';
import type { ConfigurationSnapshot } from '../../api/types';
import { useResource } from '../../api/use-resource';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { RoleBriefTab, type RoleBriefTabProps } from './RoleBriefTab';
import { ubicacionDeclarada } from './capas-pendientes';
import { avisosDeCapas } from './directiva';
import { AvisosDeSolapamiento } from './directiva-modal/AvisosDeSolapamiento';
import { CapaCabecera } from './directiva-modal/CapaCabecera';
import { CapasPendientes } from './directiva-modal/CapasPendientes';
import { CapaDeFicheros, CapaDeMemoria } from './directiva-modal/ContenidoDeCapas';

export interface DirectivaModalProps extends RoleBriefTabProps {
  onEditarEnFicheros: () => void;
  devolverFocoA?: RefObject<HTMLElement | null>;
  onCerrar: () => void;
}

function briefGuardado(snapshot: ConfigurationSnapshot | undefined, tenantId: string, alias: string): string | undefined {
  const agents = snapshot?.agents;
  if (!Array.isArray(agents)) return undefined;
  const fila = agents.find((row) => row.tenant_id === tenantId && row.alias === alias);
  return typeof fila?.role_brief === 'string' ? fila.role_brief : undefined;
}

export function DirectivaModal({
  tenantId, alias, configuration, onEditarEnPerfil, onRestaurarEnPerfil, onEditarEnFicheros,
  devolverFocoA, onCerrar,
}: DirectivaModalProps) {
  const api = useApi();
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

  const avisos = avisosDeCapas(
    briefGuardado(configuration.data, tenantId, alias),
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
              <RoleBriefTab
                tenantId={tenantId}
                alias={alias}
                configuration={configuration}
                onEditarEnPerfil={onEditarEnPerfil}
                onRestaurarEnPerfil={onRestaurarEnPerfil}
              />
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
                onClick={onEditarEnFicheros}
              >
                Editar CLAUDE.md / AGENTS.md
              </button>
              <button
                type="button"
                className="button small secondary directiva-editar-fichero"
                onClick={onEditarEnPerfil}
              >
                Editar perfil / OpenClaw (7 ficheros)
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
