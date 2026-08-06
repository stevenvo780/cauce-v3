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

/**
 * El turno mudo se sigue rechazando, pero ya no con un `throw`.
 *
 * Antes esto era `assert.throws(isContractError("MISSING_FINAL_REPLY"))`. El test afirmaba el
 * contrato que ERA el bug: el throw sale de `validateDeliveryOutput` sin `output`, la entrega
 * queda con `result` NULL, y `agentResponseText` (packages/store/src/repository.ts:1089) no
 * tiene de donde sacar texto. Medido el 2026-08-02 en produccion: las cuatro preguntas de Miguel
 * a janus del 27-jul (16:13, 16:16, 18:24, 18:27) estan `status=failed` con `result` NULL y
 * sin ninguna respuesta posterior. Miguel no recibio nada.
 *
 * El diagnostico no cambia —sigue siendo un turno fallido, y sigue contando como fallido— pero
 * ahora viaja con texto, que es lo unico que la persona del otro lado puede leer.
 */
function assertSilencioDegradado(salida: ReturnType<typeof validateDeliveryOutput>): void {
  assert.equal(salida.status, "failed", "un turno mudo no puede pasar por 'done'");
  assert.equal(salida.retryable, false, "el turno ya corrio: reintentarlo duplica sus efectos");
  // Lo que de verdad se esta probando: que hay algo que leer.
  assert.ok((salida.reply ?? "").trim().length > 0, "el reply tiene que llegar con texto");
  assert.match(salida.reply ?? "", /Volve a preguntarme/u);
}

test("OpenClaw parser exposes an empty terminal result and the delivery contract degrades it", () => {
  const parsed = parseOpenClawOutput(JSON.stringify({ output: EMPTY_SUCCESS }));
  assert.equal(parsed.output.reply, null);
  assert.deepEqual(parsed.output.messages, []);
  assertSilencioDegradado(validateDeliveryOutput(parsed.output, {
    messageType: "agent.response",
    senderAlias: "seneca",
  }));
});

test("Hermes parser exposes an empty terminal result and the delivery contract degrades it", () => {
  const parsed = parseHermesOutput(JSON.stringify({ result: EMPTY_SUCCESS }));
  assert.equal(parsed.output.reply, null);
  assert.deepEqual(parsed.output.messages, []);
  assertSilencioDegradado(validateDeliveryOutput(parsed.output, {
    messageType: "agent.response",
    senderAlias: "argos",
  }));
});

test("Codex and Claude results use the same non-empty completion contract", () => {
  const codex = parseCodexOutput(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: JSON.stringify(EMPTY_SUCCESS) },
  }));
  const claude = parseClaudeOutput(JSON.stringify({ result: EMPTY_SUCCESS }));

  for (const parsed of [codex, claude]) {
    assertSilencioDegradado(validateDeliveryOutput(parsed.output, { messageType: "agent.response" }));
  }
});

// --- El volcado de una herramienta rota NO es una respuesta -------------------
// Las dos cadenas de abajo estan copiadas TAL CUAL de `deliveries.result.output.reply` en
// produccion. Las emite openclaw 2026.6.6, no nosotros: el grep del simbolo sobre packages/ no
// da un solo resultado fuera de este arreglo, y el binario instalado en el contenedor `claw`
// las clasifica el mismo en dist/helpers-CYQZyDV5.js:119-127 (`isCronToolWarning`,
// `isCronMessagePresentationWarning`).
const AVISO_HERRAMIENTA =
  "⚠️ 🛠️ `ssh ws-prizma 'cd /workspace/clientes/b2b-sales && rg -n \"schema\"'` (exit 5)";
const AVISO_MENSAJE = "⚠️ ✉️ Message failed";

function replyDe(reply: string | null): Record<string, unknown> {
  return { reply, messages: [], notify: [], status: "done", retryable: false, artifacts: [] };
}

test("un volcado de herramienta como reply entero se degrada en vez de entregarse como respuesta", () => {
  for (const aviso of [AVISO_HERRAMIENTA, AVISO_MENSAJE]) {
    const salida = validateDeliveryOutput(validateStructuredOutput(replyDe(aviso)));
    // Esto es lo que recibieron Pablo (seneca/grp.pablo, 3 el 26-jul) y Jhon (hegel/grp.jhon, 1
    // el 28-jul) creyendo que era la contestacion del agente. Medidas 30 entregas 'done' asi.
    assert.equal(salida.status, "failed", `el aviso no puede pasar por respuesta: ${aviso}`);
    assert.equal(salida.retryable, false);
    assert.match(salida.reply ?? "", /se me rompio una herramienta/u);
    // El volcado no se tira: sirve para diagnosticar, pero va rotulado como detalle tecnico.
    assert.ok(salida.reply?.includes(aviso), "el volcado tiene que sobrevivir como detalle");
  }
});

