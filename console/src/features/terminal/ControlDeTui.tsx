import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, Undo2 } from 'lucide-react';
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
import { NegativaPty } from './NegativaPty';
import type { PtyChannelState } from './pty-types';

const BOTON = 'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border-0 px-2.5 text-[13px] font-medium bg-brand text-on-brand hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50';
const AVISO = 'm-0 rounded-md bg-warn-soft px-2 py-1 text-xs text-warn-ink';

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
    + '—la explicación del gateway se conserva—, o ya había otra reserva en vuelo para este panel. No se tomó ningún '
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
    quienLoLevanta: 'Vos: reintentá la toma de esta misma sesión. Si vuelve a fallar, cerrá la terminal y '
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
    authority_proof: grant.authority_proof,
  };
}

function explicar(error: unknown): DenegacionExplicada {
  return explicarDenegacionPty({
    texto: error instanceof Error ? error.message : undefined,
    estado: error instanceof TerminalApiError ? error.status : undefined,
    codigo: error instanceof TerminalApiError ? error.code : undefined,
  });
}

function canRetryTake(error: DenegacionExplicada): boolean {
  if (error.codigo !== undefined) {
    return ['agent_busy', 'control_held', 'stale_terminal_owner', 'agent_offline', 'session_limit', 'container_busy'].includes(error.codigo);
  }
  return error.estado === undefined || error.estado >= 500 || error.estado === 408 || error.estado === 429;
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
  /** Opens the writable session; undefined when refused. */
  onAbrirEscritura: () => Promise<TerminalSessionGrant | undefined>;
  onControlCambia: (sostenido: boolean) => void;
}) {
  const api = useApi();
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
  const takeGenerationRef = useRef(0);
  const revokedGenerationRef = useRef(0);
  const grantRef = useRef(grant);
  grantRef.current = grant;
  const enganchadaRef = useRef(sesionEnganchada);
  enganchadaRef.current = sesionEnganchada;
  const estadoRef = useRef(estadoDelCanal);
  estadoRef.current = estadoDelCanal;

  const pendiente = fase !== 'reposo';
  const escrituraBloqueada = error !== undefined && !canRetryTake(error);

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

  useEffect(() => {
    takeGenerationRef.current += 1;
  }, [grant?.session_id, grant?.request_id, grant?.owner_generation, grant?.owner_token]);

  // The relay already took the hold away: posting a release would claim something that did not
  // happen, so the state is dropped WITHOUT a request and the operator is told in Spanish.
  useEffect(() => {
    if (codigoDeCierre !== CIERRE_CONTROL_DEVUELTO) return;
    takeGenerationRef.current += 1;
    revokedGenerationRef.current += 1;
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
    const alCerrarLaPestana = () => { takeGenerationRef.current += 1; soltarEnSilencio(true); };
    window.addEventListener('beforeunload', alCerrarLaPestana);
    return () => {
      window.removeEventListener('beforeunload', alCerrarLaPestana);
      vivoRef.current = false;
      takeGenerationRef.current += 1;
      soltarEnSilencio(false);
    };
  }, [soltarEnSilencio]);


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

  async function tomar(allowBusy = true) {
    if (pendiente || tomandoRef.current || escrituraBloqueada) return;
    tomandoRef.current = true;
    setError(undefined);
    setPerdido(false);
    let postedGeneration: number | undefined;
    try {
      // A writable session already on screen is REUSED: asking for a second one returns a grant the
      // workspace refuses to adopt, and that refusal is what made the second click do nothing.
      const canalMuerto = estadoRef.current === 'closed' || estadoRef.current === 'error';
      const abierta = grantRef.current;
      const reusable = abierta?.target.mode === WRITABLE_TUI_MODE && !canalMuerto ? abierta : undefined;
      let escribible = reusable;
      if (escribible === undefined) {
        setFase('abriendo');
        escribible = await onAbrirEscritura();
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
      postedGeneration = takeGenerationRef.current;
      const revokedGeneration = revokedGenerationRef.current;
      const owner = dueno(escribible);
      const takeApi = apiRef.current;
      const tomado = await tomarControlDeTui(
        escribible.session_id, owner, takeApi, allowBusy,
      );
      const current = grantRef.current;
      const sameOwner = current?.session_id === escribible.session_id && current.request_id === owner.request_id
        && current.owner_generation === owner.owner_generation && current.owner_token === owner.owner_token
        && current.authority_proof === owner.authority_proof;
      if (!sigueVivo() || postedGeneration !== takeGenerationRef.current || !sameOwner
        || estadoRef.current === 'closed' || estadoRef.current === 'error') {
        if (revokedGeneration === revokedGenerationRef.current) {
          void devolverControlDeTui(escribible.session_id, owner, takeApi).catch(() => undefined);
        }
        return;
      }
      porDevolverRef.current = { sessionId: escribible.session_id, owner };
      recordarCsrf();
      setReintentable(false);
      setArriendo(tomado);
    } catch (fallo) {
      if (!sigueVivo() || (postedGeneration !== undefined && postedGeneration !== takeGenerationRef.current)) return;
      const explicada = explicar(fallo);
      setError(explicada);
      setReintentable(canRetryTake(explicada));
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

  const tomarRef = useRef(tomar);
  tomarRef.current = tomar;
  const intentoAutomaticoRef = useRef<string>(undefined);
  useEffect(() => {
    if (!puedeEscribir || pidiendoSesion || !sesionEnganchada || grant?.target.mode !== WRITABLE_TUI_MODE) return;
    const incarnation = JSON.stringify([grant.session_id, grant.request_id, grant.owner_generation, grant.owner_token]);
    if (intentoAutomaticoRef.current === incarnation) return;
    intentoAutomaticoRef.current = incarnation;
    void tomarRef.current();
  }, [grant?.session_id, grant?.request_id, grant?.owner_generation, grant?.owner_token, grant?.target.mode, pidiendoSesion, puedeEscribir, sesionEnganchada]);

  if (!puedeEscribir) return null;

  return (
    <section
      aria-label="Control de la TUI"
      data-sostenido={arriendo ? true : undefined}
      data-fase={fase === 'reposo' ? undefined : fase}
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-surface px-3 py-1.5"
    >
      {arriendo ? (
        <>
          <p
            className="m-0 inline-flex items-center gap-1.5 rounded-md bg-ok-soft px-2 py-1 text-xs font-medium text-ok-ink"
            role="status"
            title={`Tenés el teclado de esta TUI. ${vencimiento(arriendo)}`}
          >
            <KeyRound size={13} aria-hidden="true" />Tenés el teclado de esta TUI.
          </p>
          {arriendo.dudoso.length > 0 ? (
            <p className={AVISO} role="status">
              El gateway acreditó la toma con un recibo incompleto (sin {arriendo.dudoso.join(', ')}). El teclado es tuyo y la devolución queda registrada igual.
            </p>
          ) : null}
          <button
            className={BOTON}
            type="button"
            onClick={() => void devolver()}
            title="Suelta el teclado y el bus vuelve a entregarle a este alias."
          >
            <Undo2 size={14} aria-hidden="true" />Devolver el control
          </button>
        </>
      ) : (
        <button
          className={BOTON}
          type="button"
          disabled={pendiente || pidiendoSesion || escrituraBloqueada}
          title={escrituraBloqueada ? error.titulo : `Usar el teclado de ${alias}; los mensajes del bus quedan en cola mientras tengas el control.`}
          onClick={() => void tomar()}
        >
          <KeyRound size={14} aria-hidden="true" />{pendiente
            ? ETIQUETA_DE_FASE[fase]
            : escrituraBloqueada ? 'Escritura no disponible' : reintentable ? 'Reintentar la toma' : 'Tomar el control'}
        </button>
      )}

      {perdido ? (
        <p className={AVISO} role="status">
          Esta sesión ya no tiene el control de la TUI de {alias}. Otra sesión puede mantener el bus en pausa.
        </p>
      ) : null}

      {error ? <div className="basis-full"><NegativaPty negativa={error} /></div> : null}
    </section>
  );
}
