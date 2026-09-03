import { describe, expect, it } from 'vitest';
import {
  MAX_RULE_MATCH_CHARACTERS,
  MAX_SCANNED_CHARACTERS,
  MAX_SCANNED_NODES,
  MAX_SCANNED_TOTAL_CHARACTERS,
  MAX_SCANNED_VALUE_CHARACTERS,
  REDACTION_MARK,
  REDACTION_URI_MARK,
  redactAttachmentName,
  redactSecrets,
  redactSecretsDeep,
  redactionEnabledFromEnv,
} from '../src/index.js';

const ON = { enabled: true } as const;
const OFF = { enabled: false } as const;

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'
  + '.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';

describe('redaction rules: every family has a positive case', () => {
  it('redacts the credentials of a URI and keeps scheme and host', () => {
    const raw = 'DATABASE_URL=postgresql://neondb_owner:npg_FICTICIA0AbCdEf@ep-dry-smoke.example/neondb';
    const result = redactSecrets(raw, ON);
    expect(result.value).toContain(`postgresql://${REDACTION_URI_MARK}@`);
    expect(result.value).toContain('ep-dry-smoke.example');
    expect(result.value).not.toContain('npg_FICTICIA0AbCdEf');
    expect(result.value).not.toContain('neondb_owner');
    expect(result.kinds).toEqual(['uri_credentials']);
  });

  it.each([
    'mysql://root:s3cr3t@db.local/app',
    'redis://default:AbCdEf123456@cache:6379',
    'amqps://user:pass@rabbit.example.com/vhost',
    'mongodb+srv://admin:qwerty123@cluster0.mongodb.net',
    'https://usuario:clave@panel.interno/admin',
  ])('redacts the credentials embedded in %s', (uri) => {
    const result = redactSecrets(uri, ON);
    expect(result.value).toContain(REDACTION_URI_MARK);
    expect(result.kinds).toEqual(['uri_credentials']);
  });

  it('redacts the Authorization header in both spellings', () => {
    expect(redactSecrets('-H "Authorization: Bearer sk_live_9182abcdefghij"', ON).value)
      .toBe(`-H "Authorization: Bearer ${REDACTION_MARK}"`);
    expect(redactSecrets('AUTHORIZATION=Basic dXNlcjpwYXNz', ON).value)
      .toBe(`AUTHORIZATION=Basic ${REDACTION_MARK}`);
    expect(redactSecrets('authorization: aB3xY9zK1mN4pQ7r', ON).value)
      .toBe(`authorization: ${REDACTION_MARK}`);
  });

  it('redacts a bare Bearer token pasted into a chat', () => {
    expect(redactSecrets('probá con Bearer Ab3xY9zK1mN4pQ7rT8wZ9yZ2', ON).value)
      .toBe(`probá con Bearer ${REDACTION_MARK}`);
  });

  it('redacts a Telegram bot token', () => {
    const result = redactSecrets('el token es 7482913055:AAH3kZq9_LmN4pQ7rS2tU5vW8xY1zA3bC4d y anda', ON);
    expect(result.value).toBe(`el token es ${REDACTION_MARK} y anda`);
    expect(result.kinds).toEqual(['telegram_bot_token']);
  });

  it.each([
    'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'github_pat_11ABCDEFG0_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd',
    'AKIAIOSFODNN7EXAMPLE',
    ['xoxb', '1234567890', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-'),
    'npg_AbCdEfGhIjKlMnOpQrSt',
    'AIzaSyAbc1234567890Abc1234567890Abcdefg',
    'glpat-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  ])('redacts the proprietary prefix credential %s', (secret) => {
    const result = redactSecrets(`valor: ${secret}`, ON);
    expect(result.value).toBe(`valor: ${REDACTION_MARK}`);
    expect(result.kinds).toEqual(['api_key']);
  });

  it('redacts a JWT wherever it appears', () => {
    expect(redactSecrets(`token: ${JWT}`, ON).value).toBe(`token: ${REDACTION_MARK}`);
    expect(redactSecrets(`Authorization: Bearer ${JWT}`, ON).value)
      .toBe(`Authorization: Bearer ${REDACTION_MARK}`);
  });

  it('redacts a whole pasted private key', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA0000000000000000000000000000000000000000000000',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const result = redactSecrets(`datos: ${pem} fin`, ON);
    expect(result.value).toBe(`datos: ${REDACTION_MARK} (llave privada) fin`);
    expect(result.kinds).toEqual(['private_key']);
  });

  it('redacts an encrypted key whose headers carry hyphens', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'Proc-Type: 4,ENCRYPTED',
      'DEK-Info: AES-128-CBC,0123456789ABCDEF',
      '',
      'MIIEowIBAAKCAQEA0000000000000000000000000000000000000000000000',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const result = redactSecrets(`datos: ${pem} fin`, ON);
    expect(result.value).toBe(`datos: ${REDACTION_MARK} (llave privada) fin`);
    expect(result.kinds).toEqual(['private_key']);
  });
});

