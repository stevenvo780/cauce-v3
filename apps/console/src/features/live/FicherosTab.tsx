import { AlertTriangle, FileText, Lock, Save } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { useApi } from '../../api/context';
import type { AgentDocumentContent, AgentDocumentItem, AgentDocumentKind } from '../../api/types';
import { useResource } from '../../api/use-resource';
import { EmptyState } from '../../components/ui';
import {
  avisoAntesDeGuardar, avisoDeFuente, esAckAplicado, explicarFallo, hayCambios, mensajeDeGuardado,
  modoDeDocumento,
} from './ficheros';

/**
 * EL EDITOR DE LOS FICHEROS QUE GOBIERNAN A UN AGENTE.
 *
 * Steven lo pidió con estas palabras: «sigo sin ver en la config dónde editar el Claude.md o
 * agent.md para los agentes claude code y codex, y también el archivo para OpenClaw». Hasta hoy
 * lo único editable era la DIRECTIVA —el `role_brief`, que viaja en el sobre de cada mensaje— y
 * eso, como él mismo dijo, «es sólo una parte»: gobierna lo que el agente sabe de sí mismo, no
 * sus herramientas ni su manual.
 *
 * Vive en el MISMO cajón que la pestaña «Directiva», al lado, y no en una vista aparte. Esa es la
 * mitad del arreglo: el `role_brief` y el `CLAUDE.md` son dos capas de la misma cosa y tenerlas en
 * dos sitios distintos de la consola es lo que hizo que durante meses nadie notara que la
 * autonomía estaba escrita por duplicado en los 14 alias.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTA PANTALLA NO HACE, DICHO AQUÍ Y DICHO TAMBIÉN EN PANTALLA
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Hoy el gateway NO tiene ningún camino hasta el disco de un agente: no monta el socket de
 * docker, el relay de terminal llama al gateway y nunca al revés, y dos alias corren en otra
 * máquina. Mientras esa pieza no exista, pedir un fichero devuelve 503 y esta vista lo dice con
 * esas palabras.
 *
 * Eso es deliberado y es la parte que más importa. Lo fácil —y lo que haría esto inútil— sería
 * pintar un editor vacío y un botón de guardar: Steven vería una caja en blanco donde debería
 * estar su `CLAUDE.md`, la tomaría por «este agente no tiene manual» y al guardar escribiría un
 * fichero vacío encima. Un hueco explicado vale más que un botón que no hace nada.
 */

export interface FicherosTabProps {
  tenantId: string;
  alias: string;
}

export function FicherosTab({ tenantId, alias }: FicherosTabProps) {
  const api = useApi();
  const mapa = useResource(
    `ficheros-${tenantId}-${alias}`, () => api.getAgentDocuments(tenantId, alias),
  );
  const [abierto, setAbierto] = useState<AgentDocumentKind | undefined>(undefined);

  const aviso = mapa.data ? avisoDeFuente(mapa.data) : undefined;
  const items = mapa.data?.items ?? [];

  if (mapa.loading) return <p className="muted">Leyendo el mapa de ficheros…</p>;

  if (mapa.error) {
    const status = mapa.error instanceof ApiError ? mapa.error.status : undefined;
    if (status === 404) {
      return (
        <EmptyState>
          <strong>Ese alias no existe en ese tenant o no es visible para tu sesión.</strong>{' '}
          {mapa.error.message}
        </EmptyState>
      );
    }
    const fallo = explicarFallo(status, mapa.error.message);
    return <EmptyState><strong>{fallo.titulo}</strong>. {fallo.detalle}</EmptyState>;
  }

  if (mapa.data && !mapa.data.publicado) {
    return (
      <EmptyState>
        <strong>Este gateway todavía no publica el mapa de ficheros.</strong>{' '}
        {mapa.data.motivo ?? ''} No significa que estos agentes no tengan CLAUDE.md: significa que
        desde aquí no se ha mirado.
      </EmptyState>
    );
  }

  return (
    <div className="ficheros">
      {aviso ? (
        <p className="ficheros-caveat" role="status">
          <AlertTriangle size={14} aria-hidden="true" /> {aviso}
        </p>
      ) : null}

      {items.length === 0 ? (
        <EmptyState>
          <strong>No se pudo resolver ningún fichero para este alias.</strong> Para saber qué
          ficheros gobiernan a un agente hay que saber qué arnés corre de verdad y con qué HOME, y
          eso sólo se puede medir dentro de su contenedor.
        </EmptyState>
      ) : (
        <ul className="ficheros-lista">
          {items.map((item) => (
            <FilaDeFichero
              key={`${item.kind}-${item.path}`}
              item={item}
              tenantId={tenantId}
              alias={alias}
              abierto={abierto === item.kind}
              onAbrir={() => setAbierto(abierto === item.kind ? undefined : item.kind)}
            />
          ))}
        </ul>
      )}

      <HuecoDeclarado />
    </div>
  );
}

