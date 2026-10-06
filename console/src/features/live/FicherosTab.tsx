import { AlertTriangle, FileText, Lock, Save } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, type CauceApi } from '../../api/client';
import { useApi } from '../../api/context';
import type { AgentDocumentContent, AgentDocumentItem, AgentDocumentKind } from '../../api/types';
import { useResource } from '../../api/use-resource';
import { cn } from '../../cn';
import { Button, Notice } from '../../components/form-kit';
import { EmptyState } from '../../components/ui';
import type { PermissionState } from '../../lib';
import {
  avisoAntesDeGuardar, avisoDeFuente, esAckAplicado, explicarFallo, hayCambios, mensajeDeGuardado,
  preserveSourceLineEndings,
} from './ficheros';
import { ReasonField } from './context-ui';
import { explicarFalloDeMotivo, problemaDeMotivo } from './ficheros-motivo';
import { MENSAJES_DE_APLICACION } from './perfil';
import { useDocumentWrite } from './document-write-state';


export interface BorradorDeFichero {
  texto: string;
  /** SHA of the read it was born from: it is what still travels on save, so CAS keeps working. */
  shaBase: string | null;
  /** Resolved source of the draft; a changed harness must not redirect an old draft. */
  pathBase?: string;
}

interface FicherosTabProps {
  tenantId: string;
  alias: string;
  /** Outside the component and indexed by kind: tab, file and fold all unmount the editor. */
  borradores?: Partial<Record<AgentDocumentKind, BorradorDeFichero>>;
  onBorrador: (kind: AgentDocumentKind, borrador: BorradorDeFichero | undefined) => void;
  onApplied?: (message: string) => void;
  mutationBlocked?: boolean;
  configWritePermission?: PermissionState;
}

/**
 * Every governed file of the alias. Only the site manual (`directive`) is ever offered for
 * editing, and only with an accredited `config.write`; the rest opens in a read-only viewer.
 */
