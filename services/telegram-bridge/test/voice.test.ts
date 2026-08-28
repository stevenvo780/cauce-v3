import { describe, expect, it } from 'vitest';
import { prepareTelegramVoice, MAX_TELEGRAM_AUDIO_BYTES } from '../src/attachments.js';
import { transcribeAudio, transcriptionConfig } from '../src/transcription.js';
import { normalizedBody } from '../src/poller.js';
import { TelegramApiError } from '../src/telegram.js';
import type { TelegramApi, TelegramMessage, TelegramRemoteFile } from '../src/types.js';
import type { TranscriptionConfig } from '../src/transcription.js';

const CONFIG: TranscriptionConfig = {
  baseUrl: 'http://claw-audio:8000/v1',
  model: 'deepdml/faster-whisper-large-v3-turbo-ct2',
  language: 'es',
  timeoutMs: 5_000,
  apiKey: 'sk-local'
};

/** A minimal Ogg/Opus: what Telegram sends as a voice note. */
function ogg(size = 64): Buffer {
  const payload = Buffer.alloc(size);
  payload.write('OggS', 0, 'ascii');
  return payload;
}

class VoiceTelegram implements TelegramApi {
  readonly files = new Map<string, TelegramRemoteFile>();
  readonly payloads = new Map<string, Buffer>();
  downloads = 0;

  async getIdentity(): Promise<{ id: string }> { return { id: '900001' }; }
  async getUpdates(): Promise<[]> { return []; }
  async sendText(): Promise<{ message_id: string }> { return { message_id: '1' }; }
  async setMessageReaction(): Promise<void> { /* noop */ }
  async sendChatAction(): Promise<void> { /* noop */ }

  async getFile(fileId: string): Promise<TelegramRemoteFile> {
    const file = this.files.get(fileId);
    if (!file) throw new TelegramApiError('file not found', false);
    return file;
  }

  async downloadFile(path: string): Promise<Buffer> {
    this.downloads += 1;
    const payload = this.payloads.get(path);
    if (!payload) throw new Error('missing fixture payload');
    return payload;
  }
}

function voiceApi(payload = ogg()): VoiceTelegram {
  const api = new VoiceTelegram();
  api.files.set('voice-id', { file_id: 'voice-id', file_path: 'voice/file_1.oga', file_size: payload.length });
  api.payloads.set('voice/file_1.oga', payload);
  return api;
}

function message(overrides: Partial<TelegramMessage>): TelegramMessage {
  return { message_id: 1, from: { id: 101 }, chat: { id: 201, type: 'private' }, ...overrides };
}

const VOICE = { file_id: 'voice-id', file_unique_id: 'u1', duration: 7, mime_type: 'audio/ogg' };

describe('transcripción de notas de voz', () => {
  it('devuelve el texto dictado y manda el multipart que espera la API de OpenAI', async () => {
    const peticiones: { url: string; body: FormData; auth: string | null }[] = [];
    const resultado = await prepareTelegramVoice(
      message({ voice: VOICE }),
      voiceApi(),
      CONFIG,
      async (payload, filename, mime, config) => transcribeAudio(payload, filename, mime, config, async (url, init) => {
        peticiones.push({
          url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
          body: init?.body as FormData,
          auth: new Headers(init?.headers).get('authorization')
        });
        return new Response(JSON.stringify({ text: '  Hola, esto es una prueba.  ' }), {
          status: 200, headers: { 'content-type': 'application/json' }
        });
      })
    );

    expect(resultado).toEqual({ kind: 'voice', duration: 7, transcript: 'Hola, esto es una prueba.' });
    expect(peticiones).toHaveLength(1);
    const peticion = peticiones[0];
    expect(peticion?.url).toBe('http://claw-audio:8000/v1/audio/transcriptions');
    expect(peticion?.auth).toBe('Bearer sk-local');
    expect(peticion?.body.get('model')).toBe('deepdml/faster-whisper-large-v3-turbo-ct2');
    expect(peticion?.body.get('language')).toBe('es');
    expect(peticion?.body.get('response_format')).toBe('json');
    // The filename comes from the magic, not from what the user declared.
    expect((peticion?.body.get('file') as File | undefined)?.name).toBe('voz.ogg');
  });

  it('acepta audio y videomensajes, no sólo notas de voz', async () => {
    const transcriptor = async () => ({ transcript: 'dicho' });
    const api = voiceApi();
    await expect(prepareTelegramVoice(message({ audio: VOICE }), api, CONFIG, transcriptor))
      .resolves.toMatchObject({ kind: 'audio', transcript: 'dicho' });
    await expect(prepareTelegramVoice(message({ video_note: VOICE }), api, CONFIG, transcriptor))
      .resolves.toMatchObject({ kind: 'video_note', transcript: 'dicho' });
  });

  it('ignora los mensajes sin audio', async () => {
    const resultado = await prepareTelegramVoice(message({ text: 'hola' }), voiceApi(), CONFIG);
    expect(resultado).toEqual({});
  });

  /* --- Fail-open: the message still arrives, with a readable explanation --- */

  it('explica el problema en vez de perder el mensaje cuando el servicio no responde', async () => {
    const resultado = await prepareTelegramVoice(
      message({ voice: VOICE }),
      voiceApi(),
      CONFIG,
      async (payload, filename, mime, config) => transcribeAudio(payload, filename, mime, config, async () => {
        throw new TypeError('fetch failed');
      })
    );
    expect(resultado.transcript).toBeUndefined();
    expect(resultado.error).toBe('No pude escuchar la nota de voz: el servicio de transcripción no está accesible.');
  });

  it('explica el problema cuando la transcripción no está configurada', async () => {
    const resultado = await prepareTelegramVoice(message({ voice: VOICE }), voiceApi(), undefined);
    expect(resultado).toEqual({
      kind: 'voice',
      duration: 7,
      error: 'No pude escuchar la nota de voz: la transcripción de audio no está configurada en este puente.'
    });
  });

  it('corta antes de descargar lo que excede el techo de 25 MB', async () => {
    const api = voiceApi();
    const resultado = await prepareTelegramVoice(
      message({ voice: { ...VOICE, file_size: MAX_TELEGRAM_AUDIO_BYTES + 1 } }),
      api, CONFIG, async () => ({ transcript: 'no debería llegar acá' })
    );
    expect(resultado.error).toMatch(/25 MB/u);
    expect(api.downloads).toBe(0);
  });

  it('rechaza lo que no es audio aunque Telegram lo declare como voz', async () => {
    const resultado = await prepareTelegramVoice(
      message({ voice: VOICE }),
      voiceApi(Buffer.from('#!/bin/sh\nrm -rf /\n')),
      CONFIG,
      async () => ({ transcript: 'no debería llegar acá' })
    );
    expect(resultado.error).toMatch(/no parece audio/u);
  });

  it('recorta y limpia lo que devuelve el servicio: es entrada no confiable', async () => {
    const sucio = `hola \u0007\u202emundo${'x'.repeat(9_000)}`;
    const resultado = await prepareTelegramVoice(
      message({ voice: VOICE }), voiceApi(), CONFIG,
      async (payload, filename, mime, config) => transcribeAudio(payload, filename, mime, config, async () =>
        new Response(JSON.stringify({ text: sucio }), { status: 200 }))
    );
    expect(resultado.transcript).not.toContain(String.fromCharCode(0x07));
    expect(resultado.transcript).not.toContain('\u202e');
    expect(resultado.transcript?.length).toBeLessThanOrEqual(8_001);
  });
});

