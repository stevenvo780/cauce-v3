import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import {
  imageSignature, isSafeBasename, MAX_ATTACHMENT_BYTES, mediaTypeForExtension, normalizeMediaType
} from '@cauce/protocol';
import { TelegramApiError } from './telegram.js';
import { transcribeAudio, type TranscriptionConfig } from './transcription.js';
import type {
  PreparedTelegramAttachment, TelegramApi, TelegramFile, TelegramMessage
} from './types.js';

/** `getFile` refuses to hand over anything larger, so the protocol cap is clamped to it. */
const TELEGRAM_GETFILE_CEILING = 20_000_000;
export const MAX_TELEGRAM_ATTACHMENT_BYTES = Math.min(MAX_ATTACHMENT_BYTES, TELEGRAM_GETFILE_CEILING);

/**
 * Audio has its own cap: it never travels on the bus. It is downloaded, transcribed and
 * discarded, and only the characters of the text are kept.
 */
export const MAX_TELEGRAM_AUDIO_BYTES = 25_000_000;

interface PreparedType {
  readonly kind: 'image' | 'document';
  readonly mime: string;
}

interface Candidate {
  readonly photo: boolean;
  readonly file: TelegramFile;
}

function candidate(message: TelegramMessage): Candidate | undefined {
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const file = message.photo.at(-1);
    return file === undefined ? undefined : { photo: true, file };
  }
  const file = message.document ?? message.video ?? message.animation;
  return file === undefined ? undefined : { photo: false, file };
}

function safeFileId(file: TelegramFile): boolean {
  return typeof file.file_id === 'string' && file.file_id.length >= 1 && file.file_id.length <= 512;
}

function safeRemotePath(value: string): boolean {
  return value.length >= 1 && value.length <= 1_024 && !value.startsWith('/') &&
    !value.includes('\\') && !value.split('/').includes('..') && /^[A-Za-z0-9._/-]+$/u.test(value);
}

/**
 * Hostile code point criterion: C0/C1 controls, bidi, invisibles and the annotations.
 *
 * It is exported so `test/untrusted.test.ts` can check that the NAME sanitiser does not let
 * through anything rejected here. The two criteria were born separate —one for file names,
 * another for free text— and two validators of the same field drifting apart is exactly how a
 * value ends up accepted by one layer and rejected by the next.
 */
export { hasUnsafeTextCodePoint as hasUnsafeAttachmentCodePoint } from '@cauce/protocol';

function declaredName(item: Candidate, remotePath: string): string {
  const original = item.file.file_name ?? basename(remotePath);
  return extname(original).toLowerCase() === '.jpeg' ? `${original.slice(0, -5)}.jpg` : original;
}

/**
 * Type of the file, read from the bytes first and from the declaration second.
 *
 * No answer here turns anything away: a format nobody recognises travels as
 * `application/octet-stream`. `kind` is `image` only when the bytes really are a raster image,
 * because that is what lets a harness hand the file to a native image input.
 */
function resolveType(item: Candidate, name: string, payload: Buffer): PreparedType {
  const sniffed = imageSignature(payload);
  if (sniffed !== undefined) return { kind: 'image', mime: sniffed };
  const declared = normalizeMediaType(item.file.mime_type);
  return {
    kind: 'document',
    mime: declared ?? mediaTypeForExtension(extname(name).toLowerCase()) ?? 'application/octet-stream'
  };
}

function usefulError(name: string, detail: string): string {
  return `${isSafeBasename(name) ? name : 'archivo'}: ${detail}`;
}

