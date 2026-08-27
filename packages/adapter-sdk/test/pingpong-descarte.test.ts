import assert from "node:assert/strict";
import test from "node:test";
import { validateDeliveryOutput, validateStructuredOutput } from "../src/sdk/output-parser.js";

/**
 * Un mensaje en `messages` dirigido al remitente no debe invalidar el turno completo.
 *
 * El envío accidental hacia el remitente se descarta con aviso técnico en el parser,
 * permitiendo que el resto del resultado (`reply`, otras delegaciones) sobreviva.
 */

const ROUTING_TARGETS = [
  { tenant_id: "Steven", alias: "socrates", online: true },
  { tenant_id: "Pablo", alias: "seneca", online: true },
] as const;

/** El contexto real del caso: jarvis atiende un `agent.response` que le mandó seneca. */
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

// (a) El caso que costaba el turno: reply de verdad + un `messages` al remitente.
test("un mensaje al remitente se descarta y el reply sobrevive", () => {
  const output = validateDeliveryOutput(
    validateStructuredOutput(salida({
      reply: "Aca va la lista de 11 prospectos, con dominio y contacto de cada uno.",
      messages: [{ to: "seneca", body: "Aca va la lista de 11 prospectos." }],
    })),
    contexto(),
  );

  // Lo que antes NO pasaba: el turno vive.
  assert.equal(output.status, "done");
  assert.equal(output.retryable, false);
  assert.match(output.reply ?? "", /lista de 11 prospectos, con dominio/u);

  // El accesorio mal dirigido se fue, y dejó rastro con el motivo y el destino.
  assert.deepEqual(output.messages, []);
  assert.match(output.reply ?? "", /\[Cauce\]/u);
  assert.match(output.reply ?? "", /seneca/u);
  assert.match(output.reply ?? "", /reply/u);
});

// (a-bis) El entregable no se pierde ni cuando vivía SOLO dentro del mensaje mal dirigido:
// el destinatario del `reply` es exactamente el mismo remitente, así que se pliega ahí.
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

// (b) Una delegación legítima a un TERCERO no se toca.
test("una delegacion a un tercero legitimo queda intacta", () => {
  const entrada = validateStructuredOutput(salida({
    reply: "Delego la verificación y te aviso.",
    messages: [{ to: "socrates", body: "verificá el resultado de forma independiente" }],
  }));
  const output = validateDeliveryOutput(entrada, contexto());

  assert.equal(output.status, "done");
  assert.deepEqual(output.messages, [{ to: "socrates", body: "verificá el resultado de forma independiente" }]);
  assert.equal(output.reply, "Delego la verificación y te aviso.");
  assert.doesNotMatch(output.reply ?? "", /\[Cauce\]/u);
});

// (b-bis) Mezcla: se descarta SOLO el del remitente; el del tercero viaja.
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

// (c) El caso sano: nada que descartar, nada que tocar.
test("el turno sano no cambia en nada", () => {
  const entrada = validateStructuredOutput(salida({ reply: "Listo, sin delegaciones." }));
  const output = validateDeliveryOutput(entrada, contexto());

  assert.equal(output, entrada, "sin descartes el objeto no se reescribe");
  assert.equal(output.reply, "Listo, sin delegaciones.");
  assert.deepEqual(output.messages, []);
});

/**
 * El resto del contrato de destinos NO se ablanda: un tercero desconocido, ambiguo, fuera de
 * línea o el propio alias siguen siendo error duro. Lo único que cambia de precio es el rebote al
 * remitente, que tiene un canal correcto y evidente al que caer.
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
