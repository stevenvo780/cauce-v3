import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_RELAY_AGGREGATE_BYTES,
  MAX_RELAY_BODY_BYTES,
  MAX_RELAY_MESSAGES,
  parseDirectOutput,
  validateDeliveryOutput,
  validateStructuredOutput,
} from "../src/sdk/output-parser.js";
import { AdapterError } from "../src/sdk/errors.js";

function output(status: "done" | "failed", retryable: unknown): Record<string, unknown> {
  return {
    reply: "sanitized result",
    messages: [],
    status,
    retryable,
    artifacts: [],
  };
}

test("canonicalizes successful structured output to non-retryable", () => {
  assert.equal(validateStructuredOutput(output("done", true)).retryable, false);
  assert.equal(
    parseDirectOutput(JSON.stringify(output("done", true))).output.retryable,
    false,
  );
});

test("preserves retryable failures", () => {
  const parsed = validateStructuredOutput(output("failed", true));

  assert.equal(parsed.status, "failed");
  assert.equal(parsed.retryable, true);
});

test("rejects empty delegation targets and bodies", () => {
  for (const message of [
    { to: " ", body: "real task" },
    { to: "socrates", body: " " },
  ]) {
    assert.throws(
      () => validateStructuredOutput({
        ...output("done", false),
        messages: [message],
      }),
      /canonical lowercase alias or reserved target|must contain visible text/u,
    );
  }
});

const EMPTY_SUCCESS = {
  reply: null,
  messages: [],
  status: "done",
  retryable: false,
  artifacts: [],
} as const;

const ROUTING_TARGETS = [
  { tenant_id: "Steven", alias: "socrates", online: true },
  { tenant_id: "Pablo", alias: "seneca", online: true },
  { tenant_id: "Miguel", alias: "kratos", online: false },
] as const;

function isContractError(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof AdapterError && error.code === code && !error.retryable;
}

/**
 * The silent turn is still rejected, but no longer with a `throw`.
 *
 * Throwing exits `validateDeliveryOutput` without an `output`, the delivery ends up
 * with `result` NULL, and `agentResponseText` (packages/store/src/repository/agents/fanin/helpers.ts:62)
 * has nothing to pull text from.
 */
function assertSilencioDegradado(salida: ReturnType<typeof validateDeliveryOutput>): void {
  assert.equal(salida.status, "failed", "un turno mudo no puede pasar por 'done'");
  assert.equal(salida.retryable, false, "el turno ya corrio: reintentarlo duplica sus efectos");
  // What is actually being tested: that there is something to read.
  assert.ok((salida.reply ?? "").trim().length > 0, "el reply tiene que llegar con texto");
  assert.match(salida.reply ?? "", /Volve a preguntarme/u);
}

// --- A broken-tool dump is NOT a reply ---------------------------------------
// The two strings below are copied VERBATIM from `deliveries.result.output.reply` in
// production. They are emitted by openclaw 2026.6.6, not by us: grepping the symbol over
// packages/ yields no match outside this array, and the binary installed in the `claw`
// container classifies them the same way at dist/helpers-CYQZyDV5.js:119-127
// (`isCronToolWarning`, `isCronMessagePresentationWarning`).

test("reply null remains valid while a turn delegates genuine new work", () => {
  const delegated = validateStructuredOutput({
    ...EMPTY_SUCCESS,
    messages: [{ to: "socrates", body: "independently verify the result" }],
  });
  assert.equal(
    validateDeliveryOutput(delegated, {
      messageType: "agent.response",
      senderAlias: "seneca",
      selfAlias: "jarvis",
      routingTargets: ROUTING_TARGETS,
    }),
    delegated,
  );
});

test("agent fan-in must synthesize instead of starting another delegation round", () => {
  const delegated = validateStructuredOutput({
    ...EMPTY_SUCCESS,
    reply: "partial synthesis",
    messages: [{ to: "socrates", body: "start another round" }],
  });
  assert.throws(
    () => validateDeliveryOutput(delegated, { messageType: "agent.fanin" }),
    isContractError("FANIN_REDELEGATION_FORBIDDEN"),
  );
});

function delegatedOutput(
  to: string,
  overrides: Partial<Record<"reply" | "status" | "retryable", unknown>> = {},
) {
  return validateStructuredOutput({
    reply: null,
    messages: [{ to, body: "perform independent work" }],
    status: "done",
    retryable: false,
    artifacts: [],
    ...overrides,
  });
}

