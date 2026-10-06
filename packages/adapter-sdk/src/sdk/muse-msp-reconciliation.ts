import type { Connection, FoldedItem, TurnOutcome } from "@muse-code/sdk";

export type MuseWait = <T>(promise: Promise<T>, budgetMs?: number) => Promise<T>;

export class MuseDeadlineError extends Error {}
export class MuseAbortError extends Error {}

export class MuseMspFault extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MuseMspFault";
  }
}

export function museObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MuseMspFault("MUSE_PROTOCOL_FAILED", "Muse returned an invalid protocol object");
  }
  return value as Record<string, unknown>;
}

export function museIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:/+-]{1,512}$/u.test(value)) {
    throw new MuseMspFault("MUSE_PROTOCOL_FAILED", "Muse returned an invalid protocol identifier");
  }
  return value;
}

function museCursor(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4_096) {
    throw new MuseMspFault("MUSE_PROTOCOL_FAILED", "Muse returned an invalid view cursor");
  }
  return value;
}

function durableRange(value: unknown): void {
  const range = museObject(value);
  const first = museObject(range.first);
  const last = museObject(range.last);
  museIdentifier(first.id);
  museIdentifier(last.id);
  if (!Number.isSafeInteger(first.sequence) || !Number.isSafeInteger(last.sequence)
    || (first.sequence as number) < 0 || (last.sequence as number) < (first.sequence as number)) {
    throw new MuseMspFault("MUSE_TERMINAL_UNVERIFIED", "Muse did not provide durable record positions");
  }
  const stream = museObject(range.stream);
  museIdentifier(stream.id);
  museIdentifier(stream.kind);
}

export interface MuseView {
  readonly session: Record<string, unknown>;
  readonly viewCursor: string;
}

export async function readMuseView(
  connection: Connection, sessionId: string, wait: MuseWait, readBudgetMs = 5_000,
): Promise<MuseView> {
  const read = await wait(connection.request("session/read", { sessionId, excludeItems: false }), readBudgetMs);
  const session = museObject(read.session);
  if (session.sessionId !== sessionId) {
    throw new MuseMspFault("MUSE_FOREIGN_VIEW", "Muse read returned another session");
  }
  const history = museObject(read.history);
  if (history.mode === "none") {
    if (history.noneReason === "projectionUnavailable") {
      throw new MuseMspFault("MUSE_VIEW_UNAVAILABLE", "Muse session projection is unavailable");
    }
    if (history.noneReason === "projectionReadLimit") {
      const probe = await wait(connection.request("view/page", {
        sessionId, cursor: museCursor(read.viewCursor), limit: 1,
      }), 5_000);
      if (!Array.isArray(probe.events) || probe.events.length > 1) {
        throw new MuseMspFault("MUSE_PROTOCOL_FAILED", "Muse returned an invalid health probe page");
      }
      for (const raw of probe.events) {
        if (museObject(museObject(raw).params).sessionId !== sessionId) {
          throw new MuseMspFault("MUSE_FOREIGN_VIEW", "Muse health probe returned another session");
        }
      }
    } else if (!["excluded", "cursorSuffix", "historyBudget"].includes(String(history.noneReason))) {
      throw new MuseMspFault("MUSE_VIEW_HEALTH_UNKNOWN", "Muse did not disclose why its history is unavailable");
    }
  } else if (!["inline", "snapshot", "anchoredSnapshot"].includes(String(history.mode))) {
    throw new MuseMspFault("MUSE_VIEW_HEALTH_UNKNOWN", "Muse returned an unknown history mode");
  }
  return { session, viewCursor: museCursor(read.viewCursor) };
}

export class MuseTurnEvidence {
  private readonly messages = new Map<string, FoldedItem>();
  private outcome: TurnOutcome | undefined;
  private observedStart = false;
  private resolveTerminal!: () => void;
  readonly terminal = new Promise<void>((resolve) => { this.resolveTerminal = resolve; });

  constructor(readonly sessionId: string, readonly turnId: string) {}

