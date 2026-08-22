import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { OutputArtifact, StructuredOutput } from "./types.js";

/**
 * Convierte los adjuntos LOCALES del agente en `data:` antes de que el turno salga al bus.
 *
 * QUÉ ESTABA ROTO, medido sobre el outbox de producción el 2026-08-22: de los 12 artifacts
 * salientes de los últimos 7 días, CERO viajaban como `data:`. Los 12 eran `file://` o rutas
 * absolutas sueltas —`/home/claw/clawd/_tmp_hoja_ruta/hoja_ruta_domiciliario.png`,
 * `file:///workspace/entregables/isa/...`—, y los 12 tenían `status = sent`: el sistema declaraba
 * enviado algo que nunca viajó. Miguel, que no es técnico, lo dijo así: «cuando le pido un archivo
 * o un pantallazo me envía es un dato adjunto pero no lo logro ver». Lo que recibía, literal, era
 * «• hoja_ruta_domiciliario.png: quedó en el espacio de trabajo del agente y no viajó al chat».
 *
 * POR QUÉ SE ARREGLA ACÁ Y NO EN EL PUENTE. `services/telegram-bridge/src/artifacts.ts` NO está
 * roto: se niega a dereferenciar rutas locales a propósito, y ese comentario explica el modelo de
 * amenaza entero. El puente corre en agora-storage, al lado de Postgres; si resolviera contra su
 * propio disco el `file://` que escribió un agente, un `file:///run/secrets/database_url` —que en
 * el puente SÍ existe— subiría la contraseña de producción a un chat.
 *
 * El adapter-SDK corre DENTRO del contenedor del agente, como el usuario del agente. Acá el
 * fichero sí existe, y leerlo no cruza ninguna frontera de confianza: el adaptador sólo puede leer
 * lo que el agente ya podía leer, y de hecho ya podía ponerlo él mismo en un `data:`. Convertirlo
 * acá arregla a TODOS los agentes y TODOS los tenants de una vez, sin que ningún agente tenga que
 * aprender nada nuevo, y sin reabrir la puerta que el puente cerró.
 *
 * ------------------------------------------------------------------------------------------
 * POR QUÉ NO ESTÁ EN `parseArtifacts` (output-parser.ts), que es donde uno lo buscaría primero:
 *
 * 1. El parser es PURO y síncrono, y se llama sobre CANDIDATOS que muchas veces se descartan:
 *    `safeCandidate` prueba varias formas del stdout y se queda con una, `recoverEmbeddedEnvelope`
 *    rescata sobres incrustados en texto, y los dialectos parsean cada evento del harness. Meter
 *    E/S de disco ahí significaría abrir ficheros para sobres que nunca llegan a ser la respuesta,
 *    varias veces por turno.
 * 2. Volverlo `async` contagiaría a `parse(stdout)` de cada `HarnessDefinition` y a toda la cadena
 *    de dialectos, que hoy es síncrona y está probada como función pura.
 * 3. El parser valida FORMA; el disco es ESTADO. Un artifact vale o no vale con independencia de
 *    si el fichero existía en ese milisegundo.
 *
 * Va, en cambio, en el único punto donde el turno se convierte en ACK: `AdapterEngine`, una sola
 * vez, sobre el `output` ya validado que va a viajar. Ahí se ejecuta exactamente una vez por
 * entrega y sobre el sobre que de verdad sale.
 * ------------------------------------------------------------------------------------------
 *
 * INVARIANTE: NADA de este módulo puede tirar, y ningún fallo de lectura puede costar el turno. Un
 * artifact que no se puede leer, o que no se puede leer con seguridad, se deja EXACTAMENTE como
 * estaba —el humano seguirá viendo «quedó en el espacio de trabajo del agente»— y la respuesta del
 * agente, que es el trabajo, sale igual. Ya nos pasó al revés: un adjunto inválido envenenó la cola
 * de un alias.
 */

/**
 * Tope por adjunto. Simétrico con `MAX_EGRESS_ATTACHMENT_BYTES` del puente y con
 * `MAX_ATTACHMENT_BYTES` del protocolo (ingesta). Pasarse no es un error: el adjunto se deja como
 * estaba.
 */
export const MAX_INLINED_ARTIFACT_BYTES = 10_000_000;

/** Simétrico con `MAX_UPLOADS_PER_RELAY` del puente y `MAX_ATTACHMENTS_PER_MESSAGE` del protocolo. */
export const MAX_INLINED_ARTIFACTS_PER_RESPONSE = 4;

/**
 * Tope agregado por respuesta, simétrico con `MAX_ATTACHMENTS_TOTAL_BYTES` de la ingesta. Cuatro
 * adjuntos de 10 MB serían un ACK de ~53 MB de base64 atravesando gateway, Postgres y outbox por
 * un turno; el techo agregado mantiene el sobre en el mismo orden de magnitud que un mensaje
 * entrante con adjuntos, que es el caso que la infraestructura ya soporta medido.
 */
export const MAX_INLINED_TOTAL_BYTES = 10_000_000;

