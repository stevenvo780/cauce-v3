import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

/**
 * Los adjuntos que el agente devuelve en `output.artifacts`, del lado del EGRESO.
 *
 * Qué estaba roto: el puente no tenía forma de mandar un archivo. `dist/telegram.js` sólo conocía
 * `sendMessage`, y `egress.js` nombraba `artifacts` una sola vez, en la lista de claves que
 * DESCARTA del sobre. Todo lo que un agente adjuntara desaparecía sin dejar rastro ni error.
 *
 * Lo que costó, medido:
 *   - Isa pidió un guion CINCO veces entre el 28 y el 29-jul. Los agentes lo produjeron y lo
 *     devolvieron como `artifacts[].uri = file:///workspace/clases/video/Guion-….docx`. El puente
 *     lo tiró; zeus terminó mandándoselo a mano.
 *   - Jhon, el 28-jul: "mandame las capturas", "pero quiero imagen jpg", "que pueda ver no en
 *     letras". Recibió rutas `file:///home/claw/…` que no puede abrir desde un teléfono.
 *   - De los 30 artifacts más recientes del outbox, 5 son enlaces `https://` (deploys de Vercel,
 *     ramas de GitHub) que tampoco llegaban: para el humano, sencillamente no existían.
 *
 * ------------------------------------------------------------------------------------------
 * LAS TRES CLASES DE URI, Y POR QUÉ SE TRATAN DISTINTO
 *
 * 1. `data:` con base64 → SE SUBEN LOS BYTES. Es el único canal por el que los bytes de un agente
 *    llegan de verdad hasta acá: `parseArtifacts` del adapter-SDK reconstruye cada artifact con
 *    exactamente cuatro claves (`name`, `uri`, `media_type`, `sha256`), así que cualquier campo
 *    extra que un harness inventara —`content_base64`, por ejemplo— se pierde antes del ACK. El
 *    `uri` es el único string que viaja literal de punta a punta.
 *
 * 2. `http(s)://` → SE LISTAN COMO ENLACE, no se descargan. El puente vive en agora-storage, al
 *    lado de Postgres, del gateway y del registry en 127.0.0.1:5000. Descargar una URL que escribió
 *    un agente convertiría este servicio en un SSRF contra la red de producción. Un enlace en el
 *    chat resuelve el caso real (los deploys de Vercel) sin abrir esa puerta.
 *
 * 3. `file://`, ruta absoluta suelta, `git:`… → SE LISTAN COMO NO ENVIADOS. Esos bytes están en el
 *    contenedor del agente, en kratos; el puente corre en otra máquina. Y NUNCA se resuelven contra
 *    el disco local a propósito: si lo hiciéramos, un `file:///run/secrets/database_url` —que en el
 *    puente SÍ existe— haría que el propio puente subiera la contraseña de la base de producción a
 *    un chat. La ruta no se dereferencia; se explica.
 * ------------------------------------------------------------------------------------------
 *
 * INVARIANTE: nada de este módulo puede tirar. Un artifact mal formado se descarta y se cuenta; la
 * respuesta del agente —que es el trabajo— sale igual. Es la misma regla que ya rige `notify` y
 * `artifacts` en el parser del SDK.
 */

/** Simétrico con el techo de ingesta (`MAX_TELEGRAM_ATTACHMENT_BYTES`). */
export const MAX_EGRESS_ATTACHMENT_BYTES = 10_000_000;

/**
 * Cuántos archivos se suben por respuesta.
 *
 * Cada subida es un mensaje de Telegram más, con su fila durable y su cuota de rate limit. Un
 * agente que devuelva veinte artifacts no puede convertir una respuesta en veinte notificaciones
 * en el teléfono de alguien.
 */
export const MAX_UPLOADS_PER_RELAY = 4;
const MAX_ARTIFACTS_CONSIDERED = 16;
const MAX_LISTED_LINES = 8;
/** Cota del string base64 antes de decodificar, para no materializar un buffer absurdo. */
const MAX_DATA_URI_CHARACTERS = Math.ceil(MAX_EGRESS_ATTACHMENT_BYTES / 3) * 4 + 64;

export interface PlannedUpload {
  /** `photo` se renderiza dentro del chat; `document` se descarga. */
  readonly kind: 'photo' | 'document';
  readonly name: string;
  readonly mime_type: string;
  readonly bytes: Buffer;
  /** Identidad estable del contenido: entra en el hash durable del efecto. */
  readonly sha256: string;
}