function FilaDeFichero(
  { item, tenantId, alias, abierto, onAbrir }:
  {
    item: AgentDocumentItem;
    tenantId: string;
    alias: string;
    abierto: boolean;
    onAbrir: () => void;
  },
) {
  const modo = modoDeDocumento(item);
  return (
    <li className="ficheros-fila">
      <button type="button" className="ficheros-cabecera" onClick={onAbrir} aria-expanded={abierto}>
        {modo === 'solo-lectura' ? <Lock size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}
        <span className="ficheros-rotulo">{item.label}</span>
        <code className="ficheros-ruta">{item.path}</code>
        <span className={`ficheros-modo ficheros-modo-${modo}`}>
          {modo === 'entero' ? 'editable' : modo === 'proyectado' ? 'editable por campos' : 'sólo lectura'}
        </span>
      </button>

      {/* La razón se enseña SIEMPRE que exista, esté la fila abierta o no. Un candado sin
          explicación es justo lo que hace que alguien pida por Telegram que le desbloqueen algo
          que está bloqueado a propósito. */}
      {item.reason ? <p className="ficheros-razon">{item.reason}</p> : null}

      {abierto && modo !== 'solo-lectura'
        ? <Editor item={item} tenantId={tenantId} alias={alias} />
        : null}
    </li>
  );
}

