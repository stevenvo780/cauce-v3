import { AlertTriangle, BookOpen, Brain, Eye, EyeOff, FileWarning, IdCard, Wrench, X } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useApi } from '../../api/context';
import type { AgentDirective, ConfigurationSnapshot } from '../../api/types';
import { useResource } from '../../api/use-resource';
import { Time } from '../../components/ui';
import { RoleBriefTab, type RoleBriefTabProps } from './RoleBriefTab';
import { CAPAS_PENDIENTES, ubicacionDeclarada, type UbicacionDeclarada } from './capas-pendientes';
import { avisosDeCapas, medicionDeCapa, totalDeMemoria, type AvisoDeCapas } from './directiva';

/**
 * LAS TRES CAPAS DE DIRECTIVA, EN UN DIÁLOGO ANCHO Y NO DENTRO DEL CAJÓN.
 *
 * Steven lo pidió con estas palabras: «todo ese menú debería ser un modal, tienen demasiados
 * datos». Estaba midiendo lo mismo que Chrome: dentro del cajón de `zeus`, en producción, las
 * cuatro secciones sumaban **2.120 px** de contenido (686 + 387 + 368 + 679) apilados en una
 * columna de **420 px**, de los que se ven **1.000**. No es que quedara apretado: es que dos de
 * las tres capas quedaban SIEMPRE por debajo del pliegue, y comparar la capa 1 con la 2 —que es
 * la única razón por la que estas tres cosas están juntas— exigía recordar lo de arriba mientras
 * se bajaba.
 *
 * Tres decisiones, cada una con lo que recorta:
 *
 *  1. **Tres columnas** en vez de tres bloques apilados. Comparar es poner al lado, no
 *     desplazarse. Es lo mismo que ya justificaba juntar las capas (`DirectivaTab`), llevado a su
 *     conclusión: la duplicación no se descubre leyendo un fichero, se descubre viéndolo al lado
 *     del otro. Sin ancho, juntarlas no servía de nada.
 *  2. **La prosa se pliega.** Los cuatro párrafos de `.directiva-porque` explican POR QUÉ existe
 *     cada capa. Se leen una vez; después son 4 párrafos de 2-4 líneas que empujan el contenido
 *     hacia abajo cada vez que se abre. Van detrás de «¿por qué esta capa?», cerrados.
 *  3. **La capa 4 baja al pie.** No es una capa: es una nota de alcance sobre lo que todavía no
 *     tiene editor. Medía 679 px —casi lo mismo que la capa 1, que es la única que se puede
 *     tocar de verdad— y encabezaba con el mismo rótulo «Capa N» que las que sí son capas.
 *
 * La columna 1 conserva la proyección y su diario, ambos de sólo lectura. Editar o recuperar una
 * revisión sale de este diálogo hacia Perfil, que es el único dueño del PUT canónico y su ACK.
 */

export interface DirectivaModalProps extends RoleBriefTabProps {
  /** Lleva desde la capa manual al editor real del mismo alias, sin cerrar el cajón. */
  onEditarEnFicheros: () => void;
  /**
   * `configuration` viene de la lectura que YA hizo el cajón. Tanto los avisos como la columna
   * visible consumen ese MISMO snapshot; ninguna capa hace un segundo GET de configuración.
   */
  /**
   * El control al que vuelve el foco cuando esto se cierra. Va por referencia y no leyendo
   * `document.activeElement` al montar porque el foco tiene que devolverse DESPUÉS de quitarle el
   * `inert` al armazón: enfocar algo que está dentro de un subárbol inerte no hace nada, y el
   * operador se queda con el foco en `body` —el tabulador siguiente lo manda al principio de la
   * consola, no al botón que acaba de usar—.
   */
  devolverFocoA?: RefObject<HTMLElement | null>;
  onCerrar: () => void;
}

