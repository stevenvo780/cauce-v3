import { History, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useApi } from '../../api/context';
import type { AgentDocumentKind, AgentDocumentsMap, AgentPerfilCampos } from '../../api/types';
import { useResource, type Resource } from '../../api/use-resource';
import { EmptyState, Time, ViewTabs } from '../../components/ui';
import {
  AVISO_DE_PROFUNDIDAD, CLASES_DE_OPERACION, PALABRAS_DE_OPERACION, PASO_DE_PAGINA, SIN_CUERPO,
  TOPE_DE_PAGINA, actorDeRevision, camposCambiados, camposDeRevision, clavePedido,
  compararDocumentos, compararRevisiones, fechaDeDocumento, fechaDePerfil, fusionar, huellaCorta,
  pasoDelDiario, siguientePedido,
  type CambioDeDocumento, type PasoDelDiario,
} from './historial-de-contexto';
import type { PerfilRevision, TramoDeRevisiones } from './perfil';

/**
 * The read side of the context journal: what each version of the profile said, which governance
 * file was rewritten for it, and the way back to a past version.
 *
 * This panel does not write. A restore only loads the SEVEN authored fields of a revision into
 * the canonical draft; from there the only save available is the profile PUT with its CAS, its
 * governed batch, its hand-typed reason and the runtime ACK.
 */

type Diario = 'perfil' | AgentDocumentKind;

interface HistorialDeContextoProps {
  tenantId: string;
  alias: string;
  /** Absent without `config.write`: the journal is still read; only the restore disappears. */
  onRestaurar?: (campos: AgentPerfilCampos) => void;
}

interface RevisionEntry {
  readonly id: string;
}

function usePaginatedJournal<T extends RevisionEntry, P extends { readonly entries: readonly T[] }>(
  key: string,
  loader: (request: TramoDeRevisiones) => Promise<P>,
  timestamp: (entry: T) => string,
) {
  const [request, setRequest] = useState<TramoDeRevisiones>({ limit: PASO_DE_PAGINA });
  const [read, setRead] = useState<readonly T[]>([]);
  const page = useResource(`${key}-${clavePedido(request)}`, () => loader(request));
  const entries = fusionar(read, page.data?.entries ?? [], timestamp);
  const loadMore = () => {
    setRead(entries);
    setRequest(siguientePedido(request, page.data));
  };
  return { entries, loadMore, page, request };
}

export function HistorialDeContexto({ tenantId, alias, onRestaurar }: HistorialDeContextoProps) {
  const api = useApi();
  const [elegido, setElegido] = useState<Diario>('perfil');
  const documentos = useResource(
    `historial-documentos-${tenantId}-${alias}`,
    () => api.getAgentDocuments(tenantId, alias),
  );

  const ficheros = documentos.data?.publicado === true ? documentos.data.items ?? [] : [];
  const pestanas = [
    { id: 'perfil' as Diario, label: 'Campos canónicos' },
    ...ficheros.map((fichero) => ({ id: fichero.kind, label: fichero.label })),
  ];
  const diario = pestanas.some((pestana) => pestana.id === elegido) ? elegido : 'perfil';

  return (
    <div className="historial-contexto">
      <p className="historial-nota-actor">{AVISO_DE_PROFUNDIDAD}</p>
      {/* Said ONCE and not on every row: repeating «no consta quién» fourteen times turns an
          important datum into noise that stops being read. */}
      <p className="historial-nota-actor">
        El diario dice qué cambió y cuándo. Las revisiones antiguas pueden no decir quién: si las
        columnas de autor llegan vacías se muestra <strong>«no consta quién»</strong>, sin
        atribuir el cambio al operador que está mirando.
      </p>

      <ViewTabs
        tabs={pestanas}
        active={diario}
        onSelect={setElegido}
        label="Diarios del contexto"
        variant="chip"
        panelId="historial-contexto-panel"
      />

      <div
        className="historial-contexto-panel"
        id="historial-contexto-panel"
        role="tabpanel"
        aria-labelledby={`view-tab-${diario}`}
      >
        {diario === 'perfil' ? (
          <DiarioDePerfil tenantId={tenantId} alias={alias} onRestaurar={onRestaurar} />
        ) : (
          <DiarioDeFichero key={diario} tenantId={tenantId} alias={alias} kind={diario} />
        )}
      </div>

      <AvisoDeInventario recurso={documentos} alias={alias} ficheros={ficheros.length} />

      {onRestaurar === undefined ? (
        <p className="muted">
          Tu sesión puede leer el diario, pero no puede cargar una revisión en los campos
          canónicos.
        </p>
      ) : null}
    </div>
  );
}

