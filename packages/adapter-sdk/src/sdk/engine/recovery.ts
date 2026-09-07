import type { InboxRecord } from "../durable-store.js";
import { AdapterError } from "../errors.js";

export function interruptedStartedError(record: InboxRecord): AdapterError {
  // `preinvoke-v1` does not free the harness when persisting the local marker: it first waits for
  // the gateway to apply it and for ITS exact receipt to be fsynced in this record. That's why a
  // marker without a receipt still proves preflight, even if the ACK was lost or inconclusive. A
  // legacy record doesn't offer that proof; a receipt does open the ambiguous window between
  // freeing the waiter, invoking the process, and persisting its terminal.
  const executionConfirmed = record.execution_intent_receipt_event_id !== undefined;
  return record.execution_intent_protocol === "preinvoke-v1" && !executionConfirmed
    ? new AdapterError(
        "INTERRUPTED_PREFLIGHT",
        "Adapter stopped before the remote execution intent receipt was committed; the harness was not invoked",
        true,
      )
    : new AdapterError(
        "INTERRUPTED_AMBIGUOUS",
        "Previous harness process was interrupted after execution was committed; completion state is unknown",
        false,
      );
}

/**
 * ¿La entrega recuperada ya está muerta en el bus?
 *
 * POR QUÉ EXISTE. Medido el 2026-09-07 con kratos: al reiniciar el adaptador a las 02:25,
 * `recover()` reejecutó una entrega de las 23:40 que el bus había matado a las 23:47 —tres horas
 * antes—. El arnés la contestó a las 02:58 y su sobre salió con esa correlación muerta: nadie pudo
 * cosecharlo, el trabajo (una revisión ya publicada) quedó huérfano, y la entrega VIVA de ese
 * momento se pasó 176 minutos esperando un sobre que jamás llevaría su correlación. Un turno
 * entero gastado en contestarle a un muerto, y el alias parado mientras tanto.
 *
 * El plazo de ACK es la frontera dura: pasado `ack_deadline_at`, el store ya dio la entrega por
 * muerta y ningún ACK posterior se admite. Reejecutarla no puede terminar bien, sólo gastar el
 * turno y ensuciar la transcripción con un sobre que no se puede casar.
 *
 * Se compara contra el reloj inyectado, no contra `Date.now()`, para que sea testeable. Si la
 * fecha falta o no se puede leer, devuelve `false`: ante la duda NO se descarta trabajo.
 */
export function entregaVencidaAlRecuperar(
  request: { readonly ack_deadline_at?: string },
  ahora: Date,
): boolean {
  const limite = Date.parse(request.ack_deadline_at ?? "");
  if (!Number.isFinite(limite)) return false;
  return limite <= ahora.getTime();
}

/** El descarte de una entrega ya muerta: nunca `retryable`, porque el bus no la va a aceptar. */
export function vencidaAlRecuperarError(record: InboxRecord): AdapterError {
  return new AdapterError(
    "STALE_ON_RECOVERY",
    `Recovered delivery ${record.delivery_id} was already past its ACK deadline when the adapter`
      + " restarted: it is terminal on the bus and re-executing it would only waste a turn and"
      + " produce an envelope nobody can correlate",
    false,
  );
}
