import { describe, expect, it } from 'vitest';
import {
  dataUriByteLength,
  decodeCanonicalBase64,
  isDeliverableArtifactUri,
  MAX_ARTIFACT_LOCATOR_CHARACTERS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_RELAY_ARTIFACTS_TOTAL,
  parseDataUri,
} from '../src/index.js';

const REAL_DATA_URI = `data:text/plain;base64,${Buffer.from('hola').toString('base64')}`;

const DELIVERABLE = [
  REAL_DATA_URI,
  `data:application/pdf;base64,${Buffer.from('%PDF-1.4').toString('base64')}`,
  'data:text/plain;charset=utf-8;base64,aG9sYQ==',
  'https://consola.example/informe.pdf',
  'https://consola.example',
];

const NOT_DELIVERABLE = [
  'data:x',
  'data:,hola',
  'data:text/plain;base64,',
  'data:text/plain;base64,a',
  'data:text/plain,hola;base64,aG9sYQ==',
  'https:not-a-url',
  'https://',
  'http://consola.example/informe.pdf',
  'file:///workspace/informe.pdf',
  '/workspace/informe.pdf',
  '',
];

const EGRESS_DECODES: readonly (readonly [string, string])[] = [
  ['a case-different scheme', `DATA:application/pdf;base64,${Buffer.from('%PDF-1.4').toString('base64')}`],
  ['a base64 payload wrapped in newlines', 'data:application/pdf;base64,aG9s\nYQ==\n'],
  ['a base64 payload broken by a space', 'data:text/plain;base64,aG9s YQ=='],
  ['a missing media type', 'data:;base64,aG9sYQ=='],
  ['a media type nobody can parse', 'data:no es un tipo;base64,aG9sYQ=='],
];

const EGRESS_REFUSES: readonly (readonly [string, string])[] = [
  ['a data uri with no payload at all', 'data:application/pdf;base64,'],
  ['a payload of only whitespace', 'data:application/pdf;base64, \n '],
  ['a header without the base64 parameter', 'data:application/pdf,hola'],
];

describe('deliverable artifact uris', () => {
  it.each(DELIVERABLE)('accepts %s', (uri) => {
    expect(isDeliverableArtifactUri(uri)).toBe(true);
  });

  it.each(NOT_DELIVERABLE)('rejects %s', (uri) => {
    expect(isDeliverableArtifactUri(uri)).toBe(false);
  });

  it('rejects an https url carrying a control code point', () => {
    expect(isDeliverableArtifactUri('https://consola.example/ informe.pdf')).toBe(false);
    expect(isDeliverableArtifactUri('https://consola\n.example/informe.pdf')).toBe(false);
  });

  it('rejects a locator longer than a url may measure', () => {
    const path = 'a'.repeat(MAX_ARTIFACT_LOCATOR_CHARACTERS);
    expect(isDeliverableArtifactUri(`https://consola.example/${path}`)).toBe(false);
    expect(isDeliverableArtifactUri(`https://consola.example/${path}`.slice(0, MAX_ARTIFACT_LOCATOR_CHARACTERS)))
      .toBe(true);
  });

  it('judges shape and never destination: a private host is deliverable', () => {
    expect(isDeliverableArtifactUri('https://127.0.0.1/informe.pdf')).toBe(true);
    expect(isDeliverableArtifactUri('https://169.254.169.254/latest/meta-data/')).toBe(true);
  });
});

/* Every row the reviewer measured against `decodeDataUri` of the telegram bridge: what the egress
   decodes and uploads, the store must not veto, or the file is replaced by a generic notice. */
describe('the predicate agrees with the egress decoder', () => {
  it.each(EGRESS_DECODES)('accepts %s', (_case, uri) => {
    expect(isDeliverableArtifactUri(uri)).toBe(true);
  });

  it.each(EGRESS_REFUSES)('rejects %s, exactly as the decoder does', (_case, uri) => {
    expect(isDeliverableArtifactUri(uri)).toBe(false);
  });

  it('derives the relay artifact ceiling from the attachment cap', () => {
    expect(MAX_RELAY_ARTIFACTS_TOTAL).toBe(2 * MAX_ATTACHMENTS_PER_MESSAGE);
  });
});

