import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  HARNESS_DEFINITIONS,
  HarnessAdapter,
  fakeDefinition,
} from "../src/harnesses/index.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import { AdapterEngine, profileAdoptionFor } from "../src/sdk/engine.js";
import type {
  CancelDelivery,
  CommandRunRequest,
  CommandRunResult,
  CommandRunner,
  Delivery,
  DeliveryEvent,
} from "../src/sdk/types.js";
import {
  ControlledRunner,
  SUCCESS,
  delivery,
  sessionOf,
  setup,
} from "./engine-fixtures.js";
test("un mensaje con solo adjuntos llega al harness en vez de morir sin respuesta", async () => {
  const context = await setup("engine-media-only");
  const input: Delivery = {
    ...delivery("media-only-photo"),
    body: {
      type: "telegram.message",
      chat_type: "private",
      media: [
        { kind: "photo", file_id: "AgACAgEAAxk", file_size: 137933 },
        { kind: "photo", file_id: "AgACAgEAAxl", file_size: 141151 },
      ],
    },
  };
  await context.engine.handleDelivery(input);

  // Lo que importa: el harness SE INVOCA. Antes esto reventaba con INVALID_DELIVERY y la
  // persona que mandaba la foto no recibia absolutamente nada.
  assert.equal(context.runner.requests.length, 1);
  assert.notEqual(context.events.at(-1)?.error?.code, "INVALID_DELIVERY");

  const enviado = context.runner.requests[0]?.stdin ?? "";
  assert.match(enviado, /2 adjuntos de tipo photo/u);
  assert.match(enviado, /No podés ver ni abrir el contenido/u);
});

test("materializa attachments_v1 para el harness, verifica contenido y limpia el temporal", async () => {
  const payload = Buffer.from("%PDF-1.7\ncontenido de prueba", "utf8");
  let materializedPath: string | undefined;
  let materializedContents: Buffer | undefined;
  class AttachmentRunner extends ControlledRunner {
    override async run(request: CommandRunRequest): Promise<CommandRunResult> {
      const pathMatch = request.stdin.match(/"local_path":"([^"]+)"/u);
      assert.ok(pathMatch?.[1], "el prompt debe incluir una ruta local accesible");
      materializedPath = pathMatch[1];
      materializedContents = await readFile(materializedPath);
      assert.match(request.stdin, /"name":"informe\.pdf"/u);
      assert.match(request.stdin, /"mime_type":"application\/pdf"/u);
      assert.match(request.stdin, /delivery_mode=filesystem_fallback/u);
      return super.run(request);
    }
  }
  const runner = new AttachmentRunner();
  const context = await setup("engine-telegram-attachment", runner);
  const input: Delivery = {
    ...delivery("media-pdf"),
    body: {
      type: "telegram.message",
      attachments_v1: [{
        kind: "document",
        name: "informe.pdf",
        mime_type: "application/pdf",
        file_size: payload.length,
        sha256: createHash("sha256").update(payload).digest("hex"),
        content_base64: payload.toString("base64"),
      }],
    },
  };

  await context.engine.handleDelivery(input);

  assert.deepEqual(materializedContents, payload);
  assert.ok(materializedPath);
  await assert.rejects(access(materializedPath), { code: "ENOENT" });
  assert.equal(context.events.at(-1)?.phase, "done");
});

/**
 * La ENTREGA tiene que aceptar los mismos textos que la INGESTA.
 *
 * `SUPPORTED_MIME` es un allowlist propio de este paquete, sin relacion con el enum del protocolo.
 * Mientras solo conocia `.txt`, ampliar el protocolo movia el fallo de la ingesta a aca: el .md
 * entraba al bus, se guardaba, y al entregarlo `materializeAttachments` tiraba `INVALID_ATTACHMENT`
 * NO reintentable, que termina en `finishError` ANTES de invocar al harness. El agente no veia el
 * archivo Y TAMPOCO el texto del humano.
 */
test("los textos que la ingesta acepta tambien se materializan en la entrega", async () => {
  const casos: readonly (readonly [string, string])[] = [
    ["notas.md", "text/markdown"],
    ["notas.md", "text/x-markdown"],
    ["notas.md", "text/plain"],
    ["tabla.csv", "text/csv"],
    ["tabla.csv", "text/plain"],
  ];
  const payload = Buffer.from("# informe\nuna linea\n", "utf8");
  for (const [indice, [name, mime]] of casos.entries()) {
    const runner = new ControlledRunner();
    const context = await setup(`engine-texto-${indice}`, runner);
    const input: Delivery = {
      ...delivery(`media-texto-${indice}`),
      body: {
        type: "telegram.message",
        attachments_v1: [{
          kind: "document",
          name,
          mime_type: mime,
          file_size: payload.length,
          sha256: createHash("sha256").update(payload).digest("hex"),
          content_base64: payload.toString("base64"),
        }],
      },
    };

    await context.engine.handleDelivery(input);

    assert.equal(context.events.at(-1)?.phase, "done", `${mime} + ${name} deberia entregarse`);
    assert.match(runner.requests.at(-1)?.stdin ?? "", /"local_path":"[^"]+"/u);
  }
});

