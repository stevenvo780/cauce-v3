export const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
/** Top-level subcommands of the `cauce` CLI; an agent alias equal to one would be unreachable (`cauce <alias>`). */
export const RESERVED_CLI_ALIASES: readonly string[] = [
  'platform', 'hosts', 'context', 'context-native', 'spaces', 'flota', 'estado', 'ver',
  'cuotas', 'coutas', 'pila-test', 'help', 'ayuda', 'diagnose', 'login',
];
export const RESERVED_ALIAS_MESSAGE =
  'Ese alias está reservado: coincide con un subcomando del CLI cauce. Elige otro.';

export function isReservedAlias(value: unknown): boolean {
  return typeof value === 'string' && RESERVED_CLI_ALIASES.includes(value.trim().toLowerCase());
}

export const TENANT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
export const CANONICAL_UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const RFC_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const UUID_ANY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isCanonicalUuidV4(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID_V4_PATTERN.test(value);
}

export function isRfcUuid(value: unknown): value is string {
  return typeof value === 'string' && RFC_UUID_PATTERN.test(value);
}

export function isAnyUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_ANY_PATTERN.test(value);
}

export function isAlias(value: unknown): value is string {
  return typeof value === 'string' && ALIAS_PATTERN.test(value);
}

export function isTenant(value: unknown): value is string {
  return typeof value === 'string' && TENANT_PATTERN.test(value);
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}