export async function prepareTelegramAttachments(
  message: TelegramMessage,
  api: Pick<TelegramApi, 'getFile' | 'downloadFile'>
): Promise<{ media: PreparedTelegramAttachment[]; errors: string[] }> {
  const item = candidate(message);
  if (item === undefined) return { media: [], errors: [] };
  const earlyName = item.file.file_name ?? (item.photo ? 'foto.jpg' : 'archivo');
  if (!safeFileId(item.file)) return { media: [], errors: [usefulError(earlyName, 'identificador de Telegram inválido')] };
  if (Number.isSafeInteger(item.file.file_size) && Number(item.file.file_size) > MAX_TELEGRAM_ATTACHMENT_BYTES) {
    return { media: [], errors: [usefulError(earlyName, 'excede el límite de 10 MB')] };
  }

  try {
    const remote = await api.getFile(item.file.file_id);
    if (!safeRemotePath(remote.file_path)) {
      return { media: [], errors: [usefulError(earlyName, 'ruta remota de Telegram inválida')] };
    }
    const remoteSize = remote.file_size ?? item.file.file_size;
    if (Number.isSafeInteger(remoteSize) && Number(remoteSize) > MAX_TELEGRAM_ATTACHMENT_BYTES) {
      return { media: [], errors: [usefulError(earlyName, 'excede el límite de 10 MB')] };
    }
    const name = declaredName(item, remote.file_path);
    if (!isSafeBasename(name)) {
      return { media: [], errors: [usefulError(earlyName, 'nombre no seguro')] };
    }
    const payload = await api.downloadFile(remote.file_path, MAX_TELEGRAM_ATTACHMENT_BYTES);
    if (payload.length > MAX_TELEGRAM_ATTACHMENT_BYTES) {
      return { media: [], errors: [usefulError(name, 'excede el límite de 10 MB')] };
    }
    if (remoteSize !== undefined && payload.length !== remoteSize) {
      return { media: [], errors: [usefulError(name, 'tamaño descargado inconsistente')] };
    }
    const resolved = resolveType(item, name, payload);
    return {
      errors: [],
      media: [{
        kind: resolved.kind,
        name,
        mime_type: resolved.mime,
        file_size: payload.length,
        sha256: createHash('sha256').update(payload).digest('hex'),
        content_base64: payload.toString('base64')
      }]
    };
  } catch (error) {
    if (error instanceof TelegramApiError && !error.retryable) {
      return { media: [], errors: [usefulError(earlyName, 'Telegram rechazó la descarga')] };
    }
    throw error;
  }
}

/* ------------------------------------------------------------------------- *
 * Voice
 *
 * Deliberately a separate path from the one above. Inline attachments go through a strict
 * whitelist of mime + extension + magic because their bytes end up in the message body and from
 * there to the model. Audio does not: from a voice note only the text returned by the GPU
 * survives. What has to be verified here is not "this is safe to forward" but "this is really
 * audio", so the type is inferred from the bytes and the user-declared name is discarded whole.
 * ------------------------------------------------------------------------- */

type AudioKind = 'voice' | 'audio' | 'video_note' | 'video';

interface AudioType {
  mime: string;
  extension: string;
  matches(payload: Buffer): boolean;
}

const AUDIO_TYPES: readonly AudioType[] = [
  // What Telegram sends for a voice note: Ogg/Opus.
  { mime: 'audio/ogg', extension: '.ogg', matches: (value) => value.toString('ascii', 0, 4) === 'OggS' },
  { mime: 'audio/wav', extension: '.wav', matches: (value) => value.length >= 12 && value.toString('ascii', 0, 4) === 'RIFF' && value.toString('ascii', 8, 12) === 'WAVE' },
  { mime: 'audio/flac', extension: '.flac', matches: (value) => value.toString('ascii', 0, 4) === 'fLaC' },
  { mime: 'audio/mpeg', extension: '.mp3', matches: (value) => value.toString('ascii', 0, 3) === 'ID3' || (value.length >= 2 && value[0] === 0xff && ((value[1] ?? 0) & 0xe0) === 0xe0) },
  // ISO-BMFF: m4a, mp4 and the video_note. `ftyp` starts at byte 4.
  { mime: 'audio/mp4', extension: '.m4a', matches: (value) => value.length >= 12 && value.toString('ascii', 4, 8) === 'ftyp' },
  { mime: 'audio/webm', extension: '.webm', matches: (value) => value.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) }
];

