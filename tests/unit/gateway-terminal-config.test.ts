import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CLAIM_LEASE_SECONDS,
  DEFAULT_MAX_SESSIONS_PER_OPERATOR,
  DEFAULT_OPERATOR_HEADER,
  DEFAULT_SESSION_TTL_SECONDS,
  DEFAULT_TERMINAL_GRANTS_FILE,
  DEFAULT_TERMINAL_WS_PATH,
  DEFAULT_TICKET_TTL_SECONDS,
  MAX_CLAIM_LEASE_SECONDS,
  MAX_SESSION_TTL_SECONDS,
  MAX_TICKET_TTL_SECONDS,
  MIN_CLAIM_LEASE_SECONDS,
  loadTerminalConfig,
  terminalCapabilityAnnouncement,
} from '../../services/gateway/src/terminal/config.js';

/**
 * Hermetic tests for `services/gateway/src/terminal/config.ts`.
 *
 * The module does three things at boot:
 *   * decodes a 32-byte ticket key from disk (raw bytes / 64 hex / base64);
 *   * reads a relay token file;
 *   * validates every env var and composes `TerminalConfig`.
 *
 * The filesystem is replaced with an in-memory map so tests never touch disk
 * and can fail closed on missing files.
 */

const fsFiles = vi.hoisted(() => new Map<string, Buffer>());
const fsMock = vi.hoisted(() => vi.fn<(path: string, encoding?: 'utf8') => Promise<Buffer | string>>());

vi.mock('node:fs/promises', () => ({
  readFile: fsMock
}));

const ENV_KEYS = [
  'CAUCE_TERMINAL_ENABLED',
  'CAUCE_TERMINAL_TICKET_KEY_FILE',
  'CAUCE_TERMINAL_RELAY_TOKEN_FILE',
  'CAUCE_TERMINAL_RELAY_INSTANCE_ID',
  'CAUCE_TERMINAL_RELAY_INSTANCE_IDS',
  'CAUCE_TERMINAL_WS_PATH',
  'CAUCE_TERMINAL_OPERATOR_HEADER',
  'CAUCE_TERMINAL_MAX_SESSIONS_PER_OPERATOR',
  'CAUCE_TERMINAL_RELAY_URL',
  'CAUCE_TERMINAL_RELAY_CLIENT_CERT_FILE',
  'CAUCE_TERMINAL_RELAY_CLIENT_KEY_FILE',
  'CAUCE_TERMINAL_RELAY_CA_FILE',
  'CAUCE_TERMINAL_GRANTS_FILE',
  'CAUCE_TERMINAL_CLAIM_LEASE_SECONDS',
  'CAUCE_TERMINAL_TICKET_TTL_SECONDS',
  'CAUCE_TERMINAL_SESSION_TTL_SECONDS',
  'CAUCE_TERMINAL_OPERATORS'
] as const;

let originalEnv: Record<string, string | undefined>;

const RELAY_INSTANCE = 'a'.repeat(64);

function putFile(path: string, contents: Buffer | string): void {
  fsFiles.set(path, typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents);
}

function clearFiles(): void {
  fsFiles.clear();
}

function baseEnv(): NodeJS.ProcessEnv {
  return {
    CAUCE_TERMINAL_ENABLED: '1',
    CAUCE_TERMINAL_TICKET_KEY_FILE: '/etc/cauce/ticket.key',
    CAUCE_TERMINAL_RELAY_TOKEN_FILE: '/etc/cauce/relay.token',
    CAUCE_TERMINAL_RELAY_INSTANCE_ID: RELAY_INSTANCE
  };
}

beforeEach(() => {
  originalEnv = {};
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    Reflect.deleteProperty(process.env, key);
  }
  clearFiles();
  // 32 raw bytes of key material + 32+ chars of relay token by default.
  putFile('/etc/cauce/ticket.key', Buffer.alloc(32, 7));
  putFile('/etc/cauce/relay.token', 'a'.repeat(40));
  fsMock.mockReset();
  fsMock.mockImplementation(async (path: string, encoding?: 'utf8') => {
    const value = fsFiles.get(path);
    if (value === undefined) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    }
    return encoding === 'utf8' ? value.toString('utf8') : value;
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  vi.unstubAllEnvs();
});

