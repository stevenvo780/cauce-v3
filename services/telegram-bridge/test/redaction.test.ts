import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redactSecrets, redactSecretsDeep } from '../src/redaction.js';
import { normalizedBody } from '../src/poller.js';
import type { TelegramApi, TelegramMessage } from '../src/types.js';

/**
 * Los dos lados pesan distinto.
 *
 * Abajo hay tantas pruebas de "NO se toca" como de "sí se redacta", y es a propósito: un secreto
 * que se cuela es un incidente puntual; un falso positivo mutila el mensaje del dueño TODOS los
 * días. Si alguna de las dos mitades hay que aflojar, es la de arriba.
 */

const api = {
  async getFile() { throw new Error('no'); },
  async downloadFile() { throw new Error('no'); }
} as unknown as TelegramApi;

function message(text: string): TelegramMessage {
  return { message_id: 7, chat: { id: 42, type: 'private' }, from: { id: 9 }, text };
}

/**
 * La redacción está APAGADA por defecto desde el 02-ago (decisión de Steven; ver la cabecera de
 * `redaction.ts`). Todo lo que sigue prueba el comportamiento CON el interruptor encendido, así que
 * hay que encenderlo explícitamente; el bloque del final prueba que apagado no toca nada.
 */
describe('redacción de secretos en la ingesta', () => {
  beforeEach(() => {
    process.env.CAUCE_TELEGRAM_REDACT_INGRESS = '1';
  });
  afterEach(() => {
    delete process.env.CAUCE_TELEGRAM_REDACT_INGRESS;
  });

  /* ---------------- Lo que SÍ se redacta ---------------- */

  it('redacta la URI con credenciales del caso medido (mensaje ced40f3c, 02-ago 13:00)', () => {
    const crudo = '# Recommended for most uses\n'
      + 'DATABASE_URL=postgresql://neondb_owner:npg_mCRl9zxXQ7qG@ep-dry-smoke-au2e5vtg-pooler'
      + '.c-10.us-east-2.aws.neon.tech/neondb?sslmode=require';
    const resultado = redactSecrets(crudo);
    expect(resultado.value).not.toContain('npg_mCRl9zxXQ7qG');
    expect(resultado.value).not.toContain('neondb_owner:');
    // El host sobrevive: el agente necesita saber contra qué se estaba conectando el humano.
    expect(resultado.value).toContain('ep-dry-smoke-au2e5vtg-pooler');
    expect(resultado.value).toContain('postgresql://[credencial-redactada]@');
    expect(resultado.kinds).toContain('uri_credentials');
  });

  it('redacta mysql, redis, amqp, mongodb y https con usuario:clave', () => {
    for (const uri of [
      'mysql://root:s3cr3t@db.local/app',
      'redis://default:AbCdEf123456@cache:6379',
      'amqps://user:pass@rabbit.example.com/vhost',
      'mongodb+srv://admin:qwerty123@cluster0.mongodb.net',
      'https://usuario:clave@panel.interno/admin'
    ]) {
      const resultado = redactSecrets(uri);
      expect(resultado.value).toContain('[credencial-redactada]');
      expect(resultado.kinds).toEqual(['uri_credentials']);
    }
  });

  it('redacta la cabecera Authorization en sus dos escrituras', () => {
    expect(redactSecrets('-H "Authorization: Bearer sk_live_9182abcdefghij"').value)
      .toBe('-H "Authorization: Bearer [secreto-redactado]"');
    expect(redactSecrets('AUTHORIZATION=Basic dXNlcjpwYXNz').value)
      .toBe('AUTHORIZATION=Basic [secreto-redactado]');
    expect(redactSecrets('authorization: aB3xY9zK1mN4pQ7r').value)
      .toBe('authorization: [secreto-redactado]');
  });

  it('redacta un Bearer suelto pegado en el chat', () => {
    const resultado = redactSecrets('probá con Bearer eyJhbGci0iJIUzI1NiIsInR5cCI6IkpXVCJ9abc');
    expect(resultado.value).toBe('probá con Bearer [secreto-redactado]');
  });

  it('redacta un token de bot de Telegram', () => {
    const resultado = redactSecrets('el token es 7482913055:AAH3kZq9_LmN4pQ7rS2tU5vW8xY1zA3bC4d y anda');
    expect(resultado.value).toBe('el token es [secreto-redactado] y anda');
    expect(resultado.kinds).toEqual(['telegram_bot_token']);
  });

  it('redacta claves con prefijo propietario y JWTs', () => {
    for (const secreto of [
      'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'AKIAIOSFODNN7EXAMPLE',
      'npg_mCRl9zxXQ7qGabcd',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    ]) {
      expect(redactSecrets(`valor: ${secreto}`).value).toBe('valor: [secreto-redactado]');
    }
  });

  it('redacta una llave privada pegada entera', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabcdef\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(pem).value).toBe('[secreto-redactado] (llave privada)');
  });

  /* ---------------- Lo que NO se toca: un falso positivo es PEOR ---------------- */

  it('no toca una URL normal, ni con puerto, ni con dos puntos en la ruta', () => {
    for (const texto of [
      'mirá https://demeter-dev.vercel.app/empresa/configuracion-clientes',
      'el panel está en http://100.64.0.6:8443/v3/messages',
      'https://github.com/stevenvo780/AutomatizacionFicadirecta/tree/feat/config-clientes',
      'la ruta es file:///workspace/clases/video/Guion-Museo-de-Identidades.docx',
      'quedó en /home/dev/.claude/projects/-workspace/memory/nota.md'
    ]) {
      expect(redactSecrets(texto).value).toBe(texto);
      expect(redactSecrets(texto).count).toBe(0);
    }
  });

  it('no toca prosa normal con dos puntos, horas ni proporciones', () => {
    for (const texto of [
      'nos vemos 15:30 en la oficina',
      'la relación quedó 1024:768 y no cuadra',
      'Autorización: pendiente de aprobación del cliente',
      'Authorization: approved',
      'Authorization: responsabilidades',
      'el password es un desastre, hay que cambiarlo',
      'PGPASSWORD y DATABASE_URL están en el .env del servidor'
    ]) {
      expect(redactSecrets(texto).value).toBe(texto);
    }
  });

  it('no toca un hash, un commit ni un sha256 sueltos', () => {
    for (const texto of [
      'commit 830cf38 y 130a72c',
      'SHA-256 568147008f03f0054df978dd540c4578b370f5b42b6d13b33703ddfe32666d31',
      'la imagen es sha256:fd9e878451d5c292597a42654a10aa3e1817af52b69811c201b3286c49661e1e'
    ]) {
      expect(redactSecrets(texto).value).toBe(texto);
    }
  });

  it('no toca un mensaje largo de trabajo real', () => {
    const texto = 'Desplegué demeter-dev. El deploy quedó READY (dpl_6Ykzgz), sha 213d613b.\n'
      + 'Revisá https://vercel.com/stevenvo780s-projects/demeter-dev y decime si te sirve así.\n'
      + 'La migración 0052 corrió sola; el buzón Enrutados ya no rechaza sin motivo.';
    expect(redactSecrets(texto).value).toBe(texto);
  });

  /* ---------------- Cuerpo completo ---------------- */

  it('el recorrido profundo no toca los bytes de un adjunto', () => {
    const cuerpo = {
      text: 'mirá: postgresql://u:p@host/db',
      attachments_v1: [{ name: 'foto.jpg', content_base64: 'AAAAAAAAAAAAAAAAAAAA' }]
    };
    const resultado = redactSecretsDeep(cuerpo);
    expect(resultado.value.text).toContain('[credencial-redactada]');
    expect(resultado.value.attachments_v1[0]!.content_base64).toBe('AAAAAAAAAAAAAAAAAAAA');
  });

  it('redacta el prompt de grupo, que es lo que realmente lee el harness', async () => {
    const cuerpo = await normalizedBody(
      message('DATABASE_URL=postgresql://neondb_owner:npg_mCRl9zxXQ7qG@ep-dry.neon.tech/neondb'),
      42,
      api,
      { threadId: '0', bucket: 'directed', untrusted: { author: { username: 'pablo' } } }
    );
    expect(JSON.stringify(cuerpo)).not.toContain('npg_mCRl9zxXQ7qG');
    expect(String(cuerpo.prompt)).toContain('[credencial-redactada]');
    expect(String(cuerpo.text)).toContain('[credencial-redactada]');
    // Dos: el `text` original y el `prompt` que se arma a partir de él. La marca cuenta
    // redacciones, no secretos distintos.
    expect(cuerpo.redacted_v1).toEqual({ count: 2, kinds: ['uri_credentials'] });
  });

  it('un mensaje normal sale byte por byte igual y SIN la marca', async () => {
    const cuerpo = await normalizedBody(message('hola, ¿cómo vas con el guion?'), 42, api);
    expect(cuerpo.text).toBe('hola, ¿cómo vas con el guion?');
    expect(cuerpo.redacted_v1).toBeUndefined();
  });
});

