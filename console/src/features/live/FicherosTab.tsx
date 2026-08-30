import { AlertTriangle, FileText, Lock, Save } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { useApi } from '../../api/context';
import type { AgentDocumentContent, AgentDocumentItem, AgentDocumentKind } from '../../api/types';
import { useResource } from '../../api/use-resource';
import { EmptyState } from '../../components/ui';
import { permissionState } from '../../lib';
import {
  avisoAntesDeGuardar, avisoDeFuente, esAckAplicado, explicarFallo, hayCambios, mensajeDeGuardado,
  modoDeDocumento,
} from './ficheros';

/**
 * Editor and viewer for the configuration files that govern an agent.
 */

interface FicherosTabProps {
  tenantId: string;
  alias: string;
}

export function FicherosTab({ tenantId, alias }: FicherosTabProps) {
  const api = useApi();
  const mapa = useResource(
    `ficheros-${tenantId}-${alias}`, () => api.getAgentDocuments(tenantId, alias),
  );
  const access = useResource('console-access', () => api.getConsoleAccess());
  const [abierto, setAbierto] = useState<AgentDocumentKind | undefined>(undefined);

  const aviso = mapa.data ? avisoDeFuente(mapa.data) : undefined;
  const items = mapa.data?.items ?? [];
  const estadoPermiso = permissionState(access.data, 'config.write');
  const canWrite = estadoPermiso === 'allowed';

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
              canWrite={canWrite}
              abierto={abierto === item.kind}
              onAbrir={() => { setAbierto(abierto === item.kind ? undefined : item.kind); }}
            />
          ))}
        </ul>
      )}

      {!canWrite ? (
        <p className="ficheros-caveat" role="status">
          <Lock size={14} aria-hidden="true" />
          {estadoPermiso === 'unknown'
            ? 'No se pudo acreditar config.write; todo guardado queda bloqueado.'
            : 'Tu sesión puede inspeccionar, pero no escribir configuración.'}
        </p>
      ) : null}

      <HuecoDeclarado />
    </div>
  );
}

function FilaDeFichero(
  { item, tenantId, alias, canWrite, abierto, onAbrir }:
  {
    item: AgentDocumentItem;
    tenantId: string;
    alias: string;
    canWrite: boolean;
    abierto: boolean;
    onAbrir: () => void;
  },
) {
  const modo = modoDeDocumento(item);
  const readable = item.readable === true;
  const reason = item.reason ?? (!readable
    ? 'El gateway no acreditó que este contenido sea servible; no se envió ninguna lectura.'
    : undefined);
  const cabecera = (
    <>
      {item.editable ? <FileText size={14} aria-hidden="true" /> : <Lock size={14} aria-hidden="true" />}
      <span className="ficheros-rotulo">{item.label}</span>
      <code className="ficheros-ruta">{item.path}</code>
      <span className={`ficheros-modo ficheros-modo-${readable ? modo : 'solo-lectura'}`}>
        {!readable
          ? 'no se sirve'
          : item.editable
            ? 'editable'
            : 'visor · sólo lectura'}
      </span>
    </>
  );
  return (
    <li className="ficheros-fila">
      {readable ? (
        <button
          type="button"
          className="ficheros-cabecera"
          onClick={onAbrir}
          aria-expanded={abierto}
        >
          {cabecera}
        </button>
      ) : <div className="ficheros-cabecera">{cabecera}</div>}

      {/* The reason is shown WHENEVER it exists, whether or not the row is open. A lock without an
          explanation is exactly what makes someone ask over Telegram to have something unlocked
          that is locked on purpose. */}
      {reason ? <p className="ficheros-razon">{reason}</p> : null}

      {abierto && readable
        ? item.editable
          ? <Editor item={item} tenantId={tenantId} alias={alias} canWrite={canWrite} />
          : <Visor item={item} tenantId={tenantId} alias={alias} />
        : null}
    </li>
  );
}

/** An explicit GET with no mutation surface. Never renders Save and never calls PUT. */
function Visor({ item, tenantId, alias }: {
  item: AgentDocumentItem; tenantId: string; alias: string;
}) {
  const api = useApi();
  const [cargando, setCargando] = useState(true);
  const [servido, setServido] = useState<AgentDocumentContent | undefined>(undefined);
  const [fallo, setFallo] = useState<{ titulo: string; detalle: string } | undefined>(undefined);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(undefined);
    try {
      setServido(await api.getAgentDocumentContent(tenantId, alias, item.kind));
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

  if (cargando) return <p className="muted">Leyendo el fichero dentro del contenedor…</p>;
  if (fallo) {
    return (
      <div className="ficheros-fallo" role="status">
        <strong>{fallo.titulo}</strong>
        <p>{fallo.detalle}</p>
      </div>
    );
  }
  if (!servido) return null;
  if (!servido.exists) {
    return (
      <div className="ficheros-editor">
        <p className="ficheros-nota">
          La sonda comprobó que este fichero todavía no existe. No se muestra como texto vacío y
          este visor no lo puede crear.
        </p>
        <button type="button" className="button small secondary" onClick={() => void cargar()}>
          Volver a comprobar
        </button>
      </div>
    );
  }

  return (
    <div className="ficheros-editor">
      {servido.truncated ? (
        <p className="ficheros-aviso" role="alert">
          <AlertTriangle size={14} aria-hidden="true" /> Esta lectura está recortada. El visor
          muestra sólo el prefijo recibido y no permite modificarlo.
        </p>
      ) : null}
      <textarea
        className="ficheros-texto"
        aria-label={`Contenido de ${item.label}`}
        value={servido.content}
        spellCheck={false}
        rows={18}
        readOnly
        aria-readonly="true"
      />
      <div className="ficheros-pie">
        <span className="muted">
          {servido.bytes} bytes · visor de sólo lectura{servido.truncated ? ' · prefijo recortado' : ''}
        </span>
        <button type="button" className="button small secondary" onClick={() => void cargar()}>
          Releer
        </button>
      </div>
    </div>
  );
}

function Editor({ item, tenantId, alias, canWrite }: {
  item: AgentDocumentItem; tenantId: string; alias: string; canWrite: boolean;
}) {
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
    if (!canWrite) {
      setFallo({
        titulo: 'Permiso de escritura no acreditado',
        detalle: 'No se envió ninguna mutación porque config.write no está permitido.',
      });
      return;
    }
    if (!servido.editable || servido.truncated) {
      setFallo({
        titulo: 'Este contenido no se puede reemplazar',
        detalle: servido.truncated
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
      // The fingerprint of the opened file always travels with the save. It is what keeps two people
      // who have this screen open from silently clobbering each other: if the file changed, the
      // server answers 409 and does not write, instead of letting the last to click win.
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
  }, [api, tenantId, alias, item.kind, borrador, servido, canWrite]);

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

      {servido.truncated ? (
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
        readOnly={!canWrite || !servido.editable || servido.truncated}
        aria-readonly={!canWrite || !servido.editable || servido.truncated}
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
          disabled={!canWrite || !sucio || guardando || !servido.editable
            || servido.truncated}
        >
          <Save size={14} aria-hidden="true" /> {guardando ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </div>
  );
}

/**
 * The gap, stated in plain language and right in this view.
 *
 * It lives here because the alternative is worse: without this paragraph, an `mcp` that shows up
 * with a lock reads as "the console does not reach there yet" when in fact it is a measured and
 * firm decision. And what is truly missing —the channel to the disk— is not visible anywhere,
 * so the editor would look broken instead of incomplete.
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