export interface ArtifactPlan {
  readonly uploads: readonly PlannedUpload[];
  /** Bloque a pegar al final del texto. Cadena vacía cuando no hay nada que contar. */
  readonly footer: string;
  /** Artifacts que sólo se pudieron nombrar: enlace, o ruta que vive en el agente. */
  readonly listed: number;
  /** Artifacts que no se pudieron subir ni listar (contador para la métrica). */
  readonly discarded: number;
}

export const EMPTY_ARTIFACT_PLAN: ArtifactPlan = { uploads: [], footer: '', listed: 0, discarded: 0 };

interface RawArtifact {
  readonly name: string;
  readonly uri: string;
  readonly media_type?: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function artifactList(payload: Record<string, unknown>): readonly RawArtifact[] {
  const result = object(payload.result);
  const output = object(result?.output);
  const candidate = output?.artifacts ?? result?.artifacts ?? payload.artifacts;
  if (!Array.isArray(candidate)) return [];
  const artifacts: RawArtifact[] = [];
  for (const entry of candidate.slice(0, MAX_ARTIFACTS_CONSIDERED)) {
    const row = object(entry);
    if (row === undefined || typeof row.uri !== 'string') continue;
    artifacts.push({
      name: typeof row.name === 'string' ? row.name : '',
      uri: row.uri,
      ...(typeof row.media_type === 'string' ? { media_type: row.media_type } : {})
    });
  }
  return artifacts;
}

/* --------------------------------------------------------------------------- *
 * Nombres
 * --------------------------------------------------------------------------- */

function hasUnsafeCodePoint(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x61c ||
      (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) || code === 0xfeff || (code >= 0xfff9 && code <= 0xfffb);
  });
}

/**
 * Nombre de archivo apto para el `filename` de un multipart.
 *
 * Comillas, saltos de línea y separadores de ruta se van: el valor viaja dentro de una cabecera
 * `Content-Disposition` y no puede llevar nada capaz de cerrarla.
 */
function safeFileName(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && basename(value) === value &&
    value !== '.' && value !== '..' &&
    !value.includes('/') && !value.includes('\\') && !value.includes('"') && !value.includes("'") &&
    !hasUnsafeCodePoint(value);
}

const EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['image/gif', '.gif'],
  ['application/pdf', '.pdf'], ['text/plain', '.txt'], ['text/markdown', '.md'],
  ['text/csv', '.csv'], ['text/html', '.html'], ['application/json', '.json'],
  ['application/zip', '.zip'], ['application/gzip', '.gz'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['video/mp4', '.mp4'], ['audio/mpeg', '.mp3'], ['audio/ogg', '.ogg']
]);

function uploadName(declared: string, mime: string): string {
  const trimmed = declared.trim();
  if (safeFileName(trimmed) && extname(trimmed).length > 1) return trimmed;
  const extension = EXTENSIONS.get(mime) ?? '.bin';
  if (safeFileName(trimmed) && trimmed.length > 0) return `${trimmed}${extension}`;
  return `adjunto${extension}`;
}

/* --------------------------------------------------------------------------- *
 * Bytes
 * --------------------------------------------------------------------------- */

/** Firmas que Telegram sabe renderizar como foto dentro del chat. */
function sniffImage(bytes: Buffer): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}

interface DecodedData {
  readonly bytes?: Buffer;
  readonly mime?: string;
  /** Motivo en castellano, listo para que lo lea el humano. Presente sólo si falló. */
  readonly error?: string;
}

/**
 * `data:[<mime>][;charset=…][;base64],<datos>`.
 *
 * Sólo se acepta la variante base64: un `data:` percent-encoded sirve para textos diminutos y
 * aceptarlo agregaría un decodificador más por un caso que nadie usa.
 */
