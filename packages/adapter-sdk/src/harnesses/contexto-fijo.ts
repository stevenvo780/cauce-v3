import { createHash } from "node:crypto";

/**
 * EL SELLO DEL CONTEXTO FIJO.
 *
 * ── El problema, medido el 2026-08-24 ────────────────────────────────────────────────────────
 *
 * Cada entrega arrastra el mismo texto fijo: identidad, DEBER PRIMARIO, contrato de salida, las
 * invariantes de protocolo y las mecánicas de delegación. Llamando a `protocolPrompt()` de verdad:
 * 7.694 caracteres en esta rama y 9.210 en el build desplegado, contra 62 de pedido real. 161 a 1.
 *
 * Ese texto NO cambia entre un turno y el siguiente. Cambia cuando cambia el código o el perfil
 * del alias, y nada más. Su sitio es el fichero del arnés —`~/.claude/CLAUDE.md`,
 * `~/.codex/AGENTS.md`, el campo `agents` de `openclaw.json`—, que el modelo ya carga solo.
 *
 * ── Por qué hace falta un SELLO y no basta con «lo movimos» ──────────────────────────────────
 *
 * Si el adaptador deja de mandar lo fijo dando por sentado que el fichero está sembrado, el día
 * que el fichero no esté —contenedor recreado, alias nuevo, siembra a medias, arnés sin fichero
 * como hermes— el agente se queda SIN CONTRATO y no lo dice nadie: contesta mal y parece que el
 * modelo se volvió tonto. Es exactamente la clase de fallo que esta flota ya conoce: no da error,
 * da un comportamiento raro que cuesta días adjudicar.
 *
 * El sello convierte esa suposición en una comprobación. El que mide el fichero DENTRO del
 * contenedor calcula el resumen del bloque gestionado y lo manda en el sobre. El adaptador
 * calcula el resumen del texto que ÉL habría emitido. Si coinciden, el fichero ya lo dice y no se
 * repite. Si no coinciden —o no hay sello— se emite todo, como hoy.
 *
 * **Falla del lado seguro por construcción**: la ausencia de información produce el comportamiento
 * de siempre, nunca el recorte. Un sello no se puede fabricar por accidente: es el resumen del
 * texto exacto.
 */

/** Versión del contrato del bloque gestionado. Cambiarla invalida todos los sellos a la vez. */
export const VERSION_CONTEXTO_FIJO = "1";

export interface SelloDeContextoFijo {
  /** `VERSION_CONTEXTO_FIJO` con el que se escribió el fichero. */
  readonly version: string;
  /** sha256 en hexadecimal del texto fijo, tal cual quedó escrito en el fichero del arnés. */
  readonly sha256: string;
}

/**
 * El resumen del texto fijo. Es sha256 y no un contador de longitud a propósito: dos textos
 * distintos del mismo largo son un caso real —una regla cambiada palabra por palabra— y darían
 * por bueno un fichero que dice otra cosa.
 */
export function resumirContextoFijo(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex");
}

/**
 * ¿El fichero del arnés ya lleva EXACTAMENTE este texto fijo?
 *
 * Las tres respuestas negativas son deliberadamente indistinguibles para quien llama: sin sello,
 * con versión vieja o con resumen distinto, la respuesta es la misma —«mandalo entero»—. Quien
 * quiera saber POR QUÉ tiene `motivoDeReenvio()`, que es para el diagnóstico y no para decidir.
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
 * Por qué se reenvió el texto fijo. Va al registro del adaptador, NO a la decisión: separar el
 * diagnóstico de la decisión es lo que evita que alguien, mañana, trate «version-distinta» como
 * un caso tolerable y recorte igual.
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
 * El renglón que sustituye al bloque fijo cuando el fichero ya lo dice.
 *
 * No se queda en silencio, y esto es una decisión. Un modelo que abre un turno sin ninguna
 * referencia a su contrato puede razonablemente concluir que no lo tiene; una línea que le dice
 * dónde está cuesta 120 caracteres contra 7.694 y quita esa duda. Además deja una marca
 * buscable en los transcripts para poder auditar, después, si el recorte estuvo activo.
 */
export function renglonDeContextoFijo(): string {
  return (
    "Tu contrato de identidad, deber y protocolo NO se repite en esta entrega: ya está cargado " +
    `desde el fichero de instrucciones de tu arnés (contexto Cauce v${VERSION_CONTEXTO_FIJO}). ` +
    "Rige igual. Si no lo tenés delante, decilo en tu \"reply\" y seguí con lo que puedas."
  );
}
