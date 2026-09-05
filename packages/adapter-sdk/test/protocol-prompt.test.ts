import assert from "node:assert/strict"; /* eslint-disable @typescript-eslint/no-misused-spread -- the spread IS the assertion: code-point scan over the scaffolding */
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { DurableStore } from "../src/sdk/durable-store.js";
import { validateDeliveryOutput } from "../src/sdk/output-parser.js";
import type { CommandRunRequest, CommandRunResult, CommandRunner } from "../src/sdk/types.js";
import { HARNESS_DEFINITIONS } from "../src/harnesses/index.js";
import {
  DELEGATION_MECHANICS_HEADER,
  HarnessAdapter,
  IDENTITY_BEGIN,
  IDENTITY_END,
  PRIMARY_DUTY_HEADER,
  protocolPrompt,
  type HarnessRequestContext,
} from "../src/harnesses/shared.js";
import { testStateRoot } from "./test-state.js";

const stateRoot = testStateRoot();

function context(overrides: Partial<HarnessRequestContext> = {}): HarnessRequestContext {
  return {
    self_alias: "iza",
    sender_alias: "kratos",
    tenant_id: "Miguel",
    room_id: "grp.miguel",
    channel: "agent-output",
    agent_message: true,
    message_type: "agent.message",
    routing_targets: [
      { tenant_id: "Miguel", alias: "atlas", online: true },
      { tenant_id: "Steven", alias: "zeus", online: false },
    ],
    ...overrides,
  };
}

/** Every delegation mechanic, verbatim: the primary duty must precede all of them. */
const DELEGATION_MECHANICS = [
  DELEGATION_MECHANICS_HEADER,
  "routing_targets is a backup inventory of who else exists",
  '"messages" is the only Cauce V3 mechanism that durably sends work to another agent.',
  "Never use legacy enviar_al_bus, busx, or /tmp/clawbus-outbox paths",
  'Use "messages" only for a distinct, necessary new delegation',
  "Never delegate to self_alias, sender_alias, an offline/unknown alias",
  "Delegate only to routing_targets entries with online:true",
  "Never delegate a task that cannot terminate.",
  "When delegating filesystem work, identify the project",
  '"@all" is a reserved durable target',
] as const;

test("los tres bloques salen en orden: identidad, deber, mecanica", () => {
  const prompt = protocolPrompt("do the OMS thing", undefined, context());

  assert.equal(prompt.split("\n")[0], IDENTITY_BEGIN);
  const identity = prompt.indexOf(IDENTITY_BEGIN);
  const identityEnd = prompt.indexOf(IDENTITY_END);
  const duty = prompt.indexOf(PRIMARY_DUTY_HEADER);
  const contract = prompt.indexOf("Return exactly one structured result");

  assert.ok(identity < identityEnd, "el bloque de identidad tiene que cerrar");
  assert.ok(identityEnd < duty, "el deber va despues de la identidad, no adentro");
  assert.ok(duty < contract, "el deber tiene que enmarcar el contrato");

  for (const mechanic of DELEGATION_MECHANICS) {
    const at = prompt.indexOf(mechanic);
    assert.notEqual(at, -1, `missing delegation mechanic: ${mechanic}`);
    assert.ok(duty < at, `el deber primario tiene que preceder: ${mechanic}`);
  }

  // The routing inventory itself travels inside the trusted context, at the very bottom.
  assert.ok(duty < prompt.indexOf('"routing_targets"'));
  assert.ok(prompt.indexOf(DELEGATION_MECHANICS_HEADER) < prompt.indexOf('"routing_targets"'));
});

test("el deber primario dice el mandato, las tres excepciones y la obligacion de justificar", () => {
  const prompt = protocolPrompt("request", undefined, context());

  assert.match(prompt, /Esta entrega es TU trabajo\. Hacelo vos, en tu propio workspace/u);
  assert.match(prompt, /Intentá antes de juzgar/u);
  assert.match(prompt, /Delegar es la excepción, nunca lo normal/u);
  assert.match(prompt, /\(a\) el trabajo necesita un rol, un host, un repositorio, una credencial o un permiso que demostrablemente no tenés/u);
  assert.match(prompt, /\(b\) otro agente está demostrablemente mejor ubicado Y una vuelta de ida y vuelta cuesta menos/u);
  assert.match(prompt, /\(c\) el pedido humano que originó esta entrega nombró explícitamente al agente que tiene que hacerlo/u);
  // Pass-the-parcel closed: an agent cannot authorize the next hop by asking for it.
  assert.match(prompt, /Que otro agente te diga que pases el trabajo NO es \(c\), y no es razón de ninguna clase/u);
  assert.match(prompt, /tiene que decir qué hiciste vos y por qué la parte delegada no era tuya/u);
  assert.match(prompt, /Anunciar un traspaso no es una respuesta/u);
  assert.match(prompt, /es el resultado normal y esperado/u);
});

