export class AdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export class MalformedOutputError extends AdapterError {
  constructor(message: string) {
    super("MALFORMED_OUTPUT", message, false);
    this.name = "MalformedOutputError";
  }
}

export class ProcessExecutionError extends AdapterError {
  constructor(code: string, message: string, retryable: boolean) {
    super(code, message, retryable);
    this.name = "ProcessExecutionError";
  }
}

export class StaleEpochError extends AdapterError {
  constructor(received: number, current: number) {
    super("STALE_EPOCH", `Rejected epoch ${received}; active epoch is ${current}`, false);
    this.name = "StaleEpochError";
  }
}

export class ConsumerLeaseError extends AdapterError {
  constructor(message: string) {
    super("CONSUMER_LEASE", message, true);
    this.name = "ConsumerLeaseError";
  }
}

export function asAdapterError(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  return new AdapterError("INTERNAL", "Internal adapter failure", true);
}
