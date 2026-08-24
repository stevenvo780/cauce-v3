import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { GovernanceRelayClient, RelayFileRead } from './agent-documents.js';
import type { GovernanceReadError } from './agent-documents.routes.js';

/**
 * `GovernanceRelayClient` de verdad: habla con `POST /v3/terminal/relay/read` del terminal-relay.
 *
 * Copia el patrón de `HttpsTerminalGatewayClient` (el cliente que el relay usa contra el gateway)
 * porque es el mismo problema en el sentido contrario: dos procesos en dos máquinas, unidos por un
 * token compartido, con TLS mutuo por debajo. Aquí el que presenta el token es el gateway.
 *
 * NUNCA lanza por un fallo de red. Un relay caído tiene que verse en el modal como «no se pudo
 * leer», con el motivo, y no como una pantalla en blanco ni como un 500 del gateway.
 */

/**
 * Tope de lo que se acumula de la respuesta. El relay sirve hasta 256 KB de contenido, y el JSON
 * que lo envuelve lo infla (`\n` y los acentos van escapados), así que el doble es el margen que
 * hace falta para no cortar una lectura legítima.
 */
const MAX_RESPONSE_BYTES = 512 * 1024;

/**
 * Por encima de lo que el relay tarda en rendirse. El relay corta su propia lectura a los 5 s: si
 * el gateway cortara antes, se perdería la respuesta HONESTA (`timeout` con su motivo) y se
 * cambiaría por un fallo de transporte que no dice nada de qué pasó dentro del contenedor.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

const READ_CODES: readonly GovernanceReadError['error'][] = [
  'not_found', 'permission_denied', 'invalid_path', 'symlink_detected',
  'too_large', 'timeout', 'unavailable', 'unknown'
];

export interface HttpGovernanceRelayClientOptions {
  /** Origen HTTPS del lado navegador del relay, p. ej. `https://terminal-relay:8446`. */
  readonly relayUrl: string;
  /** El token compartido, ya en memoria: es el mismo `relayToken` de `TerminalConfig`. */
  readonly token: string;
  readonly timeoutMs?: number;
  /** CA del certificado de servidor del relay, si lo firma una CA privada. */
  readonly ca?: Buffer;
  /**
   * Identidad de cliente. NO es opcional en la práctica: el listener del relay se levanta con
   * `requestCert`/`rejectUnauthorized`, así que sin certificado firmado por la CA de la consola el
   * handshake muere antes de que el token llegue a leerse. Se deja opcional en el tipo para que un
   * despliegue mal configurado dé un fallo de lectura explicado, y no un fallo al arrancar.
   */
  readonly clientCert?: Buffer;
  readonly clientKey?: Buffer;
}

interface HttpResult {
  readonly status: number;
  readonly body: string;
  /** El relay se pasó del tope y se cortó la respuesta a medias. */
  readonly overflowed: boolean;
}

function stringField(source: Record<string, unknown>, name: string): string | undefined {
  const value = source[name];
  return typeof value === 'string' ? value : undefined;
}

/** Un código que no reconocemos es `unknown`, nunca se propaga tal cual. */
function normalizeCode(value: string): GovernanceReadError['error'] {
  return READ_CODES.includes(value as GovernanceReadError['error'])
    ? (value as GovernanceReadError['error'])
    : 'unknown';
}

/**
 * Lo que el relay contestó, ya entendido. Una respuesta que no se entiende del todo NO se completa
 * con valores por defecto: se devuelve como fallo. Rellenar huecos aquí sería inventar el contenido
 * o el tamaño de un fichero que nadie leyó.
 */
export function parseReadOutcome(body: string): RelayFileRead | GovernanceReadError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { error: 'unknown', reason: 'el terminal-relay contestó algo que no es JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'unknown', reason: 'el terminal-relay contestó algo que no es un objeto' };
  }
  const source = parsed as Record<string, unknown>;
  const failure = stringField(source, 'error');
  if (failure !== undefined) {
    return {
      error: normalizeCode(failure),
      reason: stringField(source, 'reason') ?? 'el terminal-relay no explicó el fallo'
    };
  }

  const path = stringField(source, 'path');
  const modifiedAt = stringField(source, 'modified_at');
  const content = stringField(source, 'content');
  const bytes = source.bytes;
  const truncated = source.truncated;
  if (path === undefined || modifiedAt === undefined || content === undefined) {
    return { error: 'unknown', reason: 'la lectura vino sin ruta, sin fecha o sin contenido' };
  }
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
    return { error: 'unknown', reason: 'la lectura vino sin un tamaño creíble' };
  }
  if (typeof truncated !== 'boolean') {
    return { error: 'unknown', reason: 'la lectura no dice si viene recortada' };
  }
  return { path, bytes, truncated, modified_at: modifiedAt, content };
}

export class HttpGovernanceRelayClient implements GovernanceRelayClient {
  private readonly relayUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly ca: Buffer | undefined;
  private readonly clientCert: Buffer | undefined;
  private readonly clientKey: Buffer | undefined;

  constructor(options: HttpGovernanceRelayClientOptions) {
    this.relayUrl = options.relayUrl;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.ca = options.ca;
    this.clientCert = options.clientCert;
    this.clientKey = options.clientKey;
  }

  async readFile(tenantId: string, alias: string, path: string): Promise<RelayFileRead | GovernanceReadError> {
    let result: HttpResult;
    try {
      result = await this.send({ tenant_id: tenantId, alias, path });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'sin detalle';
      // El vencimiento se distingue del resto porque significa otra cosa para quien mira el modal:
      // el relay puede estar vivo y ser el agente el que no contesta.
      const timedOut = message.includes('timed out');
      return {
        error: timedOut ? 'timeout' : 'unavailable',
        reason: `no se pudo hablar con el terminal-relay: ${message}`
      };
    }
    if (result.overflowed) {
      return { error: 'too_large', reason: 'el terminal-relay mandó más de lo que esta vía acepta' };
    }
    if (result.status === 401 || result.status === 403) {
      return { error: 'permission_denied', reason: 'el terminal-relay rechazó la credencial del gateway' };
    }
    if (result.status !== 200) {
      return { error: 'unavailable', reason: `el terminal-relay contestó ${result.status}` };
    }
    return parseReadOutcome(result.body);
  }

  private async send(body: Readonly<Record<string, unknown>>): Promise<HttpResult> {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const url = new URL('/v3/terminal/relay/read', this.relayUrl);
    const options: RequestOptions = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': payload.byteLength
      },
      ...(this.ca === undefined ? {} : { ca: this.ca }),
      ...(this.clientCert === undefined || this.clientKey === undefined
        ? {}
        : { cert: this.clientCert, key: this.clientKey })
    };
    return new Promise<HttpResult>((resolve, reject) => {
      const request = httpsRequest(url, options, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let overflowed = false;
        response.on('data', (chunk: Buffer) => {
          if (overflowed) return;
          size += chunk.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            // Se corta la descarga en cuanto se pasa: acumular el resto sólo serviría para gastar
            // la memoria del gateway en algo que ya se va a rechazar.
            overflowed = true;
            response.destroy();
            resolve({ status: response.statusCode ?? 0, body: '', overflowed: true });
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (overflowed) return;
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), overflowed: false });
        });
        response.on('error', reject);
      });
      request.setTimeout(this.timeoutMs, () => {
        request.destroy(new Error('terminal relay request timed out'));
      });
      request.on('error', reject);
      request.write(payload);
      request.end();
    });
  }
}
