#!/usr/bin/env node
/**
 * Per-alias configuration separation planner.
 *
 * THE PROBLEM, MEASURED
 * =====================
 *
 * To move each alias's fixed information to its harness's file, each alias needs to HAVE
 * its own file. Today it doesn't:
 *
 *   * `kratos` and `atlas` share the `ws-humanizar` container, the `dev` user and the HOME
 *     `/home/dev`. Their `~/.codex/AGENTS.md` is THE SAME INODE — 12,942 bytes in both.
 *   * `zeus` and `argos` share `CLAUDE.md` byte-by-byte for the same reason.
 *
 * As long as that holds, writing context per file would give `atlas` `kratos`'s identity.
 * That is exactly why the role ended up in the database
 * (`packages/store/migrations/020_agent_role_brief.sql`).
 *
 * THE PATH
 * ========
 *
 * `CLAUDE_CONFIG_DIR` and `CODEX_HOME` already govern where each CLI looks, and the
 * supervisor already builds the adapter's environment per alias. Each alias is pointed at
 * `<home>/.local/share/cauce-v3/config/<alias>/`, inside the fleet's persistent tree. Only
 * the identity file is COPIED; configuration, MCP and credentials are referenced through
 * links to the single source. Histories and sessions are neither copied nor shared. The
 * original is left INTACT as a rollback.
 *
 * THE TRAP, ALREADY PAID ONCE
 * ===========================
 *
 * `CLAUDE_CONFIG_DIR` ALSO moves `.claude.json`, and with it all of the alias's MCP
 * servers. Moving the directory without that file leaves the alias without any tools and
 * **without a single error**: it doesn't fail, doesn't warn, starts just the same and stays
 * mute on capabilities. That is why `.claude.json` is not just another copy — it is a copy
 * `obligatorio: true` that the executor must verify BY EFFECT before declaring success.
 *
 * WHAT THIS SCRIPT DOES NOT DO
 * =============================
 *
 * It doesn't touch the disk. It returns a plan. Applying it is the job of
 * `aplicar-separacion-config.sh`, which is the one that checks by effect. Separating the
 * plan from the application is what allows reviewing what will be done before doing it, and
 * testing the criteria without any container.
 */

import { parseArgs } from "node:util";

/** Fail closed: a half-baked plan is worse than no plan. */
export class ErrorDePlan extends Error {}

/**
 * The only two harnesses with a config directory governed by an environment variable. `hermes`
 * only reads stdin and does not mount any instruction file; the `openclaw` ones do not read
 * `~/.codex` nor `~/.claude`. Planning a separation for them would mean moving a directory
 * nobody reads and believing something got fixed.
 */
const ARNESES = {
  codex: { variable: "CODEX_HOME", directorio: ".codex", testigo: "AGENTS.md" },
  claude: { variable: "CLAUDE_CONFIG_DIR", directorio: ".claude", testigo: "CLAUDE.md" },
};

const ALIAS_VALIDO = /^[a-z][a-z0-9-]*$/u;

function rutaAbsolutaCanonica(valor, etiqueta) {
  if (typeof valor !== "string" || !valor.startsWith("/") || valor.includes("//")) {
    throw new ErrorDePlan(`${etiqueta} tiene que ser una ruta absoluta canónica: ${valor}`);
  }
  if (valor.length > 1 && valor.endsWith("/")) {
    throw new ErrorDePlan(`${etiqueta} no puede terminar en barra: ${valor}`);
  }
  const partes = valor.split("/").slice(1);
  if (partes.some((parte) => parte === "." || parte === "..")) {
    throw new ErrorDePlan(`${etiqueta} no puede llevar . ni ..: ${valor}`);
  }
  return valor;
}

/**
 * Where an alias's configuration will live, DERIVED and never written by hand. The path being
 * derived and not configured is deliberate: it is the same calculation the supervisor makes
 * when exporting the variable. If it were a free value in two places, one would copy to a directory
 * and the other would read from another, and the alias would boot with the factory configuration
 * without anything failing.
 */
export function directorioDeAlias(home, alias, arnes) {
  const perfil = ARNESES[arnes];
  if (!perfil) throw new ErrorDePlan(`arnés sin directorio de configuración: '${arnes}'`);
  rutaAbsolutaCanonica(home, "home");
  if (!ALIAS_VALIDO.test(alias)) throw new ErrorDePlan(`alias inválido: '${alias}'`);
  return `${home}/.local/share/cauce-v3/config/${alias}/${perfil.directorio}`;
}

/**
 * Where the alias's configuration comes from TODAY. It replicates exactly what the CLI resolves
 * (and `harnessConfigDirectory` in `packages/adapter-sdk/src/shared-session/config.ts`): if the
 * variable is set it rules; otherwise the default is `<home>/<.codex|.claude>`. Guessing the default
 * when the variable is already set would copy the wrong directory.
 */
function origenActual(home, arnes, entornoActual) {
  const { variable, directorio } = ARNESES[arnes];
  const declarado = entornoActual?.[variable];
  if (declarado === undefined || declarado === "") return `${home}/${directorio}`;
  return rutaAbsolutaCanonica(declarado, variable);
}

