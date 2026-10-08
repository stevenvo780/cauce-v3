import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repository = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SCOPES = [
  'packages/protocol/src',
  'packages/store/src',
  'services/gateway/src',
  'services/dispatcher/src',
];
const SYMBOL = /\b((?:DEFAULT|MAX|MIN)_[A-Z0-9_]+|CAUCE_[A-Z0-9_]+|DISPATCHER_[A-Z0-9_]+|ACK_TIMEOUT_MS)\b/g;

// Symbols that are NOT orchestration parameters. Every entry needs a reason;
// anything else must have a row in docs/parametros.md.
const ALLOWLIST = new Map<string, string>([
  ['MAX_SAFE_INTEGER', 'builtin de JS, no parámetro'],
  ['DISPATCHER_PHASES', 'enum de fases del dispatcher, no tunable'],
  ['CAUCE_BOOTSTRAP_', 'prefijo fijo del nonce de prueba, no variable de configuración'],
  ['CAUCE_OPENCLAW_LOCAL', 'selección fija del transporte aislado de OpenClaw administrado'],
  ['CAUCE_OPENCLAW_AGENT_ID', 'identidad nativa sellada del agente OpenClaw'],
  ['MAX_AGENT_APPEARANCE_AUTHOR_LENGTH', 'tope del identificador humano en preferencias de presentación'],
  ['MAX_AGENT_FAVORITES_PER_HUMAN', 'tope de favoritos de presentación por persona'],
  ['MAX_AGENT_GLYPH_COMBINING_MARKS', 'validación Unicode del avatar de presentación'],
  ['MAX_AGENT_GLYPH_UTF16_UNITS', 'tope de tamaño del avatar de presentación'],
  // Material secreto y rutas de identidad: existen pero no gobiernan
  // comportamiento del orquestador (constitución VI: intocables).
  ['CAUCE_CONSOLE_JWT_KEY_FILE', 'ruta de clave JWT'],
  ['CAUCE_CONSOLE_USER_PASSWORD', 'secreto de CLI, solo bootstrap'],
  ['CAUCE_MTLS_IDENTITY_FILE', 'ruta de identidad mTLS'],
  ['CAUCE_OIDC_CLIENT_SECRET_FILE', 'secreto OIDC'],
  ['CAUCE_OIDC_SESSION_KEY_FILE', 'clave de sesión OIDC'],
  ['CAUCE_TERMINAL_RELAY_CA_FILE', 'ruta de CA del relay'],
  ['CAUCE_TERMINAL_RELAY_CLIENT_CERT_FILE', 'ruta de cert mTLS'],
  ['CAUCE_TERMINAL_RELAY_CLIENT_KEY_FILE', 'ruta de clave mTLS'],
  ['CAUCE_TERMINAL_RELAY_TOKEN_FILE', 'token gateway↔relay'],
  ['CAUCE_TERMINAL_TICKET_KEY_FILE', 'master HKDF de tickets'],
  ['CAUCE_TLS_CERT_FILE', 'ruta de cert TLS'],
  ['CAUCE_TLS_CLIENT_CA_FILE', 'ruta de CA cliente'],
  ['CAUCE_TLS_KEY_FILE', 'ruta de clave TLS'],
  ['CAUCE_TOKEN_HASH_FILE', 'hash de token de operador'],
  ['CAUCE_FLEET_MTLS_IDENTITY_FILE', 'ruta de identidad mTLS de flota'],
  ['CAUCE_FLEET_TOKEN_HASH_FILE', 'ruta del hash de token del probe de flota'],
  // Binding físico aprobado: identidad, rutas y grupo del puente local.
  ['CAUCE_FLEET_API_GROUP_GID', 'grupo autorizado del socket privado de flota'],
  ['CAUCE_FLEET_API_SOCKET', 'ruta del socket privado de flota'],
  ['CAUCE_FLEET_API_CONFIG_FILE', 'ruta del catálogo privado de puentes del gateway'],
  ['CAUCE_FLEET_CONTROLLER_FILE', 'ruta del catálogo privado del coordinador de flota'],
  ['CAUCE_FLEET_AUTH_POLICY_FILE', 'ruta de policy privada de autenticación de flota'],
  ['CAUCE_FLEET_CAPABILITY_FILE', 'ruta del catálogo aprobado de runtimes de flota'],
  ['CAUCE_FLEET_CONTROLLER_HOST', 'identidad del host con autoridad de flota'],
  ['CAUCE_FLEET_DATABASE_URL_FILE', 'ruta privada de conexión del worker de flota'],
  ['CAUCE_FLEET_EXECUTABLE', 'ruta del executor físico aprobado'],
  ['CAUCE_FLEET_HOST', 'identidad del host físico de flota'],
  ['CAUCE_FLEET_POLICY_FILE', 'ruta de policy privada del executor físico'],
  ['CAUCE_FLEET_PROJECT_ROOT', 'raíz aprobada del proyecto del worker de flota'],
  ['CAUCE_FLEET_PYTHON', 'ruta del intérprete aprobado del executor físico'],
  ['CAUCE_FLEET_WORKER_ID', 'identidad del worker de flota'],
  // Wiring OIDC: endpoints y tablas, no tuning del orquestador.
  ['CAUCE_OIDC_AUDIENCE', 'wiring OIDC'],
  ['CAUCE_OIDC_AUTHORIZATION_URL', 'wiring OIDC'],
  ['CAUCE_OIDC_CLIENT_ID', 'wiring OIDC'],
  ['CAUCE_OIDC_ISSUER', 'wiring OIDC'],
  ['CAUCE_OIDC_JWKS_URL', 'wiring OIDC'],
  ['CAUCE_OIDC_POST_LOGIN_PATH', 'wiring OIDC'],
  ['CAUCE_OIDC_REDIRECT_URI', 'wiring OIDC'],
  ['CAUCE_OIDC_SESSION_TABLE', 'wiring OIDC'],
  ['CAUCE_OIDC_TOKEN_URL', 'wiring OIDC'],
]);

function sources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sources(path));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      found.push(path);
    }
  }
  return found;
}

describe('tabla única de parámetros', () => {
  test('todo parámetro del código tiene fila en docs/parametros.md o motivo en allowlist', () => {
    const table = readFileSync(join(repository, 'docs/parametros.md'), 'utf8');
    const missing: string[] = [];
    for (const scope of SCOPES) {
      for (const file of sources(join(repository, scope))) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, index) => {
          for (const match of line.matchAll(SYMBOL)) {
            const symbol = match[1] ?? '';
            if (symbol !== '' && !table.includes(symbol) && !ALLOWLIST.has(symbol)) {
              missing.push(`${symbol} @ ${file.slice(repository.length + 1)}:${String(index + 1)}`);
            }
          }
        });
      }
    }
    expect([...new Set(missing)].sort()).toEqual([]);
  });
});
