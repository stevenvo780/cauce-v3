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
 *
 * And one ORDER, which is not cosmetic: the gateway only accepts a take on a session the relay
 * already redeemed (`consumed_at IS NOT NULL`). Opening the writable session returns the moment
 * the grant exists, which is BEFORE the browser attaches, so posting the take there answered
 * `409 stale_terminal_owner` every single time. The take waits for the attach —the same
 * `ticketConsumido` the session bar paints— and says out loud that it is waiting.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, PauseCircle, Undo2 } from 'lucide-react';
import { useApi } from '../../api/context';
import {
  TerminalApiError,
  type CsrfResuelto,
  type TerminalSessionGrant,
  type TerminalSessionOwner,
} from './api';
import {
  devolverControlDeTui,
  tomarControlDeTui,
  type ControlDeTuiTomado,
} from './api-control';
import { codigoDeDenegacion, explicarDenegacionPty, type DenegacionExplicada } from './denegaciones';
import { WRITABLE_TUI_MODE } from './fleet';
import { NegativaPty } from './PtySessionDialog';
import type { PtyChannelState } from './pty-types';
import { PTY_REASON_MAX_LENGTH, ptyReasonProblem } from './session';

/** Close code the relay uses on the browser leg when the operator's hold is no longer theirs. */
const CIERRE_CONTROL_DEVUELTO = 4410;

/** How long the take waits for the relay to redeem the ticket before saying it did not attach. */
const ESPERA_DE_ENGANCHE_MS = 12_000;
const LATIDO_DE_ESPERA_MS = 50;

type FaseDeToma = 'reposo' | 'abriendo' | 'enganchando' | 'tomando' | 'devolviendo';
type ResultadoDeEspera = 'enganchada' | 'sin_canal' | 'sin_tiempo';

const ETIQUETA_DE_FASE: Readonly<Record<FaseDeToma, string>> = {
  reposo: 'Tomar el control',
  abriendo: 'Abriendo la sesión con teclado…',
  enganchando: 'Enganchando la sesión…',
  tomando: 'Tomando…',
  devolviendo: 'Tomar el control',
};

const NO_SE_ABRIO: DenegacionExplicada = {
  titulo: 'La consola no llegó a abrir la sesión con teclado',
  porQue: 'El pedido de sesión escribible no quedó adoptado por esta pestaña: o el gateway lo rechazó '
    + '—su motivo se pinta aparte—, o ya había otra reserva en vuelo para este panel. No se tomó ningún '
    + 'control: el bus le sigue entregando a este alias.',
  quienLoLevanta: 'Vos: esperá a que termine la reserva en curso y volvé a pedir la toma.',
  linea: 'La consola no llegó a abrir la sesión con teclado y no se tomó ningún control.',
};

function sinEnganche(motivo: ResultadoDeEspera): DenegacionExplicada {
  const porQue = motivo === 'sin_canal'
    ? 'La sesión con teclado quedó pedida, pero su canal se cortó antes de que el relay redimiera el '
      + 'ticket, así que el gateway todavía no la da por enganchada y rechazaría la toma.'
    : `La sesión con teclado quedó pedida, pero el relay no la enganchó en ${String(Math.round(ESPERA_DE_ENGANCHE_MS / 1000))} s. `
      + 'El gateway sólo acepta la toma sobre una sesión que el relay ya consumió.';
  return {
    titulo: 'La sesión con teclado no llegó a engancharse: seguís sin el teclado',
    porQue: `${porQue} Estás sobre una sesión escribible en solo lectura: nadie quedó silenciado y el bus le sigue entregando a este alias.`,
    quienLoLevanta: 'Vos: reintentá la toma con el mismo motivo. Si vuelve a fallar, cerrá la terminal y '
      + 'revisá que el agente PTY del contenedor siga conectado.',
    linea: 'La sesión con teclado no llegó a engancharse; no se tomó el control y el alias sigue recibiendo.',
  };
}

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

function vencimiento(arriendo: ControlDeTuiTomado): string {
  return arriendo.expires_at === undefined
    ? 'El gateway no dijo hasta cuándo vale el arriendo, así que devolvelo vos en cuanto termines'
    : `El arriendo vence a las ${new Date(arriendo.expires_at).toLocaleTimeString()} y devolverlo destraba la cola`;
}

