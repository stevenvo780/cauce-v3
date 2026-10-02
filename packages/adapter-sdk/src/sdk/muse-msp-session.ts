import {
  Session, type Connection, type HostDeathNotification, type SessionDurabilityProfile,
  type TurnOutcome,
} from "@muse-code/sdk";
import {
  MuseMspFault, MuseTurnEvidence, museIdentifier, museObject, readMuseView, reconcileMuseTurn,
  type MuseWait,
} from "./muse-msp-reconciliation.js";
import type { MuseReasoningEffort } from "./muse-msp-runner.js";

export interface MuseMspTelemetry {
  readonly event: "muse_host_initialized" | "muse_model_selection" | "muse_turn_admitted" | "muse_turn_reconciled"
    | "muse_preflight_started" | "muse_preflight_finished";
  readonly phase?: string;
  readonly budget_ms?: number;
  readonly elapsed_ms?: number;
  readonly outcome?: "completed" | "failed";
  readonly server_version?: string;
  readonly schema_fingerprint?: string;
  readonly fingerprint_warning?: boolean;
  readonly model?: string;
  readonly provider?: string;
  readonly catalog_source?: string;
  readonly requested_effort?: MuseReasoningEffort;
  readonly supported_efforts?: readonly MuseReasoningEffort[];
  readonly command_id?: string;
  readonly turn_id?: string;
}

const EFFORTS: ReadonlySet<string> = new Set([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
]);

function effort(value: unknown): MuseReasoningEffort {
  if (typeof value !== "string" || !EFFORTS.has(value)) {
    throw new MuseMspFault("MUSE_CATALOG_INVALID", "Muse catalog contains an invalid reasoning effort");
  }
  return value as MuseReasoningEffort;
}

function reasoningList(value: unknown): readonly MuseReasoningEffort[] {
  if (!Array.isArray(value) || value.length > EFFORTS.size) {
    throw new MuseMspFault("MUSE_CATALOG_INVALID", "Muse catalog contains invalid reasoning variants");
  }
  const variants = value.map(effort);
  if (new Set(variants).size !== variants.length) {
    throw new MuseMspFault("MUSE_CATALOG_INVALID", "Muse catalog repeats a reasoning tier");
  }
  return variants;
}

export function museReasoningVariants(
  value: unknown, descriptions?: unknown,
): readonly MuseReasoningEffort[] | undefined {
  const described = descriptions === undefined ? undefined : reasoningList(
    Array.isArray(descriptions) ? descriptions.map((row) => museObject(row).tier) : descriptions,
  );
  if (value === "unknown") {
    if (described !== undefined) {
      throw new MuseMspFault("MUSE_CATALOG_INVALID", "Muse unknown variants contradict its described reasoning tiers");
    }
    return undefined;
  }
  if (value === undefined) return described;
  const variants = reasoningList(value);
  let prior = -1;
  for (const tier of described ?? []) {
    const position = variants.indexOf(tier);
    if (position <= prior) {
      throw new MuseMspFault("MUSE_CATALOG_INVALID", "Muse described tiers are not an ordered subset of its variants");
    }
    prior = position;
  }
  return variants;
}

export class MuseMspSession {
  private readonly session: Session;
  private readonly buffered: { method: string; params: unknown }[] = [];
  private bufferedBytes = 0;
  private evidence: MuseTurnEvidence | undefined;
  private fault: MuseMspFault | undefined;
  private resolveFault!: (fault: MuseMspFault) => void;
  private readonly faultObserved = new Promise<MuseMspFault>((resolve) => { this.resolveFault = resolve; });
  private closing = false;
  private submitting = false;
  private progressAt = 0;
  private readonly progressCursors = new Set<string>();
  private progressCursorBytes = 0;
  private preflightPhase: string | undefined;

