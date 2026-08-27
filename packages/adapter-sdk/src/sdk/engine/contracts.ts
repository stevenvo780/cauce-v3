import type { ProfileRuntimeAdoptionEvidence } from "@cauce/protocol";
import type { HarnessAdapter, RuntimeProfileMeasurement } from "../../harnesses/shared.js";
import type { DurableStore } from "../durable-store.js";
import type { AdapterLogger, Clock, Delivery, DeliveryEvent } from "../types.js";

export type EventPublisher = (event: DeliveryEvent) => Promise<void>;
export type ExecutionIntentPublisher = (
  event: DeliveryEvent,
  signal: AbortSignal,
  timeoutMs: number,
) => Promise<void>;

export const DEFAULT_AGENTIC_TIMEOUT_MS = 24 * 60 * 60_000;
export const MAX_AGENT_EXECUTION_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
/**
 * Techo absoluto de la espera en el candado de sesión, medido desde que la entrega se acepta.
 * Se acota además por el `timeout_ms` configurado en la entrega.
 */
export const DEFAULT_QUEUE_WAIT_TIMEOUT_MS = 6 * 60 * 60_000;

interface AdapterEngineBaseOptions {
  readonly store: DurableStore;
  readonly harness: HarnessAdapter;
  readonly publish: EventPublisher;
  readonly logger?: AdapterLogger;
  readonly ownTenantId?: string;
  readonly ownRoom?: string;
  readonly defaultTimeoutMs?: number;
  /** Test/diagnostic override; production derives renewal cadence from the authenticated claim. */
  readonly claimRenewalMs?: number;
  /** Test/diagnostic override; production derives the fail-closed watchdog from the claim. */
  readonly claimWatchdogMs?: number;
  /**
   * Techo absoluto de la espera en el candado de sesión. Sin override se usa
   * `min(timeout pedido por el emisor, DEFAULT_QUEUE_WAIT_TIMEOUT_MS)`.
   */
  readonly queueWaitTimeoutMs?: number;
  readonly clock?: Clock;
}

export type AdapterEngineOptions = AdapterEngineBaseOptions & (
  | {
      /** Resolves only after the gateway durably applies/duplicates the exact intent event. */
      readonly publishExecutionIntent: ExecutionIntentPublisher;
      readonly executionIntentMode?: never;
    }
  | {
      /** Explicit bypass for isolated engine tests; no production constructor may use it. */
      readonly executionIntentMode: "local-test-only";
      readonly publishExecutionIntent?: never;
    }
);

export function profileAdoptionFor(
  delivery: Delivery,
  measured: RuntimeProfileMeasurement | undefined,
): ProfileRuntimeAdoptionEvidence | undefined {
  const contract = delivery.profile_runtime_contract;
  if (contract === undefined || measured === undefined
    || contract.documents.length !== measured.documents.length) return undefined;
  const observed = new Map(measured.documents.map((document) => [document.path, document.sha256]));
  for (const document of contract.documents) {
    if (document.path.slice(document.path.lastIndexOf("/") + 1) !== document.name
      || observed.get(document.path) !== document.sha) return undefined;
    observed.delete(document.path);
  }
  if (observed.size !== 0) return undefined;
  return {
    evidence: "adapter_delivery",
    revision: contract.revision,
    generation: contract.generation,
    documents: contract.documents,
  };
}