export interface PreparedTelegramVoice {
  /** What the human said. Absent if something failed. */
  readonly transcript?: string;
  /** Explanation in Spanish, intended for the agent to read aloud to the user. */
  readonly error?: string;
  readonly kind?: AudioKind;
  readonly duration?: number;
}

function audioCandidate(message: TelegramMessage): { kind: AudioKind; file: TelegramFile } | undefined {
  if (message.voice !== undefined) return { kind: 'voice', file: message.voice };
  if (message.audio !== undefined) return { kind: 'audio', file: message.audio };
  if (message.video_note !== undefined) return { kind: 'video_note', file: message.video_note };
  return undefined;
}

function audioError(kind: AudioKind, detail: string): string {
  const sujeto = kind === 'voice' ? 'la nota de voz' : kind === 'video_note' ? 'el videomensaje' : 'el audio';
  return `No pude escuchar ${sujeto}: ${detail}.`;
}

/**
 * Downloads the audio from a Telegram message and returns its transcription.
 *
 * It fails open on every path except for retryable Telegram errors, which propagate so the
 * poller retries the whole update just like with attachments.
 */
export async function prepareTelegramVoice(
  message: TelegramMessage,
  api: Pick<TelegramApi, 'getFile' | 'downloadFile'>,
  config: TranscriptionConfig | undefined,
  transcriber: typeof transcribeAudio = transcribeAudio
): Promise<PreparedTelegramVoice> {
  const item = audioCandidate(message);
  if (item === undefined) return {};

  const duration = Number.isSafeInteger(item.file.duration) && Number(item.file.duration) >= 0
    ? item.file.duration : undefined;
  const base = { kind: item.kind, ...(duration === undefined ? {} : { duration }) };

  if (config === undefined) {
    return { ...base, error: audioError(item.kind, 'la transcripción de audio no está configurada en este puente') };
  }
  if (!safeFileId(item.file)) {
    return { ...base, error: audioError(item.kind, 'Telegram mandó un identificador inválido') };
  }
  if (Number.isSafeInteger(item.file.file_size) && Number(item.file.file_size) > MAX_TELEGRAM_AUDIO_BYTES) {
    return { ...base, error: audioError(item.kind, 'pesa más de 25 MB') };
  }

  try {
    const remote = await api.getFile(item.file.file_id);
    if (!safeRemotePath(remote.file_path)) {
      return { ...base, error: audioError(item.kind, 'Telegram devolvió una ruta remota inválida') };
    }
    const remoteSize = remote.file_size ?? item.file.file_size;
    if (Number.isSafeInteger(remoteSize) && Number(remoteSize) > MAX_TELEGRAM_AUDIO_BYTES) {
      return { ...base, error: audioError(item.kind, 'pesa más de 25 MB') };
    }
    const payload = await api.downloadFile(remote.file_path, MAX_TELEGRAM_AUDIO_BYTES);
    if (payload.length > MAX_TELEGRAM_AUDIO_BYTES) {
      return { ...base, error: audioError(item.kind, 'pesa más de 25 MB') };
    }
    const type = AUDIO_TYPES.find((entry) => entry.matches(payload));
    if (type === undefined) {
      return { ...base, error: audioError(item.kind, 'el archivo no parece audio en un formato conocido') };
    }
    const resultado = await transcriber(payload, `voz${type.extension}`, type.mime, config);
    return resultado.transcript === undefined
      ? { ...base, error: audioError(item.kind, resultado.error ?? 'la transcripción falló') }
      : { ...base, transcript: resultado.transcript };
  } catch (error) {
    if (error instanceof TelegramApiError && !error.retryable) {
      return { ...base, error: audioError(item.kind, 'Telegram rechazó la descarga') };
    }
    throw error;
  }
}