test("un cuerpo realmente vacio sigue siendo rechazado", async () => {
  const context = await setup("engine-body-empty");
  const input: Delivery = {
    ...delivery("body-empty"),
    body: { type: "telegram.message", chat_type: "private" },
  };
  await context.engine.handleDelivery(input);
  assert.equal(context.runner.requests.length, 0);
  assert.equal(context.events.at(-1)?.error?.code, "INVALID_DELIVERY");
});

/**
 * DEFECTO B,  el `agent.fanin` llegaba con
 * las cuatro respuestas adentro y el coordinador escribía igual FALTA para tres de las cuatro.
 * La causa no era desatención: cada `agent.response` abre un turno propio que traía el pedido
 * original y UNA rama, sin ninguna noticia de las hermanas. Con esto el turno trae el estado del
 * abanico completo, calculado del inbox local, así que la última rama puede consolidar aunque el
 * arnés no tenga memoria ninguna.
 *
 * Y es también la mitad de DEFECTO A: `still_pending` es la respuesta a la pregunta que hacía
 * re-pinguear ("¿a quién le falta contestarme?") sin gastar una entrega en preguntarla.
 */
test("cada agent.response de un abanico llega con el estado de sus ramas hermanas", async () => {
  const runner = new ControlledRunner();
  runner.stdout = JSON.stringify({
    reply: "reparto el trabajo entre dos",
    messages: [
      { to: "socrates", body: "rama uno" },
      { to: "seneca", body: "rama dos" },
    ],
    status: "done",
    retryable: false,
    artifacts: [],
  });
  const context = await setup("engine-branch-progress", runner);
  const rootDelivery: Delivery = {
    ...delivery("branch-progress-root"),
    trace_id: "trace-branch-progress",
    body: { prompt: "traeme una palabra de cada uno" },
    routing_targets: [
      { tenant_id: "Steven", alias: "socrates", online: true },
      { tenant_id: "Steven", alias: "seneca", online: true },
    ],
  };
  await context.engine.handleDelivery(rootDelivery);

  const correlation = {
    root_message_id: rootDelivery.message_id,
    root_delivery_id: rootDelivery.delivery_id,
    response_to_delivery_id: rootDelivery.delivery_id,
  };
  runner.stdout = JSON.stringify({
    reply: "socrates=BOTON; seneca sigue abierto",
    messages: [],
    status: "done",
    retryable: false,
    artifacts: [],
  });
  await context.engine.handleDelivery({
    ...delivery("branch-progress-a"),
    actor_alias: "socrates",
    recipient_alias: "argos",
    trace_id: rootDelivery.trace_id,
    body: { type: "agent.response", text: "BOTON", correlation },
  });

  runner.stdout = SUCCESS;
  await context.engine.handleDelivery({
    ...delivery("branch-progress-b"),
    actor_alias: "seneca",
    recipient_alias: "argos",
    trace_id: rootDelivery.trace_id,
    body: { type: "agent.response", text: "CIRUELA", correlation },
  });

  const first = runner.requests[1]?.stdin ?? "";
  const second = runner.requests[2]?.stdin ?? "";

  // La primera rama ya sabe que la otra está abierta: re-pinguearla es duplicar, no avanzar.
  assert.match(first, /"delegated_to":\["socrates","seneca"\]/u);
  assert.match(first, /"this_branch":"socrates"/u);
  assert.match(first, /"already_returned":\[\]/u);
  assert.match(first, /"still_pending":\["seneca"\]/u);

  // La última rama llega con el agregado adentro y sin nada pendiente que pueda leerse como falta.
  assert.match(second, /"this_branch":"seneca"/u);
  assert.match(second, /"still_pending":\[\]/u);
  assert.match(
    second,
    /"alias":"socrates","your_reply":"socrates=BOTON; seneca sigue abierto"/u,
  );
  assert.match(second, /Carry every already_returned branch into this reply/u);
  assert.match(second, /do not re-send this task to any alias in either list/u);
});

