import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bloqueDePerfil, ficherosDelArnes,
  type AgentProfile, type ContextoDeAlias, type FuenteDeTope, type HechosDelAlias,
  type UnidadDeTope,
} from "@cauce/protocol";
import {
  directorioDelArnes, discoReal, resumenDeLaSiembra, sembrarPerfilDelArnes,
  type DiscoDelArnes, type ResultadoDeLaSiembra,
} from "../src/context/siembra-del-perfil.js";

function medidaDelTopeSuperado(
  resultado: ResultadoDeLaSiembra,
): { readonly unidad: UnidadDeTope; readonly fuente: FuenteDeTope } {
  if (resultado.estado !== "no-entra") throw new Error("el resultado no es un tope superado");
  return { unidad: resultado.unidad, fuente: resultado.fuente };
}

/**
 * THE PIECE THAT TOUCHES THE REAL DISK.
 *
 * Everything above composed text. This one writes inside the container of an agent that is
 * working, so what is tested here is not "the right text comes out" — that is already proven in
 * the protocol — but the three things that hurt when they go wrong:
 *
 *   · writing when there was no need (overwriting a teammate or a person's own writing),
 *   · writing in the wrong place (someone else's `$HOME` or another alias's directory),
 *   · breaking the greeting by being unable to write, leaving an alias deaf because of one file.
 */

const HECHOS: HechosDelAlias = {
  permisos: { ruta: true, lectura: true, control: false, notificacion: true },
  cuotas: [],
  arnes: { harness: "claude", home: "/home/dev", capacidades: ["bash"] },
  destinos: ["kant"],
};

function contexto(parcial: Partial<AgentProfile> = {}, alias = "zeus"): ContextoDeAlias {
  return {
    perfil: {
      tenant_id: "Steven", alias,
      purpose: null, role_summary: null, human_brief: null,
      responsibilities: [], restrictions: [], tools: [], operating_rules: [],
      ...parcial,
    },
    hechos: HECHOS,
  };
}

/** A fake disk that also COUNTS writes: "nothing was written" is half a test. */
function disco(inicial: Record<string, string> = {}) {
  const ficheros = new Map(Object.entries(inicial));
  const escrituras: string[] = [];
  const aplicar = (ruta: string, contenido: string): void => {
    ficheros.set(ruta, contenido);
    escrituras.push(ruta);
  };
  const puerto: DiscoDelArnes = {
    leer: (ruta) => ficheros.get(ruta),
    escribir: aplicar,
    escribirLote: (lote) => { for (const entrada of lote) aplicar(entrada.ruta, entrada.contenido); },
  };
  return { ficheros, escrituras, puerto };
}

const ENTORNO = { HOME: "/home/dev", CLAUDE_CONFIG_DIR: "/home/dev/.claude-zeus" };

// ── WHERE WRITES GO ───────────────────────────────────────────────────────────────────────────

test("CLAUDE_CONFIG_DIR gana sobre $HOME: es cómo dos alias del mismo contenedor se separan", () => {
  /*
   * This is not a preference: it is the mechanism. One of my tests turned red by reading my real
   * `CLAUDE.md` precisely because it was not honored, and in production ignoring it would mean
   * two aliases in the same container overwriting each other's profile on every connection.
   */
  assert.equal(directorioDelArnes("claude", ENTORNO), "/home/dev/.claude-zeus");
  assert.equal(directorioDelArnes("claude", { HOME: "/home/dev" }), "/home/dev/.claude");
});

test("dos alias con HOME compartido y homes de arnés distintos no se contaminan", () => {
  const d = disco();
  sembrarPerfilDelArnes("codex", contexto({ purpose: "soy kratos" }, "kratos"), {
    habilitado: true, disco: d.puerto,
    entorno: { HOME: "/home/dev", CODEX_HOME: "/home/dev/.codex-kratos" },
  });
  sembrarPerfilDelArnes("codex", contexto({ purpose: "soy atlas" }, "atlas"), {
    habilitado: true, disco: d.puerto,
    entorno: { HOME: "/home/dev", CODEX_HOME: "/home/dev/.codex-atlas" },
  });

  const kratos = d.ficheros.get("/home/dev/.codex-kratos/AGENTS.md") ?? "";
  const atlas = d.ficheros.get("/home/dev/.codex-atlas/AGENTS.md") ?? "";
  assert.match(kratos, /soy kratos/u);
  assert.doesNotMatch(kratos, /soy atlas/u);
  assert.match(atlas, /soy atlas/u);
  assert.doesNotMatch(atlas, /soy kratos/u);
});