function DiarioDePerfil({ tenantId, alias, onRestaurar }: HistorialDeContextoProps) {
  const api = useApi();
  const [abierta, setAbierta] = useState<string>();
  const {
    entries: entradas, loadMore, page: pagina, request: pedido,
  } = usePaginatedJournal(
    `historial-perfil-${tenantId}-${alias}`,
    (request) => api.getProfileRevisions(tenantId, alias, request),
    fechaDePerfil,
  );

  if (entradas.length === 0) {
    if (pagina.error) return <FalloDeLectura diario="del perfil" alias={alias} error={pagina.error} />;
    if (pagina.loading) return <p className="muted">Leyendo el diario del perfil…</p>;
    return (
      <EmptyState>
        El servidor miró y no hay ninguna revisión anotada para {alias}.
      </EmptyState>
    );
  }

  return (
    <div className="historial-diario">
      <ol className="historial-lista">
        {entradas.map((entrada, indice) => {
          const anterior = entradas.at(indice + 1);
          const actor = actorDeRevision(entrada);
          const vacia = entrada.operation === 'delete';
          return (
            <li
              key={entrada.id}
              className="historial-entrada"
              data-clase={CLASES_DE_OPERACION[entrada.operation]}
            >
              <div className="historial-entrada-head">
                <span className="historial-entrada-icono" aria-hidden="true"><History size={14} /></span>
                <div>
                  <strong>
                    {PALABRAS_DE_OPERACION[entrada.operation]} · revisión {entrada.revision}
                  </strong>
                  <p className="historial-entrada-cuando">
                    <Time value={entrada.changed_at} />
                    {actor === undefined ? <> · no consta quién</> : <> · por <code>{actor}</code></>}
                  </p>
                </div>
              </div>

              <div className="historial-entrada-acciones">
                {anterior === undefined ? null : (
                  <button
                    type="button"
                    className="button small secondary"
                    onClick={() => { setAbierta(abierta === entrada.id ? undefined : entrada.id); }}
                  >
                    {abierta === entrada.id ? 'Ocultar qué cambió' : 'Ver qué cambió'}
                  </button>
                )}
                {onRestaurar === undefined ? null : (
                  <button
                    type="button"
                    className="button small secondary"
                    onClick={() => { onRestaurar(camposDeRevision(entrada)); }}
                  >
                    <RotateCcw size={14} aria-hidden="true" />{' '}
                    {/* The only row whose «restore» destroys instead of going back: it says so in
                        the button, not only in the help line under it. */}
                    {vacia ? 'Restaurar este borrado: vacía los siete campos' : 'Restaurar esta revisión'}
                  </button>
                )}
              </div>

              {anterior === undefined ? (
                <span className="historial-entrada-ayuda">
                  Es la revisión más vieja de las leídas: para compararla hace falta traer la
                  anterior.
                </span>
              ) : null}
              {onRestaurar === undefined ? null : (
                <span className="historial-entrada-ayuda">
                  {vacia
                    ? 'Esta revisión borró el perfil: cargarla deja los siete campos vacíos en el borrador. No guarda nada.'
                    : 'No guarda nada: carga los siete campos canónicos en el borrador de Contexto para revisarlos y aplicarlos con CAS, motivo y ACK.'}
                </span>
              )}

              {abierta === entrada.id && anterior !== undefined ? (
                <DiffDePerfil anterior={anterior} posterior={entrada} />
              ) : null}
            </li>
          );
        })}
      </ol>

      <PieDeDiario
        diario="del perfil"
        alias={alias}
        leidas={entradas.length}
        paso={pagina.data === undefined ? undefined : pasoDelDiario(pagina.data, pedido)}
        cargando={pagina.loading}
        error={pagina.error}
        onMas={loadMore}
        onReintentar={() => { void pagina.reload(); }}
      />
    </div>
  );
}

const SIGNOS: Readonly<Record<string, string>> = { igual: ' ', quitada: '−', agregada: '+' };

