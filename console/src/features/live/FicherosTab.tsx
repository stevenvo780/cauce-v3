import { AlertTriangle, FileText, Lock, Save } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { ApiError } from '../../api/client';
import { useApi } from '../../api/context';
import type { AgentDocumentContent, AgentDocumentItem, AgentDocumentKind } from '../../api/types';
import { useResource } from '../../api/use-resource';
import { EmptyState } from '../../components/ui';
import type { PermissionState } from '../../lib';
import {
  avisoAntesDeGuardar, avisoDeFuente, esAckAplicado, explicarFallo, hayCambios, mensajeDeGuardado,
  modoDeDocumento, preserveSourceLineEndings,
} from './ficheros';
import { DOCUMENT_REASON_MAX, explicarFalloDeMotivo, problemaDeMotivo } from './ficheros-motivo';

/** Editor and viewer for the configuration files that govern an agent. */

export interface BorradorDeFichero {
  texto: string;
  /** SHA of the read it was born from: it is what still travels on save, so CAS keeps working. */
  shaBase: string | null;
}

interface FicherosTabProps {
  tenantId: string;
  alias: string;
  mode: 'inventory' | 'manual-editor';
  /** Outside the component and indexed by kind: tab, file and fold all unmount the editor. */
  borradores?: Partial<Record<AgentDocumentKind, BorradorDeFichero>>;
  onBorrador: (kind: AgentDocumentKind, borrador: BorradorDeFichero | undefined) => void;
  onApplied?: (message: string) => void;
  onOpenContext?: () => void;
  mutationBlocked?: boolean;
  configWritePermission?: PermissionState;
}

export function FicherosTab({
  tenantId, alias, mode, borradores, onBorrador, onApplied, onOpenContext,
  mutationBlocked = false, configWritePermission,
}: FicherosTabProps) {
  const api = useApi();
  const mapa = useResource(
    `ficheros-${tenantId}-${alias}`, () => api.getAgentDocuments(tenantId, alias),
  );
  const [abierto, setAbierto] = useState<AgentDocumentKind | undefined>(undefined);

  const aviso = mapa.data ? avisoDeFuente(mapa.data) : undefined;
  const items = (mapa.data?.items ?? []).filter(
    (item) => mode === 'inventory' || item.kind === 'directive',
  );
  const estadoPermiso = mode === 'manual-editor' ? (configWritePermission ?? 'unknown') : 'denied';
  const canWrite = estadoPermiso === 'allowed';
  const canEdit = mode === 'manual-editor' && canWrite;

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
      {mode === 'inventory' ? (
        <p className="ficheros-nota" role="note">
          <span>
            Este tab es inventario y visor de sólo lectura. El manual se modifica únicamente en
            {' '}<button type="button" className="button small secondary" onClick={onOpenContext}>Contexto</button>.
          </span>
        </p>
      ) : null}

      {aviso ? (
        <p className="ficheros-caveat" role="status">
          <AlertTriangle size={14} aria-hidden="true" /> {aviso}
        </p>
      ) : null}

      {items.length === 0 ? (
        <EmptyState>
          <strong>
            {mode === 'manual-editor'
              ? 'No se pudo resolver un manual editable para este alias.'
              : 'No se pudo resolver ningún fichero para este alias.'}
          </strong>{' '}
          Para saber qué ficheros gobiernan a un agente hay que saber qué arnés corre de verdad y
          con qué HOME, y eso sólo se puede medir dentro de su contenedor.
        </EmptyState>
      ) : (
        <ul className="ficheros-lista">
          {items.map((item) => (
            <FilaDeFichero
              key={`${item.kind}-${item.path}`}
              item={item}
              tenantId={tenantId}
              alias={alias}
              canEdit={canEdit}
              mutationBlocked={mutationBlocked}
              abierto={abierto === item.kind}
              borrador={mode === 'manual-editor' ? borradores?.[item.kind] : undefined}
              onBorrador={(nuevo) => { onBorrador(item.kind, nuevo); }}
              onAbrir={() => { setAbierto(abierto === item.kind ? undefined : item.kind); }}
              onApplied={onApplied}
            />
          ))}
        </ul>
      )}

      {mode === 'manual-editor' && !canWrite ? (
        <p className="ficheros-caveat" role="status">
          <Lock size={14} aria-hidden="true" />
          {estadoPermiso === 'unknown'
            ? 'No se pudo acreditar config.write; todo guardado queda bloqueado.'
            : 'Tu sesión puede inspeccionar, pero no escribir configuración.'}
        </p>
      ) : null}

      {mode === 'manual-editor' && mutationBlocked ? (
        <p className="ficheros-caveat" role="status">
          <Lock size={14} aria-hidden="true" />
          Aplicación de campos canónicos en curso. El manual queda bloqueado hasta recibir su ACK.
        </p>
      ) : null}

      {mode === 'inventory' ? <HuecoDeclarado /> : null}
    </div>
  );
}

