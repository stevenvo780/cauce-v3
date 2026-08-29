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
  setup,
} from "./engine-fixtures.js";
test("harness prompt receives authenticated origin context", async () => {
  const context = await setup("engine-authenticated-origin");
  const input: Delivery = {
    ...delivery("authenticated-origin"),
    authenticated_context: {
      session_id: "trusted-session",
      channel: "trusted-channel",
      origin: {
        adapter: "trusted-adapter",
        channel: "trusted-channel",
        conversation_id: "trusted-conversation",
        relay: [],
        metadata: {},
      },
    },
  };
  await context.engine.handleDelivery(input);
  const prompt = context.runner.requests[0]?.stdin ?? "";
  assert.match(prompt, /trusted-adapter/u);
  assert.match(prompt, /TRUSTED ORIGIN CONTEXT/u);
  assert.match(prompt, /TRUSTED DELIVERY CONTEXT/u);
  assert.match(prompt, /"self_alias":"argos"/u);
  assert.match(prompt, /"sender_alias":"kant"/u);
  assert.match(prompt, /"channel":"trusted-channel"/u);
  assert.match(prompt, /"agent_message":false/u);
  assert.match(prompt, /"message_type":"request"/u);
  assert.match(prompt, /messages.*only Cauce V3 mechanism/u);
  assert.match(prompt, /status.*done.*retryable.*MUST be false/u);
});

test("el rol declarado llega entero al harness aunque mida 1300 unidades UTF-16", async () => {
  // The exact case that left the alias deaf: 1200 CODE POINTS and 1300 UTF-16 units. The
  // database accepts it (`char_length`=1200), so the adapter must be able to receive it and pass
  // it to the harness without trimming it: trimming here would invent a role for the agent
  // different from what the operator saved through the screen.
  const brief = `${"a".repeat(1100)}${"\u{1F389}".repeat(100)}`;
  assert.equal([...brief].length, 1200);
  assert.equal(brief.length, 1300);

  const context = await setup("engine-self-role-emoji");
  await context.engine.handleDelivery({ ...delivery("self-role-emoji"), self_role: brief });
  const prompt = context.runner.requests[0]?.stdin ?? "";
  assert.ok(prompt.includes(brief), "el rol llegó recortado o alterado al harness");
});

test("el rol se recorta por puntos de código: nunca sale un surrogate suelto al harness", async () => {
  // 1199 letters + one emoji = 1200 code points and 1201 UTF-16 units. The `slice(0, 1200)`
  // that used to be here indexed UTF-16 and split the surrogate pair in half; the lone high
  // surrogate it left has no UTF-8 representation and travelled to the harness stdin as U+FFFD.
  // The agent read its own role ending in a broken character.
  const justo = `${"a".repeat(1199)}\u{1F389}`;
  assert.equal([...justo].length, 1200);
  assert.equal(justo.length, 1201);
  // NEGATIVE CONTROL: the old line, run as is, DOES break the emoji. Without this, the
  // assertion below would pass with any implementation.
  assert.ok(Buffer.from(justo.slice(0, 1200), "utf8").toString("utf8").includes("�"));

  const context = await setup("engine-self-role-surrogate");
  await context.engine.handleDelivery({ ...delivery("self-role-surrogate"), self_role: justo });
  const prompt = context.runner.requests[0]?.stdin ?? "";
  // The measured effect where it hurts: `Tu rol:` does not go through JSON.stringify (which would
  // escape the lone surrogate as \udXXX and hide it), but as raw text. Serialising to UTF-8 and
  // back is exactly what happens when crossing to the harness process stdin, and a lone surrogate
  // does not survive that trip: it comes back as U+FFFD.
  const ida_y_vuelta = Buffer.from(prompt, "utf8").toString("utf8");
  assert.ok(!ida_y_vuelta.includes("�"), "el harness recibió un carácter de reemplazo");
  assert.equal(ida_y_vuelta, prompt);
  assert.match(prompt, /Tu rol: a{1199}\u{1F389}\n/u);
});

test("un rol pasado de largo se recorta en el borde de un punto de código, no dentro", async () => {
  // The SDK does not assume the only sender is a store of this version, so the defensive trim
  // still exists — but now it lands between code points.
  const pasado = `${"a".repeat(1199)}\u{1F389}\u{1F389}`;
  const context = await setup("engine-self-role-clamp");
  await context.engine.handleDelivery({ ...delivery("self-role-clamp"), self_role: pasado });
  const prompt = context.runner.requests[0]?.stdin ?? "";
  assert.match(prompt, /Tu rol: a{1199}\u{1F389}\n/u);
  assert.ok(!prompt.includes(pasado), "no se aplicó ningún recorte");
  assert.equal(Buffer.from(prompt, "utf8").toString("utf8"), prompt);
});

test("agent-output delivery is identified as a real internal agent message", async () => {
  const context = await setup("engine-agent-output-context");
  const input: Delivery = {
    ...delivery("agent-output-context"),
    actor_alias: "jarvis",
    recipient_alias: "seneca",
    body: { type: "agent.message", text: "request from jarvis" },
    authenticated_context: {
      session_id: "trusted-agent-message",
      channel: "agent-output",
      origin: {
        adapter: "telegram",
        channel: "telegram",
        conversation_id: "trusted-conversation",
        relay: [],
        metadata: { bridge_alias: "jarvis" },
      },
    },
  };
  await context.engine.handleDelivery(input);
  const prompt = context.runner.requests[0]?.stdin ?? "";
  assert.match(prompt, /"self_alias":"seneca"/u);
  assert.match(prompt, /"sender_alias":"jarvis"/u);
  assert.match(prompt, /"channel":"agent-output"/u);
  assert.match(prompt, /"agent_message":true/u);
  assert.match(prompt, /"message_type":"agent.message"/u);
  assert.match(prompt, /"routing_targets":\[\]/u);
  assert.match(prompt, /Never use legacy enviar_al_bus/u);
  assert.match(prompt, /answer its sender with "reply"/u);
  assert.match(prompt, /Filesystem paths are local to each alias container/u);
  assert.match(prompt, /resolve the intended repository under your own current workspace/u);
  assert.match(prompt, /Do not rewrite the recipient path from your local mount/u);
  assert.match(prompt, /"@all" is a reserved durable target/u);
});

test("trusted routing inventory is exposed to the harness and @all is the only all-peers target", async () => {
  const context = await setup("engine-routing-targets");
  const input: Delivery = {
    ...delivery("routing-targets"),
    body: { type: "request", text: "validate all other agents" },
    routing_targets: [
      { tenant_id: "Pablo", alias: "seneca", online: true },
      { tenant_id: "Steven", alias: "socrates", online: false },
      { tenant_id: "Pablo", alias: "seneca", online: true },
      { tenant_id: "Miguel", alias: "kratos", online: true },
    ],
  };
  await context.engine.handleDelivery(input);
  const prompt = context.runner.requests[0]?.stdin ?? "";
  assert.match(
    prompt,
    /"routing_targets":\[\{"tenant_id":"Miguel","alias":"kratos","online":true\},\{"tenant_id":"Pablo","alias":"seneca","online":true\},\{"tenant_id":"Steven","alias":"socrates","online":false\}\]/u,
  );
  assert.match(prompt, /emit exactly one message \{"to":"@all","body":"<the delegated task>"\}/u);
  assert.match(prompt, /every online routable peer except self_alias/u);
});