/**
 * Cuántas rutas se intentan abrir como mucho. El parser no acota el largo de `artifacts`, y un
 * turno no puede convertirse en cientos de syscalls por una lista inventada.
 */
const MAX_LOOKUPS = 16;

/** Cota del base64 resultante: el mismo cálculo que hace el puente antes de decodificar. */
const MAX_BASE64_CHARACTERS = Math.ceil(MAX_INLINED_ARTIFACT_BYTES / 3) * 4 + 64;

/**
 * Nada de `/proc`, `/sys` ni `/dev`. Son ficheros «regulares» que no son ficheros: `/proc/self/…`
 * declara tamaño 0 y devuelve el estado del propio adaptador, y un dispositivo puede no terminar
 * nunca. El agente nunca quiere adjuntar eso.
 */
const FORBIDDEN_ROOTS: readonly string[] = ["/proc/", "/sys/", "/dev/"];

/**
 * Deducción de tipo por extensión: lista corta y explícita, espejo de la tabla del puente. Ante la
 * duda, `application/octet-stream`; NUNCA se adivina leyendo el contenido, eso lo hace el puente
 * con firmas reales para decidir foto vs documento.
 */
const MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".webp", "image/webp"], [".gif", "image/gif"], [".svg", "image/svg+xml"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain"], [".log", "text/plain"], [".md", "text/markdown"],
  [".csv", "text/csv"], [".html", "text/html"], [".json", "application/json"],
  [".yaml", "text/plain"], [".yml", "text/plain"],
  [".zip", "application/zip"], [".gz", "application/gzip"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".mp4", "video/mp4"], [".mp3", "audio/mpeg"], [".ogg", "audio/ogg"],
]);

/** `tipo/subtipo` con los caracteres que RFC 2045 permite en un token. Nada de `,`, `;` ni espacios. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/iu;

const HEX_SHA256 = /^[0-9a-f]{64}$/u;

/** Cualquier esquema: `data:`, `https:`, `git:`, `s3:`… Sólo `file:` se dereferencia. */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/u;

/**
 * Ruta local aceptable, ya decodificada.
 *
 * Sólo absolutas y sin ningún segmento `..`: una ruta relativa depende del cwd del adaptador (que
 * no es el del agente) y un `..` convierte una ruta que parece acotada en cualquier otra.
 */
function acceptablePath(path: string): string | undefined {
  if (path.length === 0 || path.length > 4096) return undefined;
  if (!isAbsolute(path) || path.includes("\0")) return undefined;
  if (path.split("/").includes("..")) return undefined;
  if (FORBIDDEN_ROOTS.some((root) => path.startsWith(root))) return undefined;
  return path;
}