  observe(method: string, raw: unknown): void {
    const params = museObject(raw);
    if (params.sessionId !== this.sessionId) {
      throw new MuseMspFault("MUSE_FOREIGN_VIEW", "Muse view event belongs to another session");
    }
    if (method.startsWith("item/")) {
      const item = museObject(params.item);
      if (item.turnId !== this.turnId || item.kind !== "agentMessage") return;
      const id = museIdentifier(item.itemId);
      if (!Number.isSafeInteger(item.revision) || (item.revision as number) < 1) {
        throw new MuseMspFault("MUSE_PROTOCOL_FAILED", "Muse message has an invalid revision");
      }
      if (typeof item.status !== "string" || (item.text !== undefined && typeof item.text !== "string")) {
        throw new MuseMspFault("MUSE_PROTOCOL_FAILED", "Muse message has an invalid payload");
      }
      if (item.truncated !== undefined && typeof item.truncated !== "boolean") {
        throw new MuseMspFault("MUSE_PROTOCOL_FAILED", "Muse message has an invalid truncation flag");
      }
      if (item.status === "completed") durableRange(params.sourceRange);
      if ((this.messages.get(id)?.revision ?? 0) < (item.revision as number)) {
        this.messages.set(id, item as unknown as FoldedItem);
      }
      return;
    }
    if (params.turnId !== this.turnId) return;
    if (method === "turn/started") this.observedStart = true;
    if (method !== "turn/completed" && method !== "turn/unqueued") return;
    durableRange(params.sourceRange);
    if (method === "turn/completed") {
      museIdentifier(params.terminal);
      if (params.error !== undefined) {
        const error = museObject(params.error);
        if (typeof error.message !== "string") {
          throw new MuseMspFault("MUSE_PROTOCOL_FAILED", "Muse terminal has an invalid error");
        }
      }
      this.outcome ??= { kind: "completed", observedStart: this.observedStart, params } as unknown as TurnOutcome;
    } else {
      this.outcome ??= { kind: "unqueued", params } as unknown as TurnOutcome;
    }
    this.resolveTerminal();
  }

  result(): { outcome: TurnOutcome; text: string } | undefined {
    if (this.outcome === undefined) return undefined;
    const messages = [...this.messages.values()].filter((item) => item.status === "completed");
    const final = messages.at(-1);
    if (final?.truncated === true) {
      throw new MuseMspFault("MUSE_OUTPUT_TRUNCATED", "Muse final answer was truncated by the session view");
    }
    const text = final?.text ?? "";
    if (this.outcome.kind === "completed" && this.outcome.params.terminal === "completed"
      && text.length === 0) {
      throw new MuseMspFault("MUSE_FINAL_UNVERIFIED", "Muse completed turn supplied no complete final answer");
    }
    if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) {
      throw new MuseMspFault("MUSE_OUTPUT_TOO_LARGE", "Muse final answer exceeded the bounded output budget");
    }
    return { outcome: this.outcome, text };
  }
}

export async function reconcileMuseTurn(
  connection: Connection,
  evidence: MuseTurnEvidence,
  after: string,
  wait: MuseWait,
): Promise<{ outcome: TurnOutcome; text: string }> {
  await readMuseView(connection, evidence.sessionId, wait);
  let cursor = after;
  const seen = new Set([cursor]);
  for (let page = 0; page < 64; page += 1) {
    const result = await wait(connection.request("view/page", {
      sessionId: evidence.sessionId, cursor, limit: 1_000,
    }), 5_000);
    if (!Array.isArray(result.events) || result.events.length > 1_000) {
      throw new MuseMspFault("MUSE_PROTOCOL_FAILED", "Muse returned an invalid view page");
    }
    for (const raw of result.events) {
      const event = museObject(raw);
      const params = museObject(event.params);
      if (params.sessionId !== evidence.sessionId) {
        throw new MuseMspFault("MUSE_FOREIGN_VIEW", "Muse page returned another session");
      }
      if (typeof event.method !== "string") {
        throw new MuseMspFault("MUSE_PROTOCOL_FAILED", "Muse page has an invalid event method");
      }
      museCursor(params.viewCursor);
      if (event.method !== "item/delta") evidence.observe(event.method, params);
    }
    const terminal = evidence.result();
    if (terminal !== undefined) return terminal;
    if (result.nextCursor === null) break;
    const next = museCursor(result.nextCursor);
    if (result.events.length === 0 || seen.has(next)) {
      throw new MuseMspFault("MUSE_VIEW_PAGE_STALLED", "Muse view pagination did not advance");
    }
    seen.add(next);
    cursor = next;
  }
  throw new MuseMspFault("MUSE_TERMINAL_UNVERIFIED", "Muse supplied no durable terminal for the admitted turn");
}