test("delegation rejects self, offline, unknown, and ambiguous aliases", () => {
  const cases = [
    {
      target: "jarvis",
      targets: ROUTING_TARGETS,
      code: "DELEGATION_TO_SELF",
    },
    {
      target: "kratos",
      targets: ROUTING_TARGETS,
      code: "OFFLINE_DELEGATION_TARGET",
    },
    {
      target: "midas",
      targets: ROUTING_TARGETS,
      code: "UNKNOWN_DELEGATION_TARGET",
    },
    {
      target: "socrates",
      targets: [
        { tenant_id: "Steven", alias: "socrates", online: true },
        { tenant_id: "Pablo", alias: "socrates", online: true },
      ],
      code: "AMBIGUOUS_DELEGATION_TARGET",
    },
  ] as const;

  for (const entry of cases) {
    assert.throws(
      () => validateDeliveryOutput(delegatedOutput(entry.target), {
        messageType: "request",
        senderAlias: "requester",
        selfAlias: "jarvis",
        routingTargets: entry.targets,
      }),
      isContractError(entry.code),
      `${entry.target} should fail with ${entry.code}`,
    );
  }
});

test("direct delegation fails closed without a trusted routing inventory", () => {
  assert.throws(
    () => validateDeliveryOutput(delegatedOutput("socrates"), {
      messageType: "request",
      selfAlias: "jarvis",
    }),
    isContractError("ROUTING_INVENTORY_UNAVAILABLE"),
  );
});

test("@all must be exclusive and is forbidden on every internal delivery type", () => {
  const mixed = validateStructuredOutput({
    ...EMPTY_SUCCESS,
    messages: [
      { to: "@all", body: "validate connectivity" },
      { to: "socrates", body: "also validate connectivity" },
    ],
  });
  assert.throws(
    () => validateDeliveryOutput(mixed, {
      messageType: "request",
      selfAlias: "jarvis",
      routingTargets: ROUTING_TARGETS,
    }),
    isContractError("ALL_TARGET_MUST_BE_EXCLUSIVE"),
  );

  const all = validateStructuredOutput({
    ...EMPTY_SUCCESS,
    messages: [{ to: "@all", body: "validate connectivity" }],
  });
  for (const messageType of ["agent.message", "agent.response", "agent.fanin"]) {
    assert.throws(
      () => validateDeliveryOutput(all, {
        messageType,
        senderAlias: "seneca",
        selfAlias: "jarvis",
        routingTargets: ROUTING_TARGETS,
      }),
      isContractError(messageType === "agent.fanin"
        ? "FANIN_REDELEGATION_FORBIDDEN"
        : "INTERNAL_ALL_FORBIDDEN"),
    );
  }
  assert.equal(
    validateDeliveryOutput(all, {
      messageType: "request",
      selfAlias: "jarvis",
      routingTargets: ROUTING_TARGETS,
    }),
    all,
  );
});

test("structured replies and message bodies require Unicode-visible text", () => {
  for (const invisible of [
    "\u200b",
    "\u0000",
    " \t\u200d\u0000",
    "\u034f",
    "\ufe0f",
    "\u0301",
    "\u034f\ufe0f\u0301",
  ]) {
    const output = validateStructuredOutput({
      ...EMPTY_SUCCESS,
      reply: invisible,
    });
    assert.throws(
      () => validateDeliveryOutput(output),
      isContractError("INVISIBLE_REPLY"),
    );
    assert.throws(
      () => validateStructuredOutput({
        ...EMPTY_SUCCESS,
        messages: [{ to: "socrates", body: invisible }],
      }),
      /must contain visible text/u,
    );
  }
  const composed = validateStructuredOutput({
    ...EMPTY_SUCCESS,
    reply: `a\u0301`,
  });
  assert.equal(validateDeliveryOutput(composed), composed);
});