function Editor(
  { item, tenantId, alias }: { item: AgentDocumentItem; tenantId: string; alias: string },
) {
  const api = useApi();
  const [cargando, setCargando] = useState(true);
  const [servido, setServido] = useState<AgentDocumentContent | undefined>(undefined);
  const [borrador, setBorrador] = useState('');
  const [fallo, setFallo] = useState<{ titulo: string; detalle: string } | undefined>(undefined);
  const [guardando, setGuardando] = useState(false);
  const [guardado, setGuardado] = useState<string | undefined>(undefined);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(undefined);
    setGuardado(undefined);
    try {
      const cuerpo = await api.getAgentDocumentContent(tenantId, alias, item.kind);
      setServido(cuerpo);
      setBorrador(cuerpo.content);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : undefined;
      const explicado = explicarFallo(status, error instanceof Error ? error.message : undefined);
      setFallo({ titulo: explicado.titulo, detalle: explicado.detalle });
      setServido(undefined);
    } finally {
      setCargando(false);
    }
  }, [api, tenantId, alias, item.kind]);

  useEffect(() => { void cargar(); }, [cargar]);

  const guardar = useCallback(async () => {
    if (!servido) return;
    if (!servido.editable || servido.truncated !== false) {
      setFallo({
        titulo: 'Este contenido no se puede reemplazar',
        detalle: servido.truncated !== false
          ? 'Lo servido es sólo un prefijo recortado. Reemplazarlo borraría el resto del fichero.'
          : 'El servidor marcó este documento como sólo lectura.',
      });
      return;
    }
    if (servido.exists && servido.sha === null) {
      setFallo({
        titulo: 'Falta la huella del fichero abierto',
        detalle: 'No envié el guardado: sin SHA no hay forma de detectar otra edición concurrente.',
      });
      return;
    }
    setGuardando(true);
    setFallo(undefined);
    try {
      // La huella de lo que se abrió viaja SIEMPRE. Es lo que hace que dos personas con esta
      // pantalla abierta no se pisen en silencio: si el fichero cambió, el servidor contesta 409
      // y no escribe, en vez de dejar que gane el último en pulsar.
      const resultado = await api.putAgentDocumentContent(
        tenantId, alias, item.kind, borrador, servido.sha,
      );
      if (!esAckAplicado(resultado) || resultado.path !== servido.path
        || resultado.bytes !== new TextEncoder().encode(borrador).byteLength) {
        setFallo({
          titulo: 'El servidor no confirmó la aplicación',
          detalle: mensajeDeGuardado(resultado),
        });
        return;
      }
      setServido({
        ...servido, content: borrador, sha: resultado.sha, bytes: resultado.bytes,
        exists: true, truncated: false, editable: true,
      });
      setGuardado(mensajeDeGuardado(resultado));
    } catch (error) {
      const status = error instanceof ApiError ? error.status : undefined;
      const explicado = status === 409
        ? {
          titulo: 'Alguien lo cambió mientras lo editabas',
          detalle: error instanceof Error ? error.message : 'Vuelve a abrirlo antes de guardar.',
        }
        : explicarFallo(status, error instanceof Error ? error.message : undefined);
      setFallo(explicado);
    } finally {
      setGuardando(false);
    }
  }, [api, tenantId, alias, item.kind, borrador, servido]);

  if (cargando) return <p className="muted">Leyendo el fichero dentro del contenedor…</p>;

  if (fallo && !servido) {
    return (
      <div className="ficheros-fallo" role="status">
        <strong>{fallo.titulo}</strong>
        <p>{fallo.detalle}</p>
      </div>
    );
  }

  if (!servido) return null;

  const avisoGuardar = avisoAntesDeGuardar(item);
  const sucio = hayCambios(servido.content, borrador);

  return (
    <div className="ficheros-editor">
      {!servido.exists ? (
        <p className="ficheros-nota">
          Este fichero todavía no existe. Si guardas, se crea. Está vacío porque no está, no
          porque se haya perdido.
        </p>
      ) : null}

      {avisoGuardar ? (
        <p className="ficheros-aviso" role="status">
          <AlertTriangle size={14} aria-hidden="true" /> {avisoGuardar}
        </p>
      ) : null}

      {servido.truncated !== false ? (
        <p className="ficheros-aviso" role="alert">
          <AlertTriangle size={14} aria-hidden="true" /> Esta lectura está recortada. Se muestra para
          diagnóstico, pero no se puede editar ni reemplazar: guardar este prefijo borraría el resto.
        </p>
      ) : null}

      <textarea
        className="ficheros-texto"
        aria-label={`Contenido de ${item.label}`}
        value={borrador}
        spellCheck={false}
        rows={18}
        readOnly={!servido.editable || servido.truncated !== false}
        aria-readonly={!servido.editable || servido.truncated !== false}
        onChange={(event) => {
          setBorrador(event.target.value);
          setGuardado(undefined);
        }}
      />

      <div className="ficheros-pie">
        <span className="muted">
          {servido.bytes} bytes · {servido.projected ? 'proyección de campos' : 'fichero completo'}
        </span>
        {fallo ? <span className="ficheros-fallo-linea">{fallo.titulo}: {fallo.detalle}</span> : null}
        {guardado ? <span className="ficheros-ok">{guardado}</span> : null}
        <button type="button" className="button small secondary" onClick={() => void cargar()} disabled={guardando}>
          Descartar y releer
        </button>
        <button
          type="button"
          className="button small"
          onClick={() => void guardar()}
          disabled={!sucio || guardando || !servido.editable || servido.truncated !== false}
        >
          <Save size={14} aria-hidden="true" /> {guardando ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </div>
  );
}

/**
 * El hueco, dicho en castellano llano y en la propia vista.
 *
 * Está aquí porque la alternativa es peor: sin este párrafo, un `mcp` que sale con candado se lee
 * como «la consola aún no llega ahí» cuando en realidad es una decisión medida y firme. Y lo que
 * de verdad falta —el canal hasta el disco— no se ve por ningún lado, así que parecería que el
 * editor está roto en vez de incompleto.
 */
function HuecoDeclarado() {
  return (
    <section className="ficheros-hueco" aria-label="Lo que esta vista todavía no hace">
      <h4>Lo que esto todavía no hace</h4>
      <ul>
        <li>
          <strong>Los MCP y las skills no se editan desde aquí.</strong> En claude viven en
          `~/.claude.json`, junto al OAuth de la cuenta; en openclaw, dentro del mismo fichero que
          `auth` y `secrets`, y ahí hay claves de API de verdad. Servir esos ficheros sería una
          fuga, no una funcionalidad. Se editan a mano dentro del contenedor.
        </li>
        <li>
          <strong>Los subagentes y los prompts guardados se listan, no se editan.</strong> Son
          directorios con un fichero por pieza, y esta vista edita ficheros sueltos.
        </li>
        <li>
          <strong>Esto no ve lo que se edite por la terminal.</strong> El diario de cambios cubre
          lo que pasa por esta pantalla; un `docker exec` y un editor a mano no dejan rastro aquí.
        </li>
      </ul>
    </section>
  );
}