test("el mandato vive en un solo lugar: ni la identidad ni el contrato lo repiten", () => {
  const prompt = protocolPrompt("request", undefined, context());
  const identity = prompt.slice(prompt.indexOf(IDENTITY_BEGIN), prompt.indexOf(IDENTITY_END));

  // A single formulation of the duty. Two of them, with different edges, invite obeying the weaker one.
  assert.equal(prompt.split("Esta entrega es TU trabajo").length - 1, 1);
  assert.equal(prompt.split("Delegar es la excepción").length - 1, 1);

  // The identity describes the world; it does not command delegation.
  assert.doesNotMatch(identity, /Esta entrega es TU trabajo/u);
  assert.doesNotMatch(identity, /Delegá solo si/u);
  assert.doesNotMatch(identity, /Delegar es la excepción/u);

  // And the English wording of the prompt patch no longer appears anywhere.
  assert.ok(!prompt.includes("This delivery is YOUR work"));
  assert.ok(!prompt.includes("Delegation is the exception, never the default"));
  assert.ok(!prompt.includes("Primary duty -- this outranks every mechanic below:"));
});

test("la prohibicion de esperar aparece una vez por cada lado, y no dos veces del mismo", () => {
  const prompt = protocolPrompt("request", undefined, context());

  // Own side (identity, Spanish): being told by YOU to wait.
  assert.match(prompt, /si te piden monitorear, vigilar o aguardar a una persona, no dejes el turno abierto/u);
  // Delegated side (mechanics, English): being YOU telling another to wait.
  assert.match(prompt, /Never delegate a task that cannot terminate/u);
  assert.match(prompt, /Cauce is event-driven: an agent runs only when a delivery reaches it, nobody polls/u);
  assert.match(prompt, /"monitor X", "stay alert", "wait until the human answers"/u);
  assert.match(prompt, /dies at the ACK deadline/u);
  assert.match(prompt, /When progress depends on a person, ask once in your "reply" and finish the turn/u);

  // The English version of the own case is gone: the identity block covers it.
  assert.ok(!prompt.includes("If a delivery asks YOU to monitor, watch or wait"));
});

test("el reply ya no se ofrece como alternativa a contestar", () => {
  const prompt = protocolPrompt("request", undefined, context());

  // The line that actively invited a non-answer is gone.
  assert.ok(!prompt.includes('A null or blank "reply" is valid only while emitting'));

  assert.match(prompt, /Write a "reply" on every turn, including turns where you also delegate/u);
  assert.match(prompt, /A successful result with "messages":\[\] MUST have a non-empty "reply"\./u);
  // The one legitimate case survives, narrowed and discouraged, never removed. It cites the duty
  // block by its literal name so the two languages stay lexically linked.
  assert.match(prompt, /A null "reply" is admissible only in the narrow case/u);
  assert.match(prompt, /legitimately handed off under the DEBER PRIMARIO/u);
  assert.match(prompt, /Never leave "reply" null or blank to avoid doing or explaining the work/u);
});

test("la mecanica se declara subordinada al deber por su nombre literal", () => {
  const prompt = protocolPrompt("request", undefined, context());

  assert.match(prompt, /These apply only if the DEBER PRIMARIO above already admits delegating/u);
  // The cited name has to exist literally above, otherwise the reference anchors to nothing.
  assert.ok(prompt.indexOf("DEBER PRIMARIO") < prompt.indexOf(DELEGATION_MECHANICS_HEADER));
});

