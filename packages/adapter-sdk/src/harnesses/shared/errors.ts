import { AdapterError, ProcessExecutionError } from "../../sdk/errors.js";
import type { CommandRunResult } from "../../sdk/types.js";
import { HARNESS_START_MARKER } from "../../sdk/types.js";

export function esInterrupcionDelDuenio(detalle: string | undefined): boolean {
  if (detalle === undefined || detalle === "") return false;
  return /interrup|interrupt|aborted by user|turn_aborted|cancell?ed by user/i.test(detalle);
}

export function esDiagnosticoDeArranque(detalle: string | undefined): boolean {
  if (detalle === undefined || detalle === "") return false;
  return [
    // Error en configuración inicial
    /error loading config\.toml/i,
    /unknown variant `/i,
    // Error en resolución o reanudación de sesión
    /thread\/resume[^\n]*fail/i,
    /no rollout found/i,
    /session id[^\n]*already in use/i,
    /no conversation found with session id/i,
    // Binario ausente o argumentos inválidos
    /\bcommand not found\b/i,
    /spawn[^\n]*\bENOENT\b/i,
    /\b(?:unexpected argument|unrecognized (?:option|argument))\b/i,
    // Fallo de inicialización de puente stdin
    /stdin bridge failed[^\n]*(?:modules|import|cannot find)/i,
  ].some((patron) => patron.test(detalle));
}

/**
 * Determina con certeza si el proceso del arnés falló antes de iniciar la ejecución del turno.
 */
export function nuncaEmpezoElTurno(result: CommandRunResult, detalle: string | undefined): boolean {
  if (result.stdout.length > 0) return false;
  if (result.timedOut || result.cancelled) return false;
  if (result.signal !== null || result.exitCode === null) return false;
  return result.harnessStarted === false || esDiagnosticoDeArranque(detalle);
}

/**
 * Verifica si el testigo del transporte confirma que la ejecución del arnés no llegó a iniciarse.
 */
export function elTestigoDiceQueNoEmpezo(result: CommandRunResult): boolean {
  return result.stdout.length === 0 && result.harnessStarted === false;
}

/**
 * ¿Este aborto es el apagado del adaptador?
 *
 * `AdapterEngine.stop()` aborta con `AdapterError("SHUTDOWN", …, true)`: el motivo viaja en el
 * `reason` del `AbortSignal` y ahí sigue estando cuando el transporte lo recoge. Reiniciar un
 * adaptador es un fallo de INFRAESTRUCTURA, no un veredicto sobre el trabajo.
 */
export function abortadoPorApagado(signal: AbortSignal): boolean {
  const reason: unknown = signal.reason;
  return reason instanceof AdapterError && reason.code === "SHUTDOWN" && reason.retryable;
}

/**
 * Quita la marca de arranque del stderr antes de que se convierta en causa visible.
 *
 * La marca es protocolo interno entre el puente y el runner; el operador que lee `last_error`
 * no tiene por qué verla, y peor: contaría como texto útil y desplazaría la causa real dentro
 * del presupuesto de caracteres.
 */
export function sinMarcaDeArranque(stderr: string): string {
  if (!stderr.includes(HARNESS_START_MARKER)) return stderr;
  return stderr
    .split(/\r?\n/u)
    .filter((linea) => linea.trim() !== HARNESS_START_MARKER)
    .join("\n");
}

export function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof AdapterError) return signal.reason;
  const detail = describeAbortReason(signal);
  return new ProcessExecutionError(
    "CANCELLED",
    detail === ""
      ? "Harness execution was cancelled"
      : `Harness execution was cancelled (${detail})`,
    false,
  );
}

/**
 * Describe el motivo por el cual la ejecución fue abortada, para su inclusión en logs y diagnóstico.
 */
function describeAbortReason(signal: AbortSignal): string {
  if (!signal.aborted) return "";
  const reason: unknown = signal.reason;
  if (reason === undefined || reason === null) return "";
  const raw = reason instanceof AdapterError
    ? `${reason.code}: ${reason.message}`
    : reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : typeof reason === "string"
        ? reason
        : "";
  return sanitizeProcessOutput(raw, ABORT_REASON_DETAIL_BUDGET);
}

export function cancellationMessage(signal: AbortSignal): string {
  const detail = describeAbortReason(signal);
  return detail === ""
    ? "Harness transport was cancelled after dispatch; completion state is unknown and requires manual replay"
    : `Harness transport was cancelled after dispatch (${detail}); completion state is unknown and requires manual replay`;
}

export function executionError(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  return new AdapterError("EXECUTION_FAILED", "Harness execution failed", true);
}

/**
 * Presupuesto de bytes de stderr a conservar para el detalle de error del arnés.
 */
const STDERR_DETAIL_BUDGET = 1_200;

/** Los motivos de aborto los redacta el SDK y son de una línea; no necesitan el presupuesto grande. */
const ABORT_REASON_DETAIL_BUDGET = 300;

/**
 * Qué fracción del presupuesto se gasta en el principio del texto. El resto va al final.
 *
 * No es simetría por gusto: en un stderr largo el principio trae el encabezado del error y el
 * FINAL trae la causa raíz —la última línea de un stack, el "caused by", el hint del parser—.
 * Recortar sólo por la cabeza tira sistemáticamente la mitad que sirve.
 */
const STDERR_HEAD_SHARE = 0.6;

/**
 * Sanitize process output by removing secret-like patterns and truncating.
 *
 * La redacción corre ANTES del recorte. Eso NO es suficiente por sí solo: subir el presupuesto
 * de 100 a 1200 bytes y además emitir la COLA —donde caen los volcados de entorno y de config—
 * amplía mucho lo que puede escaparse, y `last_error` termina en la base, que leen los agentes.
 * Por eso los patrones de abajo cubren las cuatro formas que la versión anterior dejaba pasar:
 *
 *   1. `ANTHROPIC_API_KEY=…`  — un `\b` delante de `api_key` no ancla, porque `_` es carácter
 *      de palabra y no hay frontera dentro de `ANTHROPIC_API_KEY`. Se admite prefijo de palabra.
 *   2. `Authorization: Bearer sk-…` — `[^\s]+` se comía `Bearer` y dejaba el token en claro.
 *      Se consume el esquema (Bearer/Basic/Token) antes del valor.
 *   3. `postgres://usuario:clave@host` — no había ningún patrón para credenciales en URL.
 *   4. `{"api_key":"…"}` — la comilla entre la clave y los dos puntos rompía el patrón.
 *
 * Y como red final, se redactan los prefijos de credencial conocidos aunque aparezcan sueltos,
 * sin clave que los nombre.
 */
export function sanitizeProcessOutput(stderr: string, maxLengthBytes: number = STDERR_DETAIL_BUDGET): string {
  if (!stderr || stderr.trim().length === 0) return "";

  const KEYWORD = String.raw`(?:api[_-]?key|api[_-]?secret|client[_-]?secret|secret|password|passwd|pwd|token|bearer|authorization|x-api-key|aws_access_key_id|aws_secret_access_key|(?:oauth|refresh|access|id)[_-]?token)`;
  // Prefijo de palabra opcional (ANTHROPIC_, GITHUB_, …) y comillas opcionales alrededor de la clave.
  const KEY = String.raw`[\w.-]*${KEYWORD}["']?`;
  // Esquema HTTP opcional delante del valor, para no perderlo dentro de `Bearer <token>`.
  const SCHEME = String.raw`(?:\s*(?:Bearer|Basic|Token|Digest))?`;

  const sanitized = stderr
    // clave = valor  ·  "clave": "valor"  ·  Authorization: Bearer <token>
    .replace(new RegExp(String.raw`${KEY}\s*[:=]${SCHEME}\s*["']?[^\s"',;}\]]+`, "gi"), "[REDACTED]")
    // credenciales embebidas en URL: esquema://usuario:clave@host
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@]+@/gi, "$1:[REDACTED]@")
    // prefijos de credencial conocidos, aunque no los nombre ninguna clave
    .replace(/\b(?:sk-ant-|sk-proj-|sk-|ghp_|gho_|ghs_|ghu_|github_pat_|napi_|xox[baprs]-|AIza|glpat-)[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
    // JWT suelto (tres segmentos base64url separados por puntos)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    // clave privada PEM: se colapsa el cuerpo entero
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]")
    .trim();

  return clampPreservingTail(sanitized, maxLengthBytes);
}

/**
 * Recorte "primeros N … [k omitidos] … últimos M", que conserva las dos puntas del texto.
 *
 * El marcador se dimensiona con `text.length` —cota superior de los dígitos que puede tener
 * el conteo real de omitidos—, así que el marcador definitivo nunca es más largo que el
 * provisional y el resultado jamás excede `maxLengthBytes`.
 */
function clampPreservingTail(text: string, maxLengthBytes: number): string {
  if (text.length <= maxLengthBytes) return text;

  const provisionalMarker = truncationMarker(text.length);
  const available = Math.max(2, maxLengthBytes - provisionalMarker.length);
  const headLength = Math.max(1, Math.floor(available * STDERR_HEAD_SHARE));
  const tailLength = Math.max(1, available - headLength);
  const omitted = text.length - headLength - tailLength;
  if (omitted <= 0) return text;

  return text.slice(0, headLength)
    + truncationMarker(omitted)
    + text.slice(text.length - tailLength);
}

function truncationMarker(omitted: number): string {
  return `\n… [${omitted} caracteres omitidos] …\n`;
}