/** ¿Algún segmento del URI crudo es `..`, con o sin percent-encoding (`%2e%2e`, `.%2E`)? */
function traverses(uri: string): boolean {
  return uri.split(/[/?#]/u).some((segment) => segment.replace(/%2e/giu, ".") === "..");
}

/**
 * Traduce el `uri` de un artifact a una ruta local, o `undefined` si no hay que tocarlo.
 *
 * `file://host/...` con host ajeno se rechaza: sería un recurso de otra máquina, no del agente.
 */
export function localArtifactPath(uri: string): string | undefined {
  const trimmed = uri.trim();
  if (trimmed.length === 0) return undefined;
  if (/^file:/iu.test(trimmed)) {
    // El `..` se busca en el URI CRUDO además de en la ruta final. `new URL()` normaliza los
    // segmentos y hace desaparecer el recorrido —`file:///w/%2e%2e/%2e%2e/etc/passwd` sale como
    // `/etc/passwd`—, así que mirar sólo el resultado daría por buena una ruta que intentó
    // escaparse. Un URI que intenta recorrer no se lee, punto.
    if (traverses(trimmed)) return undefined;
    try {
      const url = new URL(trimmed);
      const host = url.hostname.toLowerCase();
      if (host !== "" && host !== "localhost") return undefined;
      // `fileURLToPath` decodifica el percent-encoding; por eso el chequeo de `..` sobre la ruta
      // final se hace igual, después (un `%2e%2e` es un `..` con otro traje).
      return acceptablePath(fileURLToPath(url));
    } catch {
      return undefined;
    }
  }
  if (HAS_SCHEME.test(trimmed)) return undefined;
  return acceptablePath(trimmed);
}

/**
 * Lee un fichero REGULAR sin seguir el enlace simbólico final y sin quedarse colgado.
 *
 * - `O_NOFOLLOW`: un `artifacts[].uri` que apunte a un symlink a `/etc/passwd` falla acá. La
 *   validación va contra el descriptor ya abierto (`fstat`), no contra una ruta comprobada antes,
 *   para que no haya ventana entre el chequeo y el uso.
 * - `O_NONBLOCK`: abrir un FIFO en modo lectura bloquea hasta que aparezca un escritor. Sin esto,
 *   un adjunto podría colgar el turno entero, que es peor que no mandarlo.
 * - El tamaño se mira dos veces: en el `fstat` para no materializar un buffer absurdo, y sobre los
 *   bytes REALMENTE leídos, que son los que se van a codificar.
 */
async function readRegularFile(path: string): Promise<Buffer | undefined> {
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const nonBlock = "O_NONBLOCK" in fsConstants ? fsConstants.O_NONBLOCK : 0;
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow | nonBlock);
    const metadata = await handle.stat();
    if (!metadata.isFile()) return undefined;
    if (metadata.size <= 0 || metadata.size > MAX_INLINED_ARTIFACT_BYTES) return undefined;
    const bytes = await handle.readFile();
    if (bytes.length === 0 || bytes.length > MAX_INLINED_ARTIFACT_BYTES) return undefined;
    return bytes;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** El tipo que declaró el agente manda; si no declaró (o declaró basura), se deduce de la extensión. */
function mediaTypeFor(artifact: OutputArtifact, path: string): string {
  const declared = artifact.media_type?.trim() ?? "";
  if (MEDIA_TYPE.test(declared)) return declared;
  return MIME_BY_EXTENSION.get(extname(path).toLowerCase()) ?? "application/octet-stream";
}

/**
 * Convierte UN artifact. Devuelve `undefined` cuando hay que dejarlo como estaba, que es siempre la
 * respuesta segura.
 */
async function inlineArtifact(
  artifact: OutputArtifact,
  path: string,
): Promise<{ readonly artifact: OutputArtifact; readonly bytes: number } | undefined> {
  const bytes = await readRegularFile(path);
  if (bytes === undefined) return undefined;

  const digest = createHash("sha256").update(bytes).digest("hex");
  const declared = artifact.sha256?.trim().toLowerCase() ?? "";
  // Un sha declarado que no coincide con lo leído significa que el fichero cambió, o que el agente
  // se equivocó de fichero. Mandarlo igual sería decir que enviamos una cosa y enviar otra.
  if (declared !== "" && (!HEX_SHA256.test(declared) || declared !== digest)) return undefined;

  const base64 = bytes.toString("base64");
  // El límite se comprueba sobre el RESULTADO, no sobre el original: base64 crece ~33 %, y es el
  // resultado el que el puente vuelve a medir antes de subirlo.
  if (base64.length > MAX_BASE64_CHARACTERS) return undefined;

  const mediaType = mediaTypeFor(artifact, path);
  // Un nombre vacío haría que el puente subiera «adjunto.png». El fichero ya tiene nombre; que
  // Miguel reciba `hoja_ruta_domiciliario.png` es la mitad de lo que pidió.
  const name = artifact.name.trim().length > 0 ? artifact.name : basename(path);
  return {
    artifact: {
      name,
      uri: `data:${mediaType};base64,${base64}`,
      media_type: mediaType,
      sha256: digest,
    },
    bytes: bytes.length,
  };
}

/**
 * Reemplaza por `data:` los artifacts locales que se puedan leer con seguridad, y deja intacto todo
 * lo demás: los `data:` que ya venían hechos, los `http(s)://` (que el puente lista como enlace a
 * propósito, para no volverse un SSRF contra producción), lo que exceda los topes y lo que no se
 * pueda leer.
 *
 * Nunca tira. Devuelve el mismo objeto cuando no hubo nada que cambiar.
 */
export async function inlineLocalArtifacts(output: StructuredOutput): Promise<StructuredOutput> {
  try {
    if (output.artifacts.length === 0) return output;

    const artifacts: OutputArtifact[] = [];
    let remaining = MAX_INLINED_ARTIFACTS_PER_RESPONSE;
    let remainingBytes = MAX_INLINED_TOTAL_BYTES;
    let lookups = 0;
    let changed = false;

    for (const artifact of output.artifacts) {
      // Un `data:` que ya venía hecho no se toca, pero SÍ gasta cupo: el puente cuenta subidas, no
      // conversiones, y convertir un quinto adjunto que el puente va a descartar es trabajo tirado.
      if (/^data:/iu.test(artifact.uri.trim())) {
        remaining -= 1;
        artifacts.push(artifact);
        continue;
      }
      const path = remaining > 0 && lookups < MAX_LOOKUPS ? localArtifactPath(artifact.uri) : undefined;
      if (path === undefined) {
        artifacts.push(artifact);
        continue;
      }
      lookups += 1;
      const inlined = await inlineArtifact(artifact, path);
      // No se pudo (no existe, es un symlink, es un FIFO, no coincide el sha, pesa de más): queda
      // como estaba y el humano lee la línea del puente. El turno sale igual.
      if (inlined === undefined) {
        artifacts.push(artifact);
        continue;
      }
      // El techo agregado se mide en bytes del fichero, igual que `MAX_ATTACHMENTS_TOTAL_BYTES`.
      if (inlined.bytes > remainingBytes) {
        artifacts.push(artifact);
        continue;
      }
      remainingBytes -= inlined.bytes;
      remaining -= 1;
      changed = true;
      artifacts.push(inlined.artifact);
    }

    return changed ? { ...output, artifacts } : output;
  } catch {
    // Defensa en profundidad: la invariante es que un adjunto NUNCA cueste un turno.
    return output;
  }
}
