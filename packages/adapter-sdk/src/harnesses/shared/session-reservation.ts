import { abortReason } from "./errors.js"; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import type { HarnessSessionReservation } from "../../contracts/harness.js";
import { signalAborted } from "../../runtime-state.js";

export class SessionReservation implements HarnessSessionReservation {
  private released = false;

  constructor(
    readonly key: string,
    private readonly previous: Promise<void>,
    private readonly releaseTurn: () => void,
  ) {}

  wait(signal: AbortSignal): Promise<void> {
    return waitForSessionTurn(this.previous, signal);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.releaseTurn();
  }
}

async function waitForSessionTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal);
  await new Promise<void>((resolveWait, rejectWait) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => { settle(() => { rejectWait(abortReason(signal)); }); };
    signal.addEventListener("abort", onAbort, { once: true });
    void previous.then(
      () => { settle(resolveWait); },
      () => { settle(resolveWait); },
    );
  });
  if (signalAborted(signal)) throw abortReason(signal);
}