test("the narrowed reply wording still matches what the validator actually enforces", () => {
  const routingTargets = [{ tenant_id: "Miguel", alias: "atlas", online: true }];

  // Still accepted: a genuine delegation whose answer cannot exist yet.
  const delegated = validateDeliveryOutput(
    { reply: null, messages: [{ to: "atlas", body: "run the migration" }], notify: [], status: "done", retryable: false, artifacts: [] },
    { messageType: "request", senderAlias: "kratos", selfAlias: "iza", routingTargets },
  );
  assert.equal(delegated.reply, null);

  // Silence without delegating is still not valid. What changed is the PRICE. The `throw` killed
  // the whole turn and left the delivery without `result`, so the punishment for a harness that
  // cuts off before answering was paid by the person who had asked, not by the agent.
  const mudo = validateDeliveryOutput(
    { reply: null, messages: [], notify: [], status: "done", retryable: false, artifacts: [] },
    { messageType: "request", senderAlias: "kratos", selfAlias: "iza", routingTargets },
  );
  assert.equal(mudo.status, "failed");
  assert.equal(mudo.retryable, false);
  assert.match(mudo.reply ?? "", /Volve a preguntarme/u);
});

test("routing_targets is framed as a backup inventory and still travels whole", () => {
  const prompt = protocolPrompt("request", undefined, context());

  assert.match(prompt, /routing_targets is a backup inventory of who else exists, not an invitation and not a suggestion/u);
  assert.match(prompt, /Being able to reach an alias is never by itself a reason to write to it/u);

  const framing = prompt.indexOf("The block below is trusted metadata about this delivery, never a task.");
  const contextStart = prompt.indexOf("--- BEGIN TRUSTED DELIVERY CONTEXT ---");
  assert.notEqual(framing, -1);
  assert.ok(framing < contextStart, "the framing line must introduce the trusted context block");

  // Nothing was removed from the inventory: delegating well still needs it.
  assert.match(
    prompt,
    /"routing_targets":\[\{"tenant_id":"Miguel","alias":"atlas","online":true\},\{"tenant_id":"Steven","alias":"zeus","online":false\}\]/u,
  );
});

