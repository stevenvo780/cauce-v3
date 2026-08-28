import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { TelegramApiError } from './telegram.js';
import { transcribeAudio, type TranscriptionConfig } from './transcription.js';
import type {
  PreparedTelegramAttachment, TelegramApi, TelegramFile, TelegramMessage
} from './types.js';

export const MAX_TELEGRAM_ATTACHMENT_BYTES = 10_000_000;

/**
 * Audio has its own cap, higher than the inline attachments one.
 *
 * It can afford it because it does not travel on the bus: it is downloaded, transcribed and
 * discarded. What is kept are the characters of the text. A 20-minute voice note lands here and
 * comes out as a paragraph.
 */
export const MAX_TELEGRAM_AUDIO_BYTES = 25_000_000;

interface Candidate {
  kind: 'image' | 'document';
  file: TelegramFile;
}

interface AttachmentType {
  mime: string;
  extension: string;
  matches(payload: Buffer): boolean;
}

const TYPES: readonly AttachmentType[] = [
  { mime: 'image/jpeg', extension: '.jpg', matches: (value) => value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff },
  { mime: 'image/png', extension: '.png', matches: (value) => value.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/webp', extension: '.webp', matches: (value) => value.length >= 12 && value.toString('ascii', 0, 4) === 'RIFF' && value.toString('ascii', 8, 12) === 'WEBP' },
  { mime: 'application/pdf', extension: '.pdf', matches: (value) => value.subarray(0, 5).toString('ascii') === '%PDF-' },
  { mime: 'text/plain', extension: '.txt', matches: validUtf8Text },
  // The fleet works on .md and Telegram does not send a stable mime for them: depending on the
  // client they arrive as `text/markdown`, `text/x-markdown` or directly `text/plain`. The three
  // pairs are declared because the match requires (mime, extension) and any mismatch rejects it.
  // The safety check is not given by the extension but by `validUtf8Text`: the content must be
  // real UTF-8 without null bytes, so a binary renamed to .md still does not get in.
  { mime: 'text/markdown', extension: '.md', matches: validUtf8Text },
  { mime: 'text/x-markdown', extension: '.md', matches: validUtf8Text },
  { mime: 'text/plain', extension: '.md', matches: validUtf8Text },
  { mime: 'text/csv', extension: '.csv', matches: validUtf8Text },
  { mime: 'text/plain', extension: '.csv', matches: validUtf8Text },
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: '.docx',
    matches: (value) => value.length >= 4 && value[0] === 0x50 && value[1] === 0x4b && value[2] === 0x03 && value[3] === 0x04 &&
      value.includes(Buffer.from('[Content_Types].xml')) && value.includes(Buffer.from('word/document.xml'))
  }
];

function validUtf8Text(payload: Buffer): boolean {
  if (payload.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(payload);
    return true;
  } catch {
    return false;
  }
}

function candidate(message: TelegramMessage): Candidate | undefined {
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const file = message.photo.at(-1);
    return file === undefined ? undefined : { kind: 'image', file };
  }
  return message.document === undefined ? undefined : { kind: 'document', file: message.document };
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
export function hasUnsafeAttachmentCodePoint(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined) continue;
    if (
      code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x61c ||
      (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) || code === 0xfeff || (code >= 0xfff9 && code <= 0xfffb)
    ) {
      return true;
    }
  }
  return false;
}

function safeName(value: string): boolean {
  return value.length >= 1 && value.length <= 255 && basename(value) === value &&
    // Reject controls, bidi/invisible formatting and path separators in attacker-controlled names.
    value !== '.' && value !== '..' &&
    !value.includes('/') && !value.includes('\\') && !hasUnsafeAttachmentCodePoint(value);
}

function declaredType(item: Candidate, remotePath: string): { type?: AttachmentType; name: string } {
  const originalName = item.file.file_name ?? basename(remotePath);
  if (!safeName(originalName)) return { name: originalName };
  const mime = item.kind === 'image' ? 'image/jpeg' : item.file.mime_type;
  const rawExtension = extname(originalName).toLowerCase();
  const extension = rawExtension === '.jpeg' ? '.jpg' : rawExtension;
  const name = rawExtension === '.jpeg' ? `${originalName.slice(0, -5)}.jpg` : originalName;
  const type = TYPES.find((entry) => entry.mime === mime && entry.extension === extension);
  return { ...(type === undefined ? {} : { type }), name };
}

function usefulError(name: string, detail: string): string {
  return `${safeName(name) ? name : 'archivo'}: ${detail}`;
}

export async function prepareTelegramAttachments(
  message: TelegramMessage,
  api: Pick<TelegramApi, 'getFile' | 'downloadFile'>
): Promise<{ media: PreparedTelegramAttachment[]; errors: string[] }> {
  const item = candidate(message);
  if (item === undefined) return { media: [], errors: [] };
  const earlyName = item.file.file_name ?? (item.kind === 'image' ? 'foto.jpg' : 'archivo');
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
    const declared = declaredType(item, remote.file_path);
    if (!safeName(declared.name)) {
      return { media: [], errors: [usefulError(earlyName, 'nombre no seguro')] };
    }
    if (declared.type === undefined) {
      return { media: [], errors: [usefulError(declared.name, 'tipo o extensión no admitido')] };
    }
    const payload = await api.downloadFile(remote.file_path, MAX_TELEGRAM_ATTACHMENT_BYTES);
    if (payload.length > MAX_TELEGRAM_ATTACHMENT_BYTES) {
      return { media: [], errors: [usefulError(declared.name, 'excede el límite de 10 MB')] };
    }
    if (remoteSize !== undefined && payload.length !== remoteSize) {
      return { media: [], errors: [usefulError(declared.name, 'tamaño descargado inconsistente')] };
    }
    if (!declared.type.matches(payload)) {
      return { media: [], errors: [usefulError(declared.name, `el contenido no coincide con ${declared.type.mime}`)] };
    }
    return {
      errors: [],
      media: [{
        kind: declared.type.mime.startsWith('image/') ? 'image' : 'document',
        name: declared.name,
        mime_type: declared.type.mime,
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
    // The name coming from Telegram is not used: the format is inferred from the bytes.
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