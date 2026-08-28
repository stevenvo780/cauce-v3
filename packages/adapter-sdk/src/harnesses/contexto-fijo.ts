import { createHash } from "node:crypto";
import {
  bloqueGestionado as leerBloqueGestionado, conBloqueGestionado as fusionarBloqueGestionado,
  VERSION_CONTEXTO_FIJO,
} from "@cauce/protocol";

/**
 * Management of the fixed-context seal to deduplicate the invariant instructions
 * seeded into the harness's configuration files.
 */

export interface SelloDeContextoFijo {
  /** `VERSION_CONTEXTO_FIJO` with which the file was written. */
  readonly version: string;
  /** sha256 in hexadecimal of the fixed text, exactly as written in the harness file. */
  readonly sha256: string;
}

/**
 * Generates the sha256 hash of the fixed text for integrity verification.
 */
export function resumirContextoFijo(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex");
}

/**
 * Checks whether the seal matches exactly the expected version and content of the fixed text.
 */
export function elFicheroYaLoDice(
  sello: SelloDeContextoFijo | undefined,
  textoFijo: string,
): boolean {
  if (!sello) return false;
  if (sello.version !== VERSION_CONTEXTO_FIJO) return false;
  return sello.sha256 === resumirContextoFijo(textoFijo);
}

export type MotivoDeReenvio =
  | "sin-sello"
  | "version-distinta"
  | "contenido-distinto"
  | "no-hace-falta";

/**
 * Diagnostic of why the fixed text was resent.
 */
export function motivoDeReenvio(
  sello: SelloDeContextoFijo | undefined,
  textoFijo: string,
): MotivoDeReenvio {
  if (!sello) return "sin-sello";
  if (sello.version !== VERSION_CONTEXTO_FIJO) return "version-distinta";
  if (sello.sha256 !== resumirContextoFijo(textoFijo)) return "contenido-distinto";
  return "no-hace-falta";
}

/**
 * Substitute message when the fixed context is already loaded in the harness.
 */
export function renglonDeContextoFijo(): string {
  return (
    "Tu contrato de identidad, deber y protocolo NO se repite en esta entrega: ya está cargado " +
    `desde el fichero de instrucciones de tu arnés (contexto Cauce v${VERSION_CONTEXTO_FIJO}). ` +
    "Rige igual. Si no lo tenés delante, decilo en tu \"reply\" y seguí con lo que puedas."
  );
}

// ── Leer el sello del disco, desde dentro del contenedor ────────────────────────────────────

/**
 * Resolves the path to the harness's instructions file from local environment variables.
 */
export function rutaDelContextoFijo(
  harness: string,
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const absoluta = (valor: string | undefined): string | undefined =>
    valor && valor.startsWith("/") ? valor : undefined;
  if (harness === "claude") {
    return `${absoluta(environment.CLAUDE_CONFIG_DIR) ?? `${home}/.claude`}/CLAUDE.md`;
  }
  if (harness === "codex") {
    return `${absoluta(environment.CODEX_HOME) ?? `${home}/.codex`}/AGENTS.md`;
  }
  return undefined;
}

/*
 * The markers and the merge MOVED to `@cauce/protocol/marcas-de-bloque.ts`.
 *
 * Reason: the console must show EXACTLY the file that will end up on disk —with the human
 * content intact around it— and the gateway cannot import this package. What remains here is
 * what the container actually needs: the seal (`node:crypto`) and the seeding (the disk).
 *
 * Re-exported so anything already importing them from here doesn't have to move.
 */
export {
  bloqueEntreMarcas, bloqueGestionado, conBloqueEntreMarcas, conBloqueGestionado,
  MARCA_FIN, MARCA_INICIO, VERSION_CONTEXTO_FIJO,
} from "@cauce/protocol";

/**
 * Extracts the seal from content that may contain a managed block.
 */
export function extraerSello(contenido: string): SelloDeContextoFijo | undefined {
  const bloque = leerBloqueGestionado(contenido);
  if (bloque === undefined) return undefined;
  return { version: VERSION_CONTEXTO_FIJO, sha256: resumirContextoFijo(bloque) };
}

/**
 * Reads the instructions-file seal directly from the local disk.
 * If the file is missing or cannot be read, returns `undefined`.
 */
export function selloDesdeElDisco(
  ruta: string | undefined,
  leer: (ruta: string) => string,
): SelloDeContextoFijo | undefined {
  if (!ruta) return undefined;
  try {
    const contenido = leer(ruta);
    return extraerSello(contenido);
  } catch {
    return undefined;
  }
}

/** Why the file was NOT seeded. Goes to the log; the turn continues. */
export type MotivoDeNoSembrar =
  | "sembrado"
  | "apagado"
  | "sin-ruta"
  | "ya-estaba"
  | "ocupado-por-otro-alias"
  | "no-se-pudo-escribir";

/**
 * Inserts or updates the managed block with the fixed text in the harness file.
 * If the existing block belongs to another alias that shares the directory, returns `ocupado-por-otro-alias`.
 */
export function sembrarContextoFijo(
  ruta: string | undefined,
  textoFijo: string,
  io: {
    leer: (ruta: string) => string;
    escribir: (ruta: string, contenido: string) => void;
    habilitado: boolean;
  },
): MotivoDeNoSembrar {
  if (!io.habilitado) return "apagado";
  if (!ruta) return "sin-ruta";

  let original: string;
  try {
    original = io.leer(ruta);
  } catch {
    // Not existing is normal the first time: we seed over an empty file.
    original = "";
  }

  const actual = leerBloqueGestionado(original);
  if (actual === textoFijo) return "ya-estaba";
  if (actual !== undefined && actual !== textoFijo) {
    /*
     * There's a block and it says something else. Two cases we can't tell apart from here:
     * either the contract changed (and must be rewritten), or the file belongs to another alias
     * sharing `$HOME` (and rewriting would start a write war). In doubt we don't overwrite,
     * because the harm isn't symmetric: overwriting leaves two aliases without stable identity;
     * under-writing costs one full envelope per turn, which is already the status quo.
     */
    return "ocupado-por-otro-alias";
  }

  try {
    io.escribir(ruta, fusionarBloqueGestionado(original, textoFijo));
  } catch {
    return "no-se-pudo-escribir";
  }
  return "sembrado";
}
