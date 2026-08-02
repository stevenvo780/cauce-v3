import assert from "node:assert/strict";
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

const stateRoot = resolve(".test-state");

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

  // Una sola formulacion del deber. Dos, con bordes distintos, invitan a obedecer la mas floja.
  assert.equal(prompt.split("Esta entrega es TU trabajo").length - 1, 1);
  assert.equal(prompt.split("Delegar es la excepción").length - 1, 1);

  // La identidad describe el mundo; no manda sobre la delegacion.
  assert.doesNotMatch(identity, /Esta entrega es TU trabajo/u);
  assert.doesNotMatch(identity, /Delegá solo si/u);
  assert.doesNotMatch(identity, /Delegar es la excepción/u);

  // Y el mandato en ingles del parche de prompt ya no existe en ninguna parte.
  assert.ok(!prompt.includes("This delivery is YOUR work"));
  assert.ok(!prompt.includes("Delegation is the exception, never the default"));
  assert.ok(!prompt.includes("Primary duty -- this outranks every mechanic below:"));
});

test("la prohibicion de esperar aparece una vez por cada lado, y no dos veces del mismo", () => {
  const prompt = protocolPrompt("request", undefined, context());

  // Lado propio (identidad, castellano): que a VOS te encarguen esperar.
  assert.match(prompt, /si esta entrega te pide monitorear, vigilar o aguardar la respuesta de una persona, no dejes el turno abierto/u);
  // Lado delegado (mecanica, ingles): que VOS le encargues esperar a otro.
  assert.match(prompt, /Never delegate a task that cannot terminate/u);
  assert.match(prompt, /Cauce is event-driven: an agent runs only when a delivery reaches it, nobody polls/u);
  assert.match(prompt, /"monitor X", "stay alert", "wait until the human answers"/u);
  assert.match(prompt, /dies at the ACK deadline/u);
  assert.match(prompt, /When progress depends on a person, ask once in your "reply" and finish the turn/u);

  // La version en ingles del caso propio se fue: la cubre el bloque de identidad.
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
  // El nombre citado tiene que existir textualmente arriba, o la referencia no ancla en nada.
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

  // Sigue sin valer: silencio sin delegar nada. Lo que cambio es el PRECIO. El `throw` mataba el
  // turno entero y dejaba la entrega sin `result`, asi que el castigo por un harness que corta
  // antes de responder se lo comia la persona que habia preguntado, no el agente.
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

  // Una sola aparicion del texto del rol en todo el prompt.
  assert.equal(prompt.split(role).length - 1, 1);
  assert.match(prompt, new RegExp(`Tu rol: ${role.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));

  // El bloque de metadatos no lo repite, pero conserva todo lo que si es de la entrega.
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
 * DEFECTO A, medido el 2026-07-30: la prohibición de abrir otra ronda de delegación vivía SÓLO en
 * el bloque de `agent.fanin`, y para `agent.response` lo único escrito prohibía rebotarle al
 * remitente — lo único que nunca pasó. Lo que sí pasó, 4 de 4 veces, fue re-delegar A TERCEROS
 * desde la respuesta: 22 entregas donde tocaban 10.
 */
test("una agent.response trae la regla que prohibe re-pinguear las ramas ya abiertas", () => {
  const response = protocolPrompt("request", undefined, context({ message_type: "agent.response" }));

  assert.match(response, /- For an "agent\.response" delivery, finish the original task supplied by the SDK/u);
  assert.match(response, /closes ONE branch of a fan-out you already opened; it never reopens the round/u);
  assert.match(response, /never re-send this task to an alias in already_returned or still_pending/u);
  // Y el permiso para una cadena de trabajo real de varios pasos NO se retira: la prohibición es
  // de duplicar, no de delegar. Un "nunca delegues desde un response" rompería trabajo válido.
  assert.match(response, /admissible only for work that is genuinely NEW/u);
  assert.ok(response.indexOf(PRIMARY_DUTY_HEADER) < response.indexOf('- For an "agent.response" delivery'));
});

/**
 * Las reglas de continuación sólo pesan en una continuación. Iban en el bloque fijo de TODA
 * entrega, que es el que el dueño paga ~1.000 tokens por turno sin deduplicación.
 */
test("las reglas de agent.response no viajan en las entregas que no son continuaciones", () => {
  for (const messageType of ["request", "agent.message", "agent.fanin"]) {
    const prompt = protocolPrompt("request", undefined, context({ message_type: messageType }));
    assert.ok(!prompt.includes('- For an "agent.response" delivery'), messageType);
    assert.ok(!prompt.includes("closes ONE branch of a fan-out"), messageType);
  }
});

/**
 * El bloque de `agent.fanin` era código muerto: `AdapterEngine` sintetiza el fan-in en el SDK y
 * nunca invoca al arnés, así que esas cuatro líneas no se renderizaron nunca en producción. El
 * test que las exigía sostenía la creencia falsa de que el agente sintetiza el fan-in. Lo que
 * pedían sigue garantizado sin prompt: ver «every harness runtime bypasses providers and native
 * sessions for agent fan-in» en engine.test.ts y el rechazo de `validateDeliveryOutput`.
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
  // El prompt llega a un bridge Python que hace payload.decode("utf-8", errors="strict") sobre lo
  // que el runner escribio con stdin.end(request.stdin, "utf8"). La propiedad que importa no es
  // "es ASCII" —el role_brief viene en castellano de la base— sino que el viaje sea sin perdida.
  const scaffolding = protocolPrompt("request", undefined, context({
    self_role: "Producción creativa y multimedia: guiones, escenas, animación y versiones.",
  }));

  const bytes = Buffer.from(scaffolding, "utf8");
  assert.equal(bytes.toString("utf8"), scaffolding, "el prompt tiene que ir y volver identico");
  // MAX_INPUT_BYTES del bridge de hermes es 1 MiB y rechaza el exceso en vez de recortarlo.
  assert.ok(bytes.byteLength < 1024 * 1024);
  // El prompt se lee por lineas: ningun control mas alla del salto de linea.
  const controls = [...scaffolding].filter((character) => {
    const code = character.codePointAt(0)!;
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
