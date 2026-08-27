import { createHash } from "node:crypto";
import {
  bloqueGestionado as leerBloqueGestionado, conBloqueGestionado as fusionarBloqueGestionado,
  VERSION_CONTEXTO_FIJO,
} from "@cauce/protocol";

/**
 * Gestión del sello de contexto fijo para deduplicar las instrucciones invariantes
 * sembradas en los archivos de configuración del arnés.
 */

export interface SelloDeContextoFijo {
  /** `VERSION_CONTEXTO_FIJO` con el que se escribió el fichero. */
  readonly version: string;
  /** sha256 en hexadecimal del texto fijo, tal cual quedó escrito en el fichero del arnés. */
  readonly sha256: string;
}

/**
 * Genera el hash sha256 del texto fijo para verificación de integridad.
 */
export function resumirContextoFijo(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex");
}

/**
 * Comprueba si el sello coincide exactamente con la versión y contenido del texto fijo esperado.
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
 * Diagnóstico del motivo por el cual se reenvió el texto fijo.
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
 * Mensaje sustitutivo cuando el contexto fijo ya se encuentra cargado en el arnés.
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
 * Resuelve la ruta al archivo de instrucciones del arnés según las variables de entorno locales.
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
 * Las marcas y la fusión se MUDARON a `@cauce/protocol/marcas-de-bloque.ts`.
 *
 * Motivo: la consola tiene que enseñar EXACTAMENTE el fichero que va a quedar en el disco —con lo
 * humano intacto alrededor— y el gateway no puede importar este paquete. Lo que queda acá es lo
 * que de verdad necesita el contenedor: el sello (`node:crypto`) y la siembra (el disco).
 *
 * Se re-exportan para que nada de lo que ya las importaba desde aquí tenga que cambiar de sitio.
 */
export {
  bloqueEntreMarcas, bloqueGestionado, conBloqueEntreMarcas, conBloqueGestionado,
  MARCA_FIN, MARCA_INICIO, VERSION_CONTEXTO_FIJO,
} from "@cauce/protocol";

/**
 * Extrae el sello de un contenido que puede contener un bloque gestionado.
 */
export function extraerSello(contenido: string): SelloDeContextoFijo | undefined {
  const bloque = leerBloqueGestionado(contenido);
  if (bloque === undefined) return undefined;
  return { version: VERSION_CONTEXTO_FIJO, sha256: resumirContextoFijo(bloque) };
}

/**
 * Lee el sello del fichero de instrucciones directamente desde el disco local.
 * Si el fichero está ausente o no se puede leer, devuelve `undefined`.
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

/** Por qué NO se sembró el fichero. Va al registro; el turno sigue igual. */
export type MotivoDeNoSembrar =
  | "sembrado"
  | "apagado"
  | "sin-ruta"
  | "ya-estaba"
  | "ocupado-por-otro-alias"
  | "no-se-pudo-escribir";

/**
 * Inserta o actualiza el bloque gestionado con el texto fijo en el fichero del arnés.
 * Si el bloque existente pertenece a otro alias que comparte directorio, devuelve `ocupado-por-otro-alias`.
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
    // Que no exista es normal la primera vez: se siembra sobre un fichero vacío.
    original = "";
  }

  const actual = leerBloqueGestionado(original);
  if (actual === textoFijo) return "ya-estaba";
  if (actual !== undefined && actual !== textoFijo) {
    /*
     * Hay un bloque y dice otra cosa. Son dos casos y desde aquí no se distinguen: o el contrato
     * cambió (y hay que reescribirlo), o el fichero es de otro alias que comparte `$HOME` (y
     * reescribirlo sería empezar una guerra de escrituras). Ante la duda no se pisa, porque el
     * daño de las dos opciones no es simétrico: reescribir de más deja a dos alias sin identidad
     * estable; reescribir de menos sólo cuesta un sobre entero por turno, que es lo de hoy.
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