/**
 * El comportamiento por defecto, que es el que corre en producción desde el 02-ago.
 *
 * Sin esto la única prueba del interruptor sería leer el código: los 14 casos de arriba encienden
 * la redacción a mano y pasarían igual aunque el default estuviera al revés.
 */
describe('apagada por defecto: el dueño puede pasar credenciales', () => {
  beforeEach(() => {
    delete process.env.CAUCE_TELEGRAM_REDACT_INGRESS;
  });

  it('el token de bot que socrates no pudo instalar llega entero', () => {
    const crudo = 'Use this token to access the HTTP API:\n'
      + '7891234560:AAHkL2mQ9vZxR4tYpB6nWc8sDfGhJkLmNoP';
    const resultado = redactSecrets(crudo);
    expect(resultado.value).toBe(crudo);
    expect(resultado.count).toBe(0);
    expect(resultado.kinds).toEqual([]);
  });

  it('la URI con usuario y contraseña tampoco se toca', () => {
    const crudo = 'DATABASE_URL=postgresql://neondb_owner:npg_mCRl9zxXQ7qG@ep-dry.neon.tech/neondb';
    expect(redactSecrets(crudo).value).toBe(crudo);
    expect(redactSecretsDeep({ text: crudo, prompt: crudo }).count).toBe(0);
  });

  it('el cuerpo del mensaje sale sin la marca redacted_v1', async () => {
    const cuerpo = await normalizedBody(
      message('DATABASE_URL=postgresql://neondb_owner:npg_mCRl9zxXQ7qG@ep-dry.neon.tech/neondb'),
      42,
      api,
      { threadId: '0', bucket: 'directed', untrusted: { author: { username: 'pablo' } } }
    );
    expect(String(cuerpo.text)).toContain('npg_mCRl9zxXQ7qG');
    expect(cuerpo.redacted_v1).toBeUndefined();
  });

  it('con el interruptor en 1 vuelve a redactar, sin reiniciar el proceso', () => {
    process.env.CAUCE_TELEGRAM_REDACT_INGRESS = '1';
    try {
      expect(redactSecrets('postgresql://u:p@host/db').count).toBe(1);
    } finally {
      delete process.env.CAUCE_TELEGRAM_REDACT_INGRESS;
    }
  });
});
