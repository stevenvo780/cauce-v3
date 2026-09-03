import { createHash } from "node:crypto";
import {
  bloqueGestionado as leerBloqueGestionado, harnessDocumentPaths,
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

/** Diagnostic of why the fixed text was resent. */
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

// ── Read the disk seal from inside the container ────────────────────────────────────────────

/**
 * Harnesses whose sealed block lives in a plain text document of their own config directory.
 *
 * An allowlist, not a lookup: `openclaw` keeps its directive inside `openclaw.json` next to
 * `auth` and `secrets`, so it has a projection path and never a file path, and `hermes` writes
 * its document straight into a shared `$HOME`. Both must resolve to `undefined` here.
 */
const ARNESES_CON_FICHERO_SELLADO: ReadonlySet<string> = new Set(["claude", "codex"]);

/**
 * Resolves the path to the harness's instructions file from local environment variables.
 *
 * The directory, its default under HOME and the file name come from the one path table in
 * `@cauce/protocol`; this only decides WHICH harnesses have such a file.
 */
export function rutaDelContextoFijo(
  harness: string,
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!ARNESES_CON_FICHERO_SELLADO.has(harness)) return undefined;
  // A relative value is dropped instead of composed: composing it would land the file outside
  // the home, and the table's default under HOME is the safe answer.
  const absoluta = (valor: string | undefined): string | undefined =>
    valor?.startsWith("/") === true ? valor : undefined;
  const rutas = harnessDocumentPaths(harness, {
    home,
    claudeConfigDir: absoluta(environment.CLAUDE_CONFIG_DIR),
    codexHome: absoluta(environment.CODEX_HOME),
  });
  return rutas.length === 1 ? rutas[0] : undefined;
}

/*
 * The markers and the merge MOVED to `@cauce/protocol/marcas-de-bloque.ts`.
 *
 * Reason: the console must show EXACTLY the file that will end up on disk —with the human
 * content intact around it— and the gateway cannot import this package. What remains here is
 * what the container actually needs: the seal (`node:crypto`) read from the local disk.
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
function extraerSello(contenido: string): SelloDeContextoFijo | undefined {
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