function parsed(uri: string) {
  const value = parseDataUri(uri);
  if (value === undefined) throw new Error(`no parsea: ${uri}`);
  return value;
}

describe('parseDataUri reads the header the way the egress does', () => {
  it.each([
    ['last', 'data:text/plain;charset=utf-8;base64,aG9sYQ=='],
    ['in the middle', 'data:text/plain;base64;charset=utf-8,aG9sYQ=='],
    ['first', 'data:text/plain;base64,aG9sYQ=='],
    ['alone, with no media type', 'data:;base64,aG9sYQ=='],
  ])('finds the base64 parameter %s', (_case, uri) => {
    const value = parsed(uri);
    expect(value.base64).toBe(true);
    expect(value.bytes().toString('utf8')).toBe('hola');
  });

  it('lowercases the scheme and the header', () => {
    const value = parsed('DATA:TEXT/PLAIN;CHARSET=UTF-8;BASE64,aG9sYQ==');
    expect(value.base64).toBe(true);
    expect(value.mediaType).toBe('text/plain');
    expect(value.params).toEqual(['text/plain', 'charset=utf-8', 'base64']);
    expect(value.bytes().toString('utf8')).toBe('hola');
  });

  it('strips whitespace from a base64 payload', () => {
    const value = parsed('data:application/pdf;base64,aG9s\nYQ==\n');
    expect(value.payload).toBe('aG9sYQ==');
    expect(value.bytes().toString('utf8')).toBe('hola');
  });

  it('defaults the media type when the header omits it', () => {
    expect(parsed('data:;base64,aG9sYQ==').mediaType).toBe('application/octet-stream');
    expect(parsed('data:,hola').mediaType).toBe('application/octet-stream');
  });

  /* The header's first slot is the media type whatever it spells, so a lone `base64` fills both
     roles: flag and type. Every reader downstream validates the type it gets, so the doubling is
     inert here -- but it is the one place the two slots can be the same characters. */
  it('reads a header whose only field is the base64 flag', () => {
    const value = parsed('data:base64,aG9sYQ==');
    expect(value.base64).toBe(true);
    expect(value.mediaType).toBe('base64');
    expect(value.params).toEqual(['base64']);
    expect(value.payload).toBe('aG9sYQ==');
    expect(value.bytes().toString('utf8')).toBe('hola');
    expect(isDeliverableArtifactUri('data:base64,aG9sYQ==')).toBe(true);
  });

  it.each(['https://consola.example/informe.pdf', 'data:x', '/workspace/informe.pdf', ''])(
    'returns undefined for %s',
    (uri) => {
      expect(parseDataUri(uri)).toBeUndefined();
    },
  );
});

describe('parseDataUri decodes the percent form byte-wise', () => {
  it('keeps binary escapes that are not valid utf-8', () => {
    const value = parsed('data:application/octet-stream,%ff%fe%01%02%41%42%80%90');
    expect(value.base64).toBe(false);
    expect([...value.bytes()]).toEqual([0xff, 0xfe, 0x01, 0x02, 0x41, 0x42, 0x80, 0x90]);
  });

  it('mixes escapes with multibyte characters, byte for byte', () => {
    const value = parsed('data:text/plain,á%20ñ😀%41');
    expect(value.bytes()).toEqual(Buffer.from('á ñ😀A', 'utf8'));
  });

  it('treats an invalid escape as literal bytes and never throws', () => {
    expect(parsed('data:text/plain,100%').bytes()).toEqual(Buffer.from('100%', 'utf8'));
    expect(parsed('data:text/plain,%zz%4').bytes()).toEqual(Buffer.from('%zz%4', 'utf8'));
    expect(parsed('data:text/plain,%%41').bytes()).toEqual(Buffer.from('%A', 'utf8'));
    expect(parsed('data:text/plain,').bytes()).toEqual(Buffer.alloc(0));
  });

  it('keeps whitespace of a percent payload, where a space is a byte', () => {
    expect(parsed('data:text/plain,a b').payload).toBe('a b');
  });

  it('never throws on base64 that is not canonical', () => {
    expect(parsed('data:text/plain;base64,a').bytes()).toBeInstanceOf(Buffer);
    expect(parsed('data:text/plain;base64,***').bytes()).toBeInstanceOf(Buffer);
  });
});

