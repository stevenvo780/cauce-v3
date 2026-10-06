import assert from "node:assert/strict";
import test from "node:test";
import type { Connection } from "@muse-code/sdk";
import {
  MuseMspFault, MuseTurnEvidence, readMuseView, reconcileMuseTurn, type MuseWait,
} from "../src/sdk/muse-msp-reconciliation.js";
import { MuseMspSession, museReasoningVariants } from "../src/sdk/muse-msp-session.js";

const sessionId = "synthetic-session";
const turnId = "synthetic-turn";
const wait: MuseWait = async (promise) => promise;
const position = { id: "record-id", sequence: 1 };
const sourceRange = { first: position, last: position, stream: { kind: "session", id: sessionId } };

function message(text: string, extra: Record<string, unknown> = {}) {
  return { method: "item/completed", params: {
    sessionId, viewCursor: "opaque=message", sourceRange,
    item: { itemId: "answer-id", turnId, kind: "agentMessage", revision: 1, status: "completed", text, ...extra },
  } };
}

function terminal(extra: Record<string, unknown> = {}) {
  return { method: "turn/completed", params: {
    sessionId, turnId, viewCursor: "opaque=terminal", sourceRange, terminal: "completed", ...extra,
  } };
}

function feed(evidence: MuseTurnEvidence, event: { method: string; params: unknown }): void {
  evidence.observe(event.method, event.params);
}

function connectionWithPages(pages: readonly Record<string, unknown>[]) {
  const cursors: unknown[] = [];
  let count = 0;
  const connection = { request: async (method: string, params: Record<string, unknown>) => {
    assert.equal(params.sessionId, sessionId);
    if (method === "session/read") return {
      session: { sessionId }, viewCursor: "opaque=current", history: { mode: "inline", items: [] },
    };
    assert.equal(method, "view/page");
    cursors.push(params.cursor);
    return pages[count++] ?? { events: [], nextCursor: null };
  } } as unknown as Connection;
  return { connection, cursors };
}

test("Muse JSON success alone does not certify a durable turn terminal", () => {
  const evidence = new MuseTurnEvidence(sessionId, turnId);
  feed(evidence, message('{"reply":"Done","status":"done"}'));
  assert.equal(evidence.result(), undefined);
  feed(evidence, terminal({ turnId: "another-turn" }));
  assert.equal(evidence.result(), undefined);
});

test("Muse refuses a terminal without durable record positions", () => {
  const evidence = new MuseTurnEvidence(sessionId, turnId);
  assert.throws(() => { feed(evidence, terminal({ sourceRange: {} })); }, MuseMspFault);
  assert.equal(evidence.result(), undefined);
});

test("Muse cannot merge a foreign session's terminal with the current reply", () => {
  const evidence = new MuseTurnEvidence(sessionId, turnId);
  feed(evidence, message("Current reply"));
  assert.throws(() => { feed(evidence, terminal({ sessionId: "foreign-session" })); },
    (error: unknown) => error instanceof MuseMspFault && error.code === "MUSE_FOREIGN_VIEW");
  assert.equal(evidence.result(), undefined);
});

test("Muse pagination preserves opaque cursors and assembles only the exact turn's evidence", async () => {
  const evidence = new MuseTurnEvidence(sessionId, turnId);
  const { connection, cursors } = connectionWithPages([
    { events: [message("Exact reply"), terminal({ turnId: "unrelated-turn" })], nextCursor: "suffix==/opaque" },
    { events: [terminal()], nextCursor: null },
  ]);
  const result = await reconcileMuseTurn(connection, evidence, "prefix==/opaque", wait);
  assert.equal(result.text, "Exact reply");
  assert.equal(result.outcome.kind, "completed");
  assert.deepEqual(cursors, ["prefix==/opaque", "suffix==/opaque"]);
});

test("Muse pagination stops on an empty page even when its cursor changes", async () => {
  const { connection, cursors } = connectionWithPages([{ events: [], nextCursor: "next-cursor" }]);
  await assert.rejects(reconcileMuseTurn(connection, new MuseTurnEvidence(sessionId, turnId), "start", wait),
    (error: unknown) => error instanceof MuseMspFault && error.code === "MUSE_VIEW_PAGE_STALLED");
  assert.equal(cursors.length, 1);
});

test("Muse pagination refuses cursor cycles and never submits a turn", async () => {
  const ignored = { method: "session/nameChanged", params: { sessionId, viewCursor: "name-cursor" } };
  const { connection, cursors } = connectionWithPages([
    { events: [ignored], nextCursor: "second" }, { events: [ignored], nextCursor: "start" },
  ]);
  await assert.rejects(reconcileMuseTurn(connection, new MuseTurnEvidence(sessionId, turnId), "start", wait),
    (error: unknown) => error instanceof MuseMspFault && error.code === "MUSE_VIEW_PAGE_STALLED");
  assert.equal(cursors.length, 2);
});

test("Muse history snapshots containing a reply do not replace a missing terminal event", async () => {
  const { connection } = connectionWithPages([{ events: [message("Done")], nextCursor: null }]);
  await assert.rejects(reconcileMuseTurn(connection, new MuseTurnEvidence(sessionId, turnId), "start", wait),
    (error: unknown) => error instanceof MuseMspFault && error.code === "MUSE_TERMINAL_UNVERIFIED");
});