  constructor(
    private readonly connection: Connection,
    readonly sessionId: string,
    durability: SessionDurabilityProfile,
    private readonly telemetry: (event: MuseMspTelemetry) => void,
  ) {
    this.session = new Session({ connection, sessionId, durability });
    connection.onNotification((event) => {
      if (this.closing) return;
      try {
        if (event.params === undefined) return;
        const params = museObject(event.params);
        if (params.sessionId !== sessionId) return;
        if (event.method === "item/delta" && typeof params.viewCursor === "string"
          && this.progressCursors.has(params.viewCursor)) return;
        if (event.method === "session/viewHealthChanged") {
          if (params.health === "unavailable") {
            this.observeFault(new MuseMspFault("MUSE_VIEW_UNAVAILABLE", "Muse live session view became unavailable"));
          }
          return;
        }
        if (event.method === "session/statusChanged") {
          if (this.submitting && params.status === "idle") {
            this.observeFault(new MuseMspFault("MUSE_TURN_IDLE_WITHOUT_TERMINAL", "Muse became idle without delivering the turn terminal"));
          }
          return;
        }
        if (this.submitting && event.method !== "item/delta") {
          if (this.evidence === undefined) {
            this.bufferedBytes += Buffer.byteLength(JSON.stringify(params), "utf8");
            if (this.buffered.length >= 2_048 || this.bufferedBytes > 16 * 1024 * 1024) {
              throw new MuseMspFault("MUSE_EVENT_BUFFER_LIMIT", "Muse sent too many events before its turn acknowledgement");
            }
            this.buffered.push({ method: event.method, params });
          } else this.evidence.observe(event.method, params);
        }
        const applied = this.session.apply(event);
        const change = applied.fold;
        if (this.evidence !== undefined && ((change.kind === "item"
          && change.outcome.kind !== "ignoredStaleRevision") || (change.kind === "itemDelta"
          && change.outcome.kind === "appended" && typeof params.delta === "string" && params.delta.length > 0))) {
          const item = this.session.fold.items.get(change.outcome.itemId);
          if (item?.turnId === this.evidence.turnId && this.observeProgressCursor(params.viewCursor)) {
            this.progressAt = Date.now();
          }
        }
        void applied.io;
      } catch (error) {
        this.observeFault(error instanceof MuseMspFault ? error
          : new MuseMspFault("MUSE_PROTOCOL_FAILED", "Muse session event could not be processed"));
      }
    });
    connection.onProtocolError(() => {
      this.observeFault(new MuseMspFault("MUSE_PROTOCOL_FAILED", "Muse protocol framing or correlation failed"));
    });
    this.session.onGapError(() => {
      this.observeFault(new MuseMspFault("MUSE_GAP_FAILED", "Muse session view gap could not be recovered"));
    });
    this.session.onApproval((approval) => {
      const denial = approval.availableChoices.find((choice) =>
        choice.scope === "once" && (choice.decision === "denied" || choice.decision === "abort"));
      if (denial === undefined) throw new Error("Muse approval offered no denying choice");
      return { choiceId: denial.choiceId };
    });
    this.session.onApprovalError(() => {
      this.observeFault(new MuseMspFault("MUSE_APPROVAL_FAILED", "Muse approval could not be denied"));
    });
    void connection.closed.then(() => { this.hostExited({ kind: "transportEof" }); });
  }

  private observeFault(fault: MuseMspFault): void {
    this.fault ??= fault;
    this.resolveFault(this.fault);
  }

