/**
 * TAKING AND GIVING BACK THE KEYBOARD OF A WRITABLE TUI.
 *
 * Four rules are the feature itself and none of them may be softened here:
 *
 *  1. the reason is TYPED BY A HUMAN, 8..280 characters, with no default and no generated text.
 *     `liveTuiReason` is the sentence the console writes on its own to justify a read-only
 *     observation and it never reaches this write;
 *  2. the button exists only when the GATEWAY says the action is possible — `writable_modes` of
 *     `/targets` — never because `harness_rw` happens to appear in the mode list;
 *  3. before the operator types anything the screen states the consequence: while the control is
 *     held the bus does not deliver to that alias and its messages queue up;
 *  4. giving it back is always reachable, survives an error, and is also fired when the panel
 *     goes away. A hold that outlives the tab is what mutes an alias.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, PauseCircle, Undo2 } from 'lucide-react';
import { useApi } from '../../api/context';
import {
  TerminalApiError,
  type TerminalSessionGrant,
  type TerminalSessionOwner,
} from './api';
import {
  devolverControlDeTui,
  tomarControlDeTui,
  type ControlDeTuiTomado,
} from './api-control';
import { explicarDenegacionPty, type DenegacionExplicada } from './denegaciones';
import { NegativaPty } from './PtySessionDialog';
import { PTY_REASON_MAX_LENGTH, ptyReasonProblem } from './session';

/** Close code the relay uses on the browser leg when the operator's hold is no longer theirs. */
export const CIERRE_CONTROL_DEVUELTO = 4410;

interface ControlPendiente {
  sessionId: string;
  owner: TerminalSessionOwner;
}

function dueno(grant: TerminalSessionGrant): TerminalSessionOwner {
  return {
    request_id: grant.request_id,
    owner_generation: grant.owner_generation,
    owner_token: grant.owner_token,
  };
}

function explicar(error: unknown): DenegacionExplicada {
  return explicarDenegacionPty({
    texto: error instanceof Error ? error.message : undefined,
    estado: error instanceof TerminalApiError ? error.status : undefined,
    codigo: error instanceof TerminalApiError ? error.code : undefined,
  });
}

