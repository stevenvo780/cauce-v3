import { readFile } from 'node:fs/promises';
import { logEvent } from '@cauce/protocol';
import { DecisionError, type DecisionErrorCode } from './errors.js';
import { isPlainObject, type JevQuestions, type JsonValue } from './questions.js';

export const OFFICIAL_JEV_ORIGIN = 'https://api.typesafe.ai';
export const DEFAULT_JEV_URL = `${OFFICIAL_JEV_ORIGIN}/v1/systemone`;

export interface JevClientOptions {
  readonly url: string;
  readonly keyFile: string;
  readonly model: string;
  /** Budget for the whole decision, retries and waits included. */
  readonly totalTimeoutMs: number;
  readonly attemptTimeoutMs: number;
  readonly maxRounds: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  /** A second identical request is launched when the first is this slow; 0 disables it. */
  readonly hedgeAfterMs: number;
  readonly fetch?: typeof fetch;
  readonly random?: () => number;
}

export interface JevCallResult {
  readonly body: unknown;
  readonly requestId: string | undefined;
  readonly requests: number;
  /** Requests Jev may have billed: all of them except those it answered with an HTTP error. */
  readonly billable: number;
  readonly ms: number;
}

export interface JevCaller {
  /** Most requests one decision can send (rounds times hedged copies), to reserve its budget. */
  readonly maxRequests: number;
  evaluate(state: JsonValue, questions: JevQuestions): Promise<JevCallResult>;
  credentialPresent(): Promise<boolean>;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const KEY_SHAPE = /^[\x21-\x7e]{16,512}$/u;

class Failure extends Error {
  /** Jev answered with an HTTP error status, so it did not bill the request. */
  rejected = false;

  constructor(
    readonly code: DecisionErrorCode,
    readonly retryable: boolean,
    readonly detail: string,
    readonly retryAfterMs?: number,
  ) {
    super(detail);
    this.name = 'JevFailure';
  }
}

/** Only the upstream error *type* is kept: the body may echo request content and never reaches a log. */
function upstreamErrorType(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    const detail = isPlainObject(parsed) && isPlainObject(parsed.detail) ? parsed.detail.error_type : undefined;
    if (typeof detail === 'string' && /^[a-z_]{1,64}$/u.test(detail)) return detail;
  } catch { /* not JSON: an edge error page */ }
  return 'sin_detalle';
}

