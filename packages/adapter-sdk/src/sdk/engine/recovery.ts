import type { InboxRecord } from "../durable-store.js";
import { AdapterError } from "../errors.js";

export function interruptedStartedError(record: InboxRecord): AdapterError {
  // `preinvoke-v1` no libera el harness al persistir el marker local: espera primero que el
  // gateway lo aplique y que SU receipt exacto quede fsyncado en este registro. Por eso marker
  // sin receipt sigue demostrando preflight, incluso si el ACK se perdió o fue inconcluso. Un
  // registro legado no ofrece esa prueba; un receipt sí abre la ventana ambigua entre liberar
  // el waiter, invocar el proceso y persistir su terminal.
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