export function ControlDeTui({ alias, grant, puedeEscribir, codigoDeCierre, pidiendoSesion, onAbrirEscritura, onControlCambia }: {
  alias: string;
  /** Live grant of this panel, whatever its mode. The hold belongs to a writable session. */
  grant?: TerminalSessionGrant;
  /** `writable_modes` of `/targets` carries `harness_rw`. Never inferred from `modes`. */
  puedeEscribir: boolean;
  codigoDeCierre?: number;
  pidiendoSesion: boolean;
  /** Opens the writable session with the SAME hand-typed reason; `undefined` when it was refused. */
  onAbrirEscritura: (motivo: string) => Promise<TerminalSessionGrant | undefined>;
  onControlCambia: (sostenido: boolean) => void;
}) {
  const api = useApi();
  const [motivo, setMotivo] = useState('');
  const [arriendo, setArriendo] = useState<ControlDeTuiTomado>();
  const [pendiente, setPendiente] = useState(false);
  const [error, setError] = useState<DenegacionExplicada>();
  const [perdido, setPerdido] = useState(false);
  const apiRef = useRef(api);
  apiRef.current = api;
  /** What an unmount or a `beforeunload` still has to give back. Cleared the moment it is gone. */
  const porDevolverRef = useRef<ControlPendiente>(undefined);
  const alineadoRef = useRef(false);

  const problema = ptyReasonProblem(motivo);

  const soltarEnSilencio = useCallback((keepalive: boolean) => {
    const pendienteDeSoltar = porDevolverRef.current;
    if (pendienteDeSoltar === undefined) return;
    porDevolverRef.current = undefined;
    void devolverControlDeTui(
      pendienteDeSoltar.sessionId, pendienteDeSoltar.owner, apiRef.current, { keepalive },
    ).catch(() => undefined);
  }, []);

  useEffect(() => { onControlCambia(arriendo !== undefined); }, [arriendo, onControlCambia]);

  // The relay already took the hold away: posting a release would claim something that did not
  // happen, so the state is dropped WITHOUT a request and the operator is told in Spanish.
  useEffect(() => {
    if (codigoDeCierre !== CIERRE_CONTROL_DEVUELTO) return;
    porDevolverRef.current = undefined;
    setArriendo(undefined);
    setPerdido(true);
  }, [codigoDeCierre]);

  // The panel moved AWAY from the session that carries the hold: the gateway releases it inside
  // the same transaction that settles that session, so keeping it on screen would be a lie. The
  // move only counts once the panel has actually shown the writable session: the parent adopts
  // the new grant a render later than the take resolves, and that lag is not a move.
  useEffect(() => {
    if (arriendo === undefined) {
      alineadoRef.current = false;
      return;
    }
    if (grant?.session_id === arriendo.session_id) {
      alineadoRef.current = true;
      return;
    }
    if (!alineadoRef.current) return;
    porDevolverRef.current = undefined;
    setArriendo(undefined);
  }, [arriendo, grant?.session_id]);

  useEffect(() => {
    const alCerrarLaPestana = () => { soltarEnSilencio(true); };
    window.addEventListener('beforeunload', alCerrarLaPestana);
    return () => {
      window.removeEventListener('beforeunload', alCerrarLaPestana);
      soltarEnSilencio(false);
    };
  }, [soltarEnSilencio]);

  if (!puedeEscribir) return null;

  async function tomar() {
    if (problema !== undefined || pendiente) return;
    const escrito = motivo.trim();
    setPendiente(true);
    setError(undefined);
    setPerdido(false);
    try {
      const escribible = await onAbrirEscritura(escrito);
      if (escribible === undefined) return;
      const tomado = await tomarControlDeTui(
        escribible.session_id, dueno(escribible), escrito, apiRef.current,
      );
      porDevolverRef.current = { sessionId: escribible.session_id, owner: dueno(escribible) };
      setArriendo(tomado);
    } catch (fallo) {
      setError(explicar(fallo));
    } finally {
      setPendiente(false);
    }
  }

  async function devolver() {
    const enCurso = porDevolverRef.current;
    if (enCurso === undefined) {
      setArriendo(undefined);
      return;
    }
    setPendiente(true);
    setError(undefined);
    try {
      await devolverControlDeTui(enCurso.sessionId, enCurso.owner, apiRef.current);
      porDevolverRef.current = undefined;
      setArriendo(undefined);
    } catch (fallo) {
      setError(explicar(fallo));
    } finally {
      setPendiente(false);
    }
  }

  return (
    <section className="pty-control" aria-label="Control de la TUI" data-sostenido={arriendo ? true : undefined}>
      <p className="pty-control-consecuencia">
        <PauseCircle size={13} aria-hidden="true" />
        Mientras alguien tiene el control, el bus no le entrega mensajes a {alias}: quedan en cola y salen en orden en cuanto se devuelva.
      </p>

      {arriendo ? (
        <>
          <p className="pty-control-estado" role="status">
            Tenés el teclado de esta TUI. El arriendo vence a las {new Date(arriendo.expires_at).toLocaleTimeString()} y devolverlo destraba la cola de {alias}.
          </p>
          <button
            className="button small primary pty-control-devolver"
            type="button"
            onClick={() => void devolver()}
            title="Suelta el teclado y el bus vuelve a entregarle a este alias."
          >
            <Undo2 size={14} aria-hidden="true" /> Devolver el control
          </button>
        </>
      ) : (
        <>
          <label className="pty-control-motivo" htmlFor="pty-control-motivo">
            Motivo de la toma (lo escribís vos y es lo único que queda en la auditoría)
            <textarea
              id="pty-control-motivo"
              value={motivo}
              onChange={(evento) => { setMotivo(evento.target.value); }}
              rows={2}
              maxLength={PTY_REASON_MAX_LENGTH}
              autoComplete="off"
              spellCheck={false}
              placeholder="Escribí qué vas a hacer con el teclado de este agente…"
              aria-describedby="pty-control-pista"
            />
          </label>
          <p className="pty-control-pista" id="pty-control-pista">
            {problema ?? `Motivo válido · ${String(motivo.trim().length)}/${String(PTY_REASON_MAX_LENGTH)}`}
          </p>
          <button
            className="button small primary pty-control-tomar"
            type="button"
            disabled={problema !== undefined || pendiente || pidiendoSesion}
            title={problema}
            onClick={() => void tomar()}
          >
            <KeyRound size={14} aria-hidden="true" /> {pendiente ? 'Tomando…' : 'Tomar el control'}
          </button>
        </>
      )}

      {perdido ? (
        <p className="pty-control-perdido" role="status">
          El bus volvió a entregarle a {alias}. Si necesitás el teclado otra vez, tomá el control de nuevo.
        </p>
      ) : null}

      {error ? <NegativaPty negativa={error} /> : null}
    </section>
  );
}
