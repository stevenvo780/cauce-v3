/**
 * Transcripción de audio contra un servicio compatible con la API de OpenAI.
 *
 * La flota ya tenía esto resuelto antes de Cauce V3: `claw-audio` (speaches sobre CUDA, en kratos)
 * corriendo `faster-whisper-large-v3-turbo-ct2`. Lo que se perdió en la migración fue el cable, no
 * el motor. Este módulo es ese cable y nada más: recibe bytes, devuelve texto.
 *
 * Decisiones deliberadas:
 * - **Falla abierta.** Si el servicio no responde, el mensaje igual llega con su metadata y un
 *   error legible. Un audio sin transcribir es peor que uno transcrito, pero mucho mejor que un
 *   mensaje perdido: el usuario tiene que enterarse de que su nota de voz llegó y no se pudo oír.
 * - **No viaja el audio.** A diferencia de imágenes y documentos, el audio NO se manda inline en
 *   base64: un mensaje de voz de 3 MB serían 4 MB de base64 en cada fila de `messages`, y ningún
 *   harness sabe escuchar un .ogg. Lo que el agente necesita es el texto.
 * - **Sin credencial real.** El servicio es interno y no autentica; se manda un token de relleno
 *   porque la API de OpenAI lo exige sintácticamente.
 */

export interface TranscriptionConfig {
  /** Origen del servicio, sin la ruta: `http://host:8000/v1`. */
  readonly baseUrl: string;
  readonly model: string;
  readonly language: string;
  readonly timeoutMs: number;
  readonly apiKey: string;
}

export interface TranscriptionOutcome {
  readonly transcript?: string;
  readonly error?: string;
}

/** Techo del texto que se acepta de vuelta: es entrada no confiable, aunque venga de casa. */
const MAX_TRANSCRIPT_CHARS = 8_000;

export function transcriptionConfig(
  environment: NodeJS.ProcessEnv = process.env
): TranscriptionConfig | undefined {
  const baseUrl = environment.CAUCE_TELEGRAM_TRANSCRIPTION_URL?.trim();
  if (baseUrl === undefined || baseUrl.length === 0) return undefined;

  let origin: URL;
  try {
    origin = new URL(baseUrl);
  } catch {
    throw new Error('CAUCE_TELEGRAM_TRANSCRIPTION_URL must be a valid URL');
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
    throw new Error('CAUCE_TELEGRAM_TRANSCRIPTION_URL must be http or https');
  }
  if (origin.username.length > 0 || origin.password.length > 0) {
    throw new Error('CAUCE_TELEGRAM_TRANSCRIPTION_URL must not carry credentials');
  }

  const model = environment.CAUCE_TELEGRAM_TRANSCRIPTION_MODEL?.trim();
  if (model === undefined || model.length === 0) {
    throw new Error('CAUCE_TELEGRAM_TRANSCRIPTION_MODEL is required when transcription is enabled');
  }

  const seconds = Number(environment.CAUCE_TELEGRAM_TRANSCRIPTION_TIMEOUT_SECONDS ?? '120');
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 900) {
    throw new Error('CAUCE_TELEGRAM_TRANSCRIPTION_TIMEOUT_SECONDS must be between 1 and 900');
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/u, ''),
    model,
    language: environment.CAUCE_TELEGRAM_TRANSCRIPTION_LANGUAGE?.trim() || 'es',
    timeoutMs: seconds * 1_000,
    apiKey: environment.CAUCE_TELEGRAM_TRANSCRIPTION_API_KEY?.trim() || 'sk-local'
  };
}

/** Marcas bidi e invisibles: permiten disfrazar texto dentro del prompt del harness. */
const INVISIBLES = /[\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/gu;
/** Controles, salvo el salto de linea, que el reconocedor si puede devolver legitimamente. */
const CONTROLES = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu;

function sanitize(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const limpio = value
    .replace(INVISIBLES, '')
    .replace(CONTROLES, ' ')
    .replace(/[^\S\n]+/gu, ' ')
    .trim();
  if (limpio.length === 0) return undefined;
  return limpio.length > MAX_TRANSCRIPT_CHARS ? `${limpio.slice(0, MAX_TRANSCRIPT_CHARS)}\u2026` : limpio;
}

export async function transcribeAudio(
  payload: Buffer,
  filename: string,
  mimeType: string,
  config: TranscriptionConfig,
  fetcher: typeof fetch = fetch
): Promise<TranscriptionOutcome> {
  const formulario = new FormData();
  // `new Uint8Array(...)` y no el Buffer pelado: un Buffer de Node no es un BlobPart válido en TS.
  formulario.append('file', new Blob([new Uint8Array(payload)], { type: mimeType }), filename);
  formulario.append('model', config.model);
  formulario.append('language', config.language);
  formulario.append('response_format', 'json');

  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), config.timeoutMs);
  try {
    const respuesta = await fetcher(`${config.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}` },
      body: formulario,
      signal: control.signal
    });
    if (!respuesta.ok) {
      return { error: `el servicio de transcripción respondió ${respuesta.status}` };
    }
    const cuerpo: unknown = await respuesta.json();
    const texto = sanitize((cuerpo as { text?: unknown } | null)?.text);
    return texto === undefined
      ? { error: 'el servicio de transcripción devolvió una respuesta vacía' }
      : { transcript: texto };
  } catch (error) {
    const causa = error instanceof Error && error.name === 'AbortError'
      ? `no respondió en ${Math.round(config.timeoutMs / 1_000)} s`
      : 'no está accesible';
    return { error: `el servicio de transcripción ${causa}` };
  } finally {
    clearTimeout(reloj);
  }
}