export function planificarSeparacion(entrada) {
  if (entrada === null || typeof entrada !== "object") {
    throw new ErrorDePlan("la entrada tiene que ser un objeto {alias, home, arnes}");
  }
  const { alias, home, arnes, entornoActual } = entrada;
  const perfil = ARNESES[arnes];
  if (!perfil) {
    throw new ErrorDePlan(
      `arnés sin directorio de configuración por variable: '${arnes}'. ` +
      "Sólo codex (CODEX_HOME) y claude (CLAUDE_CONFIG_DIR) leen un directorio gobernado por una " +
      "variable; hermes lee stdin y los openclaw no leen ~/.codex ni ~/.claude.",
    );
  }
  const directorioDestino = directorioDeAlias(home, alias, arnes);
  const directorioOrigen = origenActual(home, arnes, entornoActual);

  // A source already under the destination (or vice versa) is not a separation: it is copying
  // a directory inside itself.
  if (
    directorioOrigen === directorioDestino
    || directorioDestino.startsWith(`${directorioOrigen}/`)
    || directorioOrigen.startsWith(`${directorioDestino}/`)
  ) {
    throw new ErrorDePlan(
      `el origen (${directorioOrigen}) y el destino (${directorioDestino}) se solapan: ` +
      "copiar un directorio dentro de sí mismo no separa nada",
    );
  }

  const copias = [{
    origen: `${directorioOrigen}/${perfil.testigo}`,
    destino: `${directorioDestino}/${perfil.testigo}`,
    tipo: "fichero",
    obligatorio: true,
    motivo:
      `${perfil.testigo} define la identidad del alias. Es el único contenido que se copia para ` +
      "darle un inodo propio; el original queda como reversa.",
  }];

  const advertencias = [];

  if (arnes === "claude") {
    // THE TRAP. When CLAUDE_CONFIG_DIR is set, the CLI reads `$CLAUDE_CONFIG_DIR/.claude.json`
    // and NOT `~/.claude.json` (ops/runbooks/encender-un-alias.md). So the file's SOURCE
    // depends on whether the variable was already set; the destination is always inside the
    // new directory.
    const yaTeniaVariable = Boolean(entornoActual?.CLAUDE_CONFIG_DIR);
    copias.push({
      origen: yaTeniaVariable ? `${directorioOrigen}/.claude.json` : `${home}/.claude.json`,
      destino: `${directorioDestino}/.claude.json`,
      tipo: "enlace",
      obligatorio: true,
      motivo:
        "CLAUDE_CONFIG_DIR mueve TAMBIÉN el .claude.json, donde viven los MCP; perderlo deja al " +
        "alias sin herramientas y sin un solo error. Se enlaza al origen único: copiarlo podría " +
        "duplicar secretos y separaría futuras rotaciones.",
    });
    copias.push({
      origen: `${directorioOrigen}/.credentials.json`,
      destino: `${directorioDestino}/.credentials.json`,
      tipo: "enlace",
      obligatorio: true,
      motivo: "La credencial permanece en un único fichero; nunca se copian sus bytes.",
    });
    copias.push({
      origen: `${directorioOrigen}/settings.json`,
      destino: `${directorioDestino}/settings.json`,
      tipo: "enlace",
      obligatorio: false,
      motivo: "Si existe, conserva permisos/hooks sin duplicar posibles valores sensibles.",
    });
    advertencias.push(
      ".credentials.json y los MCP siguen siendo compartidos por enlace con el origen autorizado. " +
      "La identidad sí queda separada; una rotación sigue teniendo una sola fuente.",
    );
  }

  if (arnes === "codex") {
    copias.push({
      origen: `${directorioOrigen}/config.toml`,
      destino: `${directorioDestino}/config.toml`,
      tipo: "enlace",
      obligatorio: true,
      motivo: "La configuración/MCP conserva una sola fuente y no duplica valores sensibles.",
    });
    copias.push({
      origen: `${directorioOrigen}/auth.json`,
      destino: `${directorioDestino}/auth.json`,
      tipo: "enlace",
      obligatorio: true,
      motivo: "La credencial permanece en un único fichero; nunca se copian sus bytes.",
    });
    advertencias.push(
      "auth.json y config.toml siguen siendo compartidos por enlace con el origen autorizado. " +
      "No se copian tokens, sesiones ni history.jsonl.",
    );
  }

  advertencias.push(
    "El fichero de identidad es una FOTO deliberada; credenciales y configuración permanecen " +
    "enlazadas. Los historiales nuevos son propios del alias y no se importan del origen ambiguo.",
  );

  return {
    alias,
    arnes,
    variable: perfil.variable,
    testigo: perfil.testigo,
    directorioOrigen,
    directorioDestino,
    copias,
    entorno: { [perfil.variable]: directorioDestino },
    // EMPTY, always. The source IS the rollback: as long as it stays there, reversing is just
    // removing an environment variable. If the plan deleted it, reversing would mean
    // restoring from a backup nobody took.
    borrados: [],
    advertencias,
    reversa:
      `1) quitar ${perfil.variable} del entorno del alias (apagar el interruptor CONFIG_POR_ALIAS ` +
      `en su .env y reiniciar el alias); 2) borrar ${directorioDestino}. El origen ` +
      `${directorioOrigen} no se tocó en ningún momento, así que el alias vuelve exactamente al ` +
      "estado anterior sin restaurar nada.",
  };
}

function main(argv) {
  let opciones;
  try {
    ({ values: opciones } = parseArgs({
      args: argv,
      options: {
        alias: { type: "string" },
        home: { type: "string" },
        arnes: { type: "string" },
        "config-dir-actual": { type: "string" },
      },
    }));
  } catch (error) {
    process.stderr.write(`separar-config-alias: ${error.message}\n`);
    return 2;
  }
  try {
    const entornoActual = {};
    if (opciones["config-dir-actual"]) {
      const perfil = ARNESES[opciones.arnes];
      if (!perfil) throw new ErrorDePlan(`arnés desconocido: '${opciones.arnes}'`);
      entornoActual[perfil.variable] = opciones["config-dir-actual"];
    }
    const plan = planificarSeparacion({
      alias: opciones.alias,
      home: opciones.home,
      arnes: opciones.arnes,
      entornoActual,
    });
    // Nothing on stdout until the plan is whole: a half plan through the pipe is worse than none.
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`separar-config-alias: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