test("relay aggregate and message-count limits fail above their exact boundaries", () => {
  const exactBody = "x".repeat(MAX_RELAY_BODY_BYTES);
  const exactAggregate = validateStructuredOutput({
    ...EMPTY_SUCCESS,
    messages: Array.from(
      { length: MAX_RELAY_AGGREGATE_BYTES / MAX_RELAY_BODY_BYTES },
      () => ({ to: "socrates", body: exactBody }),
    ),
  });
  assert.equal(
    exactAggregate.messages.reduce(
      (total, message) => total + Buffer.byteLength(message.body, "utf8"),
      0,
    ),
    MAX_RELAY_AGGREGATE_BYTES,
  );

  assert.throws(
    () => validateStructuredOutput({
      ...EMPTY_SUCCESS,
      messages: [...exactAggregate.messages, { to: "socrates", body: "x" }],
    }),
    /aggregate UTF-8 byte limit/u,
  );
  assert.throws(
    () => validateStructuredOutput({
      ...EMPTY_SUCCESS,
      messages: Array.from(
        { length: MAX_RELAY_MESSAGES + 1 },
        () => ({ to: "socrates", body: "x" }),
      ),
    }),
    /message limit/u,
  );
});

test("un output failed pierde sus delegaciones pero conserva la respuesta", () => {
  // Before this it threw FAILED_OUTPUT_MESSAGES_FORBIDDEN, and the throw took the `reply`
  // with it: the sender got "could not complete the delegated request" and nothing else.
  // A failed turn does not materialize messages anyway, so dropping them loses nothing; what
  // is gained is that the agent's reply survives and it knows what was dropped.
  const failedWithMessages = delegatedOutput("socrates", {
    status: "failed",
    retryable: true,
  });
  const resultado = validateDeliveryOutput(failedWithMessages, {
    messageType: "request",
    selfAlias: "jarvis",
    routingTargets: ROUTING_TARGETS,
  });
  assert.deepEqual(resultado.messages, []);
  assert.equal(resultado.status, "failed");
  assert.equal(resultado.retryable, true);
  assert.ok(resultado.reply !== null && resultado.reply.length > 0, "el reply tiene que sobrevivir");
  assert.match(resultado.reply, /Se descartaron 1 delegacion/u);
});

test("accepts a well formed notify directive", () => {
  const parsed = validateStructuredOutput({
    ...output("done", false),
    notify: [{ to: "steven.dm", kind: "task_complete", body: "la tarea terminó" }],
  });
  assert.deepEqual(parsed.notify, [
    { to: "steven.dm", body: "la tarea terminó", kind: "task_complete" },
  ]);
});

test("artifacts ausente se normaliza a lista vacia", () => {
  // It used to be required, and omitting it cost the whole turn for a field that is almost always [].
  const salida = validateStructuredOutput({
    reply: "hecho",
    messages: [],
    status: "done",
    retryable: false,
  });
  assert.deepEqual(salida.artifacts, []);
  assert.equal(salida.reply, "hecho");
});

test("notify never satisfies the final reply requirement", () => {
  const notifyOnly = validateStructuredOutput({
    reply: null,
    messages: [],
    notify: [{ to: "steven.dm", kind: "task_complete", body: "avisé a Steven" }],
    status: "done",
    retryable: false,
    artifacts: [],
  });
  const salida = validateDeliveryOutput(notifyOnly);
  // The rule does not change: notifying a human over DM is not replying to whoever asked you.
  assertSilencioDegradado(salida);
  // What changes is that the notification survives. With the `throw` the `notify` was lost
  // too, meaning the turn reached NEITHER the sender NOR the person the agent meant to alert.
  assert.equal(salida.notify.length, 1);
  assert.equal(salida.notify[0]?.to, "steven.dm");
});

const PDF_DATA_URI = "data:application/pdf;base64,JVBERi0xLjQK";

function soloFichero(uri: string, reply: string | null): Record<string, unknown> {
  return { reply, messages: [], notify: [], status: "done", retryable: false, artifacts: [{ name: "a.pdf", uri }] };
}

test("un reply invisible SIN fichero entregable sigue costando el turno", () => {
  assert.throws(
    () => validateDeliveryOutput(validateStructuredOutput({
      ...soloFichero(PDF_DATA_URI, ""),
      artifacts: [],
    })),
    isContractError("INVISIBLE_REPLY"),
  );
  for (const uri of ["file:///x", "http://127.0.0.1/x", "/home/dev/x.pdf", "cauce:not-sent"]) {
    assert.throws(
      () => validateDeliveryOutput(validateStructuredOutput(soloFichero(uri, ""))),
      isContractError("INVISIBLE_REPLY"),
      `"${uri}" no es un fichero que el destinatario pueda abrir`,
    );
  }
});
