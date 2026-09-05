import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AGENT_PROFILE_LIMITS, componerBloqueDePerfil, measureStrictestUnits,
  type AgentProfile, type ContextoDeAlias, type HechosDelAlias,
} from "../src/agent-profile.js";
import { MARCA_PERFIL_INICIO, bloqueDePerfil, conBloqueDePerfil, sinBloqueDePerfil } from "../src/marcas-de-bloque.js";
import {
  ErrorDeTopeDelArnes, PRESUPUESTOS_DE_CONTEXTO, TOPES_OPENCLAW, ficherosDelArnes,
  marcaDeRevisionDelPerfil, presupuestoDeContextoMedido, revisionDelPerfil,
  topeDeCodexEnConfigToml, type FicheroGenerado,
  type PresupuestoDeContexto,
} from "../src/ficheros-del-arnes.js";
import { WsOutboundSchema } from "../src/schemas.js";

// Consistency verification tests for harness file generation and update.

const HECHOS: HechosDelAlias = {
  permisos: { ruta: true, lectura: true, control: false, notificacion: true },
  cuotas: [{ proveedor: "claude", cuenta: "saldantia", limite: "2% semanal" }],
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
  assert.doesNotMatch(result.texto, /saldantia|2% semanal|Alias alcanzables|ws-argos|Permisos y acceso/u);
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

test("al retirar el bloque, lo que escribió una persona se conserva byte a byte", () => {
  const manual = "# Notas de argos\n\nEsto lo escribió una persona y no es de Cauce.\n";
  const conBloque = conBloqueDePerfil(manual, "<!-- alias: Steven/argos -->\n## Identidad\n\nx");
  const generado = ficherosDelArnes("openclaw", contexto(perfil({})), new Map([["SOUL.md", conBloque]]));
  const soul = de(generado, "SOUL.md");
  assert.ok(soul.texto.includes("Esto lo escribió una persona y no es de Cauce."));
  assert.equal(bloqueDePerfil(soul.texto), undefined);
});

test("CONTROL NEGATIVO: sobre un fichero que NUNCA tuvo bloque no se escribe nada", () => {
  const manual = "# Notas\n\nsólo texto humano\n";
  const generado = ficherosDelArnes("openclaw", contexto(perfil({})), new Map([["SOUL.md", manual]]));
  assert.equal(de(generado, "SOUL.md").escribir, false);
  assert.equal(de(generado, "SOUL.md").texto, manual);
});

// ── 2. MEMORY.md in cap accounting ────────────────────────────────────────────

test("la memoria del agente NO cuenta para el tope: no puede bloquear la siembra de los siete", () => {
  const memoriaEnorme = "recuerdo. ".repeat(20_000); // ~200.000 unidades
  const enDisco = new Map([["MEMORY.md", memoriaEnorme]]);
  const generado = ficherosDelArnes("openclaw", contexto(perfil({ purpose: "reparo Cauce" })), enDisco);

  assert.equal(de(generado, "SOUL.md").escribir, true, "la memoria del agente bloqueó su identidad");
  assert.equal(de(generado, "MEMORY.md").texto, memoriaEnorme, "le tocamos la memoria");
  assert.equal(de(generado, "MEMORY.md").escribir, false);
});

test("CONTROL NEGATIVO: lo que SÍ escribimos sigue sujeto al tope", () => {
  assert.throws(
    () => ficherosDelArnes("openclaw", contexto(perfil({ purpose: "x".repeat(TOPES_OPENCLAW.porFichero + 1) }))),
    (error: unknown) => error instanceof ErrorDeTopeDelArnes && error.fichero === "SOUL.md",
  );
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

test("CONTROL NEGATIVO: el MISMO alias sí actualiza su propio bloque", () => {
  const primero = ficherosDelArnes("codex", contexto(perfil({ purpose: "antes" }, "kratos")));
  const enDisco = new Map([["AGENTS.md", de(primero, "AGENTS.md").texto]]);
  const segundo = ficherosDelArnes("codex", contexto(perfil({ purpose: "después" }, "kratos")), enDisco);

  assert.equal(de(segundo, "AGENTS.md").escribir, true);
  assert.ok(de(segundo, "AGENTS.md").texto.includes("después"));
});

test("un perfil vacío de OTRO alias no retira el bloque administrado del dueño", () => {
  const deKratos = ficherosDelArnes(
    "codex", contexto(perfil({ purpose: "soy kratos" }, "kratos")),
  );
  const antes = de(deKratos, "AGENTS.md").texto;
  const enDisco = new Map([["AGENTS.md", antes]]);

  const atlasVacio = de(
    ficherosDelArnes("codex", contexto(perfil({}, "atlas")), enDisco),
    "AGENTS.md",
  );
  assert.equal(atlasVacio.escribir, false, "atlas intentó retirar el bloque de kratos");
  assert.equal(atlasVacio.texto, antes);
  assert.ok(atlasVacio.texto.includes("soy kratos"));

  const kratosVacio = de(
    ficherosDelArnes("codex", contexto(perfil({}, "kratos")), enDisco),
    "AGENTS.md",
  );
  assert.equal(kratosVacio.escribir, true, "el dueño no pudo retirar su bloque");
  assert.equal(bloqueDePerfil(kratosVacio.texto), undefined);
});

test("CONTROL NEGATIVO: dos alias del MISMO nombre en inquilinos distintos no se confunden", () => {
  const dePablo = ficherosDelArnes("codex", contexto({
    ...perfil({ purpose: "el argos de Pablo" }, "argos"), tenant_id: "Pablo",
  }));
  const enDisco = new Map([["AGENTS.md", de(dePablo, "AGENTS.md").texto]]);
  const deSteven = ficherosDelArnes("codex", contexto(perfil({ purpose: "el argos de Steven" }, "argos")), enDisco);
  assert.equal(de(deSteven, "AGENTS.md").escribir, false);
});

// ── 4. Generation without authored fields ─────────────────────────────────────

test("un perfil SIN NADA autorado no escribe ningún fichero, tampoco en openclaw", () => {
  const generado = ficherosDelArnes("openclaw", contexto(perfil({})));
  for (const fichero of generado.filter((f) => f.politica === "bloque-gestionado")) {
    assert.equal(fichero.escribir, false, `${fichero.nombre} se iba a escribir sin nada autorado`);
    assert.equal(fichero.texto, "", `${fichero.nombre} lleva texto`);
  }
});

test("los ficheros del agente SÍ se crean vacíos cuando faltan, y eso no es lo mismo", () => {
  const generado = ficherosDelArnes("openclaw", contexto(perfil({})));
  for (const nombre of ["MEMORY.md", "HEARTBEAT.md"]) {
    const fichero = de(generado, nombre);
    assert.equal(fichero.politica, "solo-si-falta");
    assert.equal(fichero.escribir, true, `${nombre} no se crea cuando falta`);
    assert.equal(fichero.texto, "", `${nombre} se crea con contenido nuestro dentro`);
  }
});

test("CONTROL NEGATIVO: si el fichero del agente YA existe, no se toca ni se reescribe", () => {
  const memoria = "lo que argos aprendió\n";
  const generado = ficherosDelArnes(
    "openclaw", contexto(perfil({})), new Map([["MEMORY.md", memoria]]),
  );
  assert.equal(de(generado, "MEMORY.md").escribir, false);
  assert.equal(de(generado, "MEMORY.md").texto, memoria);
});

test("CONTROL NEGATIVO: con UNA responsabilidad, AGENTS.md sólo lleva reglas autoradas", () => {
  const generado = ficherosDelArnes("openclaw", contexto(perfil({ responsibilities: ["reparar Cauce"] })));
  const agents = de(generado, "AGENTS.md");
  assert.equal(agents.escribir, true);
  assert.ok(agents.texto.includes("reparar Cauce"));
  assert.ok(!agents.texto.includes("control): no"), "congeló permisos dinámicos");
  assert.ok(!agents.texto.includes("ws-argos"), "congeló el montaje dinámico");
});

test("CONTROL NEGATIVO: sin herramientas declaradas TOOLS.md no se escribe, con una sí", () => {
  const sin = ficherosDelArnes("openclaw", contexto(perfil({ purpose: "algo" })));
  assert.equal(de(sin, "TOOLS.md").escribir, false);

  const con = ficherosDelArnes("openclaw", contexto(perfil({ tools: ["ssh"] })));
  const tools = de(con, "TOOLS.md");
  assert.equal(tools.escribir, true);
  assert.ok(tools.texto.includes("ssh"));
  assert.ok(!tools.texto.includes("saldantia"), "congeló las cuotas dinámicas");
});

// ── 5. Cap measurement over consolidated text ─────────────────────────────────

test("el tope se mide sobre el fichero ENTERO, no sólo sobre nuestro bloque", () => {
  const humano = "y".repeat(TOPES_OPENCLAW.porFichero - 500);
  const enDisco = new Map([["SOUL.md", humano]]);
  assert.throws(
    () => ficherosDelArnes("openclaw", contexto(perfil({ purpose: "x".repeat(1_000) })), enDisco),
    (error: unknown) => error instanceof ErrorDeTopeDelArnes
      && error.fichero === "SOUL.md"
      && error.medido > TOPES_OPENCLAW.porFichero,
  );
});

test("CONTROL NEGATIVO: el mismo bloque en un fichero vacío NO se pasa de tope", () => {
  const generado = ficherosDelArnes("openclaw", contexto(perfil({ purpose: "x".repeat(1_000) })));
  assert.equal(de(generado, "SOUL.md").escribir, true);
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

test("sinBloqueDePerfil no toca un fichero que no tiene bloque", () => {
  const manual = "# Manual\n\nsólo humano\n";
  assert.equal(sinBloqueDePerfil(manual), manual);
});

function topesDe(harness: string, medido?: number): PresupuestoDeContexto {
  const presupuesto = presupuestoDeContextoMedido(
    harness, medido === undefined ? {} : { codexProjectDocMaxBytes: medido },
  );
  assert.ok(presupuesto, `${harness} no declaró presupuesto`);
  return presupuesto;
}

function perfilAcentuadoAlTope(): AgentProfile {
  const acento = "\u00e1";
  return perfil({
    purpose: acento.repeat(AGENT_PROFILE_LIMITS.purpose),
    role_summary: acento.repeat(AGENT_PROFILE_LIMITS.role_summary),
    human_brief: acento.repeat(AGENT_PROFILE_LIMITS.human_brief),
    responsibilities: Array.from({ length: 8 }, () => acento.repeat(AGENT_PROFILE_LIMITS.item)),
    restrictions: Array.from({ length: 4 }, () => acento.repeat(AGENT_PROFILE_LIMITS.item)),
    tools: [],
    operating_rules: Array.from({ length: 4 }, () => acento.repeat(AGENT_PROFILE_LIMITS.item)),
  });
}

test("el AGENTS.md acentuado de 48 kB entra con el hecho medido y SOLO cae sin hecho alguno", () => {
  const ctx = contexto(perfilAcentuadoAlTope());
  const medido = topesDe("codex", 65_536);
  const conMedida = ficherosDelArnes("codex", ctx, new Map(), { topes: medido });
  const bytes = Buffer.byteLength(de(conMedida, "AGENTS.md").texto, "utf8");
  assert.ok(bytes > 48_000 && bytes < 65_536, `AGENTS.md midió ${String(bytes)} bytes`);
  assert.equal(measureStrictestUnits(de(conMedida, "AGENTS.md").texto) * 2 > bytes, true);

  const porDefecto = topesDe("codex");
  assert.throws(
    () => ficherosDelArnes("codex", ctx, new Map(), { topes: porDefecto }),
    (error: unknown) => error instanceof ErrorDeTopeDelArnes && error.medido === bytes,
  );
});

test("el mensaje del tope nombra la unidad DECLARADA y de dónde salió el número", () => {
  assert.throws(
    () => ficherosDelArnes(
      "codex", contexto(perfilAcentuadoAlTope()), new Map(),
      { topes: topesDe("codex") },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ErrorDeTopeDelArnes);
      assert.equal(error.unidad, "utf8_bytes");
      assert.equal(error.fuente, "default");
      assert.match(error.message, /bytes UTF-8/u);
      assert.match(error.message, /por defecto del arn\u00e9s/u);
      return true;
    },
  );
  assert.throws(
    () => ficherosDelArnes("codex", contexto(perfilAcentuadoAlTope()), new Map(), {
      topes: topesDe("codex", 40_000),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ErrorDeTopeDelArnes);
      assert.equal(error.fuente, "measured");
      assert.match(error.message, /medido del alias/u);
      return true;
    },
  );
  assert.throws(
    () => ficherosDelArnes(
      "openclaw", contexto(perfil({ purpose: "x".repeat(TOPES_OPENCLAW.porFichero + 1) })),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ErrorDeTopeDelArnes);
      assert.equal(error.unidad, "utf16_strictest");
      assert.match(error.message, /unidades UTF-16/u);
      return true;
    },
  );
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
