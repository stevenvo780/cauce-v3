import assert from "node:assert/strict";
import test from "node:test";
import {
  VERSION_CONTEXTO_FIJO,
  elFicheroYaLoDice,
  motivoDeReenvio,
  resumirContextoFijo,
} from "../src/harnesses/contexto-fijo.js";
import {
  PRIMARY_DUTY_HEADER,
  protocolPrompt,
  textoFijoDelSobre,
  type HarnessRequestContext,
} from "../src/harnesses/shared.js";

/**
 * Verifies the fixed information is not re-injected unnecessarily between messages when the
 * harness file already contains it, and that it stays complete otherwise.
 */

function contexto(overrides: Partial<HarnessRequestContext> = {}): HarnessRequestContext {
  return {
    self_alias: "zeus",
    sender_alias: "argos",
    tenant_id: "Steven",
    room_id: "grp.steven",
    channel: "telegram",
    agent_message: true,
    message_type: "agent.message",
    routing_targets: [
      { tenant_id: "Steven", alias: "argos", online: true },
      { tenant_id: "Steven", alias: "kant", online: true },
    ],
    self_role: "Sos el medico de la flota.",
    ...overrides,
  };
}

const ORIGEN = {
  adapter: "telegram",
  channel: "telegram",
  conversation_id: "grp.steven:1",
  relay: [] as { tenant_id: string; alias: string; relayed_at: string }[],
  metadata: {} as Record<string, unknown>,
};

const PEDIDO = "Revisa el gateway.";

/** The seal a seeded and up-to-date file would have for THIS alias. */
function selloAlDia(ctx: HarnessRequestContext) {
  return { version: VERSION_CONTEXTO_FIJO, sha256: resumirContextoFijo(textoFijoDelSobre(ctx)) };
}

test("con el fichero al día, el texto fijo NO viaja en el sobre", () => {
  const ctx = contexto();
  const sobre = protocolPrompt(PEDIDO, ORIGEN, { ...ctx, context_seal: selloAlDia(ctx) });

  assert.ok(!sobre.includes(PRIMARY_DUTY_HEADER), "el DEBER PRIMARIO se repitió teniéndolo el fichero");
  assert.ok(!sobre.includes("Delegation mechanics"), "las mecánicas de delegación se repitieron");
  assert.ok(!sobre.includes("Protocol invariants:"), "las invariantes se repitieron");
  // The dynamic part MUST keep traveling: it is the only thing that changes from turn to turn.
  assert.ok(sobre.includes("--- BEGIN TRUSTED DELIVERY CONTEXT ---"), "la metadata de la entrega desapareció");
  assert.ok(sobre.includes(PEDIDO), "el pedido desapareció");
  assert.match(sobre, /contexto Cauce v/u, "no quedó la referencia al contrato ya cargado");
});

test("el recorte se NOTA en el tamaño, que es lo que motiva todo esto", () => {
  const ctx = contexto();
  const entero = protocolPrompt(PEDIDO, ORIGEN, ctx);
  const recortado = protocolPrompt(PEDIDO, ORIGEN, { ...ctx, context_seal: selloAlDia(ctx) });
  const ahorro = entero.length - recortado.length;
  assert.ok(
    ahorro > 6_000,
    `el recorte ahorró sólo ${ahorro} caracteres de ${entero.length}: no está quitando el bloque fijo`,
  );
});

// ── NEGATIVE CONTROLS: getting the trim by accident must be impossible ──────────────

test("CONTROL NEGATIVO: sin sello, el sobre va ENTERO", () => {
  const sobre = protocolPrompt(PEDIDO, ORIGEN, contexto());
  assert.ok(sobre.includes(PRIMARY_DUTY_HEADER));
  assert.ok(sobre.includes("Protocol invariants:"));
});

test("CONTROL NEGATIVO: con un sello de OTRO texto, el sobre va ENTERO", () => {
  const ctx = contexto();
  const selloAjeno = { version: VERSION_CONTEXTO_FIJO, sha256: resumirContextoFijo("otra cosa") };
  const sobre = protocolPrompt(PEDIDO, ORIGEN, { ...ctx, context_seal: selloAjeno });
  assert.ok(sobre.includes(PRIMARY_DUTY_HEADER), "un sello que no corresponde consiguió el recorte");
});

test("CONTROL NEGATIVO: con una versión vieja del contrato, el sobre va ENTERO", () => {
  const ctx = contexto();
  const viejo = { version: "0", sha256: resumirContextoFijo(textoFijoDelSobre(ctx)) };
  const sobre = protocolPrompt(PEDIDO, ORIGEN, { ...ctx, context_seal: viejo });
  assert.ok(sobre.includes(PRIMARY_DUTY_HEADER), "una versión vieja consiguió el recorte");
});

test("CONTROL NEGATIVO: el sello de OTRO alias no sirve para éste", () => {
  /*
   * This is not theoretical: `kratos` and `atlas` share $HOME and their `AGENTS.md` is the SAME
   * inode (measured: 12,942 bytes in both on 24-aug-2026). If the seal did not depend on the
   * alias, the file of one would accredit the contract of the other and `atlas` would end up
   * with the identity of `kratos` without anything failing.
   */
  const deKratos = contexto({ self_alias: "kratos", self_role: "Sos dev de Miguel." });
  const deAtlas = contexto({ self_alias: "atlas", self_role: "Sos dev de Miguel." });
  const sobre = protocolPrompt(PEDIDO, ORIGEN, { ...deAtlas, context_seal: selloAlDia(deKratos) });
  assert.ok(sobre.includes(PRIMARY_DUTY_HEADER), "el sello de kratos acreditó el contrato de atlas");
});

test("el motivo del reenvío se puede diagnosticar, y son cuatro casos distintos", () => {
  const ctx = contexto();
  const fijo = textoFijoDelSobre(ctx);
  assert.equal(motivoDeReenvio(undefined, fijo), "sin-sello");
  assert.equal(motivoDeReenvio({ version: "0", sha256: resumirContextoFijo(fijo) }, fijo), "version-distinta");
  assert.equal(
    motivoDeReenvio({ version: VERSION_CONTEXTO_FIJO, sha256: resumirContextoFijo("x") }, fijo),
    "contenido-distinto",
  );
  assert.equal(motivoDeReenvio(selloAlDia(ctx), fijo), "no-hace-falta");
});

test("elFicheroYaLoDice sólo dice que sí con el texto exacto", () => {
  const ctx = contexto();
  const fijo = textoFijoDelSobre(ctx);
  assert.equal(elFicheroYaLoDice(selloAlDia(ctx), fijo), true);
  // A single character of difference is enough to make it not match.
  assert.equal(elFicheroYaLoDice(selloAlDia(ctx), `${fijo} `), false);
});
