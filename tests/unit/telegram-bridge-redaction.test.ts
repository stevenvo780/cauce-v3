import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  redactSecrets,
  redactSecretsDeep,
  type RedactionKind
} from '../../services/telegram-bridge/src/redaction.js';

/**
 * Cobertura pura de `services/telegram-bridge/src/redaction.ts`.
 *
 * Cada regla se prueba con un caso POSITIVO (el patrón matchea y el original
 * NO aparece en la salida) y un NEGATIVO (el patrón respeta la forma y deja
 * pasar texto inocente). El conmutador `CAUCE_TELEGRAM_REDACT_INGRESS` se
 * controla desde el test para ejercitar la rama "off" sin contaminar otros
 * suites.
 *
 * El test de profundidad usa el switch prendido para forzar que el walk
 * recursivo redacte dentro de objetos y arrays anidados.
 */

const ENV_KEY = 'CAUCE_TELEGRAM_REDACT_INGRESS';
let original: string | undefined;

beforeEach(() => {
  original = process.env[ENV_KEY];
  process.env[ENV_KEY] = '1';
});

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
});

function kinds(result: { readonly kinds: readonly RedactionKind[] }): readonly RedactionKind[] {
  return [...result.kinds].sort();
}

describe('redactSecrets: conmutador global de la ingesta', () => {
  it('con el switch apagado devuelve el texto intacto aunque haya un patrón positivo', () => {
    process.env[ENV_KEY] = '0';
    const raw = 'token=7482913055:AAH3kZq9_LmN4pQ7rS2tU5vW8xY1zA3bC4d';
    const out = redactSecrets(raw);
    expect(out.value).toBe(raw);
    expect(out.kinds).toEqual([]);
    expect(out.count).toBe(0);
  });

  it('input vacío y oversized se devuelven intactos sin tocar las reglas', () => {
    delete process.env[ENV_KEY];
    const vacio = redactSecrets('');
    expect(vacio).toEqual({ value: '', kinds: [], count: 0 });

    process.env[ENV_KEY] = '1';
    const gigante = redactSecrets('a'.repeat(256 * 1024 + 1));
    expect(gigante.count).toBe(0);
  });

  it('texto sin secretos pasa tal cual y reporta kinds vacío', () => {
    const out = redactSecrets('hola mundo, todo bien por acá');
    expect(out.value).toBe('hola mundo, todo bien por acá');
    expect(out.kinds).toEqual([]);
    expect(out.count).toBe(0);
  });
});

describe('redactSecrets: cada regla tiene un positivo y un negativo', () => {
  it('URI con credenciales: positivo redacta user:pass, conserva esquema y host', () => {
    const crudo = 'postgresql://neondb_owner:npg_FICTICIA0AbCdEf@ep-dry-smoke.example/neondb';
    const out = redactSecrets(crudo);
    expect(out.value).toContain('[credencial-redactada]');
    expect(out.value).not.toContain('neondb_owner');
    expect(out.value).not.toContain('npg_FICTICIA0AbCdEf');
    expect(out.value).toContain('postgresql://');
    expect(out.value).toContain('ep-dry-smoke.example');
    expect(kinds(out)).toEqual(['uri_credentials']);
  });

  it('URI sin credenciales: negativo, https normal NO se toca', () => {
    const crudo = 'https://github.com/anomalyco/opencode/issues';
    const out = redactSecrets(crudo);
    expect(out.value).toBe(crudo);
    expect(out.count).toBe(0);
  });

  it('Authorization con esquema declarado: positivo (Bearer / Basic / Token)', () => {
    expect(redactSecrets('-H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sign"').value)
      .toBe('-H "Authorization: Bearer [secreto-redactado]"');
    expect(redactSecrets('AUTHORIZATION=Basic dXNlcjpwYXNzd29yZA==').value)
      .toBe('AUTHORIZATION=Basic [secreto-redactado]');
  });

  it('Authorization sin esquema: positivo si parece token (mezcla letras/dígitos y >= 16 chars)', () => {
    expect(redactSecrets('authorization: Ab3xY9zK1mN4pQ7rT8w').value)
      .toBe('authorization: [secreto-redactado]');
  });

  it('Authorization sin esquema: negativo si parece palabra humana (todo letras)', () => {
    const out = redactSecrets('Authorization: responsabilidades');
    expect(out.value).toBe('Authorization: responsabilidades');
    expect(out.count).toBe(0);
  });

  it('Bearer suelto en el chat: positivo cuando el token parece token', () => {
    expect(redactSecrets('probá con Bearer Ab3xY9zK1mN4pQ7rT8wZ9yZ2').value)
      .toBe('probá con Bearer [secreto-redactado]');
  });

  it('Bearer suelto: negativo si la cadena no parece token (pocas letras)', () => {
    const out = redactSecrets('Bearer abracadabra');
    expect(out.count).toBe(0);
  });

  it('Telegram bot token: positivo en el formato canónico <id>:<35 base64url>', () => {
    const out = redactSecrets('el token es 7482913055:AAH3kZq9_LmN4pQ7rS2tU5vW8xY1zA3bC4d');
    expect(out.value).toBe('el token es [secreto-redactado]');
    expect(kinds(out)).toEqual(['telegram_bot_token']);
  });

  it('Telegram bot token: negativo si la cola no mezcla letras y dígitos', () => {
    // 31 chars pero todo letras -> el guard de looksRandom descarta el bot_token rule.
    // Tampoco hay "Authorization" ni "Bearer" en el texto, así que ninguna otra rule se activa.
    const crudo = 'referencia 7482913055:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const out = redactSecrets(crudo);
    expect(out.value).toBe(crudo);
    expect(out.count).toBe(0);
  });

  it('JWT: positivo en las tres partes separadas por punto con prefijo eyJ', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(redactSecrets(`Authorization: Bearer ${jwt}`).value)
      .toBe('Authorization: Bearer [secreto-redactado]');
    expect(redactSecrets(`token: ${jwt}`).value).toBe('token: [secreto-redactado]');
  });

  it('JWT: negativo cuando una de las partes es demasiado corta', () => {
    const out = redactSecrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc');
    // Una parte de <8 chars rompe el match. El resultado debe seguir conteniendo "abc".
    expect(out.value).toContain('abc');
  });

  it('claves con prefijo propietario: positivo para cada variante conocida', () => {
    const secretos = [
      'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'github_pat_11ABCDEFG0_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd',
      'AKIAIOSFODNN7EXAMPLE',
      ['xoxb', '1234567890', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-'),
      'npg_AbCdEfGhIjKlMnOpQrSt',
      'AIzaSyAbc1234567890Abc1234567890Abcdefg',
      'glpat-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    ];
    for (const s of secretos) {
      const out = redactSecrets(`valor: ${s}`);
      expect(out.value).toBe('valor: [secreto-redactado]');
      expect(out.kinds).toContain('api_key');
    }
  });

  it('PEM private key: positivo en el bloque completo', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA0000000000000000000000000000000000000000000000',
      '-----END RSA PRIVATE KEY-----'
    ].join('\n');
    const out = redactSecrets(`datos: ${pem} fin`);
    expect(out.value).toBe('datos: [secreto-redactado] (llave privada) fin');
    expect(kinds(out)).toEqual(['private_key']);
  });
});