test("a rejected output is durable feedback and never remains as a phantom pending branch", async () => {
  const runner = new ControlledRunner();
  runner.stdout = JSON.stringify({
    reply: "abro dos ramas",
    messages: [
      { to: "socrates", body: "rama aceptada" },
      { to: "seneca", body: "rama que el store rechaza" },
    ],
    status: "done",
    retryable: false,
    artifacts: [],
  });
  const context = await setup("engine-branch-feedback-rejection", runner);
  const rootDelivery: Delivery = {
    ...delivery("branch-feedback-root"),
    trace_id: "trace-branch-feedback",
    routing_targets: [
      { tenant_id: "Steven", alias: "socrates", online: true },
      { tenant_id: "Steven", alias: "seneca", online: true },
    ],
  };
  await context.engine.handleDelivery(rootDelivery);
  const rootTerminal = context.store.pendingEvents().find((event) => (
    event.delivery_id === rootDelivery.delivery_id && event.phase === "done"
  ));
  assert.ok(rootTerminal);
  const childId = "71000000-0000-4000-8000-000000000001";
  await context.store.acknowledgeResult(rootTerminal, {
    delegation_materializations: [{
      output_index: 0,
      target_tenant: "Steven",
      target_alias: "socrates",
      child_delivery_id: childId,
    }],
    delegation_rejections: [{
      output_index: 1,
      target: "seneca",
      code: "fanout_exceeded",
      reason: "The fan-out cap rejected this output.",
      guidance: "Do not retry this rejected branch.",
    }],
  });

  runner.stdout = SUCCESS;
  await context.engine.handleDelivery({
    ...delivery("branch-feedback-response"),
    actor_alias: "socrates",
    recipient_alias: "argos",
    trace_id: rootDelivery.trace_id,
    body: {
      type: "agent.response",
      text: "rama aceptada completa",
      correlation: {
        root_message_id: rootDelivery.message_id,
        root_delivery_id: rootDelivery.delivery_id,
        response_to_delivery_id: rootDelivery.delivery_id,
        child_delivery_id: childId,
      },
    },
  });
  const prompt = runner.requests[1]?.stdin ?? "";
  assert.match(prompt, /"delegated_to":\["socrates"\]/u);
  assert.match(prompt, /"rejected_delegations":\[\{"output_index":1,"target":"seneca","code":"fanout_exceeded"\}\]/u);
  assert.match(prompt, /"still_pending":\[\]/u);
  assert.doesNotMatch(prompt, /"still_pending":\["seneca"\]/u);
  assert.doesNotMatch(prompt, /The fan-out cap rejected this output/u, "receipt prose leaked into the prompt");
});

test("two materialized outputs to one alias close only by their exact child delivery ids", async () => {
  const runner = new ControlledRunner();
  runner.stdout = JSON.stringify({
    reply: "dos trabajos distintos para el mismo agente",
    messages: [
      { to: "socrates", body: "rama cero" },
      { to: "socrates", body: "rama uno" },
    ],
    status: "done",
    retryable: false,
    artifacts: [],
  });
  const context = await setup("engine-branch-same-alias", runner);
  const rootDelivery: Delivery = {
    ...delivery("branch-same-alias-root"),
    trace_id: "trace-branch-same-alias",
    routing_targets: [{ tenant_id: "Steven", alias: "socrates", online: true }],
  };
  await context.engine.handleDelivery(rootDelivery);
  const rootTerminal = context.store.pendingEvents().find((event) => (
    event.delivery_id === rootDelivery.delivery_id && event.phase === "done"
  ));
  assert.ok(rootTerminal);
  const firstChild = "72000000-0000-4000-8000-000000000001";
  const secondChild = "72000000-0000-4000-8000-000000000002";
  await context.store.acknowledgeResult(rootTerminal, {
    delegation_materializations: [{
      output_index: 0,
      target_tenant: "Steven",
      target_alias: "socrates",
      child_delivery_id: firstChild,
    }, {
      output_index: 1,
      target_tenant: "Steven",
      target_alias: "socrates",
      child_delivery_id: secondChild,
    }],
  });

  const correlation = (child_delivery_id: string) => ({
    root_message_id: rootDelivery.message_id,
    root_delivery_id: rootDelivery.delivery_id,
    response_to_delivery_id: rootDelivery.delivery_id,
    child_delivery_id,
  });
  runner.stdout = JSON.stringify({
    reply: "cerré solamente la rama cero",
    messages: [], status: "done", retryable: false, artifacts: [],
  });
  await context.engine.handleDelivery({
    ...delivery("branch-same-alias-first"),
    actor_alias: "socrates",
    recipient_alias: "argos",
    trace_id: rootDelivery.trace_id,
    body: { type: "agent.response", text: "primera", correlation: correlation(firstChild) },
  });

  runner.stdout = SUCCESS;
  await context.engine.handleDelivery({
    ...delivery("branch-same-alias-second"),
    actor_alias: "socrates",
    recipient_alias: "argos",
    trace_id: rootDelivery.trace_id,
    body: { type: "agent.response", text: "segunda", correlation: correlation(secondChild) },
  });

  const firstPrompt = runner.requests[1]?.stdin ?? "";
  const secondPrompt = runner.requests[2]?.stdin ?? "";
  assert.match(firstPrompt, /"still_pending":\["socrates"\]/u);
  assert.match(firstPrompt, new RegExp(`"child_delivery_id":"${secondChild}"`, "u"));
  assert.doesNotMatch(firstPrompt, /"still_pending":\[\]/u);
  assert.match(secondPrompt, /"still_pending":\[\]/u);
  assert.match(secondPrompt, new RegExp(`"child_delivery_id":"${firstChild}"`, "u"));
  assert.match(secondPrompt, /"output_index":0/u);
});

