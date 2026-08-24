import { readFile } from 'node:fs/promises';

export const DEFAULT_TERMINAL_WS_PATH = '/v3/console/terminal/ws';
export const DEFAULT_TERMINAL_GRANTS_FILE = '/run/cauce-terminal/grants.json';
export const DEFAULT_TICKET_TTL_SECONDS = 30;
export const MAX_TICKET_TTL_SECONDS = 120;
export const DEFAULT_SESSION_TTL_SECONDS = 900;
export const MAX_SESSION_TTL_SECONDS = 3_600;
export const DEFAULT_MAX_SESSIONS_PER_OPERATOR = 2;
export const DEFAULT_OPERATOR_HEADER = 'x-cauce-operator';

export interface TerminalConfig {
  /** WebSocket path the console dials; terminal-relay is proxied there by nginx. */
  readonly wsPath: string;
  /** HKDF master secret; per-alias keys are derived from it, it never leaves this process. */
  readonly ticketKey: Buffer;
  /**
   * Opaque bearer terminal-relay presents on /v3/terminal/relay/*.
   *
   * El MISMO secreto viaja en el sentido contrario: el gateway lo presenta al relay para leer un
   * fichero de gobierno (`POST /v3/terminal/relay/read`). Es un secreto compartido entre dos
   * procesos, no la credencial de uno de ellos, así que no hace falta un segundo token.
   */
  readonly relayToken: string;
  /**
   * Origen HTTPS del lado navegador del terminal-relay, para pedirle lecturas de gobierno.
   *
   * Opcional a propósito: sin esto el plano de terminal arranca exactamente igual que hoy y la
   * ruta de Directiva se registra igual, contestando que no se pudo leer. Un despliegue a medias
   * tiene que degradar con una razón, no impedir el boot del gateway entero.
   */
  readonly relayUrl?: string;
  /**
   * Material de cliente con el que el gateway se presenta al relay. El listener del relay exige
   * certificado (`requestCert`/`rejectUnauthorized`), así que en producción esto hace falta de
   * verdad; si falta, cada lectura falla explicando el handshake en vez de mentir.
   */
  readonly relayClientCertFile?: string;
  readonly relayClientKeyFile?: string;
  /** CA que firma el certificado de servidor del relay, si no está en el almacén del sistema. */
  readonly relayCaFile?: string;
  readonly grantsFile: string;
  readonly ticketTtlSeconds: number;
  readonly sessionTtlSeconds: number;
  readonly maxSessionsPerOperator: number;
  readonly operatorHeader: string;
  /** Operators the console may attribute a session to; empty means nobody is attributed. */
  readonly operators: ReadonlySet<string>;
}

/** Same acceptance rules as readSessionKey in main.ts: raw 32 bytes, 64 hex chars or base64. */
async function readTicketKey(path: string): Promise<Buffer> {
  const value = await readFile(path);
  if (value.byteLength === 32) return value;
  const encoded = value.toString('utf8').trim();
  const decoded = /^[a-f0-9]{64}$/i.test(encoded) ? Buffer.from(encoded, 'hex') : Buffer.from(encoded, 'base64');
  if (decoded.byteLength !== 32) throw new Error('CAUCE_TERMINAL_TICKET_KEY_FILE must contain exactly 32 key bytes');
  return decoded;
}

function boundedInteger(value: string | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined || value.trim().length === 0) return fallback;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return seconds;
}

function commaList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter((item) => item.length > 0);
}

/**
 * Mismo criterio que el relay aplica a la URL del gateway: origen HTTPS y sin credenciales dentro.
 * Una URL con usuario y contraseña sería un secreto viviendo en una variable de entorno que se
 * copia en logs y en `docker inspect`.
 */
function relayUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('CAUCE_TERMINAL_RELAY_URL must be a credential-free HTTPS origin');
  }
  return url.origin;
}

/** Ausente y vacío son lo mismo aquí: una variable puesta a '' es una variable sin poner. */
function optionalPath(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value.trim();
}

/**
 * Returns undefined unless CAUCE_TERMINAL_ENABLED is exactly '1'. In that case the gateway
 * boots byte-for-byte as it does today: no plugin, no capability, 501 on the capability route.
 */