describe('dataUriByteLength weighs without decoding', () => {
  it.each([0, 1, 2, 3, 4, 5, 100])('matches the decoded length for %i bytes', (size) => {
    const uri = `data:application/octet-stream;base64,${Buffer.alloc(size, 7).toString('base64')}`;
    expect(dataUriByteLength(uri)).toBe(parsed(uri).bytes().length);
  });

  it('discounts the whitespace a wrapped payload carries', () => {
    expect(dataUriByteLength('data:application/pdf;base64,aG9s\nYQ==\n')).toBe(4);
  });

  it('weighs a percent payload as the utf-8 text it travels as', () => {
    expect(dataUriByteLength('data:text/plain,á%20ñ')).toBe(Buffer.byteLength('á%20ñ', 'utf8'));
  });

  it('weighs anything it cannot parse as the whole string', () => {
    expect(dataUriByteLength('https://consola.example/informe.pdf'))
      .toBe(Buffer.byteLength('https://consola.example/informe.pdf', 'utf8'));
    expect(dataUriByteLength('data:x')).toBe(6);
  });

  /* The counter and the parser share a whitespace CLASS, never a regex instance: a `g` regex
     carries `lastIndex`, so one shared object would let a weigh-in move the parser's next read. */
  it('gives the same answer on every reading, interleaved with the parser', () => {
    const uri = 'data:application/pdf;base64,aG9s\nYQ==\n';
    expect(dataUriByteLength(uri)).toBe(4);
    expect(parseDataUri(uri)?.payload).toBe('aG9sYQ==');
    expect(dataUriByteLength(uri)).toBe(4);
    expect(dataUriByteLength(uri)).toBe(4);
  });

  /* What the docstring promises and what bounds the shape it cannot charge: the whitespace of a
     padded payload is free here, so only the caller's CHARACTER cap keeps it out of memory. */
  it('charges a whitespace-padded payload its stripped bytes, never its characters', () => {
    const uri = `data:text/plain;base64,${' '.repeat(10_000)}QUJDRA==`;
    expect(dataUriByteLength(uri)).toBe(4);
    expect(uri.length).toBeGreaterThan(10_000);
  });

  it('measures a large base64 payload without allocating it', () => {
    const uri = `data:application/octet-stream;base64,${'A'.repeat(4_000_000)}`;
    expect(dataUriByteLength(uri)).toBe(3_000_000);
  });
});

/* One parser or the divergence comes back: the guard, the byte budget and the egress each used to
   split the header their own way, and a `data:` accepted by one and skipped by another is how a
   sealed secret reached a chat. */
describe('the parser and the predicate agree on every row', () => {
  const rows = [
    ...DELIVERABLE,
    ...NOT_DELIVERABLE,
    ...EGRESS_DECODES.map(([, uri]) => uri),
    ...EGRESS_REFUSES.map(([, uri]) => uri),
  ].filter((uri) => /^data:/iu.test(uri));

  it.each(rows)('agrees on %s', (uri) => {
    const value = parseDataUri(uri);
    const deliverable = value !== undefined && value.base64
      && decodeCanonicalBase64(value.payload, MAX_ATTACHMENT_BYTES) !== undefined;
    expect(deliverable).toBe(isDeliverableArtifactUri(uri));
  });
});