test("un aviso citado dentro de una respuesta de verdad no se toca", () => {
  // El caso que no se puede romper: argos le explico a seneca, en 2.685 caracteres, que su
  // entrega volvio como un aviso. Eso es analisis del fallo, no el fallo. De las 256 entregas
  // 'done' cuyo reply contiene el simbolo, solo 30 son el volcado pelado; las otras 226 son
  // respuestas y quedan intactas.
  const analisis = `Tu entrega volvio como \`${AVISO_MENSAJE}\`, sin cuerpo.\nLo revise y el culpable es el bridge.`;
  const salida = validateDeliveryOutput(validateStructuredOutput(replyDe(analisis)));
  assert.equal(salida.status, "done");
  assert.equal(salida.reply, analisis);
});

test("el banner de sesion compartida de Cauce no se confunde con un aviso de openclaw", () => {
  // Nuestro propio aviso tambien abre con "⚠" y tambien se pega delante del reply
  // (src/shared-session/notice.ts). Si la regla se guiara por el simbolo se comeria respuestas
  // reales de socrates, kratos, zeus, kant y dedalo: son 96 entregas medidas en produccion.
  const banner = "⚠ CAUCE — SESIÓN COMPARTIDA CAÍDA\nEste turno NO pasó por la terminal.\n\nLa respuesta real.";
  const salida = validateDeliveryOutput(validateStructuredOutput(replyDe(banner)));
  assert.equal(salida.status, "done");
  assert.equal(salida.reply, banner);
});

test("el aviso de cola no le gana a la respuesta real en los payloads de openclaw", () => {
  // El bug de origen: openclaw APENDA el aviso como un payload de texto mas, y el parser hacia
  // `.at(-1)`, asi que el aviso le ganaba a la respuesta que estaba justo antes.
  const parsed = parseOpenClawOutput(JSON.stringify({
    payloads: [
      { text: JSON.stringify({ ...replyDe("La migracion corrio y quedo aplicada."), notify: [] }) },
      { text: AVISO_HERRAMIENTA },
    ],
  }));
  assert.equal(parsed.output.reply, "La migracion corrio y quedo aplicada.");
  assert.equal(validateDeliveryOutput(parsed.output).status, "done");
});

test("si el aviso es lo unico que dijo el turno, el turno igual deja resultado", () => {
  // Sin este camino el parser cae al desenvuelto de mas abajo y tira MalformedOutputError, que
  // deja la entrega SIN `result` — exactamente el modo de fallo que este arreglo viene a quitar.
  const parsed = parseOpenClawOutput(JSON.stringify({ payloads: [{ text: AVISO_HERRAMIENTA }] }));
  assert.equal(parsed.output.reply, AVISO_HERRAMIENTA);
  const salida = validateDeliveryOutput(parsed.output);
  assert.equal(salida.status, "failed");
  assert.match(salida.reply ?? "", /se me rompio una herramienta/u);
});

