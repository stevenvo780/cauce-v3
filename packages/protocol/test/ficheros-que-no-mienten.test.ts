import assert from "node:assert/strict";
import { test } from "vitest";
import {
  componerBloqueDePerfil,
  type AgentProfile, type ContextoDeAlias, type HechosDelAlias,
} from "../src/agent-profile.js";
import { MARCA_PERFIL_INICIO, bloqueDePerfil, conBloqueDePerfil, sinBloqueDePerfil } from "../src/marcas-de-bloque.js";
import {
  ErrorDeTopeDelArnes, PRESUPUESTOS_DE_CONTEXTO, TOPES_OPENCLAW, ficherosDelArnes,
  marcaDeRevisionDelPerfil, presupuestoDeContextoMedido, revisionDelPerfil,
  topeDeCodexEnConfigToml, type FicheroGenerado,
} from "../src/ficheros-del-arnes.js";
import { WsOutboundSchema } from "../src/schemas.js";

// Consistency verification tests for harness file generation and update.

const HECHOS: HechosDelAlias = {
  permisos: { ruta: true, lectura: true, control: false, notificacion: true },
  cuotas: [{ proveedor: "claude", cuenta: "zz-canary-cuenta", limite: "2% semanal" }],
  arnes: { harness: "openclaw", home: "/home/dev", contenedor: "ws-argos", capacidades: ["bash"] },
  destinos: ["kant", "zeus"],
};

function perfil(parcial: Partial<AgentProfile> = {}, alias = "argos"): AgentProfile {
  return {
    tenant_id: "Steven", alias,
    purpose: null, role_summary: null, human_brief: null,
    responsibilities: [], restrictions: [], tools: [], operating_rules: [],
    ...parcial,
  };
}

function contexto(p: AgentProfile, hechos: Partial<HechosDelAlias> = {}): ContextoDeAlias {
  return { perfil: p, hechos: { ...HECHOS, ...hechos } };
}

function de(ficheros: readonly FicheroGenerado[], nombre: string): FicheroGenerado {
  const f = ficheros.find((x) => x.nombre === nombre);
  assert.ok(f, `no vino ${nombre}`);
  return f;
}

test.each(["claude", "codex"])("%s retira hechos antiguos sin perder notas, acceso autorado ni revisión", (harness) => {
  const ctx = contexto(perfil({ purpose: "identidad vigente", tools: ["ssh al host autorizado"] }));
  const name = harness === "claude" ? "CLAUDE.md" : "AGENTS.md";
  const manual = "# Notas propias\n\nConservar mi configuración de trabajo.\n";
  const previous = conBloqueDePerfil(
    manual,
    `<!-- alias: Steven/argos -->\n${componerBloqueDePerfil(ctx.perfil, ctx.hechos)}`,
  );
  const existing = harness === "claude"
    ? previous.replace(MARCA_PERFIL_INICIO, `${marcaDeRevisionDelPerfil(9)}\n${MARCA_PERFIL_INICIO}`)
    : previous;
  const result = de(ficherosDelArnes(harness, ctx, new Map([[name, existing]]), { revision: 9 }), name);
  assert.equal(result.escribir, true);
  assert.match(result.texto, /identidad vigente/u);
  assert.match(result.texto, /ssh al host autorizado/u);
  assert.match(result.texto, /<!-- alias: Steven\/argos -->/u);
  assert.ok(result.texto.includes(manual));
  assert.doesNotMatch(result.texto, /zz-canary-cuenta|2% semanal|Alias alcanzables|ws-argos|Permisos y acceso/u);
  assert.equal(revisionDelPerfil(result.texto), harness === "claude" ? 9 : undefined);
  const repeated = de(ficherosDelArnes(harness, ctx, new Map([[name, result.texto]]), { revision: 9 }), name);
  assert.equal(repeated.escribir, false);
  assert.equal(repeated.texto, result.texto);
});

test("la proyección persistente no borra los hechos transmitidos ni muta el contexto recibido", () => {
  const ctx = contexto(perfil({ purpose: "identidad vigente" }));
  const before = structuredClone(ctx);
  for (const harness of ["claude", "codex", "openclaw"]) ficherosDelArnes(harness, ctx);
  assert.deepEqual(ctx, before);
  const frame = WsOutboundSchema.parse({
    type: "hello_ack", version: "3.0", epoch: 1,
    lease_expires_at: new Date(60_000).toISOString(), agent_profile: ctx,
  });
  assert.equal(frame.type, "hello_ack");
  assert.deepEqual(frame.agent_profile, before);
});

// ── 1. Removal of stale blocks ────────────────────────────────────────────────

test("borrar un campo en la base BORRA el bloque del fichero, no lo deja rancio", () => {
  const conPerfil = ficherosDelArnes("openclaw", contexto(perfil({ purpose: "reparo Cauce" })));
  const soul = de(conPerfil, "SOUL.md");
  assert.ok(soul.texto.includes("reparo Cauce"));

  // purpose is emptied and we generate again over the existing content.
  const enDisco = new Map([["SOUL.md", soul.texto]]);
  const vaciado = ficherosDelArnes("openclaw", contexto(perfil({})), enDisco);
  const despues = de(vaciado, "SOUL.md");

  assert.equal(despues.escribir, true, "dijo que no había nada que escribir sobre un texto rancio");
  assert.ok(!despues.texto.includes("reparo Cauce"), "el propósito borrado sigue en el fichero");
  assert.equal(bloqueDePerfil(despues.texto), undefined, "el bloque sigue ahí");
});

