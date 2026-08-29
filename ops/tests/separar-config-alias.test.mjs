#!/usr/bin/env node
/**
 * Planner for per-alias configuration separation.
 *
 * WHAT IS BEING TESTED, AND WHY `.claude.json` MATTERS SO MUCH
 * ==============================================================
 *
 * `CLAUDE_CONFIG_DIR` does not move only the `CLAUDE.md`: it ALSO moves the `.claude.json`, and
 * with it the alias's entire MCP server list. If the plan points that variable at a new
 * directory without carrying that file, the alias loses ALL its tools **without a single
 * error**: it does not fail, does not warn, boots anyway and ends up mute of capabilities.
 *
 * That is why it is not enough here for the plan to "work": the test EXPLICITLY requires that
 * `.claude.json` be among the operations and that it carries a written reason. It links to the
 * authorised source instead of copying its possible secrets. A test that only looked at the
 * directory would pass with the failure hidden inside.
 *
 * And the DELETIONS list must always be empty: the source is the rollback. While the original
 * directory is still there, reverting is removing an environment variable; if the plan deletes
 * it, reverting is restoring from a backup that nobody took.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ErrorDePlan,
  directorioDeAlias,
  planificarSeparacion,
} from "../scripts/separar-config-alias.mjs";

const guion = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../scripts/separar-config-alias.mjs",
);

const KRATOS = { alias: "kratos", home: "/home/dev", arnes: "codex" };
const ZEUS = { alias: "zeus", home: "/home/dev", arnes: "claude" };

function copiaDe(plan, destino) {
  return plan.copias.find((copia) => copia.destino === destino);
}

// ---------------------------------------------------------------------------
// The destination: derived, never hand-written.
// ---------------------------------------------------------------------------

test("el destino vive bajo el árbol persistente .local/share, derivado del alias", () => {
  assert.equal(directorioDeAlias("/home/dev", "kratos", "codex"), "/home/dev/.local/share/cauce-v3/config/kratos/.codex");
  assert.equal(directorioDeAlias("/home/dev", "atlas", "codex"), "/home/dev/.local/share/cauce-v3/config/atlas/.codex");
  assert.equal(directorioDeAlias("/home/dev", "zeus", "claude"), "/home/dev/.local/share/cauce-v3/config/zeus/.claude");
  assert.equal(directorioDeAlias("/home/claw", "hegel", "claude"), "/home/claw/.local/share/cauce-v3/config/hegel/.claude");
});

test("kratos y atlas, mismo home y mismo contenedor, salen a destinos DISTINTOS", () => {
  // That is the entire point of the work: today both read the same inode in /home/dev/.codex.
  const kratos = planificarSeparacion({ alias: "kratos", home: "/home/dev", arnes: "codex" });
  const atlas = planificarSeparacion({ alias: "atlas", home: "/home/dev", arnes: "codex" });
  assert.equal(kratos.directorioOrigen, atlas.directorioOrigen, "hoy comparten el origen");
  assert.notEqual(kratos.directorioDestino, atlas.directorioDestino);
  assert.equal(kratos.directorioDestino, "/home/dev/.local/share/cauce-v3/config/kratos/.codex");
  assert.equal(atlas.directorioDestino, "/home/dev/.local/share/cauce-v3/config/atlas/.codex");
});

// ---------------------------------------------------------------------------
// THE MEASURED TRAP: the .claude.json.
// ---------------------------------------------------------------------------

test("EXIGENCIA: .claude.json está entre las copias, y con el motivo escrito", () => {
  const plan = planificarSeparacion(ZEUS);
  const copia = copiaDe(plan, "/home/dev/.local/share/cauce-v3/config/zeus/.claude/.claude.json");
  assert.ok(
    copia,
    "sin .claude.json en el destino el alias pierde TODOS sus MCP sin un solo error de arranque",
  );
  assert.equal(copia.origen, "/home/dev/.claude.json");
  assert.equal(copia.tipo, "enlace", "los MCP pueden contener secretos y no se duplican");
  assert.equal(copia.obligatorio, true, "no es opcional: su ausencia es silenciosa");
  assert.match(
    copia.motivo,
    /MCP/u,
    "el motivo tiene que decir QUÉ se pierde, no 'se copia por si acaso'",
  );
  assert.match(copia.motivo, /sin un solo error|silencio/iu);
});

test("si el alias YA tiene CLAUDE_CONFIG_DIR puesto, el .claude.json se toma de ahí, no del home", () => {
  // When the variable is set, the CLI reads `$CLAUDE_CONFIG_DIR/.claude.json` and NOT
  // `~/.claude.json` (ops/runbooks/encender-un-alias.md). Taking it from the home would copy the
  // wrong file and the alias would boot with someone else's MCP.
  const plan = planificarSeparacion({
    ...ZEUS,
    entornoActual: { CLAUDE_CONFIG_DIR: "/datos/agents/zeus/.claude" },
  });
  assert.equal(plan.directorioOrigen, "/datos/agents/zeus/.claude");
  const copia = copiaDe(plan, "/home/dev/.local/share/cauce-v3/config/zeus/.claude/.claude.json");
  assert.equal(copia.origen, "/datos/agents/zeus/.claude/.claude.json");
});

test("codex no tiene .claude.json: todo cuelga de CODEX_HOME", () => {
  const plan = planificarSeparacion(KRATOS);
  assert.ok(
    !plan.copias.some((copia) => copia.destino.endsWith(".claude.json")),
    "inventarle un .claude.json a codex haría fallar la comprobación del ejecutor por un fichero que no existe",
  );
  assert.equal(plan.copias[0].origen, "/home/dev/.codex/AGENTS.md");
  assert.equal(plan.copias[0].tipo, "fichero");
  assert.equal(plan.copias[0].destino, `${plan.directorioDestino}/AGENTS.md`);
});

test("si el alias ya tiene CODEX_HOME puesto, el origen es ese y no ~/.codex", () => {
  const plan = planificarSeparacion({
    ...KRATOS,
    entornoActual: { CODEX_HOME: "/home/dev/.codex/cuenta-b" },
  });
  assert.equal(plan.directorioOrigen, "/home/dev/.codex/cuenta-b");
  assert.equal(plan.copias[0].origen, "/home/dev/.codex/cuenta-b/AGENTS.md");
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROL of this test: the deletions.
// ---------------------------------------------------------------------------

test("CONTROL NEGATIVO: la lista de borrados está VACÍA — el origen ES la reversa", () => {
  for (const entrada of [KRATOS, ZEUS]) {
    const plan = planificarSeparacion(entrada);
    assert.deepEqual(
      plan.borrados,
      [],
      "el directorio original no se toca: mientras siga ahí, revertir es quitar una variable",
    );
  }
});

test("CONTROL NEGATIVO: ninguna copia escribe DENTRO del directorio de origen", () => {
  // A copy whose destination fell under the source would no longer be a clean rollback: the
  // "reverted" alias would boot with files the separation put there.
  for (const entrada of [KRATOS, ZEUS]) {
    const plan = planificarSeparacion(entrada);
    for (const copia of plan.copias) {
      assert.ok(
        !copia.destino.startsWith(`${plan.directorioOrigen}/`) && copia.destino !== plan.directorioOrigen,
        `la copia a ${copia.destino} contamina el origen ${plan.directorioOrigen}`,
      );
    }
  }
});

test("CONTROL NEGATIVO: el destino no puede caer dentro del origen ni al revés", () => {
  // If the source were already under the alias's persistent destination, copying the directory
  // inside itself is an infinite recursion, not a separation.
  assert.throws(
    () => planificarSeparacion({
      ...KRATOS,
      entornoActual: { CODEX_HOME: "/home/dev/.local/share/cauce-v3/config/kratos" },
    }),
    ErrorDePlan,
  );
});

// ---------------------------------------------------------------------------
// The new environment.
// ---------------------------------------------------------------------------

test("el entorno nuevo declara exactamente UNA variable, la del arnés", () => {
  assert.deepEqual(planificarSeparacion(KRATOS).entorno, { CODEX_HOME: "/home/dev/.local/share/cauce-v3/config/kratos/.codex" });
  assert.deepEqual(planificarSeparacion(ZEUS).entorno, { CLAUDE_CONFIG_DIR: "/home/dev/.local/share/cauce-v3/config/zeus/.claude" });
  assert.equal(Object.keys(planificarSeparacion(KRATOS).entorno).length, 1);
});

test("el entorno apunta al MISMO sitio que el destino de las copias", () => {
  // Two sources of truth for the same path is exactly how an alias ends up copying to one side
  // and reading from another.
  for (const entrada of [KRATOS, ZEUS]) {
    const plan = planificarSeparacion(entrada);
    assert.equal(Object.values(plan.entorno)[0], plan.directorioDestino);
    assert.ok(
      plan.copias.every((operacion) => operacion.destino.startsWith(`${plan.directorioDestino}/`)),
      "todas las operaciones quedan dentro del perfil gobernado por la variable",
    );
  }
});

// ---------------------------------------------------------------------------
// The witness: which file the executor checks by EFFECT.
// ---------------------------------------------------------------------------

test("el plan nombra el fichero testigo cuyo inodo tiene que dejar de coincidir", () => {
  assert.equal(planificarSeparacion(KRATOS).testigo, "AGENTS.md");
  assert.equal(planificarSeparacion(ZEUS).testigo, "CLAUDE.md");
});

// ---------------------------------------------------------------------------
// Warnings: what the plan does NOT solve and must be said out loud.
// ---------------------------------------------------------------------------

test("el plan conserva una sola fuente de credencial y lo advierte", () => {
  // Splitting the directory cannot duplicate `auth.json` / `.credentials.json`: if two aliases
  // share the same account, one copy goes stale when the other rotates its refresh token.
  // Links keep a single source and make that decision visible.
  const codex = planificarSeparacion(KRATOS);
  assert.ok(codex.advertencias.some((aviso) => /auth\.json/u.test(aviso)));
  assert.ok(codex.advertencias.some((aviso) => /no se copian|compartid/iu.test(aviso)));
  const claude = planificarSeparacion(ZEUS);
  assert.ok(claude.advertencias.some((aviso) => /\.credentials\.json/u.test(aviso)));
});

test("CONTROL DE SECRETOS: identidad se copia; credenciales/config se enlazan y sesiones no viajan", () => {
  for (const entrada of [KRATOS, ZEUS]) {
    const plan = planificarSeparacion(entrada);
    assert.ok(!plan.copias.some((operacion) => operacion.tipo === "directorio"));
    const testigo = plan.copias.find((operacion) => operacion.destino.endsWith(`/${plan.testigo}`));
    assert.equal(testigo?.tipo, "fichero", "sólo la identidad recibe un inodo propio");

    for (const nombre of ["auth.json", ".credentials.json", ".claude.json", "config.toml"]) {
      const operacion = plan.copias.find((copia) => copia.destino.endsWith(`/${nombre}`));
      if (operacion) assert.equal(operacion.tipo, "enlace", `${nombre} no puede copiar bytes`);
    }
    assert.ok(
      !plan.copias.some((operacion) => /(?:^|\/)(?:sessions?|history(?:\.jsonl)?)(?:\/|$)/iu.test(operacion.origen)),
      "historiales y sesiones no se copian ni enlazan",
    );
  }
});

test("el plan lleva escrita la reversa exacta", () => {
  const plan = planificarSeparacion(KRATOS);
  assert.match(plan.reversa, /\/home\/dev\/\.local\/share\/cauce-v3\/config\/kratos\/\.codex/u, "dice QUÉ borrar");
  assert.match(plan.reversa, /CODEX_HOME/u, "dice QUÉ variable quitar");
});

// ---------------------------------------------------------------------------
// Fail closed.
// ---------------------------------------------------------------------------

test("un arnés sin directorio de configuración se rechaza, no se planifica a ojo", () => {
  for (const arnes of ["hermes", "openclaw", "opencode", "", "CODEX"]) {
    assert.throws(
      () => planificarSeparacion({ alias: "iza", home: "/home/dev", arnes }),
      ErrorDePlan,
      `${arnes} no debería planificarse`,
    );
  }
});

test("home relativo, no canónico o con .. se rechaza", () => {
  for (const home of ["home/dev", "/home//dev", "/home/dev/", "/home/dev/../dev", ""]) {
    assert.throws(() => planificarSeparacion({ ...KRATOS, home }), ErrorDePlan, `home ${home}`);
  }
});

test("un alias con barra o .. no puede construir la ruta de destino", () => {
  // The destination is DERIVED from the alias: an alias with traversal would write outside its folder.
  for (const alias of ["../otro", "kratos/x", "/kratos", "", "Kratos", ".hidden"]) {
    assert.throws(() => planificarSeparacion({ ...KRATOS, alias }), ErrorDePlan, `alias ${alias}`);
  }
});

test("una variable de entorno actual con ruta relativa se rechaza", () => {
  assert.throws(
    () => planificarSeparacion({ ...KRATOS, entornoActual: { CODEX_HOME: ".codex/cuenta-b" } }),
    ErrorDePlan,
  );
});

// ---------------------------------------------------------------------------
// Command-line interface: what the executor consumes.
// ---------------------------------------------------------------------------

test("el guion imprime el plan en JSON y sale con 0", () => {
  const resultado = spawnSync(process.execPath, [guion, "--alias", "kratos", "--home", "/home/dev", "--arnes", "codex"], { encoding: "utf8" });
  assert.equal(resultado.status, 0, resultado.stderr);
  const plan = JSON.parse(resultado.stdout);
  assert.equal(plan.directorioDestino, "/home/dev/.local/share/cauce-v3/config/kratos/.codex");
  assert.deepEqual(plan.borrados, []);
});

test("el guion falla con código distinto de 0 y NO imprime plan cuando la entrada es mala", () => {
  const resultado = spawnSync(process.execPath, [guion, "--alias", "iza", "--home", "/home/dev", "--arnes", "hermes"], { encoding: "utf8" });
  assert.notEqual(resultado.status, 0);
  assert.equal(resultado.stdout.trim(), "", "un plan a medias es peor que ningún plan");
  assert.match(resultado.stderr, /hermes/u);
});