export function ControlDeTui({ alias, grant, puedeEscribir, codigoDeCierre, pidiendoSesion, sesionEnganchada, estadoDelCanal, onAbrirEscritura, onControlCambia }: {
  alias: string;
  /** Live grant of this panel, whatever its mode. The hold belongs to a writable session. */
  grant?: TerminalSessionGrant;
  /** `writable_modes` of `/targets` carries `harness_rw`. Never inferred from `modes`. */
  puedeEscribir: boolean;
  codigoDeCierre?: number;
  pidiendoSesion: boolean;
  /** The relay redeemed the ticket of the session on screen: the same signal the bar paints. */
  sesionEnganchada: boolean;
  estadoDelCanal?: PtyChannelState;
  /** Opens the writable session with the SAME hand-typed reason; `undefined` when it was refused. */
  onAbrirEscritura: (motivo: string) => Promise<TerminalSessionGrant | undefined>;
  onControlCambia: (sostenido: boolean) => void;
}) {
  const api = useApi();
  const [motivo, setMotivo] = useState('');
  const [arriendo, setArriendo] = useState<ControlDeTuiTomado>();
  const [fase, setFase] = useState<FaseDeToma>('reposo');
  const [reintentable, setReintentable] = useState(false);
  const [error, setError] = useState<DenegacionExplicada>();
  const [perdido, setPerdido] = useState(false);
  const apiRef = useRef(api);
  apiRef.current = api;
  /** What an unmount or a `beforeunload` still has to give back. Cleared the moment it is gone. */
  const porDevolverRef = useRef<ControlPendiente>(undefined);
  /**
   * CSRF token read WHILE the hold is taken. `beforeunload` has no time to fetch one: a release
   * that awaits `/v3/auth/session` there never leaves the page and the alias stays muted.
   */
  const csrfRef = useRef<CsrfResuelto>(undefined);
  const tomandoRef = useRef(false);
  const alineadoRef = useRef(false);
  const vivoRef = useRef(true);
  const grantRef = useRef(grant);
  grantRef.current = grant;
  const enganchadaRef = useRef(sesionEnganchada);
  enganchadaRef.current = sesionEnganchada;
  const estadoRef = useRef(estadoDelCanal);
  estadoRef.current = estadoDelCanal;

  const problema = ptyReasonProblem(motivo);
  const pendiente = fase !== 'reposo';

  const soltarEnSilencio = useCallback((keepalive: boolean) => {
    const pendienteDeSoltar = porDevolverRef.current;
    if (pendienteDeSoltar === undefined) return;
    porDevolverRef.current = undefined;
    const soltar = (csrf: CsrfResuelto | undefined) => devolverControlDeTui(
      pendienteDeSoltar.sessionId,
      pendienteDeSoltar.owner,
      apiRef.current,
      { keepalive, ...(csrf ? { csrf } : {}) },
    );
    void soltar(keepalive ? csrfRef.current : undefined).catch((fallo: unknown) => {
      if (!keepalive || !(fallo instanceof TerminalApiError) || fallo.status !== 403) return;
      csrfRef.current = undefined;
      void apiRef.current.getAuthSession().then(() => soltar(undefined)).catch(() => undefined);
    });
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

  // `vivoRef` is re-armed on SETUP, not only cleared on cleanup: React runs cleanup + setup again
  // on the same mount (StrictMode does it always), and a flag that only ever goes false left the
  // take frozen on «Abriendo la sesión…» forever — it was the browser, not the suite, that saw it.
  useEffect(() => {
    vivoRef.current = true;
    const alCerrarLaPestana = () => { soltarEnSilencio(true); };
    window.addEventListener('beforeunload', alCerrarLaPestana);
    return () => {
      window.removeEventListener('beforeunload', alCerrarLaPestana);
      vivoRef.current = false;
      soltarEnSilencio(false);
    };
  }, [soltarEnSilencio]);

  if (!puedeEscribir) return null;

  /** Read through a call so the narrowing of an earlier check does not survive an `await`. */
  function sigueVivo(): boolean {
    return vivoRef.current;
  }

  /** Waits for the SAME session the take is about to be posted against to be attached. */
  async function esperarEnganche(sessionId: string): Promise<ResultadoDeEspera> {
    const limite = Date.now() + ESPERA_DE_ENGANCHE_MS;
    for (;;) {
      const alineado = grantRef.current?.session_id === sessionId;
      if (alineado && enganchadaRef.current) return 'enganchada';
      if (alineado && (estadoRef.current === 'closed' || estadoRef.current === 'error')) return 'sin_canal';
      if (Date.now() >= limite || !sigueVivo()) return 'sin_tiempo';
      await new Promise((listo) => setTimeout(listo, LATIDO_DE_ESPERA_MS));
    }
  }

  async function tomar() {
    if (problema !== undefined || pendiente || tomandoRef.current) return;
    tomandoRef.current = true;
    const escrito = motivo.trim();
    setError(undefined);
    setPerdido(false);
    try {
      // A writable session already on screen is REUSED: asking for a second one returns a grant the
      // workspace refuses to adopt, and that refusal is what made the second click do nothing.
      const canalMuerto = estadoRef.current === 'closed' || estadoRef.current === 'error';
      const abierta = grantRef.current;
      const reusable = abierta?.target.mode === WRITABLE_TUI_MODE && !canalMuerto ? abierta : undefined;
      let escribible = reusable;
      if (escribible === undefined) {
        setFase('abriendo');
        escribible = await onAbrirEscritura(escrito);
      }
      if (!sigueVivo()) return;
      if (escribible === undefined) {
        setError(NO_SE_ABRIO);
        setReintentable(true);
        return;
      }
      setFase('enganchando');
      const enganche = await esperarEnganche(escribible.session_id);
      if (!sigueVivo()) return;
      if (enganche !== 'enganchada') {
        setError(sinEnganche(enganche));
        setReintentable(true);
        return;
      }
      setFase('tomando');
      const tomado = await tomarControlDeTui(
        escribible.session_id, dueno(escribible), escrito, apiRef.current,
      );
      porDevolverRef.current = { sessionId: escribible.session_id, owner: dueno(escribible) };
      recordarCsrf();
      setReintentable(false);
      setArriendo(tomado);
    } catch (fallo) {
      setError(explicar(fallo));
      setReintentable(true);
    } finally {
      tomandoRef.current = false;
      if (sigueVivo()) setFase('reposo');
    }
  }

  function recordarCsrf() {
    void apiRef.current.csrfForMutation()
      .then((token) => { csrfRef.current = { ...(token ? { token } : {}) }; })
      .catch(() => undefined);
  }

  async function devolver() {
    const enCurso = porDevolverRef.current;
    if (enCurso === undefined) {
      setArriendo(undefined);
      return;
    }
    setFase('devolviendo');
    setError(undefined);
    try {
      await devolverControlDeTui(enCurso.sessionId, enCurso.owner, apiRef.current);
      porDevolverRef.current = undefined;
      setArriendo(undefined);
    } catch (fallo) {
      const conflicto = fallo instanceof TerminalApiError && fallo.status === 409
        ? codigoDeDenegacion(fallo.code) ?? codigoDeDenegacion(fallo.message)
        : undefined;
      if (conflicto === 'stale_terminal_owner' || conflicto === 'control_held') {
        porDevolverRef.current = undefined;
        setArriendo(undefined);
        setPerdido(true);
      }
      setError(explicar(fallo));
    } finally {
      if (sigueVivo()) setFase('reposo');
    }
  }

  return (
    <section className="pty-control" aria-label="Control de la TUI" data-sostenido={arriendo ? true : undefined} data-fase={fase === 'reposo' ? undefined : fase}>
      <p className="pty-control-consecuencia">
        <PauseCircle size={13} aria-hidden="true" />
        Mientras alguien tiene el control, el bus no le entrega mensajes a {alias}: quedan en cola y salen en orden en cuanto se devuelva.
      </p>

      {arriendo ? (
        <>
          <p className="pty-control-estado" role="status">
            Tenés el teclado de esta TUI. {vencimiento(arriendo)} de {alias}.
          </p>
          {arriendo.dudoso.length > 0 ? (
            // Wears the amber notice rule the panel already has (`pty-control-perdido`): this is the
            // same kind of aside about the hold, so it needs no rule of its own. `pty-control-recibo`
            // stays as the hook that names WHICH notice this is.
            <p className="pty-control-perdido pty-control-recibo" role="status">
              El gateway acreditó la toma con un recibo incompleto (sin {arriendo.dudoso.join(', ')}). El teclado es tuyo y la devolución queda registrada igual.
            </p>
          ) : null}
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
            <KeyRound size={14} aria-hidden="true" /> {pendiente
              ? ETIQUETA_DE_FASE[fase]
              : reintentable ? 'Reintentar la toma' : 'Tomar el control'}
          </button>
        </>
      )}

      {perdido ? (
        <p className="pty-control-perdido" role="status">
          Esta sesión ya no tiene el control de la TUI de {alias}. Otra sesión puede mantener el bus en pausa.
        </p>
      ) : null}

      {error ? <NegativaPty negativa={error} /> : null}
    </section>
  );
}