test("Muse records truncated output as a fault after observing its durable terminal", () => {
  const evidence = new MuseTurnEvidence(sessionId, turnId);
  feed(evidence, message("Partial reply", { truncated: true }));
  feed(evidence, terminal());
  assert.throws(() => evidence.result(),
    (error: unknown) => error instanceof MuseMspFault && error.code === "MUSE_OUTPUT_TRUNCATED");
});

test("Muse health reads disclose missing or unknown none reasons instead of guessing health", async () => {
  const connection = { request: async () => ({
    session: { sessionId }, viewCursor: "head", history: { mode: "none" },
  }) } as unknown as Connection;
  await assert.rejects(readMuseView(connection, sessionId, wait),
    (error: unknown) => error instanceof MuseMspFault && error.code === "MUSE_VIEW_HEALTH_UNKNOWN");
});

test("Muse extended preflight read budget leaves its projection probe at five seconds", async () => {
  const budgets: (number | undefined)[] = [];
  const methods: string[] = [];
  const connection = { request: async (method: string, params: Record<string, unknown>) => {
    methods.push(method);
    assert.equal(params.sessionId, sessionId);
    if (method === "view/page") return { events: [], nextCursor: null };
    assert.equal(params.excludeItems, false);
    return { session: { sessionId }, viewCursor: "head",
      history: { mode: "none", noneReason: "projectionReadLimit" } };
  } } as unknown as Connection;
  await readMuseView(connection, sessionId, async (promise, budget) => {
    budgets.push(budget);
    return promise;
  }, 30_000);
  assert.deepEqual(methods, ["session/read", "view/page"]);
  assert.deepEqual(budgets, [30_000, 5_000]);
});

test("Muse reconciliation retains five-second budgets for the health read and event page", async () => {
  const budgets: (number | undefined)[] = [];
  const { connection } = connectionWithPages([{ events: [message("Recovered reply"), terminal()], nextCursor: null }]);
  const result = await reconcileMuseTurn(connection, new MuseTurnEvidence(sessionId, turnId), "start",
    async (promise, budget) => { budgets.push(budget); return promise; });
  assert.equal(result.text, "Recovered reply");
  assert.deepEqual(budgets, [5_000, 5_000]);
});

test("Muse validates advertised effort variants without synthesizing unsupported max", () => {
  assert.deepEqual(museReasoningVariants(["high", "xhigh"]), ["high", "xhigh"]);
  assert.equal(museReasoningVariants(undefined), undefined);
  assert.equal(museReasoningVariants("unknown"), undefined);
  assert.throws(() => museReasoningVariants(["max", "max"]), MuseMspFault);
  assert.throws(() => museReasoningVariants(["strongerThanMax"]), MuseMspFault);
});

test("Muse decodes 1.4.1 tier descriptions as optional same-order subsets of complete variants", () => {
  assert.deepEqual(museReasoningVariants(["high", "xhigh", "max"], [
    { tier: "high", description: "High" }, { tier: "max" },
  ]), ["high", "xhigh", "max"]);
  assert.deepEqual(museReasoningVariants(["high", "max"], []), ["high", "max"]);
  assert.deepEqual(museReasoningVariants(undefined, [{ tier: "max" }]), ["max"]);
  for (const [variants, descriptions] of [
    [["high"], [{ tier: "max" }]],
    [["high", "max"], [{ tier: "max" }, { tier: "high" }]],
    [["max"], [{ tier: "max" }, { tier: "max" }]],
    ["unknown", [{ tier: "max" }]],
    [["max"], [{ effort: "max" }]],
    [["max"], null],
    [null, undefined],
  ]) assert.throws(() => museReasoningVariants(variants, descriptions), MuseMspFault);
});

test("Muse progress uses new delta bytes and unique opaque cursors rather than accumulated length", async (context) => {
  let now = 1_000;
  context.mock.method(Date, "now", () => now);
  type Notify = Parameters<Connection["onNotification"]>[0];
  let notify: Notify = () => undefined;
  const connection = {
    onNotification: (handler: Notify) => { notify = handler; }, onProtocolError: () => undefined,
    closed: new Promise<void>(() => undefined), mintCommandId: () => "synthetic-command",
    command: async () => ({ status: "accepted", turnId }),
  } as unknown as Connection;
  const session = new MuseMspSession(connection, sessionId, { kind: "durable" }, () => undefined);
  try {
    await session.submit("Synthetic progress probe", undefined, wait);
    notify({ jsonrpc: "2.0", method: "turn/started", params: { sessionId, turnId, commandId: "synthetic-command",
      sourceRange, viewCursor: "opaque=start",
    } });
    notify({ jsonrpc: "2.0", method: "item/started", params: { sessionId, sourceRange, viewCursor: "opaque:item",
      item: { itemId: "progress-item", turnId, kind: "agentMessage", revision: 1, status: "inProgress", text: "" },
    } });
    const delta = (viewCursor: string, text: string): void => {
      notify({ jsonrpc: "2.0", method: "item/delta", params: {
        sessionId, itemId: "progress-item", viewCursor, delta: text,
      } });
    };
    now = 2_000; delta("z=opaque:delta", "new bytes");
    assert.equal(session.lastProgressAt, 2_000);
    now = 3_000; delta("z=opaque:delta", "new bytes");
    assert.equal(session.lastProgressAt, 2_000);
    now = 4_000; delta("unused=empty:delta", "");
    assert.equal(session.lastProgressAt, 2_000);
    now = 5_000; delta("a=opaque:delta", "more bytes");
    assert.equal(session.lastProgressAt, 5_000);
  } finally { session.close(); }
});
