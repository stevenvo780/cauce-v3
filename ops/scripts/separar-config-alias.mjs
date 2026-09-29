#!/usr/bin/env node

import { parseArgs } from "node:util";

export class ErrorDePlan extends Error {}

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

export function directorioDeAlias(home, alias, arnes) {
  const perfil = ARNESES[arnes];
  if (!perfil) throw new ErrorDePlan(`arnés sin directorio de configuración: '${arnes}'`);
  rutaAbsolutaCanonica(home, "home");
  if (!ALIAS_VALIDO.test(alias)) throw new ErrorDePlan(`alias inválido: '${alias}'`);
  return `${home}/.local/share/cauce-v3/config/${alias}/${perfil.directorio}`;
}

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
      "Este plan configura únicamente CODEX_HOME y CLAUDE_CONFIG_DIR; OpenClaw administra sus perfiles.",
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
      `${perfil.testigo} define la identidad del alias y necesita su propio inodo.`,
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
      tipo: "fichero",
      modo: "0600",
      obligatorio: true,
      motivo: "El MCP necesita configuración propia del alias; omitir .claude.json pierde herramientas en silencio.",
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
      ".credentials.json sigue enlazado al origen autorizado; .claude.json es privado del alias. " +
      "La rotación de credenciales conserva una sola fuente.",
    );
  }

  if (arnes === "codex") {
    copias.push({
      origen: `${directorioOrigen}/config.toml`,
      destino: `${directorioDestino}/config.toml`,
      tipo: "fichero",
      modo: "0600",
      obligatorio: true,
      motivo: "La configuración MCP pertenece al alias para no conectar otros agentes a su socket.",
    });
    copias.push({
      origen: `${directorioOrigen}/auth.json`,
      destino: `${directorioDestino}/auth.json`,
      tipo: "enlace",
      obligatorio: true,
      motivo: "La credencial permanece en un único fichero; nunca se copian sus bytes.",
    });
    advertencias.push(
      "auth.json sigue enlazado al origen autorizado; config.toml es privado del alias. " +
      "No se copian tokens de autenticación, sesiones ni history.jsonl.",
    );
  }

  advertencias.push(
    "Identidad y configuración MCP quedan aisladas; los enlaces de credenciales se conservan. " +
    "Los historiales nuevos son propios del alias y no se importan del origen ambiguo.",
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
    borrados: [],
    advertencias,
    reversa:
      `1) quitar ${perfil.variable} del entorno del alias (apagar el interruptor CONFIG_POR_ALIAS ` +
      `en su .env y reiniciar el alias); 2) conservar ${directorioDestino} con sus sesiones e ` +
      `historiales. La configuración original permanece en ${directorioOrigen}; reanudar una ` +
      "conversación requiere verificar su identificador y su ubicación antes del reinicio.",
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
