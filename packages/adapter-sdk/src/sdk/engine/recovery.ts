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
