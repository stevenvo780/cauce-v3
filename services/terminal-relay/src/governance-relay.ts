import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { AgentLookup } from './agent-leg.js';
import { requestFileRead, type FileReadOutcome } from './gateway-client.js';
import { errorLabel, logEvent } from './log.js';

/**
 * `POST /v3/terminal/relay/read` — la única puerta HTTP por la que se pide un fichero de gobierno.
 *
 * Es el eslabón que faltaba entre el gateway y el pty-agent: `requestFileRead` ya sabía hablar con
 * el agente, pero nadie desde fuera del proceso podía llamarla. Esto la expone, y nada más.
 *
 * Lo que este módulo NO decide:
 *  - QUÉ se puede leer. La ruta la resuelve el gateway desde hechos medidos (`verifyReadablePath`)
 *    y el pty-agent la vuelve a validar contra su propia lista blanca antes de abrir nada. El relay
 *    no tiene los hechos del alias, así que no tiene con qué opinar; si opinara con menos
 *    información que los otros dos, sería una tercera regla que se contradice con las buenas.
 *  - QUIÉN puede pedirlo. Eso lo resolvió el gateway con el principal de la consola. Aquí sólo se
 *    comprueba que quien llama ES el gateway.
 *
 * Lo que sí decide, y por eso está aquí: que la llamada no pueda hacerle daño al resto. Cuerpo
 * acotado, alias con forma de alias, y la lectura delegada a `requestFileRead`, que ya corta por
 * tiempo, por bytes y por agente que no anuncia la capacidad.
 *
 * SOBRE EL TRANSPORTE: esto se engancha al servidor HTTPS del lado navegador, que
 * `createBrowserHttpsServer` levanta con `requestCert`/`rejectUnauthorized`. O sea que antes de
 * llegar a este código el par ya presentó un certificado de cliente firmado por la CA de la
 * consola. El token es la SEGUNDA barrera, no la única.
 */

/** Ruta de la lectura. Vive fuera de `/v3/console/` por lo mismo que las del gateway: no es un navegador. */
export const GOVERNANCE_READ_PATH = '/v3/terminal/relay/read';

/** El cuerpo es un objeto con tres cadenas cortas. Cualquier cosa más grande no es esta llamada. */
const MAX_REQUEST_BYTES = 8 * 1024;

/** Misma forma de alias que exige el gateway al pedir una sesión de terminal. */
const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/u;

const MAX_TENANT_LENGTH = 64;
const MAX_PATH_LENGTH = 4096;

export interface GovernanceRelayOptions {
  /** El mismo servidor del lado navegador; se le añade un oyente de `request`, no se crea otro. */
  readonly server: HttpsServer;
  readonly agents: AgentLookup;
  /**
   * El token compartido con el gateway. Es una función y no una cadena a propósito: el relay ya lee
   * su token del disco en cada llamada saliente, y así rotarlo tampoco obliga a reiniciar aquí.
   */
  readonly token: () => Promise<string>;
  /** Se propaga a `requestFileRead`; su default (5 s) es el que manda si no se pasa nada. */
  readonly timeoutMs?: number;
}

interface ReadRequest {
  readonly tenantId: string;
  readonly alias: string;
  readonly path: string;
}

/** Digerir antes de comparar: tiempo constante, y una longitud distinta no revienta ni se filtra. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function authorized(header: unknown, expected: string): boolean {
  const authorization = typeof header === 'string' ? header : undefined;
  if (authorization === undefined || !authorization.startsWith('Bearer ')) return false;
  return timingSafeEqual(digest(authorization.slice(7)), digest(expected));
}

/**
 * El cuerpo, o `undefined` si se pasó del tope. Quien mande un volcado no consigue que el relay lo
 * guarde entero antes de rechazarlo.
 */
async function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        // Se deja de ACUMULAR, pero se sigue drenando. Cortar el socket a media petición le llega
        // al que llama como una conexión caída, y entonces el 413 —que es la explicación de por qué
        // no se le contestó— no lo lee nadie. Lo que queda acotado aquí es la MEMORIA, no la
        // transferencia: de quién puede siquiera abrir esta conexión ya se ocupa el TLS mutuo.
        overflowed = true;
        chunks.length = 0;
        return;
      }
      if (!overflowed) chunks.push(chunk);
    });
    request.on('end', () => resolve(overflowed ? undefined : Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** El pedido, o el motivo del rechazo. Falla cerrado: un campo que no cuadra no se corrige, se rechaza. */
export function parseReadRequest(raw: string): ReadRequest | { readonly rejected: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { rejected: 'el cuerpo no es JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { rejected: 'el cuerpo tiene que ser un objeto' };
  }
  const source = parsed as Record<string, unknown>;
  const tenantId = source.tenant_id;
  const alias = source.alias;
  const path = source.path;
  if (typeof tenantId !== 'string' || tenantId.length === 0 || tenantId.length > MAX_TENANT_LENGTH) {
    return { rejected: 'tenant_id es obligatorio' };
  }
  if (typeof alias !== 'string' || !ALIAS_PATTERN.test(alias)) {
    return { rejected: 'alias no tiene forma de alias' };
  }
  // La ruta se valida sólo en lo que hace falta para no romper el cable; QUÉ ruta es aceptable lo
  // deciden el gateway y el pty-agent, cada uno con su lista y sus hechos.
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > MAX_PATH_LENGTH || path.includes('\0')) {
    return { rejected: 'path tiene que ser una ruta absoluta sin bytes nulos' };
  }
  return { tenantId, alias, path };
}

/** `body` es `unknown` y no un registro: lo que se sirve son tipos cerrados (`FileReadOutcome`). */
function send(response: ServerResponse, status: number, body?: unknown): void {
  if (response.writableEnded) return;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, {
    'content-length': payload?.byteLength ?? 0,
    'cache-control': 'no-store',
    ...(payload === undefined ? {} : { 'content-type': 'application/json' })
  });
  response.end(payload);
}

