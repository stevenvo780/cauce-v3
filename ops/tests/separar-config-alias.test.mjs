#!/usr/bin/env node
/**
 * Planificador de separación de configuración por alias.
 *
 * QUÉ SE ESTÁ PROBANDO, Y POR QUÉ IMPORTA TANTO EL `.claude.json`
 * ==============================================================
 *
 * `CLAUDE_CONFIG_DIR` no mueve solamente el `CLAUDE.md`: mueve TAMBIÉN el `.claude.json`, y con él
 * la lista entera de servidores MCP del alias. Si el plan apunta la variable a un directorio nuevo
 * sin llevarse ese fichero, el alias pierde TODAS sus herramientas **sin un solo error**: no falla,
 * no avisa, arranca igual y se queda mudo de capacidades. Eso ya se pagó una vez.
 *
 * Por eso aquí no basta con que el plan "funcione": se exige EXPLÍCITAMENTE que `.claude.json`
 * esté entre las copias y que lleve escrito el motivo. Una prueba que sólo mirara el directorio
 * pasaría con el fallo dentro.
 *
 * Y la lista de BORRADOS tiene que estar vacía siempre: el origen es la reversa. Mientras el
 * directorio original siga ahí, revertir es quitar una variable de entorno; si el plan lo borra,
 * revertir es restaurar de un respaldo que nadie tomó.
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
// El destino: derivado, nunca a mano.
// ---------------------------------------------------------------------------

test("el destino es <home>/.cauce/<alias>/<dir del arnés>, derivado del alias", () => {
  assert.equal(directorioDeAlias("/home/dev", "kratos", "codex"), "/home/dev/.cauce/kratos/.codex");
  assert.equal(directorioDeAlias("/home/dev", "atlas", "codex"), "/home/dev/.cauce/atlas/.codex");
  assert.equal(directorioDeAlias("/home/dev", "zeus", "claude"), "/home/dev/.cauce/zeus/.claude");
  assert.equal(directorioDeAlias("/home/claw", "hegel", "claude"), "/home/claw/.cauce/hegel/.claude");
});

test("kratos y atlas, mismo home y mismo contenedor, salen a destinos DISTINTOS", () => {
  // Es el punto entero del trabajo: hoy los dos leen el mismo inodo en /home/dev/.codex.
  const kratos = planificarSeparacion({ alias: "kratos", home: "/home/dev", arnes: "codex" });
  const atlas = planificarSeparacion({ alias: "atlas", home: "/home/dev", arnes: "codex" });
  assert.equal(kratos.directorioOrigen, atlas.directorioOrigen, "hoy comparten el origen");
  assert.notEqual(kratos.directorioDestino, atlas.directorioDestino);
  assert.equal(kratos.directorioDestino, "/home/dev/.cauce/kratos/.codex");
  assert.equal(atlas.directorioDestino, "/home/dev/.cauce/atlas/.codex");
});

// ---------------------------------------------------------------------------
// LA TRAMPA MEDIDA: el .claude.json.
// ---------------------------------------------------------------------------

test("EXIGENCIA: .claude.json está entre las copias, y con el motivo escrito", () => {
  const plan = planificarSeparacion(ZEUS);
  const copia = copiaDe(plan, "/home/dev/.cauce/zeus/.claude/.claude.json");
  assert.ok(
    copia,
    "sin .claude.json en el destino el alias pierde TODOS sus MCP sin un solo error de arranque",
  );
  assert.equal(copia.origen, "/home/dev/.claude.json");
  assert.equal(copia.tipo, "fichero");
  assert.equal(copia.obligatorio, true, "no es opcional: su ausencia es silenciosa");
  assert.match(
    copia.motivo,
    /MCP/u,
    "el motivo tiene que decir QUÉ se pierde, no 'se copia por si acaso'",
  );
  assert.match(copia.motivo, /sin un solo error|silencio/iu);
});

test("si el alias YA tiene CLAUDE_CONFIG_DIR puesto, el .claude.json se toma de ahí, no del home", () => {
  // Cuando la variable está puesta, el CLI lee `$CLAUDE_CONFIG_DIR/.claude.json` y NO `~/.claude.json`
  // (ops/runbooks/encender-un-alias.md). Tomarlo del home copiaría el fichero equivocado y el alias
  // arrancaría con los MCP de otro.
  const plan = planificarSeparacion({
    ...ZEUS,
    entornoActual: { CLAUDE_CONFIG_DIR: "/datos/agents/zeus/.claude" },
  });
  assert.equal(plan.directorioOrigen, "/datos/agents/zeus/.claude");
  const copia = copiaDe(plan, "/home/dev/.cauce/zeus/.claude/.claude.json");
  assert.equal(copia.origen, "/datos/agents/zeus/.claude/.claude.json");
});

test("codex no tiene .claude.json: todo cuelga de CODEX_HOME", () => {
  const plan = planificarSeparacion(KRATOS);
  assert.ok(
    !plan.copias.some((copia) => copia.destino.endsWith(".claude.json")),
    "inventarle un .claude.json a codex haría fallar la comprobación del ejecutor por un fichero que no existe",
  );
  assert.equal(plan.copias[0].origen, "/home/dev/.codex");
  assert.equal(plan.copias[0].tipo, "directorio");
});

test("si el alias ya tiene CODEX_HOME puesto, el origen es ese y no ~/.codex", () => {
  const plan = planificarSeparacion({
    ...KRATOS,
    entornoActual: { CODEX_HOME: "/home/dev/.codex/cuenta-b" },
  });
  assert.equal(plan.directorioOrigen, "/home/dev/.codex/cuenta-b");
  assert.equal(plan.copias[0].origen, "/home/dev/.codex/cuenta-b");
});

// ---------------------------------------------------------------------------
// CONTROL NEGATIVO de esta prueba: los borrados.
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
  // Una copia cuyo destino cayera bajo el origen dejaría de ser una reversa intacta: el alias
  // "revertido" arrancaría con ficheros que la separación metió ahí.
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
  // Si alguien pidiera separar un alias cuyo origen ya fuese `<home>/.cauce/<alias>/...`, copiar
  // el directorio dentro de sí mismo es una recursión infinita, no una separación.
  assert.throws(
    () => planificarSeparacion({
      ...KRATOS,
      entornoActual: { CODEX_HOME: "/home/dev/.cauce/kratos" },
    }),
    ErrorDePlan,
  );
});

// ---------------------------------------------------------------------------
// El entorno nuevo.
// ---------------------------------------------------------------------------

test("el entorno nuevo declara exactamente UNA variable, la del arnés", () => {
  assert.deepEqual(planificarSeparacion(KRATOS).entorno, { CODEX_HOME: "/home/dev/.cauce/kratos/.codex" });
  assert.deepEqual(planificarSeparacion(ZEUS).entorno, { CLAUDE_CONFIG_DIR: "/home/dev/.cauce/zeus/.claude" });
  assert.equal(Object.keys(planificarSeparacion(KRATOS).entorno).length, 1);
});

test("el entorno apunta al MISMO sitio que el destino de las copias", () => {
  // Dos fuentes de verdad para la misma ruta es exactamente cómo se llega a un alias que copia a
  // un lado y lee de otro.
  for (const entrada of [KRATOS, ZEUS]) {
    const plan = planificarSeparacion(entrada);
    assert.equal(Object.values(plan.entorno)[0], plan.directorioDestino);
    assert.equal(plan.copias[0].destino, plan.directorioDestino);
  }
});

// ---------------------------------------------------------------------------
// El testigo: qué fichero mira el ejecutor para comprobar por EFECTO.
// ---------------------------------------------------------------------------

test("el plan nombra el fichero testigo cuyo inodo tiene que dejar de coincidir", () => {
  assert.equal(planificarSeparacion(KRATOS).testigo, "AGENTS.md");
  assert.equal(planificarSeparacion(ZEUS).testigo, "CLAUDE.md");
});

// ---------------------------------------------------------------------------
// Advertencias: lo que el plan NO resuelve y hay que decir en voz alta.
// ---------------------------------------------------------------------------

test("el plan advierte de la credencial duplicada en vez de callarlo", () => {
  // Separar el directorio duplica `auth.json` / `.credentials.json`. Si dos alias comparten UNA
  // cuenta, codex mantiene una sola credencial viva: cuando una rota el refresh token, la otra
  // copia queda muerta. El plan no puede decidir eso — pero callarlo es peor.
  const codex = planificarSeparacion(KRATOS);
  assert.ok(codex.advertencias.some((aviso) => /auth\.json/u.test(aviso)));
  assert.ok(codex.advertencias.some((aviso) => /cuenta/iu.test(aviso)));
  const claude = planificarSeparacion(ZEUS);
  assert.ok(claude.advertencias.some((aviso) => /\.credentials\.json/u.test(aviso)));
});

test("el plan lleva escrita la reversa exacta", () => {
  const plan = planificarSeparacion(KRATOS);
  assert.match(plan.reversa, /\/home\/dev\/\.cauce\/kratos\/\.codex/u, "dice QUÉ borrar");
  assert.match(plan.reversa, /CODEX_HOME/u, "dice QUÉ variable quitar");
});

// ---------------------------------------------------------------------------
// Falla cerrado.
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
  // El destino se DERIVA del alias: un alias con travesía escribiría fuera de su carpeta.
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
// Interfaz de línea: lo que consume el ejecutor.
// ---------------------------------------------------------------------------

test("el guion imprime el plan en JSON y sale con 0", () => {
  const resultado = spawnSync(process.execPath, [guion, "--alias", "kratos", "--home", "/home/dev", "--arnes", "codex"], { encoding: "utf8" });
  assert.equal(resultado.status, 0, resultado.stderr);
  const plan = JSON.parse(resultado.stdout);
  assert.equal(plan.directorioDestino, "/home/dev/.cauce/kratos/.codex");
  assert.deepEqual(plan.borrados, []);
});

test("el guion falla con código distinto de 0 y NO imprime plan cuando la entrada es mala", () => {
  const resultado = spawnSync(process.execPath, [guion, "--alias", "iza", "--home", "/home/dev", "--arnes", "hermes"], { encoding: "utf8" });
  assert.notEqual(resultado.status, 0);
  assert.equal(resultado.stdout.trim(), "", "un plan a medias es peor que ningún plan");
  assert.match(resultado.stderr, /hermes/u);
});
