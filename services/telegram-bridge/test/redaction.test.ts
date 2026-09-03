import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redactSecrets, redactSecretsDeep } from '../src/index.js';
import { normalizedBody } from '../src/poller.js';
import type { TelegramApi, TelegramMessage } from '../src/types.js';

/**
 * Bridge half of the redaction: the ingress switch, its single call site and its counter. The
 * rules themselves now live only in packages/protocol/test/redaction.test.ts.
 */

const SECRET = 'DATABASE_URL=postgresql://neondb_owner:npg_FICTICIA0AbCdEf@ep-dry.neon.tech/neondb';

const api = {
  async getFile() { throw new Error('no'); },
  async downloadFile() { throw new Error('no'); }
} as unknown as TelegramApi;

function message(text: string): TelegramMessage {
  return { message_id: 7, chat: { id: 42, type: 'private' }, from: { id: 9 }, text };
}

const CONTEXT = { threadId: '0', bucket: 'directed', untrusted: { author: { username: 'pablo' } } };

describe('la ingesta del puente reexporta la implementación del protocolo', () => {
  it('mantiene los nombres públicos y el interruptor explícito', () => {
    expect(redactSecrets('postgresql://u:p@host/db', { enabled: true }).count).toBe(1);
    expect(redactSecrets('postgresql://u:p@host/db', { enabled: false }).count).toBe(0);
    expect(redactSecretsDeep({ text: SECRET }, { enabled: false })).toEqual({
      value: { text: SECRET }, kinds: [], count: 0
    });
  });
});

describe('el interruptor de ingesta, apagado por defecto', () => {
  afterEach(() => {
    delete process.env.CAUCE_TELEGRAM_REDACT_INGRESS;
  });

  it('sin la variable el cuerpo sale byte por byte igual y sin la marca', async () => {
    const cuerpo = await normalizedBody(message(SECRET), 42, api, CONTEXT);
    expect(String(cuerpo.text)).toContain('npg_FICTICIA0AbCdEf');
    expect(String(cuerpo.prompt)).toContain('npg_FICTICIA0AbCdEf');
    expect(cuerpo.redacted_v1).toBeUndefined();
  });

  it('con la variable en 0 tampoco redacta', async () => {
    process.env.CAUCE_TELEGRAM_REDACT_INGRESS = '0';
    const cuerpo = await normalizedBody(message(SECRET), 42, api, CONTEXT);
    expect(String(cuerpo.text)).toContain('npg_FICTICIA0AbCdEf');
    expect(cuerpo.redacted_v1).toBeUndefined();
  });
});

describe('el interruptor de ingesta encendido', () => {
  beforeEach(() => {
    process.env.CAUCE_TELEGRAM_REDACT_INGRESS = '1';
  });
  afterEach(() => {
    delete process.env.CAUCE_TELEGRAM_REDACT_INGRESS;
  });

  it('redacta el prompt de grupo, que es lo que realmente lee el arnés, y marca el cuerpo', async () => {
    const cuerpo = await normalizedBody(message(SECRET), 42, api, CONTEXT);
    expect(JSON.stringify(cuerpo)).not.toContain('npg_FICTICIA0AbCdEf');
    expect(String(cuerpo.prompt)).toContain('[credencial-redactada]');
    expect(String(cuerpo.text)).toContain('[credencial-redactada]');
    // Two: the original `text` and the `prompt` assembled from it. The flag counts redactions,
    // not distinct secrets.
    expect(cuerpo.redacted_v1).toEqual({ count: 2, kinds: ['uri_credentials'] });
  });

  it('avisa una sola vez por mensaje para el contador ingress_secret_redacted', async () => {
    let contador = 0;
    const cuerpo = await normalizedBody(
      message(SECRET), 42, api, CONTEXT, undefined, undefined, () => { contador += 1; }
    );
    expect(contador).toBe(1);
    expect(cuerpo.redacted_v1).toBeDefined();
  });

  it('no avisa ni marca un mensaje normal', async () => {
    let contador = 0;
    const cuerpo = await normalizedBody(
      message('hola, ¿cómo vas con el guion?'), 42, api, undefined, undefined, undefined,
      () => { contador += 1; }
    );
    expect(contador).toBe(0);
    expect(cuerpo.text).toBe('hola, ¿cómo vas con el guion?');
    expect(cuerpo.redacted_v1).toBeUndefined();
  });
});