function DiffDePerfil({ anterior, posterior }: {
  anterior: PerfilRevision;
  posterior: PerfilRevision;
}) {
  const cambiados = camposCambiados(compararRevisiones(anterior, posterior));
  return (
    <div
      className="historial-diff"
      role="group"
      aria-label={`Diferencias con la revisión ${String(anterior.revision)}`}
    >
      <p className="historial-entrada-ayuda">
        Se comparan los siete campos con la revisión {anterior.revision}; sólo se pintan los que
        cambiaron. El signo − es lo que había y + lo que quedó.
      </p>
      {cambiados.length === 0 ? (
        <p className="historial-entrada-detalle">
          Ningún campo cambió entre estas dos revisiones: el diario anota la escritura igual.
        </p>
      ) : cambiados.map((campo) => (
        <section key={campo.campo} className="historial-diff-campo">
          <p className="historial-diff-titulo">{campo.titulo}</p>
          <ol className="historial-diff-lineas">
            {campo.lineas.map((linea, indice) => (
              <li key={`${String(indice)}-${linea.texto}`} className="historial-diff-linea">
                <span className="historial-diff-signo" aria-hidden="true">{SIGNOS[linea.clase]}</span>
                <span className="historial-diff-texto" data-clase={linea.clase}>{linea.texto}</span>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function DiarioDeFichero({ tenantId, alias, kind }: {
  tenantId: string;
  alias: string;
  kind: AgentDocumentKind;
}) {
  const api = useApi();
  const {
    entries: entradas, loadMore, page: pagina, request: pedido,
  } = usePaginatedJournal(
    `historial-fichero-${tenantId}-${alias}-${kind}`,
    (request) => api.getDocumentRevisions(tenantId, alias, kind, request),
    fechaDeDocumento,
  );

  if (entradas.length === 0) {
    if (pagina.error) return <FalloDeLectura diario="del fichero" alias={alias} error={pagina.error} />;
    if (pagina.loading) return <p className="muted">Leyendo el diario del fichero…</p>;
    return (
      <EmptyState>
        El servidor miró y no hay ninguna escritura anotada de este fichero para {alias}. {SIN_CUERPO}
      </EmptyState>
    );
  }

  return (
    <div className="historial-diario">
      <p className="historial-nota-actor">{SIN_CUERPO}</p>
      <ol className="historial-lista">
        {entradas.map((entrada, indice) => {
          const anterior = entradas.at(indice + 1);
          const actor = actorDeRevision(entrada);
          return (
            <li key={entrada.id} className="historial-entrada" data-clase="reescritura">
              <div className="historial-entrada-head">
                <span className="historial-entrada-icono" aria-hidden="true"><History size={14} /></span>
                <div>
                  <strong>Escritura del fichero</strong>
                  <p className="historial-entrada-cuando">
                    <Time value={entrada.written_at} />
                    {actor === undefined ? <> · no consta quién</> : <> · por <code>{actor}</code></>}
                  </p>
                </div>
              </div>
              <p className="historial-entrada-detalle">
                <code>{entrada.path}</code> · {entrada.bytes.toLocaleString('es')} bytes · huella{' '}
                <code className="historial-huella">{huellaCorta(entrada.sha256)}</code>
              </p>
              {anterior === undefined ? (
                <span className="historial-entrada-ayuda">
                  Es la escritura más vieja de las leídas: para compararla hace falta traer la
                  anterior.
                </span>
              ) : (
                <p className="historial-entrada-detalle">
                  {fraseDeCambio(compararDocumentos(anterior, entrada))}
                </p>
              )}
            </li>
          );
        })}
      </ol>

      <PieDeDiario
        diario="del fichero"
        alias={alias}
        leidas={entradas.length}
        paso={pagina.data === undefined ? undefined : pasoDelDiario(pagina.data, pedido)}
        cargando={pagina.loading}
        error={pagina.error}
        onMas={loadMore}
        onReintentar={() => { void pagina.reload(); }}
      />
    </div>
  );
}

function fraseDeCambio(cambio: CambioDeDocumento): string {
  const tamano = cambio.bytes === 0
    ? 'el tamaño no cambió'
    : cambio.bytes > 0
      ? `el fichero creció ${String(cambio.bytes)} bytes`
      : `el fichero perdió ${String(-cambio.bytes)} bytes`;
  const ruta = cambio.movido ? ' Además cambió de ruta.' : '';
  if (cambio.huella === 'sin-dato') {
    return `Una de las dos escrituras no dejó huella, así que no se afirma si el contenido `
      + `cambió; ${tamano}.${ruta}`;
  }
  const huella = cambio.huella === 'distinta' ? 'La huella cambió' : 'La huella es la misma';
  return `${huella} y ${tamano}.${ruta}`;
}

/** A read failure is NOT «it never changed»: the two look alike on screen and are opposites. */
function FalloDeLectura({ diario, alias, error }: {
  diario: string;
  alias: string;
  error: Error;
}) {
  return (
    <EmptyState>
      No se pudo leer el diario {diario} de {alias}: {error.message}. Eso NO significa que este
      contexto no haya cambiado nunca —significa que la consola no lo pudo mirar—.
    </EmptyState>
  );
}

/**
 * The foot of a journal that already has entries on screen.
 *
 * A failed «Ver más» is painted NEXT TO the list, never in its place: hiding the button and the
 * note on error leaves a screen identical to a journal that ended, which is the opposite fact.
 */
function PieDeDiario({ diario, alias, leidas, paso, cargando, error, onMas, onReintentar }: {
  diario: string;
  alias: string;
  leidas: number;
  /** Undefined while a wider window is still travelling: the previous page is what is on screen. */
  paso?: PasoDelDiario;
  cargando: boolean;
  error?: Error;
  onMas: () => void;
  onReintentar: () => void;
}) {
  if (error !== undefined) {
    return (
      <div className="historial-paginacion">
        <p className="notice error" role="alert">
          No se pudo leer el resto del diario {diario} de {alias}: {error.message}. Siguen a la
          vista las {leidas} entradas ya leídas; que no aparezcan más NO significa que no las haya.
        </p>
        <button
          type="button"
          className="button small secondary"
          disabled={cargando}
          onClick={onReintentar}
        >
          Reintentar
        </button>
      </div>
    );
  }
  if (paso === 'fin') return null;
  if (paso === 'ventana-agotada') {
    return (
      <p className="historial-nota-actor">
        Se ven las {leidas} entradas más nuevas. Este gateway no devuelve más de {TOPE_DE_PAGINA}{' '}
        entradas por lectura y esa ventana ya se pidió entera: si el diario es más largo, lo
        anterior queda sin leer —no es que no exista—.
      </p>
    );
  }
  return (
    <div className="historial-paginacion">
      <p className="historial-nota-actor">
        Se ven las {leidas} entradas más nuevas que se pudieron leer.
      </p>
      <button
        type="button"
        className="button small secondary"
        disabled={cargando}
        onClick={onMas}
      >
        Ver más
      </button>
    </div>
  );
}

/**
 * Three different facts —a read that failed, a gateway without the route, an alias with no
 * governed files— told as three. Melting them into the strongest one asserts a capability of the
 * gateway out of a read that never happened.
 */
function AvisoDeInventario({ recurso, alias, ficheros }: {
  recurso: Resource<AgentDocumentsMap>;
  alias: string;
  ficheros: number;
}) {
  if (recurso.error !== undefined) {
    return (
      <p className="notice error" role="alert">
        No se pudo leer el inventario de ficheros de {alias}: {recurso.error.message}. Eso no dice
        que este gateway no lo publique ni que {alias} no tenga ficheros gobernados: dice que la
        consola no lo pudo mirar, así que sólo se ofrece el diario de los campos canónicos.
      </p>
    );
  }
  if (recurso.data === undefined) {
    return recurso.loading
      ? <p className="muted">Leyendo el inventario de ficheros de {alias}…</p>
      : null;
  }
  if (!recurso.data.publicado) {
    return (
      <p className="historial-nota-actor">
        {recurso.data.motivo ?? `Este gateway no publica el inventario de ficheros de ${alias}.`}
        {' '}Sólo se puede ofrecer el diario de los campos canónicos.
      </p>
    );
  }
  if (ficheros === 0) {
    return (
      <p className="historial-nota-actor">
        El servidor miró y {alias} no tiene ningún fichero gobernado en el inventario, así que el
        único diario que hay es el de los campos canónicos.
      </p>
    );
  }
  return null;
}