export async function loadTerminalConfig(
  environment: NodeJS.ProcessEnv = process.env
): Promise<TerminalConfig | undefined> {
  if (environment.CAUCE_TERMINAL_ENABLED !== '1') return undefined;
  const ticketKeyPath = environment.CAUCE_TERMINAL_TICKET_KEY_FILE;
  if (!ticketKeyPath) throw new Error('CAUCE_TERMINAL_TICKET_KEY_FILE is required when the terminal plane is enabled');
  const relayTokenPath = environment.CAUCE_TERMINAL_RELAY_TOKEN_FILE;
  if (!relayTokenPath) throw new Error('CAUCE_TERMINAL_RELAY_TOKEN_FILE is required when the terminal plane is enabled');
  const relayToken = (await readFile(relayTokenPath, 'utf8')).trim();
  if (relayToken.length < 32) throw new Error('CAUCE_TERMINAL_RELAY_TOKEN_FILE must contain at least 32 characters');
  const wsPath = environment.CAUCE_TERMINAL_WS_PATH ?? DEFAULT_TERMINAL_WS_PATH;
  if (!wsPath.startsWith('/')) throw new Error('CAUCE_TERMINAL_WS_PATH must be an absolute path');
  const operatorHeader = (environment.CAUCE_TERMINAL_OPERATOR_HEADER ?? DEFAULT_OPERATOR_HEADER).toLowerCase();
  if (!/^[a-z0-9-]+$/.test(operatorHeader)) throw new Error('CAUCE_TERMINAL_OPERATOR_HEADER is invalid');
  const maxSessions = boundedInteger(
    environment.CAUCE_TERMINAL_MAX_SESSIONS_PER_OPERATOR, DEFAULT_MAX_SESSIONS_PER_OPERATOR, 64,
    'CAUCE_TERMINAL_MAX_SESSIONS_PER_OPERATOR'
  );
  // Los tres opcionales de la vía de lectura se expanden condicionalmente: con
  // `exactOptionalPropertyTypes`, un `relayUrl: undefined` explícito NO es lo mismo que ausente.
  const readUrl = relayUrl(environment.CAUCE_TERMINAL_RELAY_URL);
  const relayClientCertFile = optionalPath(environment.CAUCE_TERMINAL_RELAY_CLIENT_CERT_FILE);
  const relayClientKeyFile = optionalPath(environment.CAUCE_TERMINAL_RELAY_CLIENT_KEY_FILE);
  const relayCaFile = optionalPath(environment.CAUCE_TERMINAL_RELAY_CA_FILE);
  return {
    wsPath,
    ticketKey: await readTicketKey(ticketKeyPath),
    relayToken,
    ...(readUrl === undefined ? {} : { relayUrl: readUrl }),
    ...(relayClientCertFile === undefined ? {} : { relayClientCertFile }),
    ...(relayClientKeyFile === undefined ? {} : { relayClientKeyFile }),
    ...(relayCaFile === undefined ? {} : { relayCaFile }),
    grantsFile: environment.CAUCE_TERMINAL_GRANTS_FILE ?? DEFAULT_TERMINAL_GRANTS_FILE,
    ticketTtlSeconds: boundedInteger(
      environment.CAUCE_TERMINAL_TICKET_TTL_SECONDS, DEFAULT_TICKET_TTL_SECONDS, MAX_TICKET_TTL_SECONDS,
      'CAUCE_TERMINAL_TICKET_TTL_SECONDS'
    ),
    sessionTtlSeconds: boundedInteger(
      environment.CAUCE_TERMINAL_SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS, MAX_SESSION_TTL_SECONDS,
      'CAUCE_TERMINAL_SESSION_TTL_SECONDS'
    ),
    maxSessionsPerOperator: maxSessions,
    operatorHeader,
    operators: new Set(commaList(environment.CAUCE_TERMINAL_OPERATORS))
  };
}

/**
 * Announcement consumed by /v3/console/access and /v3/console/terminal/capability. Without it
 * the console never receives the `ultimate-terminal.connect` permission.
 */
export function terminalCapabilityAnnouncement(config: TerminalConfig): Readonly<Record<string, unknown>> {
  return {
    available: true,
    plugin_id: 'ultimate-terminal.client',
    capabilities: ['terminal.pty.client'],
    websocket_path: config.wsPath,
    target_label: 'Cauce fleet PTY'
  };
}