export function parseRetryAfter(headers: Headers, now: number): number | undefined {
  const milliseconds = headers.get('retry-after-ms');
  if (milliseconds !== null && /^\d+(\.\d+)?$/u.test(milliseconds)) return Number(milliseconds);
  const value = headers.get('retry-after');
  if (value === null) return undefined;
  if (/^\d+$/u.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function classify(status: number, text: string, retryAfterMs: number | undefined): Failure {
  const type = upstreamErrorType(text);
  if (status === 401 || status === 403) return new Failure('jev_credencial_rechazada', false, `Jev rechazó la credencial (HTTP ${String(status)})`);
  if (status === 408) return new Failure('jev_timeout', true, 'Jev agotó su propio tiempo (HTTP 408)', retryAfterMs);
  if (status === 429) return new Failure('jev_limite', true, `Jev limitó la tasa (${type})`, retryAfterMs);
  if (status === 529) return new Failure('jev_sobrecargado', true, `Jev está sobrecargado (${type})`, retryAfterMs);
  if (status >= 500) return new Failure('jev_error', true, `Jev falló (HTTP ${String(status)}, ${type})`, retryAfterMs);
  if (status >= 400) return new Failure('jev_solicitud_rechazada', false, `Jev rechazó la solicitud (HTTP ${String(status)}, ${type})`);
  return new Failure('jev_error', false, `Jev respondió HTTP ${String(status)} inesperado`);
}

async function limitedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Failure('jev_respuesta_invalida', false, 'la respuesta de Jev excede 1 MiB');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface Success { readonly body: unknown; readonly requestId: string | undefined }

/**
 * Races up to two identical requests: the second starts only if the first is still pending. A
 * rejection that no retry can cure (credential, request body) ends the race at once, so waiting on
 * the other copy can never turn it into a retryable timeout.
 */
function hedged(launch: (signal: AbortSignal) => Promise<Success>, hedgeAfterMs: number): Promise<Success> {
  return new Promise((resolve, reject) => {
    const controllers: AbortController[] = [];
    let inFlight = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (): void => {
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const controller of controllers) controller.abort();
    };
    const start = (): void => {
      const controller = new AbortController();
      controllers.push(controller);
      inFlight += 1;
      launch(controller.signal).then((success) => {
        if (settled) return;
        settle();
        resolve(success);
      }, (error: unknown) => {
        inFlight -= 1;
        const final = error instanceof Failure && !error.retryable;
        if (settled || (inFlight > 0 && !final)) return;
        settle();
        reject(error instanceof Error ? error : new Error('fallo desconocido'));
      });
    };
    start();
    if (hedgeAfterMs > 0) timer = setTimeout(() => { timer = undefined; if (!settled) start(); }, hedgeAfterMs);
  });
}

export class JevClient implements JevCaller {
  private readonly fetchImpl: typeof fetch;
  private readonly random: () => number;
  private missingLoggedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: JevClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.random = options.random ?? Math.random;
  }

  get maxRequests(): number {
    return this.options.maxRounds * (this.options.hedgeAfterMs > 0 ? 2 : 1);
  }

  /**
   * Read on every call, so an in-place rotation needs no restart (a replaced file is not: the secret
   * is a bind mount pinned to its inode). The value never leaves this method.
   */
  private async key(): Promise<string> {
    let raw: string;
    try {
      raw = await readFile(this.options.keyFile, 'utf8');
    } catch {
      throw this.missing('el servicio no tiene la credencial de Jev: aplicá el respaldo');
    }
    const key = raw.trim();
    if (!KEY_SHAPE.test(key)) throw this.missing('la credencial de Jev está vacía o mal formada');
    return key;
  }

  /* The container stays healthy without a key on purpose (that is how Jev is switched off), so the
     log is where an unreadable key after a rotation shows up. */
  private missing(message: string): DecisionError {
    const now = Date.now();
    if (now - this.missingLoggedAt >= 60_000) {
      this.missingLoggedAt = now;
      logEvent('decisiones_sin_credencial_jev', { reason: message }, { level: 'error' });
    }
    return new DecisionError('jev_sin_credencial', message);
  }

  async credentialPresent(): Promise<boolean> {
    try {
      const raw = await readFile(this.options.keyFile, 'utf8');
      return KEY_SHAPE.test(raw.trim());
    } catch {
      return false;
    }
  }

  private async once(body: string, key: string, timeoutMs: number, signal: AbortSignal): Promise<Success> {
    const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch {
      if (timeout.aborted) throw new Failure('jev_timeout', true, `Jev no respondió en ${String(timeoutMs)} ms`);
      throw new Failure('jev_red', true, 'no se pudo conectar con Jev');
    }
    const requestId = response.headers.get('x-typesafe-request-id') ?? undefined;
    let text: string;
    try {
      text = await limitedText(response);
    } catch (error) {
      if (error instanceof Failure) throw error;
      throw new Failure(timeout.aborted ? 'jev_timeout' : 'jev_red', true, 'la respuesta de Jev se cortó');
    }
    if (!response.ok) {
      const failure = classify(response.status, text, parseRetryAfter(response.headers, Date.now()));
      failure.rejected = true;
      throw failure;
    }
    try {
      return { body: JSON.parse(text) as unknown, requestId };
    } catch {
      throw new Failure('jev_respuesta_invalida', false, 'Jev devolvió algo que no es JSON');
    }
  }

  private backoff(round: number): number {
    const base = Math.min(this.options.backoffMaxMs, this.options.backoffBaseMs * 2 ** round);
    return Math.round(base * (0.75 + this.random() * 0.5));
  }

  async evaluate(state: JsonValue, questions: JevQuestions): Promise<JevCallResult> {
    const key = await this.key();
    const started = Date.now();
    const deadline = started + this.options.totalTimeoutMs;
    const body = JSON.stringify({ model: this.options.model, state, questions });
    let requests = 0;
    let rejected = 0;
    let last = new Failure('jev_timeout', true, `Jev no respondió en ${String(this.options.totalTimeoutMs)} ms`);
    for (let round = 0; round < this.options.maxRounds; round += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const success = await hedged((signal) => {
          requests += 1;
          return this.once(body, key, Math.min(this.options.attemptTimeoutMs, deadline - Date.now()), signal).catch((error: unknown) => {
            if (error instanceof Failure && error.rejected) rejected += 1;
            throw error;
          });
        }, this.options.hedgeAfterMs);
        return { ...success, requests, billable: requests - rejected, ms: Date.now() - started };
      } catch (error) {
        last = error instanceof Failure ? error : new Failure('jev_error', false, 'fallo inesperado llamando a Jev');
        if (!last.retryable || round === this.options.maxRounds - 1) break;
        const wait = last.retryAfterMs ?? this.backoff(round);
        if (Date.now() + wait >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    throw new DecisionError(last.code, `${last.detail} tras ${String(requests)} solicitud(es)`, {
      requests,
      billable: requests - rejected,
      ...(last.retryAfterMs === undefined ? {} : { retryAfterMs: last.retryAfterMs }),
    });
  }
}

/** Refuses any Jev endpoint that is not the official origin: look-alike sites would receive the key. */
export function assertOfficialJevUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.origin !== OFFICIAL_JEV_ORIGIN || parsed.username !== '' || parsed.password !== '') {
    throw new Error(`el endpoint de Jev debe estar en ${OFFICIAL_JEV_ORIGIN}`);
  }
}
