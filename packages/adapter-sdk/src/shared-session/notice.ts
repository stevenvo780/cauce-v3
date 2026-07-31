import type { StructuredOutput } from "../sdk/types.js";
import type { SharedSessionDegradation, SharedSessionHarness } from "./types.js";

/**
 * Marca literal del aviso. Es la cadena que el dueño puede buscar en Telegram y la que afirman
 * los tests: si algún día deja de aparecer, la caída volvió a ser silenciosa.
 */
export const DEGRADED_MARK = "⚠ CAUCE — SESIÓN COMPARTIDA CAÍDA";

/** Marca del aviso de contexto perdido. La sesión funcionó; la memoria no. */
export const RESET_MARK = "⚠ CAUCE — LA TERMINAL SE REINICIÓ";

/**
 * Marca del aviso de contexto CAMBIADO: el turno pasó por la terminal de siempre, pero su memoria
 * ya no es la que el remitente cree. Es distinta de `RESET_MARK` porque la terminal NO se reinició:
 * sigue siendo la misma, con el mismo proceso, y aun así lo anterior se vació (`/clear`, `/new`) o
 * quedó resumido (compactación).
 */
export const CONTEXT_MARK = "⚠ CAUCE — EL CONTEXTO DE LA TERMINAL CAMBIÓ";

const REASON_TEXT: Readonly<Record<SharedSessionDegradation["reason"], string>> = {
  session_absent: "no hay sesión compartida abierta para este alias",
  tui_absent: "la sesión existe pero no hay una TUI viva adentro",
  input_busy: "la caja de entrada quedó ocupada con texto a medio escribir",
  modal_blocking: "la TUI está esperando que el dueño conteste un diálogo",
  handshake_failed: "el mecanismo de sesión compartida no respondió",
  context_reset: "la TUI se reinició y la conversación empezó de cero",
  session_created: "no había terminal abierta y se creó una nueva, vacía, para este turno",
  context_cleared: "el dueño vació el contexto de la terminal (/clear en claude, /new en codex)",
  context_compacted: "la terminal compactó su contexto: lo anterior quedó resumido, no íntegro",
};

/**
 * Qué se le dice al remitente cuando el turno SÍ pasó por la terminal pero la memoria cambió.
 *
 * Cada suceso lleva su propia consecuencia porque son acciones distintas: un reinicio no se
 * arregla, un `/clear` fue deliberado y una compactación se compensa volviendo a pegar lo
 * importante. Un texto único los confundiría, que es justo lo que hoy pasa.
 */
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
  // El mecanismo es el MISMO para los dos harness: pegar en la caja de la TUI y cosechar del
  // registro que ella escribe. Se nombra igual porque el remedio también es el mismo.
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
  const remedio = degradation.reason === "modal_blocking"
    ? `Para restablecerlo: contestá el diálogo abierto en el panel de \`cauce ${alias}\``
      + ` (mecanismo: ${mecanismo}).`
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
