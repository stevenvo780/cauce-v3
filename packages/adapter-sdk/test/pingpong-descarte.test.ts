import assert from "node:assert/strict";
import test from "node:test";
import { validateDeliveryOutput, validateStructuredOutput } from "../src/sdk/output-parser.js";

/**
 * A message in `messages` addressed to the sender must not invalidate the whole turn.
 *
 * The accidental send to the sender is discarded with a technical notice in the parser,
 * letting the rest of the output (`reply`, other delegations) survive.
 */

const ROUTING_TARGETS = [
  { tenant_id: "Steven", alias: "socrates", online: true },
  { tenant_id: "Pablo", alias: "seneca", online: true },
] as const;

/** The real context of the case: jarvis is handling an `agent.response` sent by seneca. */
function contexto(): Parameters<typeof validateDeliveryOutput>[1] {
  return {
    messageType: "agent.response",
    senderAlias: "seneca",
    selfAlias: "jarvis",
    routingTargets: ROUTING_TARGETS,
  };
}

function salida(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    reply: null,
    messages: [],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [],
    ...overrides,
  };
}

// (a) The case that used to cost the turn: a real reply + one `messages` to the sender.
test("un mensaje al remitente se descarta y el reply sobrevive", () => {
  const output = validateDeliveryOutput(
    validateStructuredOutput(salida({
      reply: "Aca va la lista de 11 prospectos, con dominio y contacto de cada uno.",
      messages: [{ to: "seneca", body: "Aca va la lista de 11 prospectos." }],
    })),
    contexto(),
  );

  // What did NOT happen before: the turn survives.
  assert.equal(output.status, "done");
  assert.equal(output.retryable, false);
  assert.match(output.reply ?? "", /lista de 11 prospectos, con dominio/u);

  // The misrouted accessory is gone, leaving a trace with the reason and destination.
  assert.deepEqual(output.messages, []);
  assert.match(output.reply ?? "", /\[Cauce\]/u);
  assert.match(output.reply ?? "", /seneca/u);
  assert.match(output.reply ?? "", /reply/u);
});

// (a-bis) The deliverable is not lost even when it lived ONLY inside the misrouted message:
// the `reply`'s recipient is exactly the same sender, so it folds there.
test("si el trabajo vivia solo en el mensaje al remitente, se pliega en el reply", () => {
  const output = validateDeliveryOutput(
    validateStructuredOutput(salida({
      reply: null,
      messages: [{ to: "seneca", body: "PROSPECTO-1 acme.com; PROSPECTO-2 globex.com" }],
    })),
    contexto(),
  );

  assert.equal(output.status, "done", "descartar el mensaje no puede degradar el turno a failed");
  assert.deepEqual(output.messages, []);
  assert.match(output.reply ?? "", /PROSPECTO-1 acme\.com; PROSPECTO-2 globex\.com/u);
});

// (b) A legitimate delegation to a THIRD party is left untouched.
test("una delegacion a un tercero legitimo queda intacta", () => {
  const entrada = validateStructuredOutput(salida({
    reply: "Delego la verificación y te aviso.",
    messages: [{ to: "socrates", body: "verificá el resultado de forma independiente" }],
  }));
  const output = validateDeliveryOutput(entrada, contexto());

  assert.equal(output.status, "done");
  assert.deepEqual(output.messages, [{ to: "socrates", body: "verificá el resultado de forma independiente" }]);
  const reply = output.reply ?? "";
  assert.equal(reply, "Delego la verificación y te aviso.");
  assert.doesNotMatch(reply, /\[Cauce\]/u);
});

// (b-bis) Mix: ONLY the sender's is discarded; the third party's travels.
test("con remitente y tercero mezclados solo se descarta el del remitente", () => {
  const output = validateDeliveryOutput(
    validateStructuredOutput(salida({
      reply: "Hecho.",
      messages: [
        { to: "seneca", body: "te devuelvo el resultado" },
        { to: "socrates", body: "arrancá la verificación" },
      ],
    })),
    contexto(),
  );

  assert.equal(output.status, "done");
  assert.deepEqual(output.messages, [{ to: "socrates", body: "arrancá la verificación" }]);
  assert.match(output.reply ?? "", /^Hecho\./u);
  assert.match(output.reply ?? "", /\[Cauce\]/u);
});

// (c) The healthy case: nothing to discard, nothing to touch.
test("el turno sano no cambia en nada", () => {
  const entrada = validateStructuredOutput(salida({ reply: "Listo, sin delegaciones." }));
  const output = validateDeliveryOutput(entrada, contexto());

  assert.equal(output, entrada, "sin descartes el objeto no se reescribe");
  assert.equal(output.reply, "Listo, sin delegaciones.");
  assert.deepEqual(output.messages, []);
});

/**
 * The rest of the destinations contract is NOT softened: an unknown third party, ambiguous,
 * offline, or the alias itself remain hard errors. The only price change is the bounce to the
 * sender, which has a correct and obvious channel to fall into.
 */
test("los demas destinos invalidos siguen siendo error duro", () => {
  for (const destino of ["jarvis", "vulcano"]) {
    assert.throws(
      () => validateDeliveryOutput(
        validateStructuredOutput(salida({
          reply: "algo",
          messages: [{ to: destino, body: "trabajo" }],
        })),
        contexto(),
      ),
      /alias|routing inventory/u,
      `${destino} tiene que seguir fallando`,
    );
  }
});