function decodeDataUri(uri: string): DecodedData {
  const comma = uri.indexOf(',');
  if (comma === -1) return { error: 'el data: URI no tiene datos' };
  const header = uri.slice(5, comma).toLowerCase();
  if (!header.split(';').includes('base64')) return { error: 'el data: URI no viene en base64' };
  const mime = header.split(';')[0] || 'application/octet-stream';
  const raw = uri.slice(comma + 1).replace(/\s+/gu, '');
  if (raw.length === 0) return { error: 'el data: URI vino vacío' };
  if (raw.length > MAX_DATA_URI_CHARACTERS) return { error: 'supera los 10 MB' };
  // Buffer.from ignora en silencio lo que no es base64: sin esta comprobación, un adjunto corrupto
  // se subiría truncado y el humano abriría un archivo roto sin saber por qué.
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(raw) || raw.length % 4 !== 0) {
    return { error: 'el base64 del adjunto está mal formado' };
  }
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length === 0) return { error: 'el adjunto quedó vacío al decodificar' };
  if (bytes.length > MAX_EGRESS_ATTACHMENT_BYTES) return { error: 'supera los 10 MB' };
  return { bytes, mime };
}

/* --------------------------------------------------------------------------- *
 * Listado
 * --------------------------------------------------------------------------- */

/**
 * El texto del pie pasa después por `markdownToTelegramHtml`. Se le quitan los caracteres que ese
 * conversor interpreta como marcado para que un nombre con `*` o `_` no deje el mensaje a medio
 * poner en cursiva.
 */
function plainInline(value: string, limit: number): string {
  const cleaned = value
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/[*_`~[\]]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return [...cleaned].slice(0, limit).join('');
}

function safeLink(uri: string): string | undefined {
  if (uri.length > 512 || /[\s<>"']/u.test(uri)) return undefined;
  return /^https?:\/\/[^/]+/iu.test(uri) ? uri : undefined;
}

function label(artifact: RawArtifact, fallback: string): string {
  const name = plainInline(artifact.name, 80);
  return name.length > 0 ? name : fallback;
}

/**
 * Arma el plan de una respuesta: qué se sube, qué se lista y qué se descarta.
 *
 * No tira nunca. Cualquier forma inesperada termina en `discarded` o en una línea del pie.
 */
export function planArtifacts(payload: Record<string, unknown>): ArtifactPlan {
  const artifacts = artifactList(payload);
  if (artifacts.length === 0) return EMPTY_ARTIFACT_PLAN;

  const uploads: PlannedUpload[] = [];
  const lines: string[] = [];
  let discarded = 0;

  for (const artifact of artifacts) {
    const uri = artifact.uri.trim();
    if (uri.length === 0) {
      discarded += 1;
      continue;
    }
    if (/^data:/iu.test(uri)) {
      if (uploads.length >= MAX_UPLOADS_PER_RELAY) {
        lines.push(`• ${label(artifact, 'adjunto')}: no lo mandé, ya iban ${MAX_UPLOADS_PER_RELAY} archivos en esta respuesta`);
        continue;
      }
      const decoded = decodeDataUri(uri);
      if (decoded.bytes === undefined) {
        lines.push(`• ${label(artifact, 'adjunto')}: no pude adjuntarlo (${decoded.error ?? 'contenido inválido'})`);
        continue;
      }
      const sniffed = sniffImage(decoded.bytes);
      const mime = sniffed ?? (decoded.mime ?? 'application/octet-stream');
      uploads.push({
        // La foto se decide por los BYTES, no por lo que declara el agente: un `image/png` mentido
        // hace que Telegram rechace el sendPhoto entero, y ese rechazo es evitable.
        kind: sniffed === undefined ? 'document' : 'photo',
        name: uploadName(artifact.name, mime),
        mime_type: mime,
        bytes: decoded.bytes,
        sha256: createHash('sha256').update(decoded.bytes).digest('hex')
      });
      continue;
    }
    const link = safeLink(uri);
    if (link !== undefined) {
      lines.push(`• ${label(artifact, 'enlace')}: ${link}`);
      continue;
    }
    // Ruta del contenedor del agente: existe, pero no acá. Se nombra sin repetir la ruta cruda,
    // que es justamente lo que Jhon recibió cinco veces y no le sirvió para nada.
    lines.push(`• ${label(artifact, 'archivo')}: quedó en el espacio de trabajo del agente y no viajó al chat`);
  }

  const shown = lines.slice(0, MAX_LISTED_LINES);
  if (lines.length > shown.length) shown.push(`• …y ${lines.length - shown.length} más`);
  const footer = shown.length === 0 ? '' : `\n\n📎 Adjuntos\n${shown.join('\n')}`;
  return { uploads, footer, listed: lines.length, discarded };
}