// ── THE SWITCH ───────────────────────────────────────────────────────────────────────────────

test("APAGADO no escribe NADA, y lo dice", () => {
  /*
   * It is off by default on purpose: this writes inside the containers of fifteen agents that
   * are working. Turning it on is a dated, watched decision, not a side effect of deploying a
   * version.
   */
  const d = disco();
  const resultado = sembrarPerfilDelArnes("claude", contexto({ purpose: "el médico" }), {
    habilitado: false, disco: d.puerto, entorno: ENTORNO,
  });
  assert.equal(resultado.estado, "apagado");
  assert.equal(d.escrituras.length, 0);
});

test("encendido, escribe el fichero del arnés en su sitio", () => {
  const d = disco();
  const resultado = sembrarPerfilDelArnes("claude", contexto({ purpose: "el médico de la flota" }), {
    habilitado: true, disco: d.puerto, entorno: ENTORNO,
  });
  assert.equal(resultado.estado, "hecho");
  assert.deepEqual(d.escrituras, ["/home/dev/.claude-zeus/CLAUDE.md"]);
  const escrito = d.ficheros.get("/home/dev/.claude-zeus/CLAUDE.md") ?? "";
  assert.ok(escrito.includes("el médico de la flota"));
  assert.ok(bloqueDePerfil(escrito) !== undefined, "no quedó un bloque legible");
});

// ── WHAT IS NOT OVERWRITTEN ──────────────────────────────────────────────────────────────────

test("lo que escribió una persona se conserva BYTE A BYTE", () => {
  const manual = "# Manual de zeus\n\nEsto lo escribió una persona.\n";
  const d = disco({ "/home/dev/.claude-zeus/CLAUDE.md": manual });
  sembrarPerfilDelArnes("claude", contexto({ purpose: "el médico" }), {
    habilitado: true, disco: d.puerto, entorno: ENTORNO,
  });
  const despues = d.ficheros.get("/home/dev/.claude-zeus/CLAUDE.md") ?? "";
  assert.ok(despues.includes("Esto lo escribió una persona."));
  assert.ok(despues.includes("el médico"));
});

test("codex siembra una vez y delega cualquier cambio posterior del bloque gestionado", () => {
  const path = "/home/dev/.codex-atlas/AGENTS.md";
  const manual = "# Manual de Atlas\n\nContexto exterior válido.\n";
  const d = disco({ [path]: manual });
  const opciones = {
    habilitado: true,
    disco: d.puerto,
    entorno: { HOME: "/home/dev", CODEX_HOME: "/home/dev/.codex-atlas" },
  };

  const primera = sembrarPerfilDelArnes(
    "codex", contexto({ purpose: "perfil inicial" }, "atlas"), opciones,
  );
  const sembrado = d.ficheros.get(path);
  assert.ok(sembrado);
  assert.equal(primera.estado, "hecho");
  assert.equal(primera.ficheros[0]?.estado, "escrito");
  assert.match(bloqueDePerfil(sembrado) ?? "", /alias: Steven\/atlas/u);
  assert.match(sembrado, /Contexto exterior válido\./u);

  d.escrituras.length = 0;
  const igual = sembrarPerfilDelArnes(
    "codex", contexto({ purpose: "perfil inicial" }, "atlas"), opciones,
  );
  assert.deepEqual(d.escrituras, []);
  assert.equal(igual.estado, "hecho");
  assert.equal(igual.ficheros[0]?.estado, "ya-estaba");

  const diferente = sembrarPerfilDelArnes(
    "codex", contexto({ purpose: "perfil nuevo" }, "atlas"), opciones,
  );
  assert.equal(d.escrituras.length, 1);
  assert.notEqual(d.ficheros.get(path), sembrado);
  assert.match(d.ficheros.get(path) ?? "", /perfil nuevo/u);
  assert.equal(diferente.estado, "hecho");
  assert.equal(diferente.ficheros[0]?.estado, "escrito");
});