export function FicherosTab({
  tenantId, alias, borradores, onBorrador, onApplied,
  mutationBlocked = false, configWritePermission = 'unknown',
}: FicherosTabProps) {
  const api = useApi();
  const mapa = useResource(
    `ficheros-${tenantId}-${alias}`, () => api.getAgentDocuments(tenantId, alias),
  );
  const [abierto, setAbierto] = useState<AgentDocumentKind | undefined>(undefined);

  const aviso = mapa.data ? avisoDeFuente(mapa.data) : undefined;
  const items = mapa.data?.items ?? [];
  const canWrite = configWritePermission === 'allowed';

  if (mapa.loading) return <p className="m-0 text-muted">Leyendo el mapa de ficheros…</p>;

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
    <div className="grid gap-3">
      {aviso ? (
        <Notice tone="warn" role="status" className="flex items-start gap-2">
          <AlertTriangle size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> {aviso}
        </Notice>
      ) : null}

      {items.length === 0 ? (
        <EmptyState>
          <strong>No se pudo resolver ningún fichero para este alias.</strong>{' '}
          Para saber qué ficheros gobiernan a un agente hay que saber qué arnés corre de verdad y
          con qué HOME, y eso sólo se puede medir dentro de su contenedor.
        </EmptyState>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {items.map((item) => (
            <FilaDeFichero
              key={`${item.kind}-${item.path}`}
              item={item}
              tenantId={tenantId}
              alias={alias}
              canEdit={canWrite && item.kind === 'directive' && item.editable}
              mutationBlocked={mutationBlocked}
              abierto={abierto === item.kind}
              borrador={borradores?.[item.kind]}
              onBorrador={(nuevo) => { onBorrador(item.kind, nuevo); }}
              onAbrir={() => { setAbierto(abierto === item.kind ? undefined : item.kind); }}
              onApplied={onApplied}
            />
          ))}
        </ul>
      )}

      {!canWrite ? (
        <Notice role="status" className="flex items-start gap-2">
          <Lock size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
          {configWritePermission === 'unknown'
            ? 'No se pudo acreditar config.write; todo guardado queda bloqueado.'
            : 'Tu sesión puede inspeccionar, pero no escribir configuración.'}
        </Notice>
      ) : null}

      {mutationBlocked ? (
        <Notice tone="warn" role="status" className="flex items-start gap-2">
          <Lock size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
          Aplicación de campos canónicos en curso. El manual queda bloqueado hasta recibir su ACK.
        </Notice>
      ) : null}

      <HuecoDeclarado />
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
  const readable = item.readable === true;
  const editable = canEdit && !mutationBlocked;
  const reason = item.reason ?? (!readable
    ? 'El gateway no acreditó que este contenido sea servible; no se envió ninguna lectura.'
    : undefined);
  const modeLabel = !readable
    ? 'no se sirve'
    : canEdit && mutationBlocked
      ? 'bloqueado · aplicación en curso'
      : canEdit ? 'editable' : 'visor · sólo lectura';
  const header = (
    <>
      {editable ? <FileText size={14} aria-hidden="true" className="shrink-0 text-brand-ink" />
        : <Lock size={14} aria-hidden="true" className="shrink-0 text-muted" />}
      <span className="font-medium text-fg">{item.label}</span>
      <code className="min-w-0 text-xs break-all text-muted">{item.path}</code>
      <span className={cn('ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium',
        editable ? 'bg-brand-soft text-brand-ink' : 'bg-muted-bg text-muted')}>{modeLabel}</span>
      {borrador === undefined ? null : (
        <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] font-medium text-warn-ink">borrador sin guardar</span>
      )}
    </>
  );
  const headerClass = 'flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2.5 text-left text-[13px]';
  return (
    <li className="overflow-hidden rounded-lg border border-line bg-surface">
      {readable ? (
        <button type="button" className={cn(headerClass, 'cursor-pointer border-0 bg-transparent hover:bg-subtle')}
          onClick={onAbrir} aria-expanded={abierto}>
          {header}
        </button>
      ) : <div className={headerClass}>{header}</div>}

      {reason ? <p className="m-0 px-3 pb-2.5 text-xs text-muted">{reason}</p> : null}

      {abierto && readable ? (
        <div className="border-t border-line p-3">
          {canEdit
            ? (
              <Editor
                item={item} tenantId={tenantId} alias={alias}
                canWrite={!mutationBlocked} mutationBlocked={mutationBlocked}
                borrador={borrador} onBorrador={onBorrador} onApplied={onApplied}
              />
              )
            : <Visor item={item} tenantId={tenantId} alias={alias} />}
        </div>
      ) : null}
    </li>
  );
}

interface DocumentLoadFailure {
  readonly titulo: string;
  readonly detalle: string;
}

function useDocumentContent(
  api: CauceApi,
  tenantId: string,
  alias: string,
  kind: AgentDocumentKind,
) {
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState<AgentDocumentContent | undefined>(undefined);
  const [failure, setFailure] = useState<DocumentLoadFailure | undefined>(undefined);
  const reload = useCallback(async () => {
    setLoading(true);
    setFailure(undefined);
    try {
      setContent(await api.getAgentDocumentContent(tenantId, alias, kind));
    } catch (error) {
      const status = error instanceof ApiError ? error.status : undefined;
      const explained = explicarFallo(status, error instanceof Error ? error.message : undefined);
      setFailure({ titulo: explained.titulo, detalle: explained.detalle });
      setContent(undefined);
    } finally {
      setLoading(false);
    }
  }, [api, tenantId, alias, kind]);
  useEffect(() => { void reload(); }, [reload]);
  return { content, failure, loading, reload, setContent, setFailure };
}

const TEXT_AREA = 'min-h-64 font-mono text-xs leading-relaxed';

function FalloDeLectura({ fallo }: { fallo: DocumentLoadFailure }) {
  return (
    <Notice tone="warn" role="status">
      <strong>{fallo.titulo}</strong>
      <p>{fallo.detalle}</p>
    </Notice>
  );
}

