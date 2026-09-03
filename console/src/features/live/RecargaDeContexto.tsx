import { RefreshCw, ShieldAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { ApiError } from '../../api/client';
import { ContextoContaminadoError, EntregaEnVueloError } from '../../api/client/agent-client';
import { useApi } from '../../api/context';
import {
  DOCUMENT_REASON_MAX, DOCUMENT_REASON_MIN, explicarFalloDeMotivo, problemaDeMotivo,
} from './ficheros-motivo';
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
    <div className="perfil-cuarentena" role="alert">
      <p className="perfil-cuarentena-titulo">
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
        <ul className="perfil-cuarentena-lista">
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
    </div>
  );
}

function ResultadoDeRecarga({ resultado }: { resultado: RespuestaDeRecarga }) {
  return (
    <div className="perfil-recarga-resultado" role="status">
      <p className="perfil-aviso perfil-aviso-parcial">
        Contexto reescrito en la revisión {resultado.revision}. Estado{' '}
        <strong>{resultado.state}</strong>, acreditado por <strong>{resultado.evidence}</strong>:{' '}
        {MENSAJES_DE_APLICACION[resultado.state]}
      </p>
      {resultado.documents.length === 0 ? (
        <p className="muted">El lote no tocó ningún fichero: no había ninguno que reescribir.</p>
      ) : (
        <ul className="perfil-recarga-ficheros">
          {resultado.documents.map((documento) => (
            <li key={documento.path}>
              <code>{documento.name}</code>{' '}
              <span className="muted">{documento.path}</span>{' '}
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
}

export function RecargaDeContexto({
  tenantId, alias, permitida, enCuarentena, onVeredicto, onRecargado,
}: RecargaDeContextoProps) {
  const api = useApi();
  const idMotivo = useId();
  const [motivo, setMotivo] = useState('');
  const [recargando, setRecargando] = useState(false);
  const [resultado, setResultado] = useState<RespuestaDeRecarga>();
  const [fallo, setFallo] = useState<{ titulo: string; detalle: string }>();
  const problemaMotivo = problemaDeMotivo(motivo);
  const bloqueada = !permitida || enCuarentena || recargando;

  async function recargar() {
    setFallo(undefined);
    setResultado(undefined);
    setRecargando(true);
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
        titulo: 'La recarga no se hizo',
        detalle: `HTTP ${String(status ?? 'sin dato')}: ${mensaje} Los ficheros quedan como estaban.`,
      });
    } finally {
      setRecargando(false);
    }
  }

  return (
    <div className="perfil-recarga">
      <p className="muted perfil-ayuda">
        Recargar reescribe y vuelve a medir los ficheros de gobierno de este alias a partir de la
        revisión ya guardada. NO reinicia la TUI ni toca la conversación de su dueño: que el
        proceso relea sólo lo dice su propio ACK de adopción, en la entrega siguiente.
      </p>
      <label className="perfil-motivo" htmlFor={idMotivo}>
        Motivo de la recarga (lo escribe una persona y queda en la auditoría)
        <input
          id={idMotivo}
          type="text"
          value={motivo}
          maxLength={DOCUMENT_REASON_MAX}
          autoComplete="off"
          spellCheck={false}
          placeholder="Motivo de la recarga, escrito a mano…"
          aria-describedby={`${idMotivo}-pista`}
          disabled={bloqueada}
          onChange={(event) => { setMotivo(event.target.value); }}
        />
      </label>
      <p className="perfil-razon" id={`${idMotivo}-pista`}>
        {motivo.length === 0
          ? `Hace falta un motivo escrito a mano: sin él no se recarga (mínimo `
            + `${String(DOCUMENT_REASON_MIN)}, máximo ${String(DOCUMENT_REASON_MAX)}).`
          : problemaMotivo
            ?? `Motivo válido · ${String(motivo.trim().length)}/${String(DOCUMENT_REASON_MAX)}`}
      </p>
      <button
        type="button"
        className="button small secondary"
        disabled={bloqueada || problemaMotivo !== undefined}
        onClick={() => { void recargar(); }}
      >
        <RefreshCw size={14} aria-hidden />
        {recargando ? 'Recargando contexto…' : 'Recargar contexto'}
      </button>
      {fallo ? (
        <p className="perfil-aviso perfil-aviso-error" role="alert">
          <strong>{fallo.titulo}</strong>. {fallo.detalle}
        </p>
      ) : null}
      {resultado ? <ResultadoDeRecarga resultado={resultado} /> : null}
    </div>
  );
}
