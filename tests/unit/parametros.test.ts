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
              missing.push(`${symbol} @ ${file.slice(repository.length + 1)}:${index + 1}`);
            }
          }
        });
      }
    }
    expect([...new Set(missing)].sort()).toEqual([]);
  });
});