test("la siembra converge una proyección revisionada con drift en vez de descartar la deseada", () => {
  const oldContext = contexto({ purpose: "perfil viejo" });
  const projected = ficherosDelArnes("claude", oldContext, new Map(), { revision: 4 })[0];
  assert.ok(projected);
  const path = "/home/dev/.claude-zeus/CLAUDE.md";
  const d = disco({ [path]: projected.texto });

  const resultado = sembrarPerfilDelArnes("claude", contexto({ purpose: "perfil nuevo" }), {
    habilitado: true, disco: d.puerto, entorno: ENTORNO,
  });

  assert.equal(d.escrituras.length, 1);
  assert.notEqual(d.ficheros.get(path), projected.texto);
  assert.match(d.ficheros.get(path) ?? "", /perfil nuevo/u);
  assert.equal(resultado.estado, "hecho");
  assert.equal(resultado.ficheros[0]?.estado, "escrito");
  assert.match(resumenDeLaSiembra(resultado), /escrito=1/u);
});

test("un owner esperado oculto dentro de un bloque ajeno no suplanta la primera línea", () => {
  const path = "/compartido/AGENTS.md";
  const foreign = "<!-- CAUCE:PERFIL v1 — generado desde la configuración, no editar dentro de este bloque -->\n"
    + "<!-- alias: Steven/kratos -->\najeno\n<!-- alias: Steven/atlas -->\n"
    + "<!-- CAUCE:FIN-PERFIL -->\n";
  const d = disco({ [path]: foreign });
  const resultado = sembrarPerfilDelArnes("codex", contexto({ purpose: "soy atlas" }, "atlas"), {
    habilitado: true,
    disco: d.puerto,
    entorno: { HOME: "/h", CODEX_HOME: "/compartido" },
  });

  assert.deepEqual(d.escrituras, []);
  assert.equal(d.ficheros.get(path), foreign);
  assert.equal(resultado.estado, "hecho");
  assert.equal(resultado.ficheros[0]?.estado, "ocupado-por-otro-alias");
});

test("el disco real solo traduce ENOENT a ausencia y rechaza symlink/no-regular", (t) => {
  const raiz = mkdtempSync(join(tmpdir(), "cauce-perfil-lectura-"));
  t.after(() => { rmSync(raiz, { recursive: true, force: true }); });

  assert.equal(discoReal.leer(join(raiz, "ausente.md")), undefined);

  const directorio = join(raiz, "directorio.md");
  mkdirSync(directorio);
  assert.throws(() => discoReal.leer(directorio), /no es un fichero regular/u);

  const objetivo = join(raiz, "objetivo.md");
  const enlace = join(raiz, "enlace.md");
  writeFileSync(objetivo, "intacto", "utf8");
  symlinkSync(objetivo, enlace);
  assert.throws(() => discoReal.leer(enlace));
});

test("la escritura conserva el inode existente y no sigue symlinks", (t) => {
  const raiz = mkdtempSync(join(tmpdir(), "cauce-perfil-escritura-"));
  t.after(() => { rmSync(raiz, { recursive: true, force: true }); });

  const objetivo = join(raiz, "AGENTS.md");
  writeFileSync(objetivo, "antes", "utf8");
  const inodo = statSync(objetivo).ino;

  discoReal.escribir(objetivo, "después");
  assert.equal(statSync(objetivo).ino, inodo, "reemplazó el inode que puede estar bind-mounted");
  assert.equal(readFileSync(objetivo, "utf8"), "después");

  const enlace = join(raiz, "enlace.md");
  symlinkSync(objetivo, enlace);
  assert.throws(() => { discoReal.escribir(enlace, "pisado"); });
  assert.equal(readFileSync(objetivo, "utf8"), "después");
});