describe('redactSecrets: combinaciones y orden', () => {
  it('un texto con varios secretos reporta todas las kinds ordenadas', () => {
    const raw = [
      'postgresql://u:p@db.example/app',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    ].join('\n');
    const out = redactSecrets(raw);
    expect(out.count).toBeGreaterThanOrEqual(2);
    expect(out.kinds).toContain('uri_credentials');
    expect(out.kinds).toContain('jwt');
    // El original del JWT no debe seguir presente.
    expect(out.value).not.toContain('dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  });

  it('los kinds se devuelven ordenados alfabéticamente', () => {
    const raw = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'ABC',
      '-----END RSA PRIVATE KEY-----',
      'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    ].join('\n');
    const out = redactSecrets(raw);
    const orden = kinds(out);
    const sorted = [...orden].sort();
    expect(orden).toEqual(sorted);
  });
});

describe('redactSecretsDeep: recursión sobre objetos y arrays', () => {
  it('redacta strings dentro de objetos anidados y mergea los kinds', () => {
    // El valor incluye la palabra "authorization:" para que la rule la matchee; sin la palabra
    // "Bearer" ni scheme declarado, dispara la Authorization rule con looksLikeToken.
    const payload = {
      headers: { Authorization: 'authorization: aB3xY9zK1mN4pQ7rT8wZ9yZ2aBcDeFgHi' },
      db: 'postgresql://u:p@db.example/app',
      nota: 'hola'
    };
    const out = redactSecretsDeep(payload);
    expect(out.value.headers.Authorization).toContain('[secreto-redactado]');
    expect(out.value.db).toContain('[credencial-redactada]');
    expect(out.value.nota).toBe('hola');
    expect(out.kinds).toContain('authorization');
    expect(out.kinds).toContain('uri_credentials');
  });

  it('redacta strings dentro de arrays', () => {
    const logs = [
      'Authorization: Basic dXNlcjpwYXNzd29yZA==',
      'log normal sin secretos',
      'Bearer Ab3xY9zK1mN4pQ7rT8wZ9yZ2'
    ];
    const out = redactSecretsDeep(logs);
    expect(out.value[0]).toContain('[secreto-redactado]');
    expect(out.value[1]).toBe('log normal sin secretos');
    expect(out.value[2]).toContain('[secreto-redactado]');
  });

  it('preserva la clave opaca content_base64 sin escanearla', () => {
    const payload = {
      content_base64: 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'.repeat(100),
      texto: 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    };
    const out = redactSecretsDeep(payload);
    expect(out.value.content_base64).toBe(payload.content_base64);
    expect(out.value.texto).toBe('[secreto-redactado]');
  });

  it('respeta el tope de profundidad y devuelve los nodos profundos sin tocarlos', () => {
    // La cadena tiene 9 niveles de objetos antes del string; el walk se detiene en MAX_DEPTH=8
    // y deja el último nivel sin descender, así el secreto sobrevive literal.
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' } } } } } } } } };
    const out = redactSecretsDeep(deep);
    expect(JSON.stringify(out.value)).toContain('ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    expect(out.count).toBe(0);
  });

  it('el conteo total suma los matches a través de todas las ramas', () => {
    const payload = {
      a: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      b: ['ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789']
    };
    const out = redactSecretsDeep(payload);
    expect(out.count).toBeGreaterThanOrEqual(3);
  });
});