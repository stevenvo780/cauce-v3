import assert from "node:assert/strict";
import test from "node:test";
import { protocolPrompt, type HarnessRequestContext } from "../src/harnesses/shared.js";
import type { RelayOrigin } from "../src/sdk/types.js";

/*
 * EL PRESUPUESTO DEL SOBRE, y por qué esto es una prueba y no una nota.
 *
 * Medido el 2026-08-24 contra el build DESPLEGADO en producción
 * (`/opt/cauce-v3-adapter/zeus/releases/bus-v3-20260814-umbral`), llamando a `protocolPrompt()`
 * de verdad con un contexto real —13 destinos alcanzables y un rol de 1.097 caracteres—:
 *
 *     sobre COMPLETO         : 11.546 caracteres
 *       andamiaje fijo       :  9.210   ← se repite ENTERO en cada turno de cada alias
 *       rol del alias        :  1.106   ← idem
 *       metadata JSON        :  1.168   ← esto sí cambia de una entrega a otra
 *       pedido real          :     62
 *     ratio andamiaje/pedido : 185 : 1
 *
 * El encargo es que lo FIJO deje de viajar en cada mensaje y pase a vivir en el fichero del
 * arnés, y que entre turnos sólo viaje lo dinámico. Sin una cifra que pueda dar ROJO, esa
 * reducción no se puede acreditar: cualquiera diría «ya está más corto» y nadie podría
 * desmentirlo. Estas pruebas son ese tope.
 *
 * Los topes de abajo NO son objetivos: son el estado de HOY, clavado. Sirven para dos cosas
 * opuestas y las dos importan:
 *   1. Que nadie AÑADA andamiaje sin darse cuenta — la prueba se pone roja.
 *   2. Que cuando la fase de adelgazamiento entre, haya que BAJAR estos números a mano, con lo
 *      cual el commit que los baja es la prueba de que el trabajo se hizo.
 *
 * Si estás bajando estos números: bajalos a lo que midas, no a lo que esperes.
 */

/*
 * OJO: hay DOS cifras y no son la misma. El build DESPLEGADO en producción
 * (`bus-v3-20260814-umbral`, 17-ago) mide 9.210 caracteres de andamiaje; el código de ESTA rama
 * mide 7.694. Es decir, entre agosto y hoy ya se recortaron ~1.500 caracteres que producción
 * todavía paga en cada turno de cada alias. El tope de abajo vigila el código de esta rama —que
 * es el que se puede romper desde aquí—, no el de producción.
 */
/** El andamiaje fijo medido HOY en esta rama: 7.694. El tope deja 106 de margen, no 1.700. */
const TOPE_ANDAMIAJE_FIJO = 7_800;
/** Sobre completo de hoy con un rol al tope y 13 destinos. */
const TOPE_SOBRE_COMPLETO = 10_300;

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

/*
 * La proporción es el dato que Steven puede leer de un vistazo, y la razón por la que este
 * trabajo existe. Se afirma aparte porque el día que el andamiaje baje, esta prueba tiene que
 * bajar con él: es la que traduce «se arregló» a un número.
 */
test("la proporción andamiaje/pedido queda escrita, para poder verla bajar", () => {
  const pedido = "Revisa el estado del gateway y decime si hay entregas muertas.";
  const sobre = protocolPrompt(pedido, ORIGEN, contextoReal({ self_role: "R".repeat(1097) }));
  const ratio = Math.round((sobre.length - pedido.length) / pedido.length);
  assert.ok(
    ratio <= 170,
    `Por cada carácter de trabajo real viajan ${ratio} de andamiaje. El 24-ago-2026: 161 en esta rama, 185 en el build desplegado.`,
  );
});
