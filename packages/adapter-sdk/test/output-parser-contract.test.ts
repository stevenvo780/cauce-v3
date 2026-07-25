import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_EXPANDED_RELAY_AGGREGATE_BYTES,
  MAX_NOTIFY_BODY_BYTES,
  MAX_NOTIFY_DIRECTIVES,
  MAX_RELAY_AGGREGATE_BYTES,
  MAX_RELAY_BODY_BYTES,
  MAX_RELAY_MESSAGES,
  parseClaudeOutput,
  parseCodexOutput,
  parseDirectOutput,
  parseFinalText,
  parseHermesOutput,
  parseOpenClawOutput,
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

test("canonicalizes a successful Hermes result without re-execution", () => {
  const parsed = parseHermesOutput(JSON.stringify({
    result: output("done", true),
  }));

  assert.equal(parsed.output.status, "done");
  assert.equal(parsed.output.retryable, false);
  assert.equal(parsed.output.reply, "sanitized result");
});

test("preserves retryable failures", () => {
  const parsed = validateStructuredOutput(output("failed", true));

  assert.equal(parsed.status, "failed");
  assert.equal(parsed.retryable, true);
});

test("still rejects a non-boolean retryable field", () => {
  assert.throws(
    () => validateStructuredOutput(output("done", "true")),
    /'retryable' must be a boolean/u,
  );
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
    error instanceof AdapterError && error.code === code && error.retryable === false;
}

test("OpenClaw parser exposes an empty terminal result and the delivery contract rejects it", () => {
  const parsed = parseOpenClawOutput(JSON.stringify({ output: EMPTY_SUCCESS }));
  assert.equal(parsed.output.reply, null);
  assert.deepEqual(parsed.output.messages, []);
  assert.throws(
    () => validateDeliveryOutput(parsed.output, {
      messageType: "agent.response",
      senderAlias: "seneca",
    }),
    isContractError("MISSING_FINAL_REPLY"),
  );
});

test("Hermes parser exposes an empty terminal result and the delivery contract rejects it", () => {
  const parsed = parseHermesOutput(JSON.stringify({ result: EMPTY_SUCCESS }));
  assert.equal(parsed.output.reply, null);
  assert.deepEqual(parsed.output.messages, []);
  assert.throws(
    () => validateDeliveryOutput(parsed.output, {
      messageType: "agent.response",
      senderAlias: "argos",
    }),
    isContractError("MISSING_FINAL_REPLY"),
  );
});

test("Codex and Claude results use the same non-empty completion contract", () => {
  const codex = parseCodexOutput(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: JSON.stringify(EMPTY_SUCCESS) },
  }));
  const claude = parseClaudeOutput(JSON.stringify({ result: EMPTY_SUCCESS }));

  for (const parsed of [codex, claude]) {
    assert.throws(
      () => validateDeliveryOutput(parsed.output, { messageType: "agent.response" }),
      isContractError("MISSING_FINAL_REPLY"),
    );
  }
});

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

