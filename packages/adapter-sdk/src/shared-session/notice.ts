import type { StructuredOutput } from "../sdk/types.js";
import type { SharedSessionDegradation, SharedSessionHarness } from "./types.js";

/** Marca literal de aviso de degradación de la sesión compartida. */
export const DEGRADED_MARK = "⚠ CAUCE — SESIÓN COMPARTIDA CAÍDA";

/** Marca del aviso de contexto perdido. La sesión funcionó; la memoria no. */
export const RESET_MARK = "⚠ CAUCE — LA TERMINAL SE REINICIÓ";

/** Marca de aviso de contexto modificado o compactado en la terminal. */
export const CONTEXT_MARK = "⚠ CAUCE — EL CONTEXTO DE LA TERMINAL CAMBIÓ";

/** Marca de aviso para turnos fusionados con una ejecución concurrente en la terminal. */
export const MERGED_MARK = "⚠ CAUCE — EL TURNO SE FUNDIÓ CON OTRO EN CURSO";

const REASON_TEXT: Readonly<Record<SharedSessionDegradation["reason"], string>> = {
  session_absent: "no hay sesión compartida abierta para este alias",
  tui_absent: "la sesión existe pero no hay una TUI viva adentro",
  session_alias_mismatch: "la sesión tmux declara un alias distinto",
  session_harness_mismatch: "la sesión tmux pertenece a otro harness",
  session_identity_unverified: "la identidad alias+harness de la sesión no pudo acreditarse",
  input_busy: "la caja de entrada quedó ocupada con texto a medio escribir",
  modal_blocking: "la TUI está esperando que el dueño conteste un diálogo",
  handshake_failed: "el mecanismo de sesión compartida no respondió",
  context_reset: "la TUI se reinició y la conversación empezó de cero",
  session_created: "no había terminal abierta y se creó una nueva, vacía, para este turno",
  context_cleared: "el dueño vació el contexto de la terminal (/clear en claude, /new en codex)",
  context_compacted: "la terminal compactó su contexto: lo anterior quedó resumido, no íntegro",
  turn_merged: "el panel estaba ocupado y la terminal fundió este pedido con el turno en curso",
};

/** Mensajes explicativos según el tipo de cambio de contexto en la terminal. */
const CONTEXT_NOTICE: Readonly<Record<string, { readonly mark: string; readonly consequence: string }>> = {
  context_reset: {
    mark: RESET_MARK,
    consequence: "Este turno SÍ pasó por la terminal, pero lo anterior a este reinicio ya no está"
      + " en su conversación.",
  },
  session_created: {
    mark: RESET_MARK,
    consequence: "Este turno SÍ pasó por una terminal real, pero por una RECIÉN CREADA y vacía:"
      + " la conversación anterior no está, y el dueño no tenía ese panel abierto.",
  },
  context_cleared: {
    mark: CONTEXT_MARK,
    consequence: "Este turno SÍ pasó por la terminal y el dueño lo vio, pero empezó SIN la"
      + " conversación anterior: lo dicho antes de ese vaciado ya no cuenta.",
  },
  context_compacted: {
    mark: CONTEXT_MARK,
    consequence: "Este turno SÍ pasó por la terminal, pero lo anterior quedó RESUMIDO y no"
      + " íntegro: si algo importante se perdió, hay que volver a decirlo.",
  },
  turn_merged: {
    mark: MERGED_MARK,
    consequence: "Este turno SÍ pasó por la terminal y se ejecutó entero, pero NO abrió un turno"
      + " propio: la terminal estaba ocupada y lo fundió con lo que ya estaba haciendo, así que esta"
      + " respuesta puede contestar a la vez lo que pidió el dueño y lo que pidió el bus.",
  },
};

/** Genera el aviso de degradación o cambio de contexto para incluir en la respuesta. */
export function degradationNotice(
  alias: string,
  harness: SharedSessionHarness,
  degradation: SharedSessionDegradation,
): string {
  const mecanismo = `tmux + registro de ${harness}`;
  if (!degradation.fellBack) {
    const context = CONTEXT_NOTICE[degradation.reason] ?? CONTEXT_NOTICE.context_reset!;
    return [
      context.mark,
      `La memoria de la terminal de ${alias} cambió: ${REASON_TEXT[degradation.reason]}`
        + ` (${degradation.reason}). Detalle: ${degradation.detail}`,
      context.consequence,
    ].join("\n");
  }
  const identityFailure = degradation.reason === "session_alias_mismatch"
    || degradation.reason === "session_harness_mismatch"
    || degradation.reason === "session_identity_unverified";
  const remedio = degradation.reason === "modal_blocking"
    ? `Para restablecerlo: contestá el diálogo abierto en el panel de \`cauce ${alias}\``
      + ` (mecanismo: ${mecanismo}).`
    : identityFailure
      ? `Para restablecerlo: revisá y drená/archivá la sesión incompatible de \`cauce ${alias}\``
        + ` antes de crear la correcta; el adaptador la conservó intacta (mecanismo: ${mecanismo}).`
      : `Para restablecerlo: abrí \`cauce ${alias}\` (mecanismo: ${mecanismo}).`;
  return [
    DEGRADED_MARK,
    `Este turno NO pasó por la terminal de ${alias}: ${REASON_TEXT[degradation.reason]}`
      + ` (${degradation.reason}). Detalle: ${degradation.detail}`,
    "Se respondió por el camino de siempre, así que este intercambio NO aparece en el panel"
      + " del dueño y el agente no lo verá en la conversación de la terminal.",
    remedio,
  ].join("\n");
}

/** Antepone el aviso de degradación o advertencia al campo reply de la salida estructurada. */
export function annotateDegraded(output: StructuredOutput, notice: string): StructuredOutput {
  const body = output.reply === null || output.reply.trim().length === 0
    ? notice
    : `${notice}\n\n${output.reply}`;
  return { ...output, reply: body };
}
