import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redactSecretsDeep, redactionEnabledFromEnv } from '@cauce/protocol';
import { normalizedBody } from '../../services/telegram-bridge/src/ingress-body.js';
import type { TelegramApi, TelegramMessage } from '../../services/telegram-bridge/src/types.js';

/**
 * Semántica del conmutador de ingesta del puente, que es lo único suyo: las reglas de redacción
 * son del protocolo y se prueban en `packages/protocol/test/redaction.test.ts`.
 *
 * La ingesta de Telegram está APAGADA por defecto: sólo `'1'` la enciende. Un valor raro no puede
 * encenderla por accidente, porque nadie revisa un puente que redacta de más hasta que un agente
 * deja de entender lo que le mandaron.
 */

const ENV_KEY = 'CAUCE_TELEGRAM_REDACT_INGRESS';
const SECRET = 'postgresql://neondb_owner:npg_FICTICIA0AbCdEf@ep-dry.neon.tech/neondb';

let original: string | undefined;

beforeEach(() => {
  original = process.env[ENV_KEY];
  Reflect.deleteProperty(process.env, ENV_KEY);
});

afterEach(() => {
  if (original === undefined) Reflect.deleteProperty(process.env, ENV_KEY);
  else process.env[ENV_KEY] = original;
});

const api = {
  async getFile() { throw new Error('sin red en esta prueba'); },
  async downloadFile() { throw new Error('sin red en esta prueba'); }
} as unknown as TelegramApi;

function message(text: string): TelegramMessage {
  return { message_id: 7, chat: { id: 42, type: 'private' }, from: { id: 9 }, text };
}

function enabled(): boolean {
  return redactionEnabledFromEnv(process.env, ENV_KEY, false);
}

describe('conmutador de ingesta del puente de Telegram', () => {
  it('ausente queda apagado', () => {
    expect(enabled()).toBe(false);
  });

  it('sólo "1" lo enciende; "0", vacío y cualquier otro valor lo dejan apagado', () => {
    process.env[ENV_KEY] = '1';
    expect(enabled()).toBe(true);
    for (const valor of ['0', '', 'true', 'si', 'yes', '2']) {
      process.env[ENV_KEY] = valor;
      expect(enabled()).toBe(false);
    }
  });

  it('el interruptor decide el recorrido profundo, no la presencia del secreto', () => {
    expect(redactSecretsDeep({ text: SECRET }, { enabled: enabled() }).count).toBe(0);
    process.env[ENV_KEY] = '1';
    expect(redactSecretsDeep({ text: SECRET }, { enabled: enabled() }).count).toBe(1);
  });
});

describe('el punto de llamada de la ingesta', () => {
  it('apagado: el cuerpo publicado conserva el secreto y no lleva marca', async () => {
    const cuerpo = await normalizedBody(message(SECRET), 42, api);
    expect(cuerpo.text).toBe(SECRET);
    expect(cuerpo.redacted_v1).toBeUndefined();
  });

  it('encendido: el cuerpo sale redactado y con el recuento por familia', async () => {
    process.env[ENV_KEY] = '1';
    const cuerpo = await normalizedBody(message(SECRET), 42, api);
    expect(cuerpo.text).toBe('postgresql://[credencial-redactada]@ep-dry.neon.tech/neondb');
    expect(cuerpo.redacted_v1).toEqual({ count: 1, kinds: ['uri_credentials'] });
  });

  it('un valor que no es "1" mantiene el comportamiento apagado de siempre', async () => {
    process.env[ENV_KEY] = 'true';
    const cuerpo = await normalizedBody(message(SECRET), 42, api);
    expect(cuerpo.text).toBe(SECRET);
    expect(cuerpo.redacted_v1).toBeUndefined();
  });
});
