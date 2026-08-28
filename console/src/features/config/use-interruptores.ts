import { useRef, useState } from 'react';
import type { ConfigMutation } from '../../api/types';
import { textoRecarga, type ConfigChangeOutcome, type EstadoRecarga } from './config-change';
import type { Interruptor } from './interruptores';

/**
 * **Switch behavior: paint instantly and REVERT ONLY if the server rejects.**
 *
 * This is what must be tested for this lane. An optimistic switch with no rollback is worse than
 * a button: a button that fails at least leaves the row as it was, whereas a switch that stays
 * flipped after a 409 is telling the operator that a permission is granted when the database says
 * it is not. Nothing refutes that lie until someone reloads the page — and by then a decision has
 * already been made on top of it.
 *
 * The rule, without exceptions:
 *  - while the write is in flight, paint what the operator asked for and leave the control
 *    `aria-busy`;
 *  - if the server responds OK AND the reread arrived, drop the optimistic value: the fresh
 *    snapshot rules — that is what the database actually holds (and may differ from what was
 *    requested if another operator wrote in the meantime);
 *  - if the server responds OK but the reread did NOT arrive, keep what was requested and state
 *    plainly that the table may be stale;
 *  - if the server REJECTS, drop the optimistic value — i.e. the switch returns on its own to what
 *    the snapshot says — and show the reason **from the server**, not one invented here, with a
 *    button to retry exactly the same mutation.
 */

export interface FalloDeInterruptor {
  interruptor: Interruptor;
  /** The reason as the server reported it. Never a generic "could not" message. */
  motivo: string;
  /** The revision under which this failure is the latest thing that happened. */
  revision: number | undefined;
}

export interface ConfirmacionDeInterruptor {
  interruptor: Interruptor;
  texto: string;
}

export interface AvisoDeInterruptor {
  coleccion: string;
  text: string;
  tone: 'success' | 'parcial';
  revision: number | undefined;
}

export interface ControlDeInterruptores {
  /** What the cell must paint: the optimistic value if there is one, otherwise the server's. */
  valorPintado: (interruptor: Interruptor) => boolean;
  enVuelo: (clave: string) => boolean;
  fallo: (clave: string) => FalloDeInterruptor | undefined;
  avisoDe: (coleccion: string) => { text: string; tone: 'success' | 'parcial' } | undefined;
  confirmacion: ConfirmacionDeInterruptor | undefined;
  /** A click on the switch. Confirms only if the switch requires it. */
  pulsar: (interruptor: Interruptor) => void;
  confirmar: () => void;
  cancelar: () => void;
  reintentar: (clave: string) => void;
  /** On tab change: banners belong to the screen that produced them. */
  limpiar: () => void;
}

/**
 * The revision the snapshot holds AFTER a write: the reread if it arrived, otherwise the one it
 * already had. Same criterion as `ConfigPage`, so a banner does not outlive the data that
 * refutes it.
 */
function revisionTrasEscribir(recarga: EstadoRecarga | undefined, actual: number | undefined): number | undefined {
  if (recarga?.releido) return recarga.revision;
  return actual;
}

function sinClave<T>(mapa: Record<string, T>, clave: string): Record<string, T> {
  if (!Object.hasOwn(mapa, clave)) return mapa;
  const next: Record<string, T> = {};
  for (const [k, v] of Object.entries(mapa)) {
    if (k !== clave) next[k] = v;
  }
  return next;
}