/** An explicit GET with no mutation surface. Never renders Save and never calls PUT. */
function Visor({ item, tenantId, alias }: {
  item: AgentDocumentItem; tenantId: string; alias: string;
}) {
  const api = useApi();
  const {
    content: servido, failure: fallo, loading: cargando, reload: cargar,
  } = useDocumentContent(api, tenantId, alias, item.kind);

  if (cargando) return <p className="m-0 text-muted">Leyendo el fichero dentro del contenedor…</p>;
  if (fallo) return <FalloDeLectura fallo={fallo} />;
  if (!servido) return null;
  if (!servido.exists) {
    return (
      <div className="grid justify-items-start gap-2">
        <p className="m-0 text-xs text-muted">
          La sonda comprobó que este fichero todavía no existe. No se muestra como texto vacío y
          este visor no lo puede crear.
        </p>
        <Button size="sm" onClick={() => void cargar()}>Volver a comprobar</Button>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {servido.truncated ? (
        <Notice tone="warn" role="alert" className="flex items-start gap-2">
          <AlertTriangle size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> Esta lectura está recortada. El visor
          muestra sólo el prefijo recibido y no permite modificarlo.
        </Notice>
      ) : null}
      <textarea
        className={TEXT_AREA}
        aria-label={`Contenido de ${item.label}`}
        value={servido.content}
        spellCheck={false}
        rows={18}
        readOnly
        aria-readonly="true"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted">
          {servido.bytes} bytes · visor de sólo lectura{servido.truncated ? ' · prefijo recortado' : ''}
        </span>
        <Button size="sm" onClick={() => void cargar()}>Releer</Button>
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
  const {
    content: servido, failure: fallo, loading: cargando, reload: cargar, setContent: setServido,
    setFailure: setFallo,
  } = useDocumentContent(api, tenantId, alias, item.kind);
  const [guardando, setGuardando] = useDocumentWrite(api, JSON.stringify([tenantId, alias, item.kind]));
  const [guardado, setGuardado] = useState<string | undefined>(undefined);
  const [motivo, setMotivo] = useState('');
  const problemaMotivo = problemaDeMotivo(motivo);

  useEffect(() => { setGuardado(undefined); }, [api, tenantId, alias, item.kind]);

  const releer = useCallback(async () => {
    setGuardado(undefined);
    await cargar();
  }, [cargar]);

  const texto = borrador?.texto ?? servido?.content ?? '';
  const changedTarget = borrador?.pathBase !== undefined && servido?.path !== undefined
    && borrador.pathBase !== servido.path;

  const guardar = useCallback(async () => {
    if (!servido || guardando || changedTarget) return;
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
      const mensaje = resultado.state === 'written_pending_session'
        ? `${mensajeDeGuardado(resultado)} Sesión sin adoptar todavía: `
          + MENSAJES_DE_APLICACION.written_pending_session
        : mensajeDeGuardado(resultado);
      setGuardado(mensaje);
      onApplied?.(mensaje);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : undefined;
      const codigo = error instanceof ApiError ? error.code : undefined;
      const mensaje = error instanceof Error ? error.message : undefined;
      const explicado = error instanceof ApiError && status === 409
        && error.code === 'managed_context_conflict'
        ? {
          titulo: 'El bloque canónico se edita en Perfil / campos canónicos',
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
    motivo, problemaMotivo, onBorrador, onApplied, setFallo, setServido, guardando, setGuardando, changedTarget,
  ]);

  if (cargando) return <p className="m-0 text-muted">Leyendo el fichero dentro del contenedor…</p>;
  if (fallo && !servido) return <FalloDeLectura fallo={fallo} />;
  if (!servido) return null;

  const avisoGuardar = avisoAntesDeGuardar(item);
  const sucio = hayCambios(servido.content, texto);
  const bloqueado = guardando || !canWrite || !servido.editable || servido.truncated;

  return (
    <div className="grid gap-3">
      {changedTarget ? <Notice tone="danger" role="alert">El destino del manual cambió desde que empezaste el borrador. No se guardará ese texto en otro archivo. Conservá tu texto antes de descartarlo y releer.</Notice> : null}
      {!servido.exists ? (
        <Notice>
          Este fichero todavía no existe. Si guardas, se crea. Está vacío porque no está, no
          porque se haya perdido.
        </Notice>
      ) : null}

      {avisoGuardar ? (
        <Notice tone="warn" role="status" className="flex items-start gap-2">
          <AlertTriangle size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> {avisoGuardar}
        </Notice>
      ) : null}

      {servido.truncated ? (
        <Notice tone="warn" role="alert" className="flex items-start gap-2">
          <AlertTriangle size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> Esta lectura está recortada. Se muestra para
          diagnóstico, pero no se puede editar ni reemplazar: guardar este prefijo borraría el resto.
        </Notice>
      ) : null}

      <textarea
        className={TEXT_AREA}
        aria-label={`Contenido de ${item.label}`}
        value={texto}
        spellCheck={false}
        rows={18}
        readOnly={bloqueado}
        aria-readonly={bloqueado}
        onChange={(event) => {
          if (!canWrite || guardando || mutationBlocked) return;
          const escrito = preserveSourceLineEndings(servido.content, event.target.value);
          onBorrador(escrito === servido.content
            ? undefined
            : { texto: escrito, shaBase: borrador ? borrador.shaBase : servido.sha,
              pathBase: borrador?.pathBase ?? servido.path });
          setGuardado(undefined);
        }}
      />

      <ReasonField label="Motivo del guardado" value={motivo} disabled={bloqueado}
        placeholder="Escribí por qué cambiás este fichero…"
        onChange={(value) => { setMotivo(value); setGuardado(undefined); }} />

      {fallo ? <Notice tone="danger" role="alert"><strong>{fallo.titulo}</strong>: {fallo.detalle}</Notice> : null}
      {guardado ? <Notice tone="ok" role="status">{guardado}</Notice> : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted">
          {servido.bytes} bytes · {servido.projected ? 'proyección de campos' : 'fichero completo'}
        </span>
        <div className="flex gap-2">
          <Button size="sm" disabled={guardando || mutationBlocked}
            onClick={() => {
              if (mutationBlocked) return;
              onBorrador(undefined);
              void releer();
            }}>
            Descartar y releer
          </Button>
          <Button size="sm" variant="primary" onClick={() => void guardar()}
            disabled={!canWrite || !sucio || guardando || changedTarget || !servido.editable
              || servido.truncated || problemaMotivo !== undefined}>
            <Save size={14} aria-hidden="true" /> {guardando ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The gap, stated in plain language and right in this view. Without it a locked `mcp` reads as
 * "the console does not reach there yet" when it is a measured decision, and what is truly
 * missing —the channel to the disk— is visible nowhere at all.
 */
function HuecoDeclarado() {
  return (
    <details className="rounded-lg border border-line px-3 py-2 text-[13px]">
      <summary className="cursor-pointer font-medium">Lo que esto todavía no hace</summary>
      <ul className="mt-2 mb-0 grid gap-2 pl-5 text-xs text-muted">
        <li>
          <strong className="text-fg-2">Los MCP y las skills no se editan desde aquí.</strong> En claude viven en
          `~/.claude.json`, junto al OAuth de la cuenta; en openclaw, dentro del mismo fichero que
          `auth` y `secrets`, y ahí hay claves de API de verdad. Servir esos ficheros sería una
          fuga, no una funcionalidad. Se editan a mano dentro del contenedor.
        </li>
        <li>
          <strong className="text-fg-2">Los subagentes y los prompts guardados se listan, no se editan.</strong> Son
          directorios con un fichero por pieza, y esta vista edita ficheros sueltos.
        </li>
        <li>
          <strong className="text-fg-2">Esto no ve lo que se edite por la terminal.</strong> El diario de cambios cubre
          lo que pasa por esta pantalla; un `docker exec` y un editor a mano no dejan rastro aquí.
        </li>
      </ul>
    </details>
  );
}