describe('constantes por defecto del plano terminal', () => {
  it('publica los nombres y topes que el resto del código espera', () => {
    expect(DEFAULT_TERMINAL_WS_PATH).toBe('/v3/console/terminal/ws');
    expect(DEFAULT_TERMINAL_GRANTS_FILE).toBe('/run/cauce-terminal/grants.json');
    expect(DEFAULT_OPERATOR_HEADER).toBe('x-cauce-operator');
    expect(DEFAULT_TICKET_TTL_SECONDS).toBe(30);
    expect(MAX_TICKET_TTL_SECONDS).toBe(120);
    expect(DEFAULT_SESSION_TTL_SECONDS).toBe(900);
    expect(MAX_SESSION_TTL_SECONDS).toBe(3_600);
    expect(DEFAULT_CLAIM_LEASE_SECONDS).toBe(150);
    expect(MIN_CLAIM_LEASE_SECONDS).toBe(131);
    expect(MAX_CLAIM_LEASE_SECONDS).toBe(300);
    expect(DEFAULT_MAX_SESSIONS_PER_OPERATOR).toBe(2);
    expect(MIN_CLAIM_LEASE_SECONDS).toBeLessThan(DEFAULT_CLAIM_LEASE_SECONDS);
    expect(DEFAULT_CLAIM_LEASE_SECONDS).toBeLessThanOrEqual(MAX_CLAIM_LEASE_SECONDS);
    expect(DEFAULT_TICKET_TTL_SECONDS).toBeLessThanOrEqual(MAX_TICKET_TTL_SECONDS);
    expect(DEFAULT_SESSION_TTL_SECONDS).toBeLessThanOrEqual(MAX_SESSION_TTL_SECONDS);
  });
});