describe('redaction rules: a false positive is worse than a miss', () => {
  it.each([
    'mirá https://demeter-dev.vercel.app/empresa/configuracion-clientes',
    'el panel está en http://100.64.0.6:8443/v3/messages',
    'https://github.com/anomalyco/opencode/issues',
    'la ruta es file:///workspace/clases/video/Guion.docx',
    'nos vemos 15:30 en la oficina',
    'la relación quedó 1024:768 y no cuadra',
    'Authorization: responsabilidades',
    'el password es un desastre, hay que cambiarlo',
    'commit 830cf38 y 130a72c',
    'la imagen es sha256:fd9e878451d5c292597a42654a10aa3e1817af52b69811c201b3286c49661e1e',
    'Bearer abracadabra',
    'referencia 7482913055:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ])('leaves innocent text untouched: %s', (text) => {
    const result = redactSecrets(text, ON);
    expect(result.value).toBe(text);
    expect(result.count).toBe(0);
    expect(result.kinds).toEqual([]);
  });

  it('reports every family, sorted, when a text carries several secrets', () => {
    const raw = ['postgresql://u:p@db.example/app', JWT].join('\n');
    const result = redactSecrets(raw, ON);
    expect(result.count).toBeGreaterThanOrEqual(2);
    expect(result.kinds).toEqual(['jwt', 'uri_credentials']);
    expect(result.value).not.toContain('dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  });

  it('gives up on an empty text', () => {
    expect(redactSecrets('', ON)).toEqual({ value: '', kinds: [], count: 0 });
  });
});

describe('a value bigger than one scan window has no blind spot', () => {
  const SECRET = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

  it('redacts a secret buried in 300 KiB of padding', () => {
    const huge = `${'a'.repeat(300 * 1024)} ${SECRET}`;
    const result = redactSecrets(huge, ON);
    expect(result.value).not.toContain(SECRET);
    expect(result.count).toBe(1);
    expect(result.kinds).toEqual(['api_key']);
    expect(result.unscanned).toBeUndefined();
  });

  it('redacts a secret sitting across a window seam', () => {
    for (const offset of [-45, -40, -36, -7, -1, 0, 1]) {
      const head = 'a'.repeat(MAX_SCANNED_CHARACTERS + offset);
      const result = redactSecrets(`${head} ${SECRET} cola`, ON);
      expect(result.value).not.toContain(SECRET);
      expect(result.count).toBe(1);
      expect(result.value.endsWith(`${REDACTION_MARK} cola`)).toBe(true);
    }
  });

  it('redacts a private key that straddles a window seam', () => {
    const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA0000', '-----END RSA PRIVATE KEY-----']
      .join('\n');
    const head = 'a'.repeat(MAX_SCANNED_CHARACTERS - 40);
    const result = redactSecrets(`${head} ${pem} fin`, ON);
    expect(result.value).not.toContain('MIIEowIBAAKCAQEA0000');
    expect(result.count).toBe(1);
  });

  it('reports the tail it refused to scan instead of pretending the value is clean', () => {
    const huge = `${SECRET} ${'a'.repeat(MAX_SCANNED_VALUE_CHARACTERS)} ${SECRET}`;
    const result = redactSecrets(huge, ON);
    expect(result.value.startsWith(REDACTION_MARK)).toBe(true);
    expect(result.value.endsWith(SECRET)).toBe(true);
    expect(result.count).toBe(1);
    expect(result.unscanned).toEqual({
      reason: 'value_length',
      count: huge.length - MAX_SCANNED_VALUE_CHARACTERS,
      reasons: [{ reason: 'value_length', count: huge.length - MAX_SCANNED_VALUE_CHARACTERS }],
    });
  });
});

describe('the longest match of a rule is really bounded', () => {
  const TOKEN = 'aB3xY9zK1mN4pQ7rT8wZ9yZ2aBcDeFgHi';

  it('matches across the widest gap the rule admits and no further', () => {
    const inside = redactSecrets(`authorization:${' '.repeat(64)}${TOKEN}`, ON);
    expect(inside.value).toContain(REDACTION_MARK);
    expect(inside.count).toBe(1);
    const beyond = redactSecrets(`authorization:${' '.repeat(65)}${TOKEN}`, ON);
    expect(beyond.count).toBe(0);
  });

  it('never matches over a gap wider than the window overlap', () => {
    const gap = redactSecrets(
      `authorization:${' '.repeat(MAX_RULE_MATCH_CHARACTERS)}${TOKEN}`, ON
    );
    expect(gap.count).toBe(0);
    expect(gap.value).toContain(TOKEN);
  });

  it('redacts the widest admitted match sitting across a window seam', () => {
    const secret = `authorization:${' '.repeat(64)}${TOKEN}`;
    for (const offset of [-secret.length, -40, -1, 0]) {
      const head = 'a'.repeat(MAX_SCANNED_CHARACTERS + offset);
      const result = redactSecrets(`${head} ${secret} cola`, ON);
      expect(result.value).not.toContain(TOKEN);
      expect(result.count).toBe(1);
    }
  });
});

describe('the switch is a parameter, not an environment read', () => {
  it('passes the value through byte for byte when disabled', () => {
    const raw = 'token=7482913055:AAH3kZq9_LmN4pQ7rS2tU5vW8xY1zA3bC4d';
    const result = redactSecrets(raw, OFF);
    expect(result.value).toBe(raw);
    expect(result.kinds).toEqual([]);
    expect(result.count).toBe(0);
  });

  it('passes a whole structure through when disabled', () => {
    const body = { text: 'postgresql://u:p@db.example/app', logs: [`Bearer ${JWT}`] };
    const result = redactSecretsDeep(body, OFF);
    expect(result.value).toEqual(body);
    expect(result.count).toBe(0);
    expect(result.kinds).toEqual([]);
  });

  const switchCases: readonly [string | undefined, boolean, boolean][] = [
    ['1', true, true],
    ['1', false, true],
    ['0', true, false],
    ['0', false, false],
    [undefined, true, true],
    [undefined, false, false],
    ['si', true, true],
    ['si', false, false],
  ];

  it.each(switchCases)('reads %s with default %s as %s', (value, defaultOn, expected) => {
    const env: NodeJS.ProcessEnv = value === undefined ? {} : { CAUCE_REDACT: value };
    expect(redactionEnabledFromEnv(env, 'CAUCE_REDACT', defaultOn)).toBe(expected);
  });
});

describe('deep redaction', () => {
  it('redacts strings inside nested objects and merges the families', () => {
    const payload = {
      headers: { Authorization: 'authorization: aB3xY9zK1mN4pQ7rT8wZ9yZ2aBcDeFgHi' },
      db: 'postgresql://u:p@db.example/app',
      nota: 'hola',
    };
    const result = redactSecretsDeep(payload, ON);
    expect(result.value.headers.Authorization).toContain(REDACTION_MARK);
    expect(result.value.db).toContain(REDACTION_URI_MARK);
    expect(result.value.nota).toBe('hola');
    expect(result.kinds).toEqual(['authorization', 'uri_credentials']);
  });

  it('redacts strings inside arrays', () => {
    const logs = ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'log normal', 'Bearer Ab3xY9zK1mN4pQ7rT8wZ9yZ2'];
    const result = redactSecretsDeep(logs, ON);
    expect(result.value[0]).toContain(REDACTION_MARK);
    expect(result.value[1]).toBe('log normal');
    expect(result.value[2]).toContain(REDACTION_MARK);
  });

  it('never scans a content_base64 value, at any depth', () => {
    const secret = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const payload = {
      content_base64: secret.repeat(10),
      attachments_v1: [{ name: 'foto.jpg', content_base64: secret }],
      nested: { deeper: { content_base64: secret } },
      texto: secret,
    };
    const result = redactSecretsDeep(payload, ON);
    expect(result.value.content_base64).toBe(secret.repeat(10));
    expect(result.value.attachments_v1[0]?.content_base64).toBe(secret);
    expect(result.value.nested.deeper.content_base64).toBe(secret);
    expect(result.value.texto).toBe(REDACTION_MARK);
  });

  it('redacts a secret nested well below the old depth cap', () => {
    const secret = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: secret } } } } } } } } };
    const result = redactSecretsDeep(deep, ON);
    expect(JSON.stringify(result.value)).not.toContain(secret);
    expect(result.value.a.b.c.d.e.f.g.h.i).toBe(REDACTION_MARK);
    expect(result.count).toBe(1);
    expect(result.unscanned).toBeUndefined();
  });

  it('survives a structure deeper than any recursion would take', () => {
    const secret = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    let node: Record<string, unknown> = { leaf: secret };
    for (let level = 0; level < 20_000; level += 1) node = { nested: node };
    const result = redactSecretsDeep(node, ON);
    let walked: Record<string, unknown> = result.value;
    for (let level = 0; level < 20_000; level += 1) {
      walked = walked.nested as Record<string, unknown>;
    }
    expect(walked.leaf).toBe(REDACTION_MARK);
    expect(result.count).toBe(1);
  });

  it('reports the nodes it refused to walk instead of reporting them clean', () => {
    const secret = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const wide: unknown[] = Array.from({ length: MAX_SCANNED_NODES + 10 }, () => 1);
    wide[0] = secret;
    wide[wide.length - 1] = secret;
    const result = redactSecretsDeep(wide, ON);
    expect(result.value[0]).toBe(REDACTION_MARK);
    expect(result.count).toBe(1);
    expect(result.unscanned?.reason).toBe('node_budget');
    expect(result.unscanned?.count).toBeGreaterThan(0);
    expect(result.value.at(-1)).toBe(secret);
  });

  it('never turns a __proto__ key into a prototype write', () => {
    const raw = '{"__proto__":{"isAdmin":true,"tenant_id":"steven"},"text":"hola"}';
    const input = JSON.parse(raw) as Record<string, unknown>;
    const result = redactSecretsDeep(input, ON);
    const output = result.value;
    expect(Object.getPrototypeOf(output)).toBe(null);
    expect(Object.keys(output).sort()).toEqual(['__proto__', 'text']);
    expect((output as { isAdmin?: unknown }).isAdmin).toBeUndefined();
    expect((output as { tenant_id?: unknown }).tenant_id).toBeUndefined();
    expect(({} as { isAdmin?: unknown }).isAdmin).toBeUndefined();
  });

  it('keeps a constructor key as plain data', () => {
    const raw = '{"constructor":{"prototype":{"isAdmin":true}},"text":"hola"}';
    const input = JSON.parse(raw) as Record<string, unknown>;
    const result = redactSecretsDeep(input, ON);
    expect(Object.keys(result.value).sort()).toEqual(['constructor', 'text']);
    expect(({} as { isAdmin?: unknown }).isAdmin).toBeUndefined();
  });
});