async function handle(
  options: GovernanceRelayOptions,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const path = (request.url ?? '/').split('?', 1)[0];
  if (path !== GOVERNANCE_READ_PATH) {
    request.resume();
    send(response, 404, { error: 'not_found' });
    return;
  }
  if (request.method !== 'POST') {
    request.resume();
    response.setHeader('allow', 'POST');
    send(response, 405, { error: 'method_not_allowed' });
    return;
  }

  let expected: string;
  try {
    expected = await options.token();
  } catch (error) {
    // Sin token no se puede autenticar a nadie, y dejar pasar sería justo lo contrario de fallar
    // cerrado. Es un fallo del relay, no del que llama: 503, no 401.
    logEvent('terminal_relay_read_token_unreadable', { error: errorLabel(error) });
    request.resume();
    send(response, 503, { error: 'unavailable' });
    return;
  }
  if (!authorized(request.headers.authorization, expected)) {
    // Cuerpo vacío a propósito, igual que en las rutas de relay del gateway: quien no se autentica
    // no aprende nada del plano. Y el cuerpo ni se lee: un no autenticado no mueve al pty-agent.
    logEvent('terminal_relay_read_rejected', { reason: 'bad_token' });
    request.resume();
    send(response, 401);
    return;
  }

  let raw: string | undefined;
  try {
    raw = await readBody(request);
  } catch (error) {
    logEvent('terminal_relay_read_rejected', { reason: 'body_error', error: errorLabel(error) });
    send(response, 400, { error: 'invalid_request', reason: 'no se pudo leer el cuerpo' });
    return;
  }
  if (raw === undefined) {
    send(response, 413, { error: 'invalid_request', reason: 'el cuerpo se pasa del tope' });
    return;
  }
  const parsed = parseReadRequest(raw);
  if ('rejected' in parsed) {
    logEvent('terminal_relay_read_rejected', { reason: 'invalid_request' });
    send(response, 400, { error: 'invalid_request', reason: parsed.rejected });
    return;
  }

  const connection = options.agents.lookup(parsed.tenantId, parsed.alias);
  if (!connection) {
    // 200 con un fallo de LECTURA, no 404: la llamada llegó y se contestó. Que el alias no tenga
    // pty-agent conectado es un hecho del alias, y el modal tiene que poder decirlo con esas
    // palabras en vez de enseñar un error de transporte.
    const offline: FileReadOutcome = {
      error: 'unavailable',
      reason: 'no hay ningún pty-agent conectado para ese alias'
    };
    logEvent('terminal_relay_read_served', {
      tenant_id: parsed.tenantId, alias: parsed.alias, path: parsed.path, error: 'unavailable'
    });
    send(response, 200, offline);
    return;
  }

  const outcome = await requestFileRead(
    connection,
    parsed.tenantId,
    parsed.alias,
    parsed.path,
    options.timeoutMs
  );
  const failed = 'error' in outcome;
  // Nunca el contenido: el tamaño y el veredicto bastan para diagnosticar, y el manual de un alias
  // es suyo. Lo mismo vale para el resto de este fichero.
  logEvent('terminal_relay_read_served', {
    tenant_id: parsed.tenantId,
    alias: parsed.alias,
    path: parsed.path,
    error: failed ? outcome.error : null,
    bytes: failed ? null : outcome.bytes
  });
  send(response, 200, outcome);
}

/**
 * Engancha la lectura de gobierno al servidor del lado navegador.
 *
 * No recibe el cliente del gateway a propósito: la decisión de si esta lectura vale ya la tomó el
 * gateway antes de llamar, así que preguntársela de vuelta sería un viaje de ida y vuelta que no
 * cambia ningún resultado. Lo único que hace falta saber es que quien llama es él, y eso es el token.
 */
export function setupGovernanceRelay(options: GovernanceRelayOptions): void {
  options.server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    handle(options, request, response).catch((error: unknown) => {
      // Una lectura rota no puede tumbar el proceso y con él todas las terminales abiertas.
      logEvent('terminal_relay_read_failed', { error: errorLabel(error) });
      send(response, 500, { error: 'unknown', reason: 'la lectura falló en el relay' });
    });
  });
}