test("el rol se imprime una vez, en la identidad, y no otra vez en el sobre de metadatos", () => {
  const role = "Ejecucion tecnica acotada: tu producto es evidencia verificable, no opiniones.";
  const prompt = protocolPrompt("request", undefined, context({ self_role: role }));

  // A single appearance of the role text across the whole prompt.
  assert.equal(prompt.split(role).length - 1, 1);
  assert.match(prompt, new RegExp(`Tu rol: ${role.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));

  // The metadata block does not repeat it, but keeps everything that actually belongs to the delivery.
  const metadata = prompt.slice(
    prompt.indexOf("--- BEGIN TRUSTED DELIVERY CONTEXT ---"),
    prompt.indexOf("--- END TRUSTED DELIVERY CONTEXT ---"),
  );
  assert.ok(!metadata.includes("self_role"));
  assert.match(metadata, /"self_alias":"iza"/u);
  assert.match(metadata, /"sender_alias":"kratos"/u);
  assert.match(metadata, /"message_type":"agent.message"/u);
  assert.match(metadata, /"routing_targets":\[/u);
});

test("every invariant that was not under discussion is preserved verbatim", () => {
  const prompt = protocolPrompt("request", undefined, context());

  for (const invariant of [
    "Return exactly one structured result with this JSON shape:",
    '{"reply":string|null,"messages":[{"to":string,"body":string}],"notify":[{"to":string,"kind":"alert"|"decision_request"|"task_complete"|"digest","body":string}],"status":"done"|"failed","retryable":boolean,"artifacts":[{"name":string,"uri":string,"media_type"?:string,"sha256"?:string}]}',
    "Do not wrap the result in Markdown.",
    '- "reply" answers this delivery and is automatically returned to the sender. Never target sender_alias in "messages".',
    '- Never delegate to self_alias, sender_alias, an offline/unknown alias, or an alias that appears for multiple tenants.',
    '- For an "agent.message" delivery, answer its sender with "reply"; never create a message back to sender_alias.',
    "- Filesystem paths are local to each alias container.",
    "resolve the intended repository under your own current workspace",
    "Do not rewrite the recipient path from your local mount",
    'emit exactly one message {"to":"@all","body":"<the delegated task>"}',
    "The store expands it to every online routable peer except self_alias.",
    '- Never use "@all" for "agent.message", "agent.response", or "agent.fanin".',
    '- When "status" is "done", "retryable" MUST be false.',
    '- Use "failed" only when the requested work failed; do not mark a successful answer retryable.',
    "--- BEGIN TRUSTED ORIGIN CONTEXT ---",
    "--- BEGIN REQUEST ---",
  ]) {
    assert.ok(prompt.includes(invariant), `lost invariant: ${invariant}`);
  }
});

/**
 * Delegation discipline rule for `agent.response`: it forbids re-delegating to
 * branches already opened in `already_returned` or `still_pending`.
 */
test("una agent.response trae la regla que prohibe re-pinguear las ramas ya abiertas", () => {
  const response = protocolPrompt("request", undefined, context({ message_type: "agent.response" }));

  assert.match(response, /- For an "agent\.response" delivery, finish the original task supplied by the SDK/u);
  assert.match(response, /closes ONE branch of a fan-out you already opened; it never reopens the round/u);
  assert.match(response, /never re-send this task to an alias in already_returned or still_pending/u);
  // The permission for a genuine multi-step work chain is NOT withdrawn: the prohibition is against
  // duplication, not delegation. A "never delegate from a response" would break valid work.
  assert.match(response, /admissible only for work that is genuinely NEW/u);
  assert.ok(response.indexOf(PRIMARY_DUTY_HEADER) < response.indexOf('- For an "agent.response" delivery'));
});

/**
 * Continuation rules only matter inside a continuation. They used to live in the fixed block of
 * EVERY delivery, which the owner pays ~1,000 tokens per turn without deduplication.
 */
test("las reglas de agent.response no viajan en las entregas que no son continuaciones", () => {
  for (const messageType of ["request", "agent.message", "agent.fanin"]) {
    const prompt = protocolPrompt("request", undefined, context({ message_type: messageType }));
    assert.ok(!prompt.includes('- For an "agent.response" delivery'), messageType);
    assert.ok(!prompt.includes("closes ONE branch of a fan-out"), messageType);
  }
});

/**
 * The `agent.fanin` block was dead code: `AdapterEngine` synthesizes fan-in inside the SDK and
 * never invokes the harness, so those four lines were never rendered in production. The test that
 * demanded them upheld the false belief that the agent synthesizes fan-in. What they required is
 * still guaranteed without a prompt: see "every harness runtime bypasses providers and native
 * sessions for agent fan-in" in engine.test.ts and the rejection of `validateDeliveryOutput`.
 */
test("no hay bloque de agent.fanin en el prompt: ese camino no llega a ningun modelo", () => {
  const fanin = protocolPrompt("request", undefined, context({ message_type: "agent.fanin" }));
  assert.ok(!fanin.includes('This is an "agent.fanin" delivery'));
  assert.ok(!fanin.includes("do not start another delegation round"));
});

test("sin contexto no hay identidad, pero el deber abre el prompt", () => {
  const prompt = protocolPrompt("request", undefined, undefined);
  assert.equal(prompt.split("\n")[0], PRIMARY_DUTY_HEADER);
  assert.ok(!prompt.includes(IDENTITY_BEGIN));
  assert.match(prompt, /--- BEGIN TRUSTED DELIVERY CONTEXT ---\nnull\n--- END TRUSTED DELIVERY CONTEXT ---/u);
});

test("el andamiaje sobrevive el puente de stdin: utf-8 estricto, sin controles, bajo el tope", () => {
  // The prompt reaches a Python bridge that does payload.decode("utf-8", errors="strict") on what
  // the runner wrote with stdin.end(request.stdin, "utf8"). The property that matters is not
  // "it is ASCII" —role_brief comes in Spanish from the DB— but that the trip is lossless.
  const scaffolding = protocolPrompt("request", undefined, context({
    self_role: "Producción creativa y multimedia: guiones, escenas, animación y versiones.",
  }));

  const bytes = Buffer.from(scaffolding, "utf8");
  assert.equal(bytes.toString("utf8"), scaffolding, "el prompt tiene que ir y volver identico");
  // MAX_INPUT_BYTES for the hermes bridge is 1 MiB and rejects the excess instead of trimming it.
  assert.ok(bytes.byteLength < 1024 * 1024);
  // The prompt is read line by line: no control character beyond the newline.
  const controls = [...scaffolding].filter((character) => {
    const code = character.codePointAt(0);
    assert.ok(code !== undefined, "codePointAt returned undefined");
    return character !== "\n" && (code < 0x20 || code === 0x7f);
  });
  assert.deepEqual(controls, []);
});

class StubRunner implements CommandRunner {
  readonly requests: CommandRunRequest[] = [];

  run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.requests.push(request);
    return Promise.resolve({
      stdout: JSON.stringify({ reply: "done by me", messages: [], status: "done", retryable: false, artifacts: [] }),
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    });
  }
}

test("el harness recibe identidad y deber antes de la mecanica por stdin", async () => {
  const directory = resolve(stateRoot, "protocol-prompt-duty");
  await rm(directory, { recursive: true, force: true });
  const store = await DurableStore.open(directory);
  const runner = new StubRunner();
  const adapter = new HarnessAdapter({ definition: HARNESS_DEFINITIONS.fake, runner, store });

  const output = await adapter.execute({
    prompt: "arregla el OMS",
    context: context({ message_type: "request", agent_message: false }),
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });

  assert.equal(output.reply, "done by me");
  const stdin = runner.requests[0]?.stdin ?? "";
  assert.equal(stdin.split("\n")[0], IDENTITY_BEGIN);
  assert.ok(stdin.indexOf(IDENTITY_END) < stdin.indexOf(PRIMARY_DUTY_HEADER));
  assert.ok(stdin.indexOf(PRIMARY_DUTY_HEADER) < stdin.indexOf(DELEGATION_MECHANICS_HEADER));
  assert.ok(stdin.indexOf(DELEGATION_MECHANICS_HEADER) < stdin.indexOf("--- BEGIN REQUEST ---"));
});

const DIRECTOR = {
  self_alias: "argos", tenant_id: "Steven", room_id: "grp.steven", sender_alias: "zeus",
} as const;

test("para el alias que dirige, el deber primario manda REPARTIR y VERIFICAR; construir es la excepción", () => {
  const prompt = protocolPrompt("request", undefined, context(DIRECTOR));

  assert.match(prompt, /tu entrega es REPARTIR y VERIFICAR/u);
  assert.match(prompt, /Construir vos es la excepción/u);
  assert.match(prompt, /Escribir código de producto NUNCA es tuyo/u);
  assert.match(prompt, /desatascalo dirigiendo/u);
  assert.match(prompt, /"messages" lleva N entradas/u);
  assert.equal(prompt.split("Esta entrega es TU trabajo").length - 1, 0);
  assert.equal(prompt.split("Delegar es la excepción").length - 1, 0);
  assert.equal(prompt.split(PRIMARY_DUTY_HEADER).length - 1, 1);
  assert.ok(prompt.indexOf(PRIMARY_DUTY_HEADER) < prompt.indexOf(DELEGATION_MECHANICS_HEADER));
  assert.ok(prompt.indexOf(IDENTITY_END) < prompt.indexOf(PRIMARY_DUTY_HEADER));
});

test("CONTROL NEGATIVO: el mandato del director es por alias Y tenant; nadie más lo hereda", () => {
  for (const ctx of [
    context(), // iza / Miguel: the usual executor
    context({ self_alias: "zeus", tenant_id: "Steven", room_id: "grp.steven" }), // same tenant, other alias
    context({ self_alias: "argos", tenant_id: "Pablo", room_id: "grp.pablo" }), // same alias, other tenant
  ]) {
    const quien = `${ctx.tenant_id}/${ctx.self_alias}`;
    const prompt = protocolPrompt("request", undefined, ctx);
    assert.match(prompt, /Esta entrega es TU trabajo/u, `${quien} perdió el mandato del ejecutor`);
    assert.match(prompt, /Delegar es la excepción, nunca lo normal/u, `${quien} perdió el mandato del ejecutor`);
    assert.doesNotMatch(prompt, /REPARTIR y VERIFICAR/u, `${quien} heredó el mandato del director`);
  }
});

test("el mandato del director no pesa más que el del ejecutor: el sobre de argos no crece", () => {
  const director = protocolPrompt("request", undefined, context(DIRECTOR));
  const ejecutor = protocolPrompt("request", undefined, context({ ...DIRECTOR, self_alias: "zeus" }));
  assert.ok(
    director.length <= ejecutor.length + 100,
    `el sobre del director mide ${String(director.length)} y el del ejecutor ${String(ejecutor.length)}`,
  );
});