  private observeProgressCursor(value: unknown): boolean {
    if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 4_096) {
      throw new MuseMspFault("MUSE_PROTOCOL_FAILED", "Muse progress has an invalid opaque view cursor");
    }
    if (this.progressCursors.has(value)) return false;
    const bytes = Buffer.byteLength(value, "utf8");
    if (this.progressCursors.size >= 65_536 || this.progressCursorBytes + bytes > 16 * 1024 * 1024) {
      throw new MuseMspFault("MUSE_PROGRESS_CURSOR_LIMIT", "Muse progress exceeded its bounded cursor budget");
    }
    this.progressCursors.add(value);
    this.progressCursorBytes += bytes;
    return true;
  }

  hostExited(exit: HostDeathNotification): void {
    if (this.closing) return;
    this.session.hostExited(exit);
    this.observeFault(new MuseMspFault("MUSE_HOST_EXITED", "Muse host exited before the result was collected"));
  }

  close(): void {
    this.closing = true;
  }

  get lastProgressAt(): number { return this.progressAt; }
  get lastPreflightPhase(): string | undefined { return this.preflightPhase; }

  private throwIfFaulted(): void {
    if (this.fault !== undefined) throw this.fault;
  }

  async preflight<T>(promise: Promise<T>, wait: MuseWait, phase: string, budgetMs = 5_000): Promise<T> {
    this.throwIfFaulted();
    this.preflightPhase = phase;
    const started = Date.now();
    const pending = wait(Promise.race([
      promise,
      this.faultObserved.then((fault) => Promise.reject(fault)),
    ]), budgetMs);
    this.telemetry({ event: "muse_preflight_started", phase, budget_ms: budgetMs });
    try {
      const value = await pending;
      this.throwIfFaulted();
      this.telemetry({ event: "muse_preflight_finished", phase, elapsed_ms: Date.now() - started, outcome: "completed" });
      return value;
    } catch (error) {
      this.telemetry({ event: "muse_preflight_finished", phase, elapsed_ms: Date.now() - started, outcome: "failed" });
      throw error;
    }
  }

  async configure(
    model: string | undefined,
    reasoningEffort: MuseReasoningEffort | undefined,
    approvalMode: "allowAll" | "onRequest" | "denyUnmatched",
    wait: MuseWait,
  ): Promise<{ viewCursor: string; workspace: unknown }> {
    const view = await this.preflight(readMuseView(this.connection, this.sessionId, wait), wait, "session/read");
    const catalog = await this.preflight(this.connection.request("model/list", { sessionId: this.sessionId }), wait, "model/list");
    if (!Array.isArray(catalog.models)) {
      throw new MuseMspFault("MUSE_CATALOG_INVALID", "Muse returned an invalid model catalog");
    }
    const requested = model ?? view.session.modelId;
    const rows = catalog.models.map(museObject).filter((row) => row.modelId === requested);
    const selected = rows[0];
    if (rows.length !== 1 || selected === undefined) {
      throw new MuseMspFault("MUSE_MODEL_UNVERIFIED", "Muse catalog does not identify one requested model route");
    }
    const modelId = museIdentifier(selected.modelId);
    const providerId = museIdentifier(selected.providerId);
    const source = museIdentifier(catalog.source);
    if (reasoningEffort !== undefined && source !== "providerCatalog") {
      throw new MuseMspFault("MUSE_EFFORT_UNVERIFIED", "Muse provider has not verified the requested reasoning tier's support");
    }
    const variants = museReasoningVariants(selected.variants, selected.reasoningEffortVariants);
    if (selected.defaultReasoningEffort !== undefined) {
      const defaultEffort = effort(selected.defaultReasoningEffort);
      if (variants !== undefined && !variants.includes(defaultEffort)) {
        throw new MuseMspFault("MUSE_CATALOG_INVALID", "Muse catalog default is absent from its reasoning variants");
      }
    }
    if (reasoningEffort !== undefined) {
      if (variants === undefined) {
        throw new MuseMspFault("MUSE_EFFORT_UNVERIFIED", "Muse catalog does not disclose the requested reasoning tier's support");
      }
      if (!variants.includes(reasoningEffort)) {
        throw new MuseMspFault("MUSE_REASONING_UNSUPPORTED", "Muse selected model does not support the requested reasoning tier");
      }
    }
    const selection: Record<string, unknown> = { modelId, providerId };
    if (selected.profileId !== undefined && selected.profileId !== null) {
      selection.profileId = museIdentifier(selected.profileId);
    }
    const changed = await this.preflight(this.connection.command("session/setModel", {
      sessionId: this.sessionId, model: selection,
    }), wait, "session/setModel");
    if (changed.status !== "accepted") {
      throw new MuseMspFault("MUSE_MODEL_UNVERIFIED", "Muse did not accept the catalog model route");
    }
    const mode = await this.preflight(this.connection.command("session/setApprovalMode", {
      sessionId: this.sessionId, mode: approvalMode,
    }), wait, "session/setApprovalMode");
    if (mode.status !== "accepted" || museObject(mode.effectiveMode).mode !== approvalMode) {
      throw new MuseMspFault("MUSE_APPROVAL_UNVERIFIED", "Muse did not confirm the requested approval mode");
    }
    this.telemetry({
      event: "muse_model_selection", model: modelId, provider: providerId, catalog_source: source,
      ...(reasoningEffort === undefined ? {} : { requested_effort: reasoningEffort }),
      ...(variants === undefined ? {} : { supported_efforts: variants }),
    });
    return { viewCursor: view.viewCursor, workspace: view.session.workspaceRoot };
  }

  async submit(text: string, reasoningEffort: MuseReasoningEffort | undefined, wait: MuseWait): Promise<string> {
    if (this.fault !== undefined) throw this.fault;
    this.submitting = true;
    const commandId = this.connection.mintCommandId();
    const ack = await wait(this.connection.command("turn/start", {
      sessionId: this.sessionId, input: [{ type: "text", text }], ifBusy: "queue",
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }, { commandId, maxAttempts: 1 }));
    if (ack.status !== "accepted") {
      throw new MuseMspFault("MUSE_TURN_ACK_INVALID", "Muse did not admit the submitted turn");
    }
    const turnId = museIdentifier(ack.turnId);
    this.evidence = new MuseTurnEvidence(this.sessionId, turnId);
    this.progressCursors.clear();
    this.progressCursorBytes = 0;
    this.progressAt = Date.now();
    for (const event of this.buffered.splice(0)) this.evidence.observe(event.method, event.params);
    this.bufferedBytes = 0;
    this.telemetry({ event: "muse_turn_admitted", command_id: commandId, turn_id: turnId });
    return turnId;
  }

  async complete(after: string, wait: MuseWait, recoveryWait: MuseWait = wait): Promise<{ outcome: TurnOutcome; text: string }> {
    const evidence = this.evidence;
    if (evidence === undefined) throw new Error("Muse turn was not admitted");
    const available = (): { outcome: TurnOutcome; text: string } | undefined => {
      try { return evidence.result(); } catch (error) {
        if (error instanceof MuseMspFault && error.code === "MUSE_FINAL_UNVERIFIED") return undefined;
        throw error;
      }
    };
    const finish = (): { outcome: TurnOutcome; text: string } => {
      const result = available();
      if (result === undefined) throw new MuseMspFault("MUSE_TERMINAL_UNVERIFIED", "Muse turn terminal is missing");
      return result;
    };
    if (available() !== undefined) return finish();
    let recovery: Promise<{ outcome: TurnOutcome; text: string }> | undefined;
    const recover = (): Promise<{ outcome: TurnOutcome; text: string }> => recovery ??= (async () => {
      try {
        const result = await recoveryWait(reconcileMuseTurn(this.connection, evidence, after, recoveryWait), 5_000);
        this.telemetry({ event: "muse_turn_reconciled", turn_id: evidence.turnId });
        return result;
      } catch (error) {
        if (available() !== undefined) return finish();
        throw error instanceof MuseMspFault ? error : this.fault
          ?? new MuseMspFault("MUSE_RECONCILIATION_FAILED", "Muse turn reconciliation failed within its read budget");
      }
    })();
    const live = evidence.terminal.then(() => available() === undefined ? recover() : finish());
    const recovered = this.faultObserved.then(() => available() === undefined ? recover() : finish());
    return wait(Promise.race([live, recovered]));
  }
}