/** Una delegación de una sola rama no tiene nada que consolidar: el prompt queda como estaba. */
test("un abanico de una sola rama no paga el bloque de branch_progress", async () => {
  const runner = new ControlledRunner();
  runner.stdout = JSON.stringify({
    reply: "va uno solo",
    messages: [{ to: "socrates", body: "rama unica" }],
    status: "done",
    retryable: false,
    artifacts: [],
  });
  const context = await setup("engine-branch-progress-single", runner);
  const rootDelivery: Delivery = {
    ...delivery("branch-single-root"),
    trace_id: "trace-branch-single",
    body: { prompt: "una sola cosa" },
    routing_targets: [{ tenant_id: "Steven", alias: "socrates", online: true }],
  };
  await context.engine.handleDelivery(rootDelivery);

  runner.stdout = SUCCESS;
  await context.engine.handleDelivery({
    ...delivery("branch-single-response"),
    actor_alias: "socrates",
    recipient_alias: "argos",
    trace_id: rootDelivery.trace_id,
    body: {
      type: "agent.response",
      text: "listo",
      correlation: {
        root_message_id: rootDelivery.message_id,
        root_delivery_id: rootDelivery.delivery_id,
        response_to_delivery_id: rootDelivery.delivery_id,
      },
    },
  });

  const prompt = runner.requests[1]?.stdin ?? "";
  assert.match(prompt, /agent_response_continuation/u);
  // La clave del JSON y la instrucción que la acompaña; la palabra suelta no sirve como prueba,
  // porque el contrato de toda `agent.response` la nombra en prosa aunque no haya bloque.
  assert.ok(!prompt.includes('"branch_progress"'));
  assert.ok(!prompt.includes("branch_progress is this adapter's own local record"));
});

/**
 * Sin `origin` la conversación se derivaba del ACTOR, y para el tráfico entre agentes el actor no
 * es una conversación: es una RAMA. Un abanico de cuatro volvía como cuatro sesiones nativas
 * aisladas y cuatro candados FIFO independientes, así que ningún turno veía a los demás y encima
 * podían correr a la vez. Se colapsa hasta el tenant del par: ni más (una sesión por cadena no
 * tiene cota y `sessions.json` se invalida a las 4096 entradas, sin poda) ni menos (una sesión
 * única mezclaría el trabajo de dos tenants en un mismo transcript).
 */
test("sin origin, el carril de agentes es uno por tenant y no uno por remitente", async () => {
  const context = await setup("engine-agent-lane-session");
  const consolePublish = (id: string, overrides: Partial<Delivery>): Delivery => {
    const { origin: _origin, authenticated_context: _authenticated, ...rest } = delivery(id);
    return {
      ...rest,
      authenticated_context: { session_id: `delivery:${id}:attempt:1`, channel: "console" },
      ...overrides,
    };
  };

  await context.engine.handleDelivery(consolePublish("agent-lane-human", {
    body: { prompt: "esto lo hacés vos" },
  }));
  await context.engine.handleDelivery(consolePublish("agent-lane-a", {
    actor_alias: "socrates",
    body: { type: "agent.response", text: "rama de socrates" },
  }));
  await context.engine.handleDelivery(consolePublish("agent-lane-b", {
    actor_alias: "seneca",
    body: { type: "agent.response", text: "rama de seneca" },
  }));
  await context.engine.handleDelivery(consolePublish("agent-lane-c", {
    tenant_id: "Miguel",
    actor_alias: "atlas",
    body: { type: "agent.response", text: "rama de atlas" },
  }));

  const human = sessionOf(context.runner, 0);
  const socrates = sessionOf(context.runner, 1);
  const seneca = sessionOf(context.runner, 2);
  const atlas = sessionOf(context.runner, 3);

  // Dos ramas del mismo tenant comparten sesión: por eso la última puede ver a la anterior, y por
  // eso el candado FIFO las serializa en vez de dejarlas correr en paralelo.
  assert.equal(seneca, socrates);
  // Pero el trabajo de otro tenant no entra en ese transcript.
  assert.notEqual(atlas, socrates);
  // Y la conversación de la persona sigue siendo suya, en su propio carril.
  assert.notEqual(human, socrates);
});