export function useInterruptores(
  escribir: (mutation: ConfigMutation) => Promise<ConfigChangeOutcome>,
  revisionActual: number | undefined,
): ControlDeInterruptores {
  const [optimista, setOptimista] = useState<Record<string, boolean>>({});
  const [volando, setVolando] = useState<Record<string, true>>({});
  const [fallos, setFallos] = useState<Record<string, FalloDeInterruptor>>({});
  const [confirmacion, setConfirmacion] = useState<ConfirmacionDeInterruptor>();
  const [aviso, setAviso] = useState<AvisoDeInterruptor>();

  // "Latest reference" pattern: handlers are passed to the DOM and must not freeze either the
  // expected revision or the page's `change`; without it, the second click would send the first's.
  const ultimo = useRef({ escribir, revisionActual });
  ultimo.current = { escribir, revisionActual };

  async function aplicar(interruptor: Interruptor) {
    const { clave } = interruptor;
    const pedido = !interruptor.valor;
    setFallos((actual) => sinClave(actual, clave));
    setAviso(undefined);
    setOptimista((actual) => ({ ...actual, [clave]: pedido }));
    setVolando((actual) => ({ ...actual, [clave]: true }));
    let desenlace: ConfigChangeOutcome;
    try {
      desenlace = await ultimo.current.escribir(interruptor.mutation);
    } catch (error) {
// `change()` does not throw, but if it ever did, a switch stuck on after a write that blew up is
        // exactly the lie this module exists to prevent. It reverts anyway.
      desenlace = {
        ok: false, conflict: false,
        message: error instanceof Error ? error.message : 'Cambio rechazado: UNKNOWN',
      };
    }
    setVolando((actual) => sinClave(actual, clave));
    const revision = revisionTrasEscribir(desenlace.recarga, ultimo.current.revisionActual);

    if (!desenlace.ok) {
      // ⬅️ THE REVERT. Dropping the optimistic value returns the cell to what the snapshot says,
      // which is what the database holds. Without this line the switch stays painted in a state
      // nobody saved.
      setOptimista((actual) => sinClave(actual, clave));
      setFallos((actual) => ({
        ...actual,
        [clave]: { interruptor, revision, motivo: desenlace.message + textoRecarga(desenlace.recarga) },
      }));
      return;
    }

    if (desenlace.recarga && !desenlace.recarga.releido) {
      // It was saved, but could not be verified by rereading. What was requested is kept — the server
      // said it applied it — and a notice warns that the rest of the table may be stale.
      setAviso({
        coleccion: interruptor.coleccion, tone: 'parcial', revision,
        text: `${interruptor.descripcion}: el servidor lo aplicó en la revisión `
          + `${String(desenlace.result.revision ?? 'UNKNOWN')}.${textoRecarga(desenlace.recarga)}`,
      });
      return;
    }

    setOptimista((actual) => sinClave(actual, clave));
    setAviso({
      coleccion: interruptor.coleccion, tone: 'success', revision,
      text: `${interruptor.descripcion}: aplicado en la revisión `
        + `${String(desenlace.result.revision ?? 'UNKNOWN')} (${desenlace.result.summary ?? 'sin resumen del servidor'}).`
        + textoRecarga(desenlace.recarga),
    });
  }

  return {
    valorPintado: (interruptor) => (Object.hasOwn(optimista, interruptor.clave)
      ? optimista[interruptor.clave]
      : interruptor.valor),
    enVuelo: (clave) => Object.hasOwn(volando, clave),
    // A banner belongs to the state that produced it: if the snapshot shifted underneath — another
    // operator, "Refresh", another write — it stops being shown instead of continuing to assert
    // itself.
    fallo: (clave) => {
      const registrado = Object.hasOwn(fallos, clave) ? fallos[clave] : undefined;
      return registrado && registrado.revision === revisionActual ? registrado : undefined;
    },
    avisoDe: (coleccion) => (aviso?.coleccion === coleccion && aviso.revision === revisionActual
      ? { text: aviso.text, tone: aviso.tone }
      : undefined),
    confirmacion,
    pulsar: (interruptor) => {
      if (interruptor.confirmar !== undefined) {
        setAviso(undefined);
        setConfirmacion({ interruptor, texto: interruptor.confirmar });
        return;
      }
      void aplicar(interruptor);
    },
    confirmar: () => {
      const pedida = confirmacion;
      setConfirmacion(undefined);
      if (pedida) void aplicar(pedida.interruptor);
    },
    cancelar: () => { setConfirmacion(undefined); },
    reintentar: (clave) => {
      const registrado = Object.hasOwn(fallos, clave) ? fallos[clave] : undefined;
      if (registrado) void aplicar(registrado.interruptor);
    },
    limpiar: () => {
      setConfirmacion(undefined);
      setFallos({});
      setAviso(undefined);
    },
  };
}