test("un symlink en cualquier directorio padre no puede escapar del home", (t) => {
  const raiz = mkdtempSync(join(tmpdir(), "cauce-perfil-padre-"));
  t.after(() => { rmSync(raiz, { recursive: true, force: true }); });

  const home = join(raiz, "home");
  const fuera = join(raiz, "fuera");
  mkdirSync(home);
  mkdirSync(fuera);
  symlinkSync(fuera, join(home, ".codex"));
  const ruta = join(home, ".codex", "AGENTS.md");

  assert.throws(() => discoReal.leer(ruta), "trató el padre symlink como ausencia");
  assert.throws(() => { discoReal.escribir(ruta, "escape"); });
  assert.equal(existsSync(join(fuera, "AGENTS.md")), false, "escribió fuera del home autorizado");
  assert.ok(!readdirSync(fuera).some((nombre) => nombre.startsWith(".cauce-perfil-")));
});

test("el preflight del lote falla antes de modificar el primer destino", (t) => {
  const raiz = mkdtempSync(join(tmpdir(), "cauce-perfil-lote-"));
  t.after(() => { rmSync(raiz, { recursive: true, force: true }); });

  const primero = join(raiz, "SOUL.md");
  const objetivo = join(raiz, "objetivo.md");
  const segundo = join(raiz, "IDENTITY.md");
  writeFileSync(primero, "primero-intacto", "utf8");
  writeFileSync(objetivo, "segundo-intacto", "utf8");
  symlinkSync(objetivo, segundo);

  assert.throws(() => { discoReal.escribirLote([
    { ruta: primero, contenido: "primero-nuevo" },
    { ruta: segundo, contenido: "segundo-nuevo" },
  ]); });
  assert.equal(readFileSync(primero, "utf8"), "primero-intacto");
  assert.equal(readFileSync(objetivo, "utf8"), "segundo-intacto");
  assert.ok(!readdirSync(raiz).some((nombre) => nombre.startsWith(".cauce-perfil-")));
});

test("un tope superado NO escribe NINGUNO de los siete", () => {
  /*
   * A half-finished person — four files today and three not — contradicts itself, and the model
   * has no way of knowing which to believe. Better to write nothing and say so.
   */
  const d = disco();
  const resultado = sembrarPerfilDelArnes("openclaw", contexto({ purpose: "x".repeat(90_001) }), {
    habilitado: true, disco: d.puerto, entorno: { HOME: "/h", CAUCE_OPENCLAW_WORKSPACE: "/ws" },
  });
  assert.equal(resultado.estado, "no-entra");
  assert.equal(d.escrituras.length, 0);
  assert.equal(resultado.fichero, "SOUL.md");
  assert.deepEqual(medidaDelTopeSuperado(resultado),
    { unidad: "utf16_strictest", fuente: "default" });
});

function contextoAcentuadoAlTope(): ContextoDeAlias {
  const acento = "\u00e1";
  return contexto({
    purpose: acento.repeat(2_000),
    role_summary: acento.repeat(4_000),
    human_brief: acento.repeat(2_000),
    responsibilities: Array.from({ length: 8 }, () => acento.repeat(1_000)),
    restrictions: Array.from({ length: 4 }, () => acento.repeat(1_000)),
    operating_rules: Array.from({ length: 4 }, () => acento.repeat(1_000)),
  });
}

const ENTORNO_CODEX = { HOME: "/home/dev" };
const CONFIG_DE_CODEX = "/home/dev/.codex/config.toml";

test("codex: el project_doc_max_bytes medido del config.toml manda sobre el defecto", () => {
  const d = disco({ [CONFIG_DE_CODEX]: "model = \"gpt\"\nproject_doc_max_bytes = 65536\n" });
  const resultado = sembrarPerfilDelArnes("codex", contextoAcentuadoAlTope(), {
    habilitado: true, disco: d.puerto, entorno: ENTORNO_CODEX,
  });
  assert.equal(resultado.estado, "hecho");
  assert.deepEqual(d.escrituras, ["/home/dev/.codex/AGENTS.md"]);
  const escrito = d.ficheros.get("/home/dev/.codex/AGENTS.md") ?? "";
  assert.ok(Buffer.byteLength(escrito, "utf8") > 48_000);
});
