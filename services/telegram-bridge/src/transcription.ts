/**
 * Audio transcription against an OpenAI-API-compatible service.
 */
import { logJsonLine } from './ingress-body.js';

/**
 * Cuanto del cuerpo de error del servicio se conserva para el registro.
 *
 * El cuerpo trae la causa de verdad —`RuntimeError: CUDA failed with error out of memory`— y hasta
 * hoy se tiraba entera: el puente devolvia «respondio 500» y no registraba nada. El 2026-08-30 eso
 * costo una hora de diagnostico subiendo a la torre a leer los logs del servicio, mientras kratos
 * y su humano se quedaban sin poder hablar. La causa NO viaja al chat —es interna— pero tiene que
 * quedar en el registro del puente, que es donde se mira primero.
 */
const MAX_ERROR_BODY_CHARS = 500;

async function causaDelServicio(respuesta: { text(): Promise<string> }): Promise<string> {
  try {
    return (await respuesta.text()).replace(/\s+/gu, ' ').trim().slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    return '';
  }
}

export interface TranscriptionConfig {
  /** Service origin, without the path: `http://host:8000/v1`. */
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

/** Cap on the text accepted back: it is untrusted input, even when it comes from home. */
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

  const rawLanguage = environment.CAUCE_TELEGRAM_TRANSCRIPTION_LANGUAGE?.trim();
  const rawApiKey = environment.CAUCE_TELEGRAM_TRANSCRIPTION_API_KEY?.trim();

  return {
    baseUrl: baseUrl.replace(/\/+$/u, ''),
    model,
    language: rawLanguage && rawLanguage.length > 0 ? rawLanguage : 'es',
    timeoutMs: seconds * 1_000,
    apiKey: rawApiKey && rawApiKey.length > 0 ? rawApiKey : 'sk-local'
  };
}

/** Bidi and invisible marks: they allow disguising text inside the harness prompt. */
const INVISIBLES = /[\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/gu;

/** Controls, except line break, that the recognizer can legitimately return. */
function replaceControls(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    const isControl = codePoint !== undefined && (
      codePoint <= 0x09
      || (codePoint >= 0x0b && codePoint <= 0x1f)
      || (codePoint >= 0x7f && codePoint <= 0x9f)
    );
    return isControl ? ' ' : character;
  }).join('');
}

function sanitize(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const limpio = replaceControls(value.replace(INVISIBLES, ''))
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
  // `new Uint8Array(...)` and not the raw Buffer: a Node Buffer is not a valid BlobPart in TS.
  formulario.append('file', new Blob([new Uint8Array(payload)], { type: mimeType }), filename);
  formulario.append('model', config.model);
  formulario.append('language', config.language);
  formulario.append('response_format', 'json');

  const control = new AbortController();
  const reloj = setTimeout(() => { control.abort(); }, config.timeoutMs);
  try {
    const respuesta = await fetcher(`${config.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}` },
      body: formulario,
      signal: control.signal
    });
    if (!respuesta.ok) {
      logJsonLine({
        event: 'telegram_transcription_failed',
        status: respuesta.status,
        model: config.model,
        bytes: payload.length,
        cause: await causaDelServicio(respuesta),
      });
      return { error: `el servicio de transcripción respondió ${String(respuesta.status)}` };
    }
    const cuerpo: unknown = await respuesta.json();
    const texto = sanitize((cuerpo as { text?: unknown } | null)?.text);
    return texto === undefined
      ? { error: 'el servicio de transcripción devolvió una respuesta vacía' }
      : { transcript: texto };
  } catch (error) {
    const causa = error instanceof Error && error.name === 'AbortError'
      ? `no respondió en ${String(Math.round(config.timeoutMs / 1_000))} s`
      : 'no está accesible';
    logJsonLine({
      event: 'telegram_transcription_failed',
      status: null,
      model: config.model,
      bytes: payload.length,
      cause: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, MAX_ERROR_BODY_CHARS) : '',
    });
    return { error: `el servicio de transcripción ${causa}` };
  } finally {
    clearTimeout(reloj);
  }
}