function FilaDeFichero(
  {
    item, tenantId, alias, canEdit, mutationBlocked, abierto, borrador, onBorrador, onAbrir,
    onApplied,
  }:
  {
    item: AgentDocumentItem;
    tenantId: string;
    alias: string;
    canEdit: boolean;
    mutationBlocked: boolean;
    abierto: boolean;
    borrador: BorradorDeFichero | undefined;
    onBorrador: (borrador: BorradorDeFichero | undefined) => void;
    onAbrir: () => void;
    onApplied?: (message: string) => void;
  },
) {
  const modo = modoDeDocumento(item);
  const readable = item.readable === true;
  const reason = item.reason ?? (!readable
    ? 'El gateway no acreditó que este contenido sea servible; no se envió ninguna lectura.'
    : undefined);
  const cabecera = (
    <>
      {canEdit && item.editable && !mutationBlocked
        ? <FileText size={14} aria-hidden="true" />
        : <Lock size={14} aria-hidden="true" />}
      <span className="ficheros-rotulo">{item.label}</span>
      <code className="ficheros-ruta">{item.path}</code>
      <span className={`ficheros-modo ficheros-modo-${readable && canEdit && item.editable && !mutationBlocked ? modo : 'solo-lectura'}`}>
        {!readable
          ? 'no se sirve'
          : canEdit && item.editable && mutationBlocked
            ? 'bloqueado · aplicación en curso'
          : canEdit && item.editable
            ? 'editable'
            : 'visor · sólo lectura'}
      </span>
      {borrador === undefined ? null : (
        <span className="ficheros-borrador">borrador sin guardar</span>
      )}
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
        ? canEdit && item.editable
          ? (
            <Editor
              item={item} tenantId={tenantId} alias={alias}
              canWrite={!mutationBlocked} mutationBlocked={mutationBlocked}
              borrador={borrador} onBorrador={onBorrador} onApplied={onApplied}
            />
            )
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

function Editor({
  item, tenantId, alias, canWrite, mutationBlocked, borrador, onBorrador, onApplied,
}: {
  item: AgentDocumentItem; tenantId: string; alias: string; canWrite: boolean;
  mutationBlocked: boolean;
  borrador: BorradorDeFichero | undefined;
  onBorrador: (borrador: BorradorDeFichero | undefined) => void;
  onApplied?: (message: string) => void;
}) {
  const api = useApi();
  const [cargando, setCargando] = useState(true);
  const [servido, setServido] = useState<AgentDocumentContent | undefined>(undefined);
  const [fallo, setFallo] = useState<{ titulo: string; detalle: string } | undefined>(undefined);
  const [guardando, setGuardando] = useState(false);
  const [guardado, setGuardado] = useState<string | undefined>(undefined);
  const [motivo, setMotivo] = useState('');
  const idMotivo = useId();
  const problemaMotivo = problemaDeMotivo(motivo);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(undefined);
    setGuardado(undefined);
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

  const texto = borrador?.texto ?? servido?.content ?? '';

  const guardar = useCallback(async () => {
    if (!servido) return;
    if (mutationBlocked) {
      setFallo({
        titulo: 'Aplicación canónica en curso',
        detalle: 'Esperá el ACK del perfil antes de cambiar el manual.',
      });
      return;
    }
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
    if (problemaMotivo !== undefined) {
      setFallo({
        titulo: 'Falta el motivo de este guardado',
        detalle: `${problemaMotivo} La fila de auditoría se escribe con lo que escribas acá; `
          + 'no se manda nada sin ese texto.',
      });
      return;
    }
    setGuardando(true);
    setFallo(undefined);
    try {
      // The fingerprint of the read this text was born from travels: a file changed meanwhile
      // answers 409 instead of letting the last to click win.
      const resultado = await api.putAgentDocumentContent(
        tenantId, alias, item.kind, texto, borrador ? borrador.shaBase : servido.sha, motivo.trim(),
      );
      if (!esAckAplicado(resultado) || resultado.path !== servido.path
        || resultado.bytes !== new TextEncoder().encode(texto).byteLength) {
        setFallo({
          titulo: 'El servidor no confirmó la escritura',
          detalle: mensajeDeGuardado(resultado),
        });
        return;
      }
      // `written_pending_session` IS a save: refresh the served fingerprint or the retry 409s.
      setServido({
        ...servido, content: texto, sha: resultado.sha, bytes: resultado.bytes,
        exists: true, truncated: false, editable: true,
      });
      onBorrador(undefined);
      setMotivo('');
      const mensaje = mensajeDeGuardado(resultado);
      setGuardado(mensaje);
      onApplied?.(mensaje);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : undefined;
      const codigo = error instanceof ApiError ? error.code : undefined;
      const mensaje = error instanceof Error ? error.message : undefined;
      const explicado = error instanceof ApiError && status === 409
        && error.code === 'managed_context_conflict'
        ? {
          titulo: 'El bloque canónico se edita en Contexto / campos canónicos',
          detalle: `${error.message}. El manual conserva el borrador; revisá los campos canónicos sin perder este texto.`,
        }
        : status === 409
        ? {
          titulo: 'Alguien lo cambió mientras lo editabas',
          detalle: error instanceof Error ? error.message : 'Vuelve a abrirlo antes de guardar.',
        }
        : explicarFalloDeMotivo(status, codigo, mensaje) ?? explicarFallo(status, mensaje);
      setFallo(explicado);
    } finally {
      setGuardando(false);
    }
  }, [
    api, tenantId, alias, item.kind, texto, borrador, servido, canWrite, mutationBlocked,
    motivo, problemaMotivo, onBorrador, onApplied,
  ]);

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
  const sucio = hayCambios(servido.content, texto);

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
        value={texto}
        spellCheck={false}
        rows={18}
        readOnly={!canWrite || !servido.editable || servido.truncated}
        aria-readonly={!canWrite || !servido.editable || servido.truncated}
        onChange={(event) => {
          if (!canWrite || mutationBlocked) return;
          const escrito = preserveSourceLineEndings(servido.content, event.target.value);
          onBorrador(escrito === servido.content
            ? undefined
            : { texto: escrito, shaBase: borrador ? borrador.shaBase : servido.sha });
          setGuardado(undefined);
        }}
      />

      <label htmlFor={idMotivo}>
        Motivo del guardado (lo escribe una persona y queda en la auditoría)
        <input
          id={idMotivo}
          type="text"
          value={motivo}
          maxLength={DOCUMENT_REASON_MAX}
          autoComplete="off"
          spellCheck={false}
          placeholder="Escribí por qué cambiás este fichero…"
          aria-describedby={`${idMotivo}-pista`}
          disabled={guardando || !canWrite || !servido.editable || servido.truncated}
          onChange={(event) => { setMotivo(event.target.value); setGuardado(undefined); }}
        />
      </label>
      <p className="ficheros-razon" id={`${idMotivo}-pista`}>
        {problemaMotivo
          ?? `Motivo válido · ${String(motivo.trim().length)}/${String(DOCUMENT_REASON_MAX)}`}
      </p>

      <div className="ficheros-pie">
        <span className="muted">
          {servido.bytes} bytes · {servido.projected ? 'proyección de campos' : 'fichero completo'}
        </span>
        {fallo ? <span className="ficheros-fallo-linea">{fallo.titulo}: {fallo.detalle}</span> : null}
        {guardado ? <span className="ficheros-ok">{guardado}</span> : null}
        <button
          type="button"
          className="button small secondary"
          disabled={guardando || mutationBlocked}
          onClick={() => {
            if (mutationBlocked) return;
            onBorrador(undefined);
            void cargar();
          }}
        >
          Descartar y releer
        </button>
        <button
          type="button"
          className="button small"
          onClick={() => void guardar()}
          disabled={!canWrite || !sucio || guardando || !servido.editable
            || servido.truncated || problemaMotivo !== undefined}
        >
          <Save size={14} aria-hidden="true" /> {guardando ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </div>
  );
}

/**
 * The gap, stated in plain language and right in this view. Without this paragraph a locked `mcp`
 * reads as "the console does not reach there yet" when it is a measured decision, and what is
 * truly missing —the channel to the disk— is visible nowhere at all.
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