// ── 3. Block ownership guard ──────────────────────────────────────────────────

test("no se pisa el bloque de OTRO alias: aliases con home compartido", () => {
  const deKratos = ficherosDelArnes(
    "codex", contexto(perfil({ purpose: "soy kratos" }, "kratos")),
  );
  const enDisco = new Map([["AGENTS.md", de(deKratos, "AGENTS.md").texto]]);

  const deAtlas = ficherosDelArnes(
    "codex", contexto(perfil({ purpose: "soy atlas" }, "atlas")), enDisco,
  );
  const resultado = de(deAtlas, "AGENTS.md");

  assert.equal(resultado.escribir, false, "atlas pisó el bloque de kratos");
  assert.ok(resultado.texto.includes("soy kratos"));
  assert.ok(!resultado.texto.includes("soy atlas"));
});

// ── 5. Cap measurement over consolidated text ─────────────────────────────────

test("el tope se mide sobre el fichero ENTERO, no solo sobre nuestro bloque", () => {
  const humano = "y".repeat(TOPES_OPENCLAW.porFichero - 500);
  const enDisco = new Map([["SOUL.md", humano]]);
  assert.throws(
    () => ficherosDelArnes("openclaw", contexto(perfil({ purpose: "x".repeat(1_000) })), enDisco),
    (error: unknown) => error instanceof ErrorDeTopeDelArnes
      && error.fichero === "SOUL.md"
      && error.medido > TOPES_OPENCLAW.porFichero,
  );
});

// ── 6. Block removal, standalone ──────────────────────────────────────────────

test("sinBloqueDePerfil es idempotente y no acumula líneas en blanco", () => {
  const manual = "# Manual\n\nlo humano\n";
  const conBloque = conBloqueDePerfil(manual, "<!-- alias: Steven/argos -->\nx");
  const primera = sinBloqueDePerfil(conBloque);
  const segunda = sinBloqueDePerfil(primera);
  assert.equal(segunda, primera, "quitar dos veces no da lo mismo");
  assert.ok(primera.includes("lo humano"));
  assert.ok(!primera.includes("CAUCE:PERFIL"));
});

test("presupuestoDeContextoMedido: el hecho por alias manda y un hecho inservible cae al defecto", () => {
  assert.deepEqual(presupuestoDeContextoMedido("codex", { codexProjectDocMaxBytes: 65_536 }), {
    unit: "utf8_bytes", porFichero: 65_536, fuente: "measured",
  });
  assert.deepEqual(presupuestoDeContextoMedido("codex", {}), PRESUPUESTOS_DE_CONTEXTO.codex);
  for (const roto of [0, -1, 1.5, Number.NaN, 17 * 1_024 * 1_024]) {
    assert.deepEqual(
      presupuestoDeContextoMedido("codex", { codexProjectDocMaxBytes: roto }),
      PRESUPUESTOS_DE_CONTEXTO.codex,
      String(roto),
    );
  }
  assert.deepEqual(presupuestoDeContextoMedido("openclaw", { codexProjectDocMaxBytes: 65_536 }),
    PRESUPUESTOS_DE_CONTEXTO.openclaw);
  assert.equal(presupuestoDeContextoMedido("opencode", {}), undefined);
});

test("topeDeCodexEnConfigToml lee la clave de la tabla raíz y desconfía de todo lo demás", () => {
  assert.equal(topeDeCodexEnConfigToml("project_doc_max_bytes = 65536\n"), 65_536);
  assert.equal(topeDeCodexEnConfigToml("model = \"gpt\"\nproject_doc_max_bytes=65_536 # medido\r\n"), 65_536);
  assert.equal(topeDeCodexEnConfigToml("[profiles.zeus]\nproject_doc_max_bytes = 999999\n"), undefined);
  assert.equal(topeDeCodexEnConfigToml("project_doc_max_bytes = \"65536\"\n"), undefined);
  assert.equal(topeDeCodexEnConfigToml("project_doc_max_bytes = 0\n"), undefined);
  assert.equal(topeDeCodexEnConfigToml("project_doc_max_bytes = 16777217\n"), undefined);
  assert.equal(topeDeCodexEnConfigToml("project_doc_max_bytes = 1\nproject_doc_max_bytes = 2\n"), undefined);
  assert.equal(topeDeCodexEnConfigToml("otra_clave = 1\n"), undefined);
  assert.equal(topeDeCodexEnConfigToml("project_doc_max_bytes = 0x10000\n"), 65_536);
  assert.equal(topeDeCodexEnConfigToml("\"project_doc_max_bytes\" = 65536\n"), 65_536);
  assert.equal(
    topeDeCodexEnConfigToml("model = sin comillas\nproject_doc_max_bytes = 65536\n"), undefined,
  );
  assert.equal(
    topeDeCodexEnConfigToml("notes = \"\"\"\nproject_doc_max_bytes = 65536\n\"\"\"\n"), undefined,
  );
});