test("an internal delivery cannot send any message back to its sender", () => {
  const bounced = validateStructuredOutput({
    ...EMPTY_SUCCESS,
    messages: [{ to: "seneca", body: "a differently worded follow-up" }],
  });
  assert.throws(
    () => validateDeliveryOutput(bounced, {
      messageType: "agent.response",
      senderAlias: "seneca",
      selfAlias: "jarvis",
      routingTargets: ROUTING_TARGETS,
    }),
    isContractError("AGENT_MESSAGE_PING_PONG"),
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

test("@all requires a trusted inventory with at least one online peer", () => {
  const all = validateStructuredOutput({
    ...EMPTY_SUCCESS,
    messages: [{ to: "@all", body: "validate connectivity" }],
  });
  assert.throws(
    () => validateDeliveryOutput(all, {
      messageType: "request",
      selfAlias: "jarvis",
    }),
    isContractError("ROUTING_INVENTORY_UNAVAILABLE"),
  );
  assert.throws(
    () => validateDeliveryOutput(all, {
      messageType: "request",
      selfAlias: "jarvis",
      routingTargets: [],
    }),
    isContractError("NO_ONLINE_TARGETS"),
  );
  assert.throws(
    () => validateDeliveryOutput(all, {
      messageType: "request",
      selfAlias: "jarvis",
      routingTargets: [
        { tenant_id: "Steven", alias: "jarvis", online: true },
        { tenant_id: "Pablo", alias: "seneca", online: false },
      ],
    }),
    isContractError("NO_ONLINE_TARGETS"),
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

test("plain final text rejects zero-width and control-only output before fallback", () => {
  for (const invisible of [
    "\u200b",
    "\u0000",
    "\t\u200d\u0000",
    "\u034f",
    "\ufe0f",
    "\u0301",
  ]) {
    assert.throws(
      () => parseFinalText(invisible, "Native result"),
      /did not contain visible text/u,
    );
  }
});

test("relay body limits use exact UTF-8 byte boundaries", () => {
  const exactAscii = "x".repeat(MAX_RELAY_BODY_BYTES);
  const exactMultibyte = "\u00e9".repeat(MAX_RELAY_BODY_BYTES / 2);
  for (const body of [exactAscii, exactMultibyte]) {
    const parsed = validateStructuredOutput({
      ...EMPTY_SUCCESS,
      messages: [{ to: "socrates", body }],
    });
    assert.equal(Buffer.byteLength(parsed.messages[0]?.body ?? "", "utf8"), MAX_RELAY_BODY_BYTES);
  }

  assert.throws(
    () => validateStructuredOutput({
      ...EMPTY_SUCCESS,
      messages: [{ to: "socrates", body: `${exactAscii}x` }],
    }),
    /body exceeded the UTF-8 byte limit/u,
  );
  assert.throws(
    () => validateStructuredOutput({
      ...EMPTY_SUCCESS,
      messages: [{ to: "socrates", body: `${exactMultibyte}x` }],
    }),
    /body exceeded the UTF-8 byte limit/u,
  );
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

test("@all expansion is bounded by aggregate UTF-8 bytes", () => {
  const all = validateStructuredOutput({
    ...EMPTY_SUCCESS,
    messages: [{ to: "@all", body: "x".repeat(MAX_RELAY_BODY_BYTES) }],
  });
  const exactPeerCount = MAX_EXPANDED_RELAY_AGGREGATE_BYTES / MAX_RELAY_BODY_BYTES;
  const targets = Array.from({ length: exactPeerCount + 1 }, (_, index) => ({
    tenant_id: `tenant-${index}`,
    alias: `peer${index}`,
    online: true,
  }));

  assert.equal(
    validateDeliveryOutput(all, {
      messageType: "request",
      selfAlias: "jarvis",
      routingTargets: targets.slice(0, exactPeerCount),
    }),
    all,
  );
  assert.throws(
    () => validateDeliveryOutput(all, {
      messageType: "request",
      selfAlias: "jarvis",
      routingTargets: targets,
    }),
    isContractError("EXPANDED_RELAY_AGGREGATE_TOO_LARGE"),
  );
});

test("failed fan-in cannot carry messages", () => {
  const failedWithMessages = delegatedOutput("socrates", {
    status: "failed",
    retryable: true,
  });
  assert.throws(
    () => validateDeliveryOutput(failedWithMessages, {
      messageType: "agent.fanin",
      senderAlias: "cauce",
      selfAlias: "jarvis",
      routingTargets: ROUTING_TARGETS,
    }),
    isContractError("FANIN_REDELEGATION_FORBIDDEN"),
  );
});

test("failed non-fanin output cannot claim an unmaterialized delegation", () => {
  const failedWithMessages = delegatedOutput("socrates", {
    status: "failed",
    retryable: true,
  });
  assert.throws(
    () => validateDeliveryOutput(failedWithMessages, {
      messageType: "request",
      selfAlias: "jarvis",
      routingTargets: ROUTING_TARGETS,
    }),
    isContractError("FAILED_OUTPUT_MESSAGES_FORBIDDEN"),
  );
});

test("failed output rejects an invisible reply but permits reply null", () => {
  const invisibleFailure = validateStructuredOutput({
    reply: "\u200b\u0000",
    messages: [],
    status: "failed",
    retryable: true,
    artifacts: [],
  });
  assert.throws(
    () => validateDeliveryOutput(invisibleFailure),
    isContractError("INVISIBLE_REPLY"),
  );

  const nullFailure = validateStructuredOutput({
    ...invisibleFailure,
    reply: null,
  });
  assert.equal(validateDeliveryOutput(nullFailure), nullFailure);
});

test("delegation target syntax accepts only a canonical alias or exact @all", () => {
  for (const target of ["Socrates", "@group", "socrates.other", ""]) {
    assert.throws(
      () => validateStructuredOutput({
        ...EMPTY_SUCCESS,
        messages: [{ to: target, body: "visible task" }],
      }),
      /canonical lowercase alias or reserved target/u,
    );
  }
});

test("legacy five-key output normalizes notify to an empty list", () => {
  const legacy = validateStructuredOutput(output("done", false));
  assert.deepEqual(legacy.notify, []);
  assert.deepEqual(
    parseDirectOutput(JSON.stringify(output("done", false))).output.notify,
    [],
  );
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

test("rejects malformed notify directives", () => {
  const cases: Array<[unknown, RegExp]> = [
    ["not-an-array", /'notify' must be an array/u],
    [[{ to: "Steven.DM", kind: "alert", body: "x" }], /canonical destination handle/u],
    [[{ to: "steven.dm", kind: "gossip", body: "x" }], /notify\[0\]\.kind must be one of/u],
    [[{ to: "steven.dm", kind: "alert", body: " " }], /must contain visible text/u],
    [
      [{ to: "steven.dm", kind: "alert", body: "x".repeat(MAX_NOTIFY_BODY_BYTES + 1) }],
      /UTF-8 byte limit/u,
    ],
    [
      Array.from({ length: MAX_NOTIFY_DIRECTIVES + 1 }, () => ({
        to: "steven.dm", kind: "alert", body: "x",
      })),
      /exceeded the 4 directive limit/u,
    ],
  ];
  for (const [notify, pattern] of cases) {
    assert.throws(
      () => validateStructuredOutput({ ...output("done", false), notify }),
      pattern,
    );
  }
});

test("notify bodies are bounded in aggregate", () => {
  const body = "x".repeat(MAX_NOTIFY_BODY_BYTES);
  assert.throws(
    () => validateStructuredOutput({
      ...output("done", false),
      notify: Array.from({ length: 3 }, () => ({ to: "steven.dm", kind: "digest", body })),
    }),
    /aggregate UTF-8 byte limit/u,
  );
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
  assert.throws(
    () => validateDeliveryOutput(notifyOnly),
    isContractError("MISSING_FINAL_REPLY"),
  );
});

test("a failed output may notify even though it may not delegate", () => {
  const failed = validateStructuredOutput({
    reply: "la tarea larga falló",
    messages: [],
    notify: [{ to: "steven.dm", kind: "alert", body: "falló el build nocturno" }],
    status: "failed",
    retryable: false,
    artifacts: [],
  });
  assert.equal(validateDeliveryOutput(failed), failed);

  assert.throws(
    () => validateDeliveryOutput(validateStructuredOutput({
      reply: "falló",
      messages: [{ to: "socrates", body: "seguí vos" }],
      status: "failed",
      retryable: false,
      artifacts: [],
    })),
    isContractError("FAILED_OUTPUT_MESSAGES_FORBIDDEN"),
  );
});
