#!/usr/bin/env node
/**
 * Planificador de separación de configuración por alias.
 *
 * EL PROBLEMA, MEDIDO
 * ===================
 *
 * Para poder mover la información fija de cada alias al fichero de su arnés hace falta que cada
 * alias TENGA su fichero. Hoy no lo tiene:
 *
 *   * `kratos` y `atlas` comparten el contenedor `ws-humanizar`, el usuario `dev` y el HOME
 *     `/home/dev`. Su `~/.codex/AGENTS.md` es EL MISMO INODO — 12.942 bytes en los dos.
 *   * `zeus` y `argos` comparten `CLAUDE.md` byte a byte por lo mismo.
 *
 * Mientras eso siga así, escribir el contexto por fichero le daría a `atlas` la identidad de
 * `kratos`. Ese es exactamente el motivo por el que el rol acabó en la base de datos
 * (`packages/store/migrations/020_agent_role_brief.sql`).
 *
 * LA VÍA
 * ======
 *
 * `CLAUDE_CONFIG_DIR` y `CODEX_HOME` ya gobiernan dónde busca cada CLI, y el supervisor ya
 * construye el entorno del adaptador por alias. Se apunta cada alias a `<home>/.cauce/<alias>/`,
 * se COPIA el contenido actual y se deja el original INTACTO como reversa.
 *
 * LA TRAMPA, QUE YA SE PAGÓ UNA VEZ
 * =================================
 *
 * `CLAUDE_CONFIG_DIR` mueve TAMBIÉN el `.claude.json`, y con él todos los servidores MCP del
 * alias. Mover el directorio sin llevarse ese fichero deja al alias sin ninguna herramienta y
 * **sin un solo error**: no falla, no avisa, arranca igual y se queda mudo de capacidades. Por eso
 * el `.claude.json` no es una copia más — es una copia `obligatorio: true` que el ejecutor tiene
 * que comprobar POR EFECTO antes de declarar éxito.
 *
 * LO QUE ESTE GUION NO HACE
 * =========================
 *
 * No toca el disco. Devuelve un plan. Aplicarlo es trabajo de `aplicar-separacion-config.sh`, que
 * es quien comprueba por efecto. Separar el plan de la aplicación es lo que permite revisar qué se
 * va a hacer antes de hacerlo, y probar el criterio sin ningún contenedor.
 */

import { parseArgs } from "node:util";

/** Falla cerrado: un plan a medias es peor que ningún plan. */
export class ErrorDePlan extends Error {}

/**
 * Los dos únicos arneses con un directorio de configuración gobernado por una variable.
 *
 * `hermes` sólo lee stdin y no monta ningún fichero de instrucciones; los `openclaw` no leen
 * `~/.codex` ni `~/.claude`. Planificarles una separación sería mover un directorio que nadie
 * lee y creer que se arregló algo.
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
 * Dónde va a vivir la configuración de un alias. DERIVADA, nunca escrita a mano.
 *
 * Que la ruta se derive y no se configure es deliberado: es el mismo cálculo que hace el
 * supervisor al exportar la variable. Si fuera un valor libre en dos sitios, un día uno copiaría a
 * un directorio y el otro leería de otro, y el alias arrancaría con la configuración de fábrica
 * sin que nada fallara.
 */
export function directorioDeAlias(home, alias, arnes) {
  const perfil = ARNESES[arnes];
  if (!perfil) throw new ErrorDePlan(`arnés sin directorio de configuración: '${arnes}'`);
  rutaAbsolutaCanonica(home, "home");
  if (!ALIAS_VALIDO.test(alias)) throw new ErrorDePlan(`alias inválido: '${alias}'`);
  return `${home}/.cauce/${alias}/${perfil.directorio}`;
}

/**
 * De dónde sale HOY la configuración del alias.
 *
 * Replica exactamente lo que resuelve el CLI (y `harnessConfigDirectory` en
 * `packages/adapter-sdk/src/shared-session/config.ts`): si la variable está puesta manda ella; si
 * no, el defecto es `<home>/<.codex|.claude>`. Adivinar el defecto cuando la variable ya está
 * puesta copiaría el directorio equivocado.
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

  // Un origen que ya está bajo el destino (o al revés) no es una separación: es copiar un
  // directorio dentro de sí mismo.
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
    origen: directorioOrigen,
    destino: directorioDestino,
    tipo: "directorio",
    obligatorio: true,
    motivo:
      `Todo lo que ${perfil.variable} gobierna cuelga de aquí (${perfil.testigo}, credenciales, ` +
      "historial y registro de sesiones). Se COPIA, no se mueve: el original queda como reversa.",
  }];

  const advertencias = [];

  if (arnes === "claude") {
    // LA TRAMPA. Cuando CLAUDE_CONFIG_DIR está puesto, el CLI lee `$CLAUDE_CONFIG_DIR/.claude.json`
    // y NO `~/.claude.json` (ops/runbooks/encender-un-alias.md). Así que el ORIGEN del fichero
    // depende de si la variable ya estaba puesta; el destino, siempre dentro del directorio nuevo.
    const yaTeniaVariable = Boolean(entornoActual?.CLAUDE_CONFIG_DIR);
    copias.push({
      origen: yaTeniaVariable ? `${directorioOrigen}/.claude.json` : `${home}/.claude.json`,
      destino: `${directorioDestino}/.claude.json`,
      tipo: "fichero",
      obligatorio: true,
      motivo:
        "CLAUDE_CONFIG_DIR mueve TAMBIÉN el .claude.json, y ahí viven todos los servidores MCP del " +
        "alias. Si no llega, el alias pierde todas sus herramientas sin un solo error: no falla, " +
        "arranca igual y se queda mudo de capacidades. Es el fallo que ya se pagó una vez.",
    });
    advertencias.push(
      "El .credentials.json del alias queda DUPLICADO: el original sigue en el origen y la copia " +
      "vive en el destino. Si dos alias comparten una misma cuenta Claude, ahora hay dos copias " +
      "del mismo token y la rotación de una no alcanza a la otra. Comprobá a qué cuenta pertenece " +
      "cada alias ANTES de aplicar; este plan no puede decidirlo.",
    );
  }

  if (arnes === "codex") {
    advertencias.push(
      "El auth.json del alias queda DUPLICADO. Codex mantiene UNA sola credencial viva por cuenta: " +
      "si dos alias comparten cuenta, en cuanto una copia refresque el token la otra queda muerta " +
      "y ese alias deja de responder sin decir por qué. Comprobá que cada alias separado tiene su " +
      "propia cuenta ANTES de aplicar; este plan no puede decidirlo.",
    );
  }

  advertencias.push(
    "La copia es una FOTO. Todo lo que el alias escriba en el origen después de aplicar esto (y " +
    "todo lo que el despliegue monte encima) deja de verse desde el destino.",
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
    // VACÍA, siempre. El origen ES la reversa: mientras siga ahí, revertir es quitar una variable
    // de entorno. Si el plan lo borrara, revertir sería restaurar de un respaldo que nadie tomó.
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
    // Nada por stdout hasta que el plan está entero: medio plan por la tubería es peor que ninguno.
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