/** Sólo para el aviso de solapamiento: el texto del rol tal y como está GUARDADO. */
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
  /*
   * La lectura de los ficheros del contenedor se paga al ABRIR el diálogo, no al abrir la pestaña.
   * Hoy son 14 alias devolviendo 404, así que da igual; el día que el gateway publique la ruta va
   * a ser un `docker exec` por alias mirado, y pagarlo por cada clic en la pestaña «Directiva»
   * —que ahora enseña sólo dos renglones— sería cobrarlo sin usarlo.
   */
  const directiva = useResource(
    `directiva-ficheros-${tenantId}-${alias}`,
    () => api.getAgentDirective(tenantId, alias),
  );

  const dialogo = useRef<HTMLDivElement>(null);
  const cerrar = useRef<HTMLButtonElement>(null);
  // El efecto de montaje corre UNA vez y no puede depender de la prop sin volver a montar el
  // `inert`; la referencia se guarda aparte para que la limpieza vea siempre la última.
  const focoDeVuelta = useRef(devolverFocoA);
  focoDeVuelta.current = devolverFocoA;

  useEffect(() => {
    /*
     * `inert` sobre el armazón —no sobre `body`, donde vive este diálogo— apaga la consola de
     * detrás para el ratón, el tabulador y el lector de pantalla a la vez. Es el mismo mecanismo
     * que usa la confirmación de `/config`; ver `ConfirmacionDeAccion`.
     *
     * Lo que `inert` NO hace es frenar la RUEDA: MEDIDO en Chrome con el diálogo abierto, la
     * página de detrás conservaba 2.894 px de recorrido. Eso lo corta la clase, que va en
     * `documentElement` y no en `body` porque quien posee el desplazamiento de la página es el
     * elemento raíz: puesta en `body`, el `scrollbar-gutter` que evita el salto de 7 px del
     * diálogo no tenía a quién aplicarse. Ver `html.directiva-modal-abierta` en `live.css`.
     *
     * Va por CSS y no por un `style` en línea a propósito: la CSP de producción es
     * `style-src 'self'` y un estilo inyectado desde JS no se aplicaría —funcionaría en el
     * servidor de desarrollo y no en producción—.
     */
    const fondo = document.querySelector('.app-shell');
    fondo?.setAttribute('inert', '');
    document.documentElement.classList.add('directiva-modal-abierta');
    cerrar.current?.focus();
    return () => {
      fondo?.removeAttribute('inert');
      document.documentElement.classList.remove('directiva-modal-abierta');
      // El orden importa: primero se levanta el `inert`, y recién después se devuelve el foco.
      focoDeVuelta.current?.current?.focus();
    };
  }, []);

  useEffect(() => {
    /*
     * Escape se atiende en CAPTURA sobre `document`, y no sólo con el `onKeyDown` del diálogo.
     * `AgentDrawer` tiene su propio escuchador de Escape en `document` para cerrarse, así que sin
     * esto una sola pulsación cerraba el diálogo Y el cajón de debajo: el operador apretaba Esc
     * para volver al detalle del alias y se quedaba mirando el mapa. Capturar antes y cortar la
     * propagación deja el cajón donde estaba, que es lo que espera quien cierra un modal.
     */
    const alPulsar = (evento: globalThis.KeyboardEvent) => {
      if (evento.key !== 'Escape') return;
      evento.stopPropagation();
      onCerrar();
    };
    document.addEventListener('keydown', alPulsar, true);
    return () => document.removeEventListener('keydown', alPulsar, true);
  }, [onCerrar]);

  /** El tabulador da la vuelta dentro del diálogo en vez de irse al fondo apagado. */
  const teclado = (evento: KeyboardEvent<HTMLDivElement>) => {
    if (evento.key !== 'Tab') return;
    const focos = dialogo.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), summary, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!focos || focos.length === 0) return;
    const primero = focos[0];
    const ultimo = focos[focos.length - 1];
    if (!evento.shiftKey && document.activeElement === ultimo) { evento.preventDefault(); primero.focus(); }
    if (evento.shiftKey && document.activeElement === primero) { evento.preventDefault(); ultimo.focus(); }
  };

  const avisos = avisosDeCapas(
    briefGuardado(configuration.data, tenantId, alias),
    directiva.error ? undefined : directiva.data,
  );

  return createPortal(
    <div
      className="directiva-modal-fondo"
      /* `onMouseDown` y no `onClick`: con `click`, soltar el ratón sobre el velo tras haber
         empezado a seleccionar texto DENTRO del diálogo lo cerraba y se perdía el borrador. */
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

/**
 * Las dos partes del encargo que TODAVÍA no se pueden tocar, dichas en vez de omitidas.
 *
 * Steven pidió cuatro cosas y esto resuelve dos. Callar las otras dos dejaría al operador
 * eligiendo entre dos conclusiones falsas —que se olvidaron, o que este agente no tiene
 * herramientas configuradas—. Con el hueco rotulado sabe que existen, dónde viven y qué falta.
 *
 * PLEGADA Y EN EL PIE, que es el cambio de esta ronda. Como cuarta sección abierta medía 679 px
 * —casi los 686 de la capa 1, la única editable— y se leía como si fuera una capa más, cuando es
 * una nota de alcance. Un renglón que se abre a voluntad dice lo mismo sin cobrar el 32 % del
 * alto cada vez que alguien viene a corregir una línea del rol.
 *
 * No lleva ningún botón a propósito. Un botón que no hace nada es peor que este texto: promete un
 * efecto, y en la única capa donde todavía no está decidido dónde vive el dato, ese efecto podría
 * escribirse en un fichero que nadie lee.
 */
function CapasPendientes({ ubicacion, alias }: { ubicacion: UbicacionDeclarada; alias: string }) {
  return (
    <details className="directiva-pendientes">
      <summary>
        <Wrench size={14} aria-hidden="true" />
        Lo que todavía no se puede desde aquí — herramientas y prompts
      </summary>

      <ul className="directiva-pendiente-lista">
        {CAPAS_PENDIENTES.map((capa) => (
          <li key={capa.id}>
            <strong>{capa.titulo}</strong>
            <p className="directiva-pendiente-pedido">{capa.pedido}</p>
            <p className="directiva-pendiente-porque">{capa.porQueNo}</p>
            <p className="directiva-pendiente-falta">Para que esto tenga editor: {capa.queFalta}</p>
          </li>
        ))}
      </ul>

      {/* La ubicación NO se inventa: si el registro no la declara se dice que es UNKNOWN, en vez
          de rellenarla con el `/home/dev` que tienen casi todos —que mandaría a mirar el fichero
          equivocado justo en el alias que se sale de la norma—. */}
      <p className="directiva-pendiente-donde">
        Mientras tanto, la configuración de {alias} vive en{' '}
        {ubicacion.contenedor ? <code>{ubicacion.contenedor}</code> : <span className="unknown">contenedor UNKNOWN</span>}
        {', '}
        {ubicacion.home ? <code>{ubicacion.home}</code> : <span className="unknown">$HOME UNKNOWN</span>}
        {'. '}
        Se toca por la TUI o por <code>docker exec</code>, con lo que eso implica: sin revisión y
        sin vuelta atrás.
      </p>
    </details>
  );
}

/**
 * La cabecera de una capa: lo que se ve SIEMPRE, y el porqué detrás de un pliegue.
 *
 * Siempre visible: el número, el título, el fin en versalitas y la fuente. Son las cuatro cosas
 * que hacen falta para decidir en qué capa va a parar una frase —que es la pregunta que esta
 * pantalla existe para contestar—. El párrafo explicativo contesta otra pregunta, «por qué existe
 * esta capa», y ésa se contesta una vez en la vida.
 */
function CapaCabecera({ icono, numero, titulo, fin, fuente, porque }: {
  icono: ReactNode; numero: number; titulo: string; fin: string; fuente: string; porque: string;
}) {
  return (
    <header className="directiva-capa-head">
      <span className="directiva-capa-icono" aria-hidden="true">{icono}</span>
      <div>
        <h3>Capa {numero} · {titulo}</h3>
        {/* El fin va ARRIBA del nombre técnico: la pregunta que resuelve cada capa es lo que
            decide dónde va a parar cada frase, y es justo lo que hoy nadie tiene delante. */}
        <p className="directiva-capa-fin">{fin}</p>
        <p className="directiva-capa-fuente">{fuente}</p>
        <details className="directiva-porque-caja">
          <summary>¿por qué esta capa?</summary>
          <p className="directiva-porque">{porque}</p>
        </details>
      </div>
    </header>
  );
}

function AvisosDeSolapamiento({ avisos }: { avisos: AvisoDeCapas[] }) {
  if (avisos.length === 0) return null;
  return (
    <div className="directiva-avisos" role="group" aria-label="Avisos de solapamiento entre capas">
      {avisos.map((aviso) => (
        <div key={aviso.id} className="directiva-aviso" data-tono={aviso.tono} role={aviso.tono === 'choque' ? 'alert' : 'note'}>
          <span aria-hidden="true">
            {aviso.tono === 'choque' ? <AlertTriangle size={15} /> : <FileWarning size={15} />}
          </span>
          <div>
            <strong>{aviso.titulo}</strong>
            <p>{aviso.detalle}</p>
            {aviso.evidencia.length > 0 ? (
              <ul className="directiva-evidencia">
                {aviso.evidencia.map((dato) => <li key={dato}><code>{dato}</code></li>)}
              </ul>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * NO SE MIRÓ y MIRÉ Y NO HAY son dos hechos distintos, y tienen que VERSE distintos.
 *
 * Es la mitad del trabajo de esta pantalla. Pintar «este alias no tiene CLAUDE.md» sobre una
 * lectura que nunca ocurrió sería cierto para gaia y falso para janus —que tiene dos— con la
 * misma cara de seguridad en los dos casos. Hoy en producción la ruta devuelve 404 en los 14
 * alias, así que el estado que se ve SIEMPRE es el primero.
 *
 * Los dos estados compartían componente (`EmptyState`) y por tanto el mismo recuadro punteado
 * gris: la distinción quedaba enterrada dentro del párrafo, en el único sitio que nadie lee
 * entero. Ahora se separan por rótulo y por color, y el día que el gateway publique la ruta van a
 * convivir en la misma flota: unos alias con manual, otros medidos y vacíos.
 */
function SinMedir({ children }: { children: ReactNode }) {
  return (
    <div className="directiva-lectura" data-medicion="no-medida" role="note">
      <p className="directiva-lectura-rotulo">
        <EyeOff size={14} aria-hidden="true" /> No se pudo mirar
      </p>
      <p>{children}</p>
    </div>
  );
}

function NoSeMiro({ motivo, que }: { motivo: string | undefined; que: string }) {
  return (
    <SinMedir>
      No se pudo mirar {que} de este alias: el gateway todavía no publica esta lectura
      {motivo ? <> (dijo: «{motivo}»)</> : ' y no dio un motivo'}. Eso NO significa que no exista
      —significa que la consola no lo vio—. El día que publique{' '}
      <code>GET /v3/console/agents/:tenant/:alias/directive</code>, esta columna se llena sola.
    </SinMedir>
  );
}

function LecturaFallida({ motivo, que }: { motivo: string; que: string }) {
  return (
    <SinMedir>
      No se pudo mirar {que} de este alias: el servidor respondió «{motivo}». Eso NO significa
      que no exista —significa que la lectura falló o que el recurso no es visible para esta
      sesión—.
    </SinMedir>
  );
}

/** El estado opuesto: la lectura SÍ ocurrió, y por eso acá sí se puede afirmar la ausencia. */
function MiroYNoHay({ children }: { children: ReactNode }) {
  return (
    <div className="directiva-lectura" data-medicion="medida-vacia" role="note">
      <p className="directiva-lectura-rotulo">
        <Eye size={14} aria-hidden="true" /> El servidor miró
      </p>
      <p>{children}</p>
    </div>
  );
}

type RecursoDirectiva = { data?: AgentDirective; error?: Error; loading: boolean };

function CapaDeFicheros({ recurso }: { recurso: RecursoDirectiva }) {
  /*
   * Quién decide qué se pinta es `medicionDeCapa`, y no una cadena de guardas aquí, porque el
   * criterio —«¿ocurrió la lectura?»— tiene que poder probarse solo. Esta columna llegó a
   * afirmar «no hay ningún CLAUDE.md» sobre respuestas en las que el servidor no había mirado
   * nada; ver la cabecera de `medicionDeCapa` en `directiva.ts`.
   */
  const medicion = medicionDeCapa(recurso, 'files');
  if (medicion === 'cargando') return <p className="muted">Buscando el manual medido del runtime…</p>;
  if (medicion === 'no-se-miro') {
    if (recurso.error) {
      return <LecturaFallida que="el manual del sitio" motivo={recurso.error.message} />;
    }
    return <NoSeMiro que="el manual del sitio" motivo={recurso.data?.motivo} />;
  }
  if (medicion === 'miro-y-no-hay') {
    return (
      <MiroYNoHay>
        Miró el contenedor{recurso.data?.container_id ? ` (${recurso.data.container_id})` : ''} y no
        hay ningún manual estándar acreditado en las rutas medidas. Esto no prueba ausencia de
        reglas o fallbacks que la respuesta declare fuera de cobertura.
      </MiroYNoHay>
    );
  }

  const ficheros = recurso.data?.files ?? [];
  return (
    <div>
      <p className="directiva-fichero-meta">
        {recurso.data?.manual_order === 'codex_precedence'
          ? 'Orden efectivo de Codex: más profundo prevalece; override gana dentro del nivel.'
          : recurso.data?.manual_order === 'claude_load_order'
            ? 'Orden de carga medido de Claude; no se inventa una precedencia adicional.'
            : 'Orden medido del runtime.'}
      </p>
      {(recurso.data?.context_limitations ?? []).map((limitacion) => (
        <p key={limitacion} className="directiva-fichero-meta" role="note">Cobertura limitada: {limitacion}</p>
      ))}
      <ul className="directiva-ficheros">
        {ficheros.map((fichero, indice) => (
          <li key={fichero.path ?? indice}>
            <div className="directiva-fichero-head">
              <code>{fichero.path ?? 'ruta sin informar'}</code>
              <span className="chip">{fichero.scope === 'user' ? 'nivel usuario' : fichero.scope === 'workspace' ? 'espacio de trabajo' : 'nivel sin informar'}</span>
              {typeof fichero.precedence === 'number' ? <span className="chip">orden {fichero.precedence + 1}</span> : null}
              <span className="directiva-fichero-meta">
                {typeof fichero.bytes === 'number' ? `${fichero.bytes} bytes` : 'tamaño sin informar'}
                {' · '}<Time value={fichero.modified_at} />
              </span>
            </div>
            {typeof fichero.error === 'string' ? (
              <p className="directiva-fichero-meta" role="alert">
                No se pudo leer ({fichero.error}): {fichero.reason ?? 'sin detalle'}. No se toma como ausencia.
              </p>
            ) : typeof fichero.text === 'string' ? (
              <details>
                <summary>Ver el contenido{fichero.truncated ? ' (recortado por el servidor)' : ''}</summary>
                <pre className="directiva-fichero-texto">{fichero.text}</pre>
              </details>
            ) : (
              <p className="directiva-fichero-meta">
                El servidor lo lista pero no publica su contenido: no se puede cotejar con el rol.
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CapaDeMemoria({ recurso }: { recurso: RecursoDirectiva }) {
  const medicion = medicionDeCapa(recurso, 'memory');
  if (medicion === 'cargando') return <p className="muted">Leyendo el índice de memoria…</p>;
  if (medicion === 'no-se-miro') {
    if (recurso.error) {
      return <LecturaFallida que="la memoria" motivo={recurso.error.message} />;
    }
    /*
     * Dos cosas distintas caen aquí y las dos son «no se miró»: que el gateway no publique la
     * ruta, y que la publique sin haber medido el contenedor. La segunda es la que llegaba antes
     * hasta el «el índice llegó vacío», que afirma un cero que nadie contó.
     */
    const publicaFicherosPeroNoMemoria =
      recurso.data?.publicado === true && recurso.data.medido !== false
      && recurso.data.files != null && recurso.data.memory == null;
    if (publicaFicherosPeroNoMemoria) {
      return (
        <SinMedir>
          Este gateway publica los ficheros del alias pero no su índice de memoria, así que cuánto
          recuerda es un dato que no tenemos. No es cero.
        </SinMedir>
      );
    }
    const memoryFailure = recurso.data?.memory;
    const motivoMemoria = memoryFailure && 'error' in memoryFailure
      ? memoryFailure.reason
      : undefined;
    return (
      <NoSeMiro
        que="la memoria"
        motivo={motivoMemoria ?? recurso.data?.motivo}
      />
    );
  }

  const memoria = recurso.data?.memory;
  const total = totalDeMemoria(recurso.data);
  if (!memoria || total === undefined) {
    return (
      <SinMedir>
        Este gateway publica los ficheros del alias pero no su índice de memoria, así que cuánto
        recuerda es un dato que no tenemos. No es cero.
      </SinMedir>
    );
  }

  const entradas = memoria.entries ?? [];
  const limiteInferior = memoria.total === null
    && typeof memoria.observed_at_least === 'number';
  return (
    <div className="directiva-memoria">
      <p className="directiva-memoria-resumen">
        <strong>{limiteInferior ? `≥ ${total}` : total}</strong> entrada(s) en{' '}
        <code>{memoria.root ?? 'raíz sin informar'}</code>
        {limiteInferior
          ? ` · el barrido alcanzó su límite; se observaron como mínimo ${total}`
          : memoria.truncated ? ` · se listan las ${entradas.length} primeras` : ''}
      </p>
      {entradas.length === 0 ? (
        medicion === 'miro-y-no-hay' ? (
          <MiroYNoHay>El índice llegó vacío: miró y este alias no tiene memoria escrita.</MiroYNoHay>
        ) : (
          <p className="muted">El barrido fue parcial y no publicó entradas de muestra.</p>
        )
      ) : (
        <ul className="directiva-memoria-lista">
          {entradas.map((entrada, indice) => (
            <li key={entrada.path ?? indice}>
              <code>{entrada.path ?? 'ruta sin informar'}</code>
              <span className="directiva-fichero-meta">
                {typeof entrada.bytes === 'number' ? `${entrada.bytes} bytes` : 'tamaño sin informar'}
                {' · '}<Time value={entrada.modified_at} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
