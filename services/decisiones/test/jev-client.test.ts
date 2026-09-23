import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionError } from '../src/errors.js';
import { assertOfficialJevUrl, JevClient, parseRetryAfter, type JevClientOptions } from '../src/jev-client.js';
import { loadConfig } from '../src/config.js';
import { validateQuestions } from '../src/questions.js';
import { FakeJev } from './support/fake-jev.js';

const KEY = 'tsk_prueba_0123456789abcdefghijklmnop';
const directory = mkdtempSync(join(tmpdir(), 'cauce-jev-'));
const keyFile = join(directory, 'typesafe-jev.key');
writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
const QUESTIONS = validateQuestions({ urgente: { type: 'noul', instructions: '¿Es urgente?' } });

const jev = new FakeJev();
beforeAll(async () => { await jev.start(); });
afterAll(async () => { await jev.stop(); });
beforeEach(() => { jev.seen.length = 0; });

function client(overrides: Partial<JevClientOptions> = {}): JevClient {
  return new JevClient({
    url: jev.url, keyFile, model: 'jev-latest', totalTimeoutMs: 4_000, attemptTimeoutMs: 1_500,
    maxRounds: 3, backoffBaseMs: 20, backoffMaxMs: 100, hedgeAfterMs: 0, random: () => 0.5, ...overrides,
  });
}

async function failure(promise: Promise<unknown>): Promise<DecisionError> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(DecisionError);
  expect((error as Error).message).not.toContain(KEY);
  return error as DecisionError;
}

describe('cliente de Jev', () => {
  it('manda el modelo, la clave sólo en Authorization y devuelve el request id', async () => {
    const result = await client().evaluate({ texto: 'hola' }, QUESTIONS);
    expect(jev.seen).toHaveLength(1);
    expect(jev.seen[0]?.authorization).toBe(`Bearer ${KEY}`);
    expect(jev.seen[0]?.body).toMatchObject({ model: 'jev-latest', state: { texto: 'hola' }, questions: QUESTIONS });
    expect(result).toMatchObject({ requestId: 'req_1', requests: 1 });
  });

  it('reintenta 429 respetando retry-after y 529/520 con backoff', async () => {
    jev.respond((_request, index) => index === 0
      ? { status: 429, headers: { 'retry-after-ms': '30' }, body: { detail: { error_type: 'rate_limited' } } }
      : index === 1 ? { status: 529, body: { detail: { error_type: 'system_overloaded' } } }
        : index === 2 ? { status: 520, raw: 'error code: 520' }
          : { body: { model: 'jev-1.13.0', answers: { urgente: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 10, output_tokens: 1 } } });
    const result = await client({ maxRounds: 4 }).evaluate('x', QUESTIONS);
    expect(result.requests).toBe(4);
  });

  it('no reintenta 401 ni 422 y nunca filtra la clave', async () => {
    jev.respond(() => ({ status: 401, body: { detail: 'bad key' } }));
    expect((await failure(client().evaluate('x', QUESTIONS))).code).toBe('jev_credencial_rechazada');
    expect(jev.seen).toHaveLength(1);
    jev.seen.length = 0;
    jev.respond(() => ({ status: 422, body: { detail: { error_type: 'validation_error', echo: KEY } } }));
    const rejected = await failure(client().evaluate('x', QUESTIONS));
    expect(rejected.code).toBe('jev_solicitud_rechazada');
    expect(rejected.message).toContain('validation_error');
    expect(jev.seen).toHaveLength(1);
  });

  it('corta por intento y por presupuesto total con jev_timeout', async () => {
    jev.respond(() => ({ delayMs: 2_000, body: {} }));
    const error = await failure(client({ attemptTimeoutMs: 200, totalTimeoutMs: 700, maxRounds: 5 }).evaluate('x', QUESTIONS));
    expect(error.code).toBe('jev_timeout');
    expect(jev.seen.length).toBeGreaterThanOrEqual(2);
  });

  it('una segunda solicitud de respaldo gana a la primera cuando ésta se cuelga', async () => {
    jev.respond((_request, index) => index === 0
      ? { delayMs: 3_000, body: {} }
      : { body: { model: 'jev-1.13.0', answers: { urgente: { type: 'noul', noul: 0.3 } }, usage: { input_tokens: 5, output_tokens: 1 } } });
    const started = Date.now();
    const result = await client({ hedgeAfterMs: 100, attemptTimeoutMs: 3_500 }).evaluate('x', QUESTIONS);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.requests).toBe(2);
  });

  it('sin fichero de clave responde jev_sin_credencial sin tocar la red', async () => {
    const error = await failure(client({ keyFile: join(directory, 'no-existe') }).evaluate('x', QUESTIONS));
    expect(error.code).toBe('jev_sin_credencial');
    expect(jev.seen).toHaveLength(0);
    expect(await client({ keyFile: '/dev/null' }).credentialPresent()).toBe(false);
  });

  it('sólo acepta el origen oficial de Jev en producción', () => {
    expect(() => { assertOfficialJevUrl('https://api.typesafe.ai/v1/systemone'); }).not.toThrow();
    for (const impostor of ['https://jevapi.org/v1/systemone', 'https://api.typesafe.ai.jev-ai.pro/v1', 'http://api.typesafe.ai/v1/systemone']) {
      expect(() => { assertOfficialJevUrl(impostor); }).toThrow(/api\.typesafe\.ai/u);
    }
    const base = { CAUCE_DECISIONES_TLS_CERT_FILE: 'c', CAUCE_DECISIONES_TLS_KEY_FILE: 'k', CAUCE_DECISIONES_CLIENT_CA_FILE: 'a', CAUCE_DECISIONES_IDENTITY_FILE: 'i' };
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', CAUCE_DECISIONES_JEV_URL: 'https://jevtypesafeai.com/v1/systemone' })).toThrow(/api\.typesafe\.ai/u);
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).jev).toMatchObject({ url: 'https://api.typesafe.ai/v1/systemone', keyFile: '/etc/cauce-v3/secrets/typesafe-jev.key', model: 'jev-latest', totalTimeoutMs: 30_000 });
  });

  it('interpreta retry-after en segundos, milisegundos y fecha', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '2' }), 0)).toBe(2_000);
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '150' }), 0)).toBe(150);
    expect(parseRetryAfter(new Headers({ 'retry-after': new Date(10_000).toUTCString() }), 4_000)).toBe(6_000);
    expect(parseRetryAfter(new Headers(), 0)).toBeUndefined();
  });
});