describe('configuración', () => {
  it('queda apagada si no hay URL', () => {
    expect(transcriptionConfig({})).toBeUndefined();
  });

  it('exige un modelo y una URL sana', () => {
    expect(() => transcriptionConfig({ CAUCE_TELEGRAM_TRANSCRIPTION_URL: 'no-es-una-url' })).toThrow(/valid URL/u);
    expect(() => transcriptionConfig({ CAUCE_TELEGRAM_TRANSCRIPTION_URL: 'http://x/v1' })).toThrow(/MODEL is required/u);
    expect(() => transcriptionConfig({
      CAUCE_TELEGRAM_TRANSCRIPTION_URL: 'http://user:pass@x/v1',
      CAUCE_TELEGRAM_TRANSCRIPTION_MODEL: 'm'
    })).toThrow(/credentials/u);
  });

  it('toma los valores del entorno y cae en castellano por defecto', () => {
    expect(transcriptionConfig({
      CAUCE_TELEGRAM_TRANSCRIPTION_URL: 'http://claw-audio:8000/v1/',
      CAUCE_TELEGRAM_TRANSCRIPTION_MODEL: 'whisper',
      CAUCE_TELEGRAM_TRANSCRIPTION_TIMEOUT_SECONDS: '90'
    })).toEqual({
      baseUrl: 'http://claw-audio:8000/v1',
      model: 'whisper',
      language: 'es',
      timeoutMs: 90_000,
      apiKey: 'sk-local'
    });
  });
});

describe('cuerpo del mensaje', () => {
  const transcriptor = async () => ({ transcript: 'Comprá pan y avisale a jarvis.' });

  it('pone la transcripción donde el agente la lee, etiquetada como dictada', async () => {
    const cuerpo = await normalizedBody(
      message({ voice: VOICE }), 42, voiceApi(), undefined, CONFIG, transcriptor
    );
    expect(cuerpo.prompt).toBe('[nota de voz transcrita] Comprá pan y avisale a jarvis.');
    // A faithful record of what happened with the audio, for the operator.
    expect(cuerpo.voice_v1).toEqual({ kind: 'voice', duration: 7, transcript: 'Comprá pan y avisale a jarvis.' });
    // `text` stays as what Telegram sent: here, nothing.
    expect(cuerpo.text).toBeUndefined();
  });

  it('conserva el epígrafe cuando el audio viene con texto', async () => {
    const cuerpo = await normalizedBody(
      message({ voice: VOICE, caption: 'mirá esto' }), 42,
      voiceApi(), undefined, CONFIG, transcriptor
    );
    expect(cuerpo.prompt).toBe('mirá esto\n\n[nota de voz transcrita] Comprá pan y avisale a jarvis.');
    expect(cuerpo.caption).toBe('mirá esto');
  });

  it('le da al agente el error para que se lo explique al usuario', async () => {
    const cuerpo = await normalizedBody(
      message({ voice: VOICE }), 42, voiceApi(), undefined, undefined
    );
    expect(cuerpo.prompt).toMatch(/^No pude escuchar la nota de voz: .*Decíselo al usuario/su);
  });

  it('no toca el cuerpo de un mensaje de texto', async () => {
    const cuerpo = await normalizedBody(
      message({ text: 'hola' }), 42, voiceApi(), undefined, CONFIG, transcriptor
    );
    expect(cuerpo.prompt).toBeUndefined();
    expect(cuerpo.voice_v1).toBeUndefined();
    expect(cuerpo.text).toBe('hola');
  });
});
