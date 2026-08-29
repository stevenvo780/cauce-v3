import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Console password derivation and verification using scrypt (RFC 7914).
 * Uses a format compatible with the PHC string format:
 *   $scrypt$n=32768,r=8,p=1$<base64 salt>$<base64 derived>
 */

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer, salt: Buffer, keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

/** N=2^15 with r=8 is ~33 MB per verification: costly for a GPU, imperceptible on a login. */
export const DEFAULT_SCRYPT_COST = 32_768;
export const DEFAULT_SCRYPT_BLOCK_SIZE = 8;
export const DEFAULT_SCRYPT_PARALLELISM = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
/** Explicit memory ceiling: Node's default (32 MB) falls below N=2^15, r=8. */
const MAX_MEMORY = 96 * 1024 * 1024;

/**
 * An unbounded password is an exhaustion vector: scrypt works on whatever it is given and the
 * login is not authenticated. 1024 characters are more than enough for any real passphrase.
 */
export const MAX_PASSWORD_LENGTH = 1_024;
export const MIN_PASSWORD_LENGTH = 12;

export interface ScryptParameters {
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelism: number;
}

function assertPasswordShape(password: string): void {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('la contraseña no puede estar vacía');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`la contraseña no puede superar ${MAX_PASSWORD_LENGTH} caracteres`);
  }
}

/** Only applied at CREATION. Verification never enforces a minimum length: it would break old accounts. */
export function assertPasswordPolicy(password: string): void {
  assertPasswordShape(password);
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`la contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`);
  }
}

export async function hashPassword(
  password: string,
  parameters: ScryptParameters = {
    cost: DEFAULT_SCRYPT_COST,
    blockSize: DEFAULT_SCRYPT_BLOCK_SIZE,
    parallelism: DEFAULT_SCRYPT_PARALLELISM
  }
): Promise<string> {
  assertPasswordShape(password);
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: parameters.cost, r: parameters.blockSize, p: parameters.parallelism, maxmem: MAX_MEMORY
  });
  return `$scrypt$n=${parameters.cost},r=${parameters.blockSize},p=${parameters.parallelism}$${
    salt.toString('base64')}$${derived.toString('base64')}`;
}

interface ParsedHash {
  parameters: ScryptParameters;
  salt: Buffer;
  derived: Buffer;
}

function positiveInteger(value: string | undefined, name: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`parámetro scrypt ${name} inválido`);
  }
  return parsed;
}

export function parsePasswordHash(encoded: string): ParsedHash {
  const parts = encoded.split('$');
  // ['', 'scrypt', 'n=..,r=..,p=..', '<salt>', '<derived>']
  if (parts.length !== 5 || parts[0] !== '' || parts[1] !== 'scrypt') {
    throw new Error('hash de contraseña con formato desconocido');
  }
  const options = new Map(parts[2]!.split(',').map((item) => {
    const separator = item.indexOf('=');
    return [item.slice(0, separator), item.slice(separator + 1)] as const;
  }));
  const salt = Buffer.from(parts[3]!, 'base64');
  const derived = Buffer.from(parts[4]!, 'base64');
  if (salt.byteLength < 8 || derived.byteLength < 16) throw new Error('hash de contraseña truncado');
  return {
    parameters: {
      cost: positiveInteger(options.get('n'), 'n', 1 << 20),
      blockSize: positiveInteger(options.get('r'), 'r', 64),
      parallelism: positiveInteger(options.get('p'), 'p', 16)
    },
    salt,
    derived
  };
}

/**
 * Never throws for a wrong password or an unreadable hash: returns `false`. A distinguishable
 * throw from the outside would be an oracle — the difference between "that account does not
 * exist" and "that password is wrong" would show in the error shape, even with the same message.
 */
export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    return false;
  }
  let parsed: ParsedHash;
  try {
    parsed = parsePasswordHash(encoded);
  } catch {
    return false;
  }
  try {
    const derived = await scryptAsync(password.normalize('NFKC'), parsed.salt, parsed.derived.byteLength, {
      N: parsed.parameters.cost, r: parsed.parameters.blockSize, p: parsed.parameters.parallelism,
      maxmem: MAX_MEMORY
    });
    return derived.byteLength === parsed.derived.byteLength && timingSafeEqual(derived, parsed.derived);
  } catch {
    return false;
  }
}

/**
 * Decoy hash against which verification runs when the email does NOT exist.
 *
 * Without this, an unknown email responds in microseconds and a known one in ~100 ms: the error
 * message would be identical and user enumeration would still work, by measuring the clock. It
 * is derived from a random password nobody knows, so it can never verify.
 */
export const DECOY_PASSWORD_HASH_PROMISE: Promise<string> = hashPassword(randomBytes(32).toString('base64'));
