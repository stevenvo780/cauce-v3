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

  // What matters: the harness IS INVOKED. Before this it blew up with INVALID_DELIVERY and the
  // person sending the photo got absolutely nothing back.
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
 * DELIVERY must accept the same text formats as INGEST.
 *
 * `SUPPORTED_MIME` is an allowlist owned by this package, unrelated to the protocol enum. While
 * it only knew `.txt`, broadening the protocol moved the failure from ingest to here: the .md
 * entered the bus, was stored, and on delivery `materializeAttachments` threw `INVALID_ATTACHMENT`
 * (non-retryable), ending in `finishError` BEFORE invoking the harness. The agent saw neither
 * the file NOR the human's text.
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
 * DEFECT B — `agent.fanin` arrived with all four responses inside and the coordinator still wrote
 * FALTA for three of the four. The cause was not inattention: every `agent.response` opens its
 * own turn carrying the original request and ONE branch, with no notice of the siblings. With
 * this, the turn carries the full fan-out state, computed from the local inbox, so the last
 * branch can consolidate even when the harness has no memory at all.
 *
 * It is also half of DEFECT A: `still_pending` answers the question that caused re-pinging
 * ("who is still left to reply to me?") without spending a delivery asking it.
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

  // The first branch already knows the other is still open: re-pinging duplicates work, not progress.
  assert.match(first, /"delegated_to":\["socrates","seneca"\]/u);
  assert.match(first, /"this_branch":"socrates"/u);
  assert.match(first, /"already_returned":\[\]/u);
  assert.match(first, /"still_pending":\["seneca"\]/u);

  // The last branch arrives with the aggregate inside and nothing pending that could read as missing.
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

/** A single-branch delegation has nothing to consolidate: the prompt stays as it was. */
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
  // The JSON key plus the instruction that goes with it; the standalone word is not proof, because
  // the contract of every `agent.response` mentions it in prose even when the block is absent.
  assert.ok(!prompt.includes('"branch_progress"'));
  assert.ok(!prompt.includes("branch_progress is this adapter's own local record"));
});

/**
 * Without `origin` the conversation was derived from the ACTOR, and for agent-to-agent traffic
 * the actor is not a conversation: it is a BRANCH. A fan-out of four came back as four isolated
 * native sessions and four independent FIFO locks, so no turn saw the others and they could even
 * run in parallel. It collapses to the pair's tenant: no more (one session per chain has no cap
 * and `sessions.json` invalidates at 4096 entries, with no pruning) and no less (a single session
 * would mix two tenants' work in the same transcript).
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

  // Two branches of the same tenant share the session: that is why the last one can see the
  // previous one, and why the FIFO lock serializes them instead of letting them run in parallel.
  assert.equal(seneca, socrates);
  // But the work of another tenant does not enter that transcript.
  assert.notEqual(atlas, socrates);
  // And the person's own conversation stays theirs, in its own lane.
  assert.notEqual(human, socrates);
});