describe('one deep walk has an aggregate character budget', () => {
  const SECRET = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  const MIB = 1024 * 1024;
  const fill = (seed: string): string => seed.repeat(Math.ceil(MIB / seed.length)).slice(0, MIB);
  /* Loose on purpose: what it pins is that no crafted body buys seconds of the event loop, not
     how fast the machine running it is. */
  const CEILING_MS = 2_000;

  it('walks a crafted flood of private-key headers without stalling the event loop', () => {
    const body = {
      type: 'chat', text: 'hola',
      junk: Array.from({ length: 12 }, () => fill('-----BEGIN PRIVATE KEY-----'))
    };
    const started = performance.now();
    const result = redactSecretsDeep(body, ON);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(CEILING_MS);
    expect(result.count).toBe(0);
    expect(result.unscanned?.reason).toBe('character_budget');
    expect(result.unscanned?.count).toBe(12 * MIB - MAX_SCANNED_TOTAL_CHARACTERS + 'hola'.length + 'chat'.length);
  });

  it('still redacts inside the budget and reports the remainder it never read', () => {
    const benign = fill('lorem ipsum dolor sit amet ');
    const body = {
      junk: [
        `${SECRET} ${benign}`.slice(0, MIB),
        ...Array.from({ length: 10 }, () => benign),
        `${benign} ${SECRET}`.slice(-MIB)
      ]
    };
    const started = performance.now();
    const result = redactSecretsDeep(body, ON);
    expect(performance.now() - started).toBeLessThan(CEILING_MS);
    expect(result.value.junk[0]?.startsWith(REDACTION_MARK)).toBe(true);
    expect(result.count).toBe(1);
    expect(result.value.junk.at(-1)).toContain(SECRET);
    expect(result.unscanned?.reason).toBe('character_budget');
    expect(result.unscanned?.count).toBeGreaterThan(0);
  });

  it('reports every bound it hit, not only the first', () => {
    const wide: unknown[] = Array.from({ length: MAX_SCANNED_NODES + 10 }, () => 'x');
    wide[0] = 'a'.repeat(MAX_SCANNED_VALUE_CHARACTERS + 25);
    for (let index = 1; index * MAX_SCANNED_VALUE_CHARACTERS < MAX_SCANNED_TOTAL_CHARACTERS; index += 1) {
      wide[index] = 'b'.repeat(MAX_SCANNED_VALUE_CHARACTERS);
    }
    const result = redactSecretsDeep(wide, ON);
    expect(result.unscanned?.reason).toBe('mixed');
    expect(result.unscanned?.reasons).toEqual([
      { reason: 'value_length', count: 25 },
      { reason: 'character_budget', count: expect.any(Number) as number },
      { reason: 'node_budget', count: expect.any(Number) as number },
    ]);
    const total = (result.unscanned?.reasons ?? []).reduce((sum, part) => sum + part.count, 0);
    expect(result.unscanned?.count).toBe(total);
  });
});

describe('attachment names', () => {
  it('applies the same rules to a filename', () => {
    expect(redactAttachmentName('ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789.txt', ON))
      .toBe(`${REDACTION_MARK}.txt`);
    expect(redactAttachmentName('informe-final.pdf', ON)).toBe('informe-final.pdf');
  });

  it('returns the name unchanged when disabled', () => {
    const name = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789.txt';
    expect(redactAttachmentName(name, OFF)).toBe(name);
  });
});