test("con aviso de cola gana finalAssistantVisibleText, que es donde openclaw deja el texto real", () => {
  // Es la misma recuperacion que hace openclaw en helpers-CYQZyDV5.js:152 (`hasRecoveredToolWarning`).
  const parsed = parseOpenClawOutput(JSON.stringify({
    payloads: [{ text: AVISO_MENSAJE }],
    finalAssistantVisibleText: "Revise los accesos y estan los tres activos.",
  }));
  assert.equal(parsed.output.reply, "Revise los accesos y estan los tres activos.");
  assert.equal(validateDeliveryOutput(parsed.output).status, "done");
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

/**
 * Rebotarle al remitente sigue sin valer, pero ya no con un `throw`. Lo que cambio es el PRECIO:
 * `AGENT_MESSAGE_PING_PONG` era no reintentable y se llevaba el `reply` ENTERO, o sea el trabajo.
 * Medido en 48 h (2026-08-04/05): 5 turnos asi en 5 alias de 4 tenants. Ahora se descarta el
 * mensaje, se avisa por que, y la respuesta llega. Ver test/pingpong-descarte.test.ts.
 */
test("an internal delivery cannot send any message back to its sender", () => {
  const bounced = validateStructuredOutput({
    ...EMPTY_SUCCESS,
    messages: [{ to: "seneca", body: "a differently worded follow-up" }],
  });
  const output = validateDeliveryOutput(bounced, {
    messageType: "agent.response",
    senderAlias: "seneca",
    selfAlias: "jarvis",
    routingTargets: ROUTING_TARGETS,
  });

  assert.deepEqual(output.messages, [], "el rebote no se materializa");
  assert.equal(output.status, "done", "pero tampoco cuesta el turno");
  assert.match(output.reply ?? "", /a differently worded follow-up/u);
  assert.match(output.reply ?? "", /\[Cauce\].*"seneca"/su);
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

test("un output failed pierde sus delegaciones pero conserva la respuesta", () => {
  // Antes esto lanzaba FAILED_OUTPUT_MESSAGES_FORBIDDEN, y el throw se llevaba puesto el `reply`
  // entero: al remitente le llegaba "could not complete the delegated request" y nada mas.
  // Un turno failed no materializa mensajes de todos modos, asi que descartarlos no pierde nada;
  // lo que se gana es que la respuesta del agente sobreviva y el sepa que se descartaron.
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
  assert.match(resultado.reply as string, /Se descartaron 1 delegacion/u);
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

test("una notify mal formada se descarta y la respuesta sobrevive", () => {
  // Antes cada una de estas era un throw, y el throw se llevaba puesto el reply entero: el agente
  // hacia el trabajo y el duenio recibia un error de esquema. `notify` es accesorio; si viene mal
  // se descarta, se le explica al agente en su propia respuesta, y el turno sigue vivo.
  const casos: Array<[unknown, RegExp]> = [
    ["not-an-array", /no era una lista/u],
    [[{ to: "Steven.DM", kind: "alert", body: "x" }], /no es un handle de destino/u],
    [[{ to: "steven.dm", kind: "gossip", body: "x" }], /'kind' debe ser uno de/u],
    [[{ to: "steven.dm", kind: "alert", body: " " }], /no tiene texto visible/u],
    [
      [{ to: "steven.dm", kind: "alert", body: "x".repeat(MAX_NOTIFY_BODY_BYTES + 1) }],
      /supera el limite de bytes/u,
    ],
    [
      Array.from({ length: MAX_NOTIFY_DIRECTIVES + 1 }, () => ({
        to: "steven.dm", kind: "alert", body: "x",
      })),
      /el limite es 4/u,
    ],
  ];
  for (const [notify, patron] of casos) {
    const salida = validateStructuredOutput({ ...output("done", false), notify });
    assert.match(salida.reply as string, patron);
    assert.match(salida.reply as string, /\[Cauce\]/u);
  }
});

test("una notify bien formada pasa intacta y no ensucia la respuesta", () => {
  const salida = validateStructuredOutput({
    ...output("done", false),
    notify: [{ to: "steven_dm", kind: "decision_request", body: "necesito que autorices X" }],
  });
  assert.equal(salida.notify?.length, 1);
  assert.equal(salida.notify?.[0]?.to, "steven_dm");
  assert.ok(!(salida.reply as string).includes("[Cauce]"));
});

test("las notify agregadas se acotan sin tumbar el turno", () => {
  const body = "x".repeat(MAX_NOTIFY_BODY_BYTES);
  const salida = validateStructuredOutput({
    ...output("done", false),
    notify: Array.from({ length: 3 }, () => ({ to: "steven.dm", kind: "digest", body })),
  });
  assert.ok((salida.notify?.length ?? 0) < 3, "las que exceden el agregado no se entregan");
  assert.match(salida.reply as string, /limite agregado de bytes/u);
});

test("artifacts ausente se normaliza a lista vacia", () => {
  // Era obligatorio, y omitirlo costaba el turno entero por un campo que casi siempre es [].
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
  // La regla no cambia: avisarle a un humano por DM no es contestarle a quien te pregunto.
  assertSilencioDegradado(salida);
  // Lo que cambia es que el aviso sobrevive. Con el `throw` se perdia tambien el `notify`, o sea
  // que el turno no le llegaba NI al remitente NI a la persona a la que el agente queria avisar.
  assert.equal(salida.notify?.length, 1);
  assert.equal(salida.notify?.[0]?.to, "steven.dm");
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

  // Y una delegacion en un turno failed ya no hace estallar el turno: se descarta y se avisa,
  // sin tocar `notify`, que es el unico canal que sobrevive a un fallo.
  const conDelegacion = validateDeliveryOutput(validateStructuredOutput({
    reply: "falló",
    messages: [{ to: "socrates", body: "seguí vos" }],
    notify: [{ to: "steven.dm", kind: "alert", body: "necesito autorizacion" }],
    status: "failed",
    retryable: false,
    artifacts: [],
  }));
  assert.deepEqual(conDelegacion.messages, []);
  assert.match(conDelegacion.reply as string, /^falló\n\n\[Cauce\] Se descartaron 1 delegacion/u);
  assert.equal(conDelegacion.notify?.length, 1);
});