describe('loadTerminalConfig', () => {
  it('devuelve undefined cuando el plano terminal está deshabilitado', async () => {
    expect(await loadTerminalConfig({})).toBeUndefined();
    expect(await loadTerminalConfig({ CAUCE_TERMINAL_ENABLED: '0' })).toBeUndefined();
    expect(await loadTerminalConfig({ CAUCE_TERMINAL_ENABLED: '' })).toBeUndefined();
  });

  it('carga la configuración canónica cuando todos los env vars están presentes', async () => {
    const config = await loadTerminalConfig(baseEnv());
    if (!config) throw new Error('loadTerminalConfig unexpectedly returned undefined');
    expect(config.wsPath).toBe(DEFAULT_TERMINAL_WS_PATH);
    expect(config.ticketKey.byteLength).toBe(32);
    expect(config.relayToken).toBe('a'.repeat(40));
    expect([...config.relayInstanceIds]).toEqual([RELAY_INSTANCE]);
    expect(config.grantsFile).toBe(DEFAULT_TERMINAL_GRANTS_FILE);
    expect(config.ticketTtlSeconds).toBe(DEFAULT_TICKET_TTL_SECONDS);
    expect(config.sessionTtlSeconds).toBe(DEFAULT_SESSION_TTL_SECONDS);
    expect(config.claimLeaseSeconds).toBe(DEFAULT_CLAIM_LEASE_SECONDS);
    expect(config.maxSessionsPerOperator).toBe(DEFAULT_MAX_SESSIONS_PER_OPERATOR);
    expect(config.operatorHeader).toBe(DEFAULT_OPERATOR_HEADER);
    expect(config.operators.size).toBe(0);
    expect(config.relayUrl).toBeUndefined();
    expect(config.relayClientCertFile).toBeUndefined();
    expect(config.relayClientKeyFile).toBeUndefined();
    expect(config.relayCaFile).toBeUndefined();
  });

  it('rechaza estar habilitado sin CAUCE_TERMINAL_TICKET_KEY_FILE', async () => {
    const env = baseEnv();
    Reflect.deleteProperty(env, 'CAUCE_TERMINAL_TICKET_KEY_FILE');
    await expect(loadTerminalConfig(env)).rejects.toThrow(/CAUCE_TERMINAL_TICKET_KEY_FILE is required/);
  });

  it('rechaza estar habilitado sin CAUCE_TERMINAL_RELAY_TOKEN_FILE', async () => {
    const env = baseEnv();
    Reflect.deleteProperty(env, 'CAUCE_TERMINAL_RELAY_TOKEN_FILE');
    await expect(loadTerminalConfig(env)).rejects.toThrow(/CAUCE_TERMINAL_RELAY_TOKEN_FILE is required/);
  });

  it('rechaza un relay token con menos de 32 caracteres tras trim', async () => {
    putFile('/etc/cauce/relay.token', 'short\n');
    await expect(loadTerminalConfig(baseEnv())).rejects.toThrow(/at least 32 characters/);
    putFile('/etc/cauce/relay.token', '   ' + 'x'.repeat(40));
    const config = await loadTerminalConfig(baseEnv());
    if (!config) throw new Error('loadTerminalConfig unexpectedly returned undefined');
    expect(config.relayToken).toBe('x'.repeat(40));
  });

  it('rechaza un ticket key que no codifica exactamente 32 bytes', async () => {
    putFile('/etc/cauce/ticket.key', Buffer.from('not-32-bytes-of-key-material-at-all'));
    await expect(loadTerminalConfig(baseEnv())).rejects.toThrow(/32 key bytes/);
  });

  it('acepta el ticket key como 64 hex chars y como base64 de 32 bytes', async () => {
    putFile('/etc/cauce/ticket.key', 'c'.repeat(64));
    const fromHex = await loadTerminalConfig(baseEnv());
    if (!fromHex) throw new Error('loadTerminalConfig unexpectedly returned undefined');
    expect(fromHex.ticketKey.byteLength).toBe(32);
    putFile('/etc/cauce/ticket.key', Buffer.from(Buffer.alloc(32, 9)).toString('base64'));
    const fromBase64 = await loadTerminalConfig(baseEnv());
    if (!fromBase64) throw new Error('loadTerminalConfig unexpectedly returned undefined');
    expect(fromBase64.ticketKey.byteLength).toBe(32);
  });

  it('rechaza el WS path que no es absoluto', async () => {
    await expect(loadTerminalConfig({ ...baseEnv(), CAUCE_TERMINAL_WS_PATH: 'relay/ws' }))
      .rejects.toThrow(/WS_PATH must be an absolute path/);
  });

  it('rechaza el operator header con caracteres fuera de [a-z0-9-]', async () => {
    await expect(loadTerminalConfig({ ...baseEnv(), CAUCE_TERMINAL_OPERATOR_HEADER: 'x op' }))
      .rejects.toThrow(/CAUCE_TERMINAL_OPERATOR_HEADER is invalid/);
    await expect(loadTerminalConfig({ ...baseEnv(), CAUCE_TERMINAL_OPERATOR_HEADER: 'x.op' }))
      .rejects.toThrow(/CAUCE_TERMINAL_OPERATOR_HEADER is invalid/);
    const config = await loadTerminalConfig({ ...baseEnv(), CAUCE_TERMINAL_OPERATOR_HEADER: 'X-Custom' });
    if (!config) throw new Error('loadTerminalConfig unexpectedly returned undefined');
    expect(config.operatorHeader).toBe('x-custom');
  });

  it('rechaza max sessions fuera del rango 1..64, incluyendo no numéricos', async () => {
    for (const value of ['0', '-1', '65', 'abc']) {
      await expect(loadTerminalConfig({ ...baseEnv(), CAUCE_TERMINAL_MAX_SESSIONS_PER_OPERATOR: value }))
        .rejects.toThrow(/MAX_SESSIONS_PER_OPERATOR/);
    }
    const config = await loadTerminalConfig({ ...baseEnv(), CAUCE_TERMINAL_MAX_SESSIONS_PER_OPERATOR: '4' });
    if (!config) throw new Error('loadTerminalConfig unexpectedly returned undefined');
    expect(config.maxSessionsPerOperator).toBe(4);
  });

  it('rechaza el ticket TTL y session TTL fuera de su rango y aplica los defaults', async () => {
    await expect(loadTerminalConfig({ ...baseEnv(), CAUCE_TERMINAL_TICKET_TTL_SECONDS: '0' }))
      .rejects.toThrow(/TICKET_TTL_SECONDS/);
    await expect(loadTerminalConfig({ ...baseEnv(), CAUCE_TERMINAL_TICKET_TTL_SECONDS: '121' }))
      .rejects.toThrow(/TICKET_TTL_SECONDS/);
    await expect(loadTerminalConfig({ ...baseEnv(), CAUCE_TERMINAL_SESSION_TTL_SECONDS: '3601' }))
      .rejects.toThrow(/SESSION_TTL_SECONDS/);
    const config = await loadTerminalConfig({
      ...baseEnv(),
      CAUCE_TERMINAL_TICKET_TTL_SECONDS: '60',
      CAUCE_TERMINAL_SESSION_TTL_SECONDS: '1800'
    });
    if (!config) throw new Error('loadTerminalConfig unexpectedly returned undefined');
    expect(config.ticketTtlSeconds).toBe(60);
    expect(config.sessionTtlSeconds).toBe(1800);
  });

  it('rechaza el claim lease por debajo del mínimo del contrato con el relay', async () => {
    await expect(loadTerminalConfig({ ...baseEnv(), CAUCE_TERMINAL_CLAIM_LEASE_SECONDS: '130' }))
      .rejects.toThrow(/CLAIM_LEASE_SECONDS/);
    await expect(loadTerminalConfig({ ...baseEnv(), CAUCE_TERMINAL_CLAIM_LEASE_SECONDS: '301' }))
      .rejects.toThrow(/CLAIM_LEASE_SECONDS/);
    const config = await loadTerminalConfig({ ...baseEnv(), CAUCE_TERMINAL_CLAIM_LEASE_SECONDS: '131' });
    if (!config) throw new Error('loadTerminalConfig unexpectedly returned undefined');
    expect(config.claimLeaseSeconds).toBe(131);
    const configMax = await loadTerminalConfig({ ...baseEnv(), CAUCE_TERMINAL_CLAIM_LEASE_SECONDS: '300' });
    if (!configMax) throw new Error('loadTerminalConfig unexpectedly returned undefined');
    expect(configMax.claimLeaseSeconds).toBe(300);
  });

  it('exige CAUCE_TERMINAL_RELAY_INSTANCE_ID cuando el plano está habilitado', async () => {
    const env = baseEnv();
    Reflect.deleteProperty(env, 'CAUCE_TERMINAL_RELAY_INSTANCE_ID');
    await expect(loadTerminalConfig(env)).rejects.toThrow(/CAUCE_TERMINAL_RELAY_INSTANCE_ID is required/);
  });

  it('rechaza instance ids que no son 64 hex chars y los duplicados', async () => {
    await expect(loadTerminalConfig({ ...baseEnv(), CAUCE_TERMINAL_RELAY_INSTANCE_ID: 'not-hex' }))
      .rejects.toThrow(/64 lowercase hexadecimal/);
    await expect(loadTerminalConfig({
      ...baseEnv(),
      CAUCE_TERMINAL_RELAY_INSTANCE_IDS: `${RELAY_INSTANCE},${RELAY_INSTANCE}`
    })).rejects.toThrow(/must not contain duplicates/);
  });

  it('acepta la forma plural con varios ids separados por coma', async () => {
    const second = 'b'.repeat(64);
    const config = await loadTerminalConfig({
      ...baseEnv(),
      CAUCE_TERMINAL_RELAY_INSTANCE_IDS: `${RELAY_INSTANCE}, ${second}`
    });
    if (!config) throw new Error('loadTerminalConfig unexpectedly returned undefined');
    expect([...config.relayInstanceIds].sort()).toEqual([RELAY_INSTANCE, second].sort());
  });

  it('rechaza un relay URL que no es HTTPS o que carga credenciales', async () => {
    await expect(loadTerminalConfig({ ...baseEnv(), CAUCE_TERMINAL_RELAY_URL: 'http://relay.local' }))
      .rejects.toThrow(/credential-free HTTPS origin/);
    await expect(loadTerminalConfig({ ...baseEnv(), CAUCE_TERMINAL_RELAY_URL: 'https://user:pw@relay' }))
      .rejects.toThrow(/credential-free HTTPS origin/);
    const config = await loadTerminalConfig({ ...baseEnv(), CAUCE_TERMINAL_RELAY_URL: 'https://relay.local:8443/' });
    if (!config) throw new Error('loadTerminalConfig unexpectedly returned undefined');
    expect(config.relayUrl).toBe('https://relay.local:8443');
  });

  it('trata ausente y string vacío como equivalentes para los paths opcionales', async () => {
    const config = await loadTerminalConfig({
      ...baseEnv(),
      CAUCE_TERMINAL_RELAY_CLIENT_CERT_FILE: '   ',
      CAUCE_TERMINAL_RELAY_CLIENT_KEY_FILE: '/etc/cauce/client.key',
      CAUCE_TERMINAL_RELAY_CA_FILE: ''
    });
    if (!config) throw new Error('loadTerminalConfig unexpectedly returned undefined');
    expect(config.relayClientCertFile).toBeUndefined();
    expect(config.relayClientKeyFile).toBe('/etc/cauce/client.key');
    expect(config.relayCaFile).toBeUndefined();
  });

  it('parsea la lista de operators como trimmed split y dedupea duplicados', async () => {
    const config = await loadTerminalConfig({
      ...baseEnv(),
      CAUCE_TERMINAL_OPERATORS: ' alice , bob ,, alice '
    });
    if (!config) throw new Error('loadTerminalConfig unexpectedly returned undefined');
    expect([...config.operators].sort()).toEqual(['alice', 'bob']);
  });

  it('lee process.env cuando se invoca sin argumentos', async () => {
    process.env.CAUCE_TERMINAL_ENABLED = '1';
    process.env.CAUCE_TERMINAL_TICKET_KEY_FILE = '/etc/cauce/ticket.key';
    process.env.CAUCE_TERMINAL_RELAY_TOKEN_FILE = '/etc/cauce/relay.token';
    process.env.CAUCE_TERMINAL_RELAY_INSTANCE_ID = RELAY_INSTANCE;
    putFile('/etc/cauce/relay.token', 'z'.repeat(40));
    const config = await loadTerminalConfig();
    if (!config) throw new Error('loadTerminalConfig unexpectedly returned undefined');
    expect(config.relayToken).toBe('z'.repeat(40));
  });

  it('la combinación de un buen TTL con una mala claim lease falla sin contaminar al siguiente', async () => {
    await expect(loadTerminalConfig({
      ...baseEnv(),
      CAUCE_TERMINAL_TICKET_TTL_SECONDS: '60',
      CAUCE_TERMINAL_CLAIM_LEASE_SECONDS: '50'
    })).rejects.toThrow(/CLAIM_LEASE_SECONDS/);
    const config = await loadTerminalConfig({
      ...baseEnv(),
      CAUCE_TERMINAL_TICKET_TTL_SECONDS: '60',
      CAUCE_TERMINAL_CLAIM_LEASE_SECONDS: '150'
    });
    if (!config) throw new Error('loadTerminalConfig unexpectedly returned undefined');
    expect(config.ticketTtlSeconds).toBe(60);
    expect(config.claimLeaseSeconds).toBe(150);
  });

  it('relanza el error cuando el archivo de ticket key no existe', async () => {
    fsFiles.delete('/etc/cauce/ticket.key');
    await expect(loadTerminalConfig(baseEnv())).rejects.toThrow(/ENOENT/);
  });
});

describe('terminalCapabilityAnnouncement', () => {
  it('anuncia el plugin con el wsPath de la config y los capabilities correctos', async () => {
    const config = await loadTerminalConfig(baseEnv());
    if (!config) throw new Error('loadTerminalConfig unexpectedly returned undefined');
    expect(terminalCapabilityAnnouncement(config)).toEqual({
      available: true,
      plugin_id: 'ultimate-terminal.client',
      capabilities: ['terminal.pty.client'],
      websocket_path: config.wsPath,
      target_label: 'Cauce fleet PTY'
    });
  });

  it('refleja un wsPath personalizado cuando la env lo overridea', async () => {
    const config = await loadTerminalConfig({
      ...baseEnv(),
      CAUCE_TERMINAL_WS_PATH: '/custom/ws'
    });
    if (!config) throw new Error('loadTerminalConfig unexpectedly returned undefined');
    const announcement = terminalCapabilityAnnouncement(config);
    expect(announcement.websocket_path).toBe('/custom/ws');
  });
});
