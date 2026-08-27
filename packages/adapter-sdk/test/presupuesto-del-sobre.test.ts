import assert from "node:assert/strict";
import test from "node:test";
import { protocolPrompt, type HarnessRequestContext } from "../src/harnesses/shared.js";
import type { RelayOrigin } from "../src/sdk/types.js";

/**
 * Presupuesto de tamaño del sobre y andamiaje de prompt.
 *
 * Valida límites máximos de caracteres en el andamiaje del sobre generado por
 * `protocolPrompt()`, evitando regresiones de tamaño en el transporte de mensajes.
 */
const TOPE_ANDAMIAJE_FIJO = 7_900;
const TOPE_SOBRE_COMPLETO = 10_400;

function contextoReal(overrides: Partial<HarnessRequestContext> = {}): HarnessRequestContext {
  return {
    self_alias: "zeus",
    sender_alias: "argos",
    tenant_id: "Steven",
    room_id: "grp.steven",
    channel: "telegram",
    agent_message: true,
    message_type: "agent.message",
    routing_targets: [
      "argos", "atlas", "gaia", "hegel", "heraclito", "iza", "janus",
      "jarvis", "kant", "kratos", "salva", "socrates", "tales",
    ].map((alias) => ({ tenant_id: "Steven", alias, online: true })),
    ...overrides,
  };
}

const ORIGEN: RelayOrigin = {
  adapter: "telegram",
  channel: "telegram",
  conversation_id: "grp.steven:123",
  relay: [],
  metadata: {},
};

/** El andamiaje = el sobre sin rol, sin metadata y sin pedido. */
function medirAndamiaje(): number {
  const conRol = protocolPrompt("", ORIGEN, contextoReal({ self_role: "R".repeat(1000) }));
  const sinRol = protocolPrompt("", ORIGEN, contextoReal());
  const inicioMetadata = sinRol.indexOf("--- BEGIN TRUSTED DELIVERY CONTEXT ---");
  assert.notEqual(inicioMetadata, -1, "el bloque de metadata tiene que existir para poder restarlo");
  // Control de coherencia: quitar el rol tiene que quitar exactamente el rol (más su renglón).
  assert.ok(conRol.length - sinRol.length >= 1000, "la línea del rol no se está contando");
  return inicioMetadata;
}

test("el andamiaje FIJO del sobre no crece sin que nadie se entere", () => {
  const andamiaje = medirAndamiaje();
  assert.ok(
    andamiaje <= TOPE_ANDAMIAJE_FIJO,
    `El texto fijo que viaja en CADA entrega mide ${andamiaje} caracteres y el tope es ` +
      `${TOPE_ANDAMIAJE_FIJO}. Si lo subiste a propósito, subí el tope en el mismo commit y ` +
      `explicá por qué ese texto tiene que ir en cada turno en vez de en el fichero del arnés.`,
  );
});

test("el sobre completo, con rol al tope y 13 destinos, no crece sin que nadie se entere", () => {
  const sobre = protocolPrompt(
    "Revisa el estado del gateway y decime si hay entregas muertas.",
    ORIGEN,
    contextoReal({ self_role: "R".repeat(1200) }),
  );
  assert.ok(
    sobre.length <= TOPE_SOBRE_COMPLETO,
    `El sobre mide ${sobre.length} caracteres y el tope es ${TOPE_SOBRE_COMPLETO}.`,
  );
});

/*
 * CONTROL NEGATIVO. Sin esto, las dos pruebas de arriba podrían estar midiendo la cadena vacía
 * y darían verde para siempre. Aquí se comprueba que el medidor SÍ reacciona: un sobre con más
 * texto mide más, y el andamiaje medido es un número grande de verdad y no un cero.
 */
test("CONTROL NEGATIVO: el medidor reacciona, no devuelve siempre lo mismo", () => {
  const andamiaje = medirAndamiaje();
  assert.ok(andamiaje > 5_000, `el andamiaje medido (${andamiaje}) es sospechosamente chico: ¿mide algo?`);

  const corto = protocolPrompt("hola", ORIGEN, contextoReal());
  const largo = protocolPrompt("hola".repeat(500), ORIGEN, contextoReal());
  assert.ok(largo.length > corto.length + 1_000, "el medidor no distingue un pedido largo de uno corto");
});

/**
 * Verifica que la proporción andamiaje/pedido se mantenga acotada.
 */
test("la proporción andamiaje/pedido queda escrita, para poder verla bajar", () => {
  const pedido = "Revisa el estado del gateway y decime si hay entregas muertas.";
  const sobre = protocolPrompt(pedido, ORIGEN, contextoReal({ self_role: "R".repeat(1097) }));
  const ratio = Math.round((sobre.length - pedido.length) / pedido.length);
  assert.ok(
    ratio <= 170,
    `Por cada carácter de trabajo real viajan ${ratio} de andamiaje.`,
  );
});
