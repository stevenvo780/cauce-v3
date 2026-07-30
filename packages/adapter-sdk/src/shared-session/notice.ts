import type { StructuredOutput } from "../sdk/types.js";
import type { SharedSessionDegradation, SharedSessionHarness } from "./types.js";

/**
 * Marca literal del aviso. Es la cadena que el dueño puede buscar en Telegram y la que afirman
 * los tests: si algún día deja de aparecer, la caída volvió a ser silenciosa.
 */
export const DEGRADED_MARK = "⚠ CAUCE — SESIÓN COMPARTIDA CAÍDA";

/** Marca del aviso de contexto perdido. La sesión funcionó; la memoria no. */
export const RESET_MARK = "⚠ CAUCE — LA TERMINAL SE REINICIÓ";

const REASON_TEXT: Readonly<Record<SharedSessionDegradation["reason"], string>> = {
  session_absent: "no hay sesión compartida abierta para este alias",
  tui_absent: "la sesión existe pero no hay una TUI viva adentro",
  input_busy: "la caja de entrada quedó ocupada con texto a medio escribir",
  handshake_failed: "el mecanismo de sesión compartida no respondió",
  context_reset: "la TUI se reinició y la conversación empezó de cero",
};

/**
 * El aviso que el dueño lee dentro de la respuesta que le llega por Telegram.
 *
 * Dice las tres cosas que necesita para decidir: qué pasó, qué consecuencia tuvo (este turno NO
 * comparte contexto con lo que él ve en su terminal) y qué hacer.
 *
 * Lo redacta el adaptador DESPUÉS de validar el sobre, nunca el modelo. Esa es la diferencia que
 * importa: ya se demostró que un agente puede falsificar cualquier señal que venga de su stdout,
 * así que un aviso que el propio harness pudiera escribir no probaría nada.
 */
export function degradationNotice(
  alias: string,
  harness: SharedSessionHarness,
  degradation: SharedSessionDegradation,
): string {
  const mecanismo = harness === "claude" ? "tmux + transcript" : "app-server de codex";
  if (!degradation.fellBack) {
    return [
      RESET_MARK,
      `La terminal de ${alias} se reinició: ${REASON_TEXT[degradation.reason]}`
        + ` (${degradation.reason}). Detalle: ${degradation.detail}`,
      "Este turno SÍ pasó por la terminal, pero lo anterior a este reinicio ya no está"
        + " en su conversación.",
    ].join("\n");
  }
  return [
    DEGRADED_MARK,
    `Este turno NO pasó por la terminal de ${alias}: ${REASON_TEXT[degradation.reason]}`
      + ` (${degradation.reason}). Detalle: ${degradation.detail}`,
    "Se respondió por el camino de siempre, así que este intercambio NO aparece en el panel"
      + " del dueño y el agente no lo verá en la conversación de la terminal.",
    `Para restablecerlo: abrí \`cauce ${alias}\` (mecanismo: ${mecanismo}).`,
  ].join("\n");
}

/**
 * Pega el aviso delante del "reply" ya validado.
 *
 * Se aplica DESPUÉS de `validateDeliveryOutput` a propósito: el contrato del bus se valida sobre
 * lo que produjo el harness, sin ninguna concesión, y sólo entonces el adaptador añade su propia
 * nota. Así el aviso no puede volver válido un sobre inválido.
 *
 * Cuando el harness devolvió `reply: null` —admisible sólo si delegó todo— el aviso PASA A SER el
 * reply. Es deliberado: el remitente tiene que enterarse igual, y un reply no vacío junto a
 * `messages` no vacío es una combinación que el contrato ya admite.
 */
export function annotateDegraded(output: StructuredOutput, notice: string): StructuredOutput {
  const body = output.reply === null || output.reply.trim().length === 0
    ? notice
    : `${notice}\n\n${output.reply}`;
  return { ...output, reply: body };
}
