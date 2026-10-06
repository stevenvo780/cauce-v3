import { RefreshCw, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import { ContextoContaminadoError, EntregaEnVueloError } from '../../api/client/agent-client';
import { useApi } from '../../api/context';
import { Button, Notice, SectionCard } from '../../components/form-kit';
import { ReasonField } from './context-ui';
import { explicarFalloDeMotivo, problemaDeMotivo } from './ficheros-motivo';
import {
  CONTAMINACION_ILEGIBLE, MENSAJES_DE_APLICACION, contaminacionDe, entregasEnVuelo, esRecargaHecha,
  fraseDeContaminacion,
  type ContaminacionDeContexto, type RespuestaDeRecarga,
} from './perfil';

/**
 * The remedy for a context that is on disk but stale, and the quarantine that suspends it.
 *
 * A reload rewrites and re-measures the governance files from the revision already stored: it
 * authors nothing and, above all, it does NOT restart the harness. Restarting a live TUI destroys
 * the conversation of whoever owns it, so the success it can honestly report is bytes on disk —
 * the process is only reading them once its own adoption ACK says so.
 */

function huellaCorta(sha: string | null): string {
  return sha === null ? 'no existía' : `${sha.slice(0, 12)}…`;
}

export function AvisoDeContaminacion({ contaminacion }: { contaminacion: ContaminacionDeContexto }) {
  return (
    <Notice tone="danger" role="alert" className="grid gap-1.5">
      <p className="flex items-center gap-1.5 font-semibold">
        <ShieldAlert size={16} aria-hidden />
        Los ficheros de gobierno de este alias contienen algo que no es suyo.
      </p>
      <p>
        Guardar y recargar quedan bloqueados hasta que alguien mire ese contenedor. No se pisa lo
        que hay dentro: reescribirlo borraría la prueba de cómo llegó ahí.
      </p>
      {contaminacion.findings.length === 0 ? (
        <p>
          El gateway marcó contaminación pero no dijo en qué fichero ni de quién. Se trata como
          sucio igual: un veredicto que no se puede leer no se presenta como limpio.
        </p>
      ) : (
        <ul className="m-0 grid gap-1 pl-5">
          {contaminacion.findings.map((hallazgo) => (
            <li key={`${hallazgo.reason}-${hallazgo.path}`}>
              <code>{hallazgo.document}</code> en {hallazgo.path}:{' '}
              {fraseDeContaminacion(hallazgo.reason)}
              {hallazgo.owner === undefined
                ? null
                : <> — el bloque es de <strong>{hallazgo.owner}</strong></>}
            </li>
          ))}
        </ul>
      )}
    </Notice>
  );
}

function ResultadoDeRecarga({ resultado }: { resultado: RespuestaDeRecarga }) {
  return (
    <div className="grid gap-2" role="status">
      <Notice tone="warn">
        Contexto reescrito en la revisión {resultado.revision}. Estado{' '}
        <strong>{resultado.state}</strong>, acreditado por <strong>{resultado.evidence}</strong>:{' '}
        {MENSAJES_DE_APLICACION[resultado.state]}
      </Notice>
      {resultado.documents.length === 0 ? (
        <p className="m-0 text-xs text-muted">El lote no tocó ningún fichero: no había ninguno que reescribir.</p>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0 text-xs">
          {resultado.documents.map((documento) => (
            <li key={documento.path}>
              <code>{documento.name}</code>{' '}
              <span className="text-muted">{documento.path}</span>{' '}
              {huellaCorta(documento.sha_before)} → {huellaCorta(documento.sha_after)} ·{' '}
              {documento.bytes.toLocaleString('es')} bytes
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface RecargaDeContextoProps {
  tenantId: string;
  alias: string;
  /** Write permission accredited for this session; without it nothing is sent. */
  permitida: boolean;
  enCuarentena: boolean;
  onVeredicto: (contaminacion: ContaminacionDeContexto) => void;
  onRecargado: () => void;
  editorBlocked?: boolean;
  onWriteInFlightChange?: (busy: boolean) => void;
}

export function RecargaDeContexto({
  tenantId, alias, permitida, enCuarentena, onVeredicto, onRecargado,
  editorBlocked = false, onWriteInFlightChange,
}: RecargaDeContextoProps) {
  const api = useApi();
  const [motivo, setMotivo] = useState('');
  const [recargando, setRecargando] = useState(false);
  const [resultado, setResultado] = useState<RespuestaDeRecarga>();
  const [fallo, setFallo] = useState<{ titulo: string; detalle: string }>();
  const problemaMotivo = problemaDeMotivo(motivo);
  const bloqueada = !permitida || enCuarentena || recargando || editorBlocked;

  async function recargar() {
    if (bloqueada || problemaMotivo !== undefined) return;
    setFallo(undefined);
    setResultado(undefined);
    setRecargando(true);
    onWriteInFlightChange?.(true);
    try {
      const respuesta = await api.postContextReload(tenantId, alias, motivo.trim());
      // The verdict is READ before anything else: a 2xx that cannot be read as clean is not clean.
      const leido = contaminacionDe(respuesta);
      if (leido !== undefined) onVeredicto(leido);
      if (!esRecargaHecha(respuesta, { tenantId, alias })) {
        setFallo({
          titulo: 'El gateway no acreditó la recarga',
          detalle: 'Respondió 2xx sin decir estado, revisión y huellas por fichero. No se presenta '
            + 'como reescrito lo que nadie acreditó.',
        });
        return;
      }
      setResultado(respuesta);
      setMotivo('');
      onRecargado();
    } catch (error) {
      if (error instanceof ContextoContaminadoError) {
        onVeredicto(contaminacionDe(error.cuerpo) ?? CONTAMINACION_ILEGIBLE);
        setFallo({ titulo: 'Contexto en cuarentena', detalle: error.message });
        return;
      }
      if (error instanceof EntregaEnVueloError) {
        const entregas = entregasEnVuelo(error.cuerpo);
        setFallo({
          titulo: 'Hay una entrega en vuelo',
          detalle: entregas.length === 0
            ? `${error.message} Se puede reintentar cuando termine.`
            : `${error.message} En vuelo ahora: ${entregas.join(', ')}.`,
        });
        return;
      }
      const status = error instanceof ApiError ? error.status : undefined;
      const codigo = error instanceof ApiError ? error.code : undefined;
      const mensaje = error instanceof Error ? error.message : 'el servidor no dijo por qué';
      const delMotivo = codigo === 'invalid_reason' || codigo === 'writable_requires_attribution'
        ? explicarFalloDeMotivo(status, codigo, mensaje)
        : undefined;
      setFallo(delMotivo ?? {
        titulo: 'No se pudo acreditar la recarga',
        detalle: `HTTP ${String(status ?? 'sin dato')}: ${mensaje} El resultado puede ser parcial; volvé a medir antes de reintentar.`,
      });
      onRecargado();
    } finally {
      setRecargando(false);
      onWriteInFlightChange?.(false);
    }
  }

  return (
    <SectionCard
      title="Recargar contexto"
      description="Reescribe y vuelve a medir los ficheros de gobierno desde la revisión ya guardada. NO reinicia la TUI ni toca la conversación de su dueño: que el proceso relea lo dice su ACK de adopción."
    >
      <ReasonField label="Motivo de la recarga" value={motivo} onChange={setMotivo} disabled={bloqueada}
        placeholder="Por qué recargás el contexto…" />
      <div>
        <Button size="sm" disabled={bloqueada || problemaMotivo !== undefined} onClick={() => { void recargar(); }}>
          <RefreshCw size={14} aria-hidden />
          {recargando ? 'Recargando contexto…' : 'Recargar contexto'}
        </Button>
      </div>
      {fallo ? <Notice tone="danger" role="alert"><strong>{fallo.titulo}</strong>. {fallo.detalle}</Notice> : null}
      {resultado ? <ResultadoDeRecarga resultado={resultado} /> : null}
    </SectionCard>
  );
}
