// Golden-vector suite for the PTY wire contract v1.
//
// This is the test that catches a protocol divergence before it reaches production: the
// gateway, the terminal-relay and the Python pty-agent are written by different teams and
// never see each other, so the only thing keeping them compatible is that all three
// reproduce tests/terminal-pty/vectors.json byte for byte.
//
// Run: pnpm vitest run tests/terminal-pty/vectors.test.ts

import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createGovernanceSandbox, type GovernanceOutput, type GovernanceSandbox } from './governance-double.mjs';
import {
  CLOSE_CODE, FrameDecoder, GEOMETRY_CLAMP, MAX_FRAME_PAYLOAD, PREFIXED_TAGS, TAG, TICKET_HKDF_SALT,
  b64urlDecode, b64urlEncode, canonicalTicketPayload, closeCodeForTicketReason,
  decodeDataPayload, decodeSingleFrame, deriveAliasKey, encodeDataFrame, encodeFrame,
  encodeJsonFrame, mintTicket, verifyTicket,
  type TicketPayload, type TicketVerifyOptions,
} from './protocol.mjs';

interface VectorCase {
  name: string;
  kind: string;
  must_fail: boolean;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

interface VectorFile {
  contract: string;
  frozen: boolean;
  master_key_b64: string;
  hkdf: { salt_utf8: string; length: number };
  framing: {
    max_payload: number;
    session_id_bytes: number;
    tags: Record<string, number>;
    prefixed_tags: string[];
  };
  geometry: Record<string, unknown>;
  limits: Record<string, number>;
  ttls: Record<string, number>;
  modes: { all: string[]; writable: string[]; tui: string[]; read_only: string[] };
  ws_close_codes: Record<string, number>;
  keys: Record<string, string>;
  cases: VectorCase[];
}

const vectorsPath = fileURLToPath(new URL('./vectors.json', import.meta.url));
const vectorsRaw = readFileSync(vectorsPath, 'utf8');
const vectors = JSON.parse(vectorsRaw) as VectorFile;

const agentSessionPath = fileURLToPath(new URL('../../ops/pty-agent/cauce_pty_agent/session.py', import.meta.url));

function readOnlyModesOfAgent(): string[] {
  const source = readFileSync(agentSessionPath, 'utf8');
  const declaration = /^READ_ONLY_MODES\s*=\s*frozenset\(\{([^}]*)\}\)/m.exec(source);
  if (declaration === null) {
    throw new Error('the agent no longer declares READ_ONLY_MODES as a frozenset literal; pin modes.read_only again by hand');
  }
  return [...(declaration[1] ?? '').matchAll(/["']([^"']+)["']/g)].map((match) => String(match[1]));
}

// The three values below come from the frozen specification, not from this harness. They are
// spelled out here so a "helpful" regeneration of vectors.json cannot silently move the contract.
const GOLDEN_MASTER_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const GOLDEN_ALIAS_KEY_HEX = '33ab99cc766ee43031f9c22b8db78aeae5b04bc0ebedddfe8539330af7233efa';
const GOLDEN_PAYLOAD_JSON = '{"v":1,"sid":"11111111-2222-3333-4444-555555555555","op":"unattributed:console-basic-auth","sub":"Steven:kant","tgt":{"tenant":"Steven","alias":"jarvis","container":"claw","generation":"gen-1","image":"sha256:deadbeef","uid":1000,"user":"claw"},"mode":"shell","iat":1750000000,"exp":1750000030}';
const GOLDEN_TICKET = 'v1.eyJ2IjoxLCJzaWQiOiIxMTExMTExMS0yMjIyLTMzMzMtNDQ0NC01NTU1NTU1NTU1NTUiLCJvcCI6InVuYXR0cmlidXRlZDpjb25zb2xlLWJhc2ljLWF1dGgiLCJzdWIiOiJTdGV2ZW46a2FudCIsInRndCI6eyJ0ZW5hbnQiOiJTdGV2ZW4iLCJhbGlhcyI6ImphcnZpcyIsImNvbnRhaW5lciI6ImNsYXciLCJnZW5lcmF0aW9uIjoiZ2VuLTEiLCJpbWFnZSI6InNoYTI1NjpkZWFkYmVlZiIsInVpZCI6MTAwMCwidXNlciI6ImNsYXcifSwibW9kZSI6InNoZWxsIiwiaWF0IjoxNzUwMDAwMDAwLCJleHAiOjE3NTAwMDAwMzB9.034UhsCFtCkD-mxdU51meZwH44SLyjrD1PT26ikM3iY';
const GOLDEN_STDOUT_FRAME_HEX = '210000002631313131313131312d323232322d333333332d343434342d3535353535353535353535356869';

function text(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string') throw new Error(`vector field ${key} is not a string`);
  return value;
}

function integer(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== 'number') throw new Error(`vector field ${key} is not a number`);
  return value;
}

function record(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`vector field ${key} is not an object`);
  }
  return value as Record<string, unknown>;
}

function tagValue(name: unknown): number {
  if (typeof name === 'number') return name;
  if (typeof name !== 'string') throw new Error('frame tag must be a name or a byte');
  const tag = vectors.framing.tags[name];
  if (tag === undefined) throw new Error(`unknown tag name ${name}`);
  return tag;
}

function tagName(tag: number): string {
  const found = Object.entries(vectors.framing.tags).find(([, value]) => value === tag);
  return found ? found[0] : String(tag);
}

function failureReason(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  if (error instanceof Error && 'reason' in error && typeof error.reason === 'string') return error.reason;
  throw error;
}

function buildPayload(spec: Record<string, unknown>): Buffer {
  const type = text(spec, 'type');
  if (type === 'empty') return Buffer.alloc(0);
  if (type === 'json') return Buffer.from(JSON.stringify(spec.value), 'utf8');
  if (type !== 'data') throw new Error(`unknown payload type ${type}`);
  return Buffer.from(text(spec, 'session_id'), 'ascii');
}

function buildData(spec: Record<string, unknown>): Buffer {
  if (typeof spec.data_utf8 === 'string') return Buffer.from(spec.data_utf8, 'utf8');
  if (typeof spec.data_hex === 'string') return Buffer.from(spec.data_hex, 'hex');
  if (spec.fill !== undefined) {
    const fill = record(spec, 'fill');
    return Buffer.alloc(integer(fill, 'count'), integer(fill, 'byte'));
  }
  return Buffer.alloc(0);
}

function encodeCase(testCase: VectorCase): Buffer {
  const tag = tagValue(testCase.input.tag);
  const spec = record(testCase.input, 'payload');
  const type = text(spec, 'type');
  if (type === 'data') return encodeDataFrame(tag, text(spec, 'session_id'), buildData(spec));
  if (type === 'json') return encodeJsonFrame(tag, spec.value);
  return encodeFrame(tag, buildPayload(spec));
}

function verifyOptions(raw: Record<string, unknown>): TicketVerifyOptions {
  const options: TicketVerifyOptions = {};
  if (typeof raw.now === 'number') options.now = raw.now;
  if (typeof raw.clock_skew_sec === 'number') options.clock_skew_sec = raw.clock_skew_sec;
  if (typeof raw.session_id === 'string') options.session_id = raw.session_id;
  if (typeof raw.tenant === 'string') options.tenant = raw.tenant;
  if (typeof raw.alias === 'string') options.alias = raw.alias;
  if (typeof raw.container_id === 'string') options.container_id = raw.container_id;
  if (typeof raw.generation === 'string') options.generation = raw.generation;
  if (Array.isArray(raw.modes)) options.modes = raw.modes.filter((mode): mode is string => typeof mode === 'string');
  return options;
}

function casesOf(kind: string): VectorCase[] {
  const selected = vectors.cases.filter((testCase) => testCase.kind === kind);
  if (selected.length === 0) throw new Error(`vectors.json has no cases of kind ${kind}`);
  return selected;
}

describe('pty wire vectors: the fixture file itself', () => {
  it('still carries the frozen golden values from the specification', () => {
    expect(vectors.contract).toBe('cauce-v3/pty-wire/v1');
    expect(vectors.frozen).toBe(true);
    expect(vectors.master_key_b64).toBe(GOLDEN_MASTER_B64);
    expect(vectors.hkdf).toMatchObject({ salt_utf8: TICKET_HKDF_SALT, length: 32 });
    expect(vectors.keys['Steven:jarvis']).toBe(GOLDEN_ALIAS_KEY_HEX);
    expect(vectorsRaw).toContain(GOLDEN_TICKET);
    expect(vectorsRaw).toContain(GOLDEN_STDOUT_FRAME_HEX);
    expect(vectors.framing.max_payload).toBe(MAX_FRAME_PAYLOAD);
    expect(vectors.framing.tags).toMatchObject({ STDOUT: TAG.STDOUT, STDIN: TAG.STDIN, PING: TAG.PING });
    expect(vectors.ws_close_codes).toStrictEqual(CLOSE_CODE);
  });

  it('gives every case a unique name, a kind and an explicit must_fail', () => {
    const names = new Set<string>();
    for (const testCase of vectors.cases) {
      expect(typeof testCase.name, testCase.name).toBe('string');
      expect(typeof testCase.kind, testCase.name).toBe('string');
      expect(typeof testCase.must_fail, testCase.name).toBe('boolean');
      expect(names.has(testCase.name), `duplicate case ${testCase.name}`).toBe(false);
      names.add(testCase.name);
    }
    expect(vectors.cases.length).toBeGreaterThanOrEqual(30);
  });
});

describe('pty wire vectors: ticket derivation and signing', () => {
  // Deliberately independent of protocol.mjs: if the harness and the specification ever
  // disagree, this recomputation from raw primitives is the tie-breaker.
  it('reproduces the golden alias key, payload and ticket from raw primitives', () => {
    const master = Buffer.from(GOLDEN_MASTER_B64, 'base64');
    const info = Buffer.from('pty:Steven:jarvis', 'utf8');
    const aliasKey = Buffer.from(hkdfSync('sha256', master, Buffer.from(TICKET_HKDF_SALT, 'utf8'), info, 32));
    expect(aliasKey.toString('hex')).toBe(GOLDEN_ALIAS_KEY_HEX);

    const b64url = (bytes: Buffer): string =>
      bytes.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const signingInput = `v1.${b64url(Buffer.from(GOLDEN_PAYLOAD_JSON, 'utf8'))}`;
    const mac = createHmac('sha256', aliasKey).update(Buffer.from(signingInput, 'ascii')).digest();
    expect(`${signingInput}.${b64url(mac)}`).toBe(GOLDEN_TICKET);
  });

  it.each(casesOf('derive_alias_key'))('$name', (testCase) => {
    const { input, expected } = testCase;
    if (testCase.must_fail) {
      try {
        deriveAliasKey(text(input, 'master_key_b64'), text(input, 'tenant'), text(input, 'alias'));
        expect.unreachable(`${testCase.name} should have failed`);
      } catch (error) {
        expect(failureReason(error)).toBe(text(expected, 'reason'));
      }
      return;
    }
    const key = deriveAliasKey(text(input, 'master_key_b64'), text(input, 'tenant'), text(input, 'alias'));
    expect(key).toHaveLength(32);
    expect(key.toString('hex')).toBe(text(expected, 'alias_key_hex'));
  });

  it.each(casesOf('canonical_payload'))('$name', (testCase) => {
    const payload = record(testCase.input, 'payload') as unknown as TicketPayload;
    if (testCase.must_fail) {
      try {
        canonicalTicketPayload(payload);
        expect.unreachable(`${testCase.name} should have failed`);
      } catch (error) {
        expect(failureReason(error)).toBe(text(testCase.expected, 'reason'));
      }
      return;
    }
    const json = canonicalTicketPayload(payload);
    expect(json).toBe(text(testCase.expected, 'payload_json'));
    // The signed bytes must round-trip to the same object: key order is the only freedom taken.
    expect(JSON.parse(json)).toStrictEqual(payload);
  });

  it.each(casesOf('mint_ticket'))('$name', (testCase) => {
    const aliasKey = Buffer.from(text(testCase.input, 'alias_key_hex'), 'hex');
    const payload = record(testCase.input, 'payload') as unknown as TicketPayload;
    const ticket = mintTicket(aliasKey, payload);
    expect(ticket).toBe(text(testCase.expected, 'ticket'));
    // Round-trip: the ticket we mint is the ticket our own verifier accepts.
    const verified = verifyTicket(aliasKey, ticket, { now: payload.iat });
    expect(verified.ok).toBe(true);
    expect(b64urlDecode(ticket.split('.')[1] ?? '').toString('utf8')).toBe(canonicalTicketPayload(payload));
  });

  it.each(casesOf('verify_ticket'))('$name', (testCase) => {
    const aliasKey = Buffer.from(text(testCase.input, 'alias_key_hex'), 'hex');
    const options = verifyOptions(record(testCase.input, 'options'));
    const result = verifyTicket(aliasKey, text(testCase.input, 'ticket'), options);
    if (testCase.must_fail) {
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe(text(testCase.expected, 'reason'));
      expect(closeCodeForTicketReason(result.reason)).toBe(integer(testCase.expected, 'ws_close_code'));
      return;
    }
    expect(result.ok, `unexpected reason ${result.ok ? '' : result.reason}`).toBe(true);
    if (!result.ok) return;
    expect(result.payload.sid).toBe(text(testCase.expected, 'sid'));
    expect(result.payload.tgt.alias).toBe(text(testCase.expected, 'alias'));
    expect(result.payload.tgt.uid).toBe(integer(testCase.expected, 'uid'));
    expect(result.payload.tgt.user).toBe(text(testCase.expected, 'user'));
    expect(result.payload.mode).toBe(text(testCase.expected, 'mode'));
  });

  it('never lets a ticket for one alias validate under another alias key', () => {
    const jarvis = deriveAliasKey(GOLDEN_MASTER_B64, 'Steven', 'jarvis');
    const kant = deriveAliasKey(GOLDEN_MASTER_B64, 'Steven', 'kant');
    expect(jarvis.equals(kant)).toBe(false);
    expect(verifyTicket(kant, GOLDEN_TICKET, { now: 1_750_000_015 })).toMatchObject({ ok: false, reason: 'bad_signature' });
  });
});

describe('pty wire vectors: framing', () => {
  it.each(casesOf('encode_frame'))('$name', (testCase) => {
    if (testCase.must_fail) {
      try {
        encodeCase(testCase);
        expect.unreachable(`${testCase.name} should have failed`);
      } catch (error) {
        expect(failureReason(error)).toBe(text(testCase.expected, 'reason'));
      }
      return;
    }
    const frame = encodeCase(testCase);
    if (typeof testCase.expected.frame_hex === 'string') {
      expect(frame.toString('hex')).toBe(testCase.expected.frame_hex);
    } else {
      expect(frame).toHaveLength(integer(testCase.expected, 'frame_length'));
      expect(frame.subarray(0, 5).toString('hex')).toBe(text(testCase.expected, 'header_hex'));
      expect(createHash256(frame)).toBe(text(testCase.expected, 'frame_sha256'));
    }
    // Whatever we encode must decode back through the incremental decoder.
    const decoded = decodeSingleFrame(frame);
    expect(decoded.tag).toBe(tagValue(testCase.input.tag));
  });

  it.each(casesOf('decode_frame'))('$name', (testCase) => {
    const bytes = Buffer.from(text(testCase.input, 'frame_hex'), 'hex');
    if (testCase.must_fail) {
      try {
        const frame = decodeSingleFrame(bytes);
        // Length failures surface at the header; data-shape failures at the payload.
        decodeDataPayload(frame.payload);
        expect.unreachable(`${testCase.name} should have failed`);
      } catch (error) {
        expect(failureReason(error)).toBe(text(testCase.expected, 'reason'));
      }
      return;
    }
    const frame = decodeSingleFrame(bytes);
    expect(tagName(frame.tag)).toBe(String(testCase.expected.tag));
    expect(frame.known).toBe(testCase.expected.known);
    if (typeof testCase.expected.payload_hex === 'string') {
      expect(frame.payload.toString('hex')).toBe(testCase.expected.payload_hex);
    }
    if (typeof testCase.expected.session_id === 'string') {
      const data = decodeDataPayload(frame.payload);
      expect(data.session_id).toBe(testCase.expected.session_id);
      expect(data.data.toString('utf8')).toBe(testCase.expected.data_utf8);
    }
    if (typeof testCase.expected.action === 'string') {
      expect(testCase.expected.action).toBe('protocol_error');
      expect(CLOSE_CODE.protocol_error).toBe(integer(testCase.expected, 'ws_close_code'));
    }
  });

  it.each(casesOf('decode_stream'))('$name', (testCase) => {
    const stream = Buffer.from(text(testCase.input, 'stream_hex'), 'hex');
    const chunkSize = integer(testCase.input, 'chunk_size');
    const decoder = new FrameDecoder();
    const collected: { tag: number; payload: Buffer }[] = [];
    const feed = (): void => {
      if (chunkSize <= 0) {
        collected.push(...decoder.push(stream));
        return;
      }
      for (let offset = 0; offset < stream.length; offset += chunkSize) {
        collected.push(...decoder.push(stream.subarray(offset, offset + chunkSize)));
      }
    };

    if (testCase.must_fail) {
      try {
        feed();
        expect.unreachable(`${testCase.name} should have failed`);
      } catch (error) {
        expect(failureReason(error)).toBe(text(testCase.expected, 'reason'));
      }
      return;
    }

    feed();
    const expectedFrames = testCase.expected.frames;
    if (!Array.isArray(expectedFrames)) throw new Error('expected.frames must be an array');
    expect(collected).toHaveLength(expectedFrames.length);
    expectedFrames.forEach((raw, index) => {
      const expectedFrame = raw as Record<string, unknown>;
      const frame = collected[index];
      if (frame === undefined) throw new Error(`missing decoded frame ${String(index)}`);
      expect(tagName(frame.tag)).toBe(String(expectedFrame.tag));
      if (typeof expectedFrame.session_id === 'string') {
        const data = decodeDataPayload(frame.payload);
        expect(data.session_id).toBe(expectedFrame.session_id);
        expect(data.data.toString('utf8')).toBe(expectedFrame.data_utf8);
      }
      if (typeof expectedFrame.payload_hex === 'string') {
        expect(frame.payload.toString('hex')).toBe(expectedFrame.payload_hex);
      }
    });
    expect(decoder.pending).toBe(integer(testCase.expected, 'pending'));
  });

  it('round-trips every byte value through a STDIN frame without transcoding', () => {
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const every = Buffer.alloc(256);
    for (let byte = 0; byte < 256; byte += 1) every[byte] = byte;
    const frame = encodeDataFrame(TAG.STDIN, sessionId, every);
    const decoded = decodeDataPayload(decodeSingleFrame(frame).payload);
    expect(decoded.session_id).toBe(sessionId);
    expect(decoded.data.equals(every)).toBe(true);
  });

  it('encodes the announced length as a big-endian uint32', () => {
    const frame = encodeFrame(TAG.PING, Buffer.alloc(258));
    expect(frame.subarray(0, 5).toString('hex')).toBe('4000000102');
    expect(b64urlEncode(Buffer.from([0xfb, 0xff])) ).toBe('-_8');
  });
});

function indexRows(head: Record<string, unknown>): { path: string; bytes: number }[] {
  const entries = head.entries;
  if (!Array.isArray(entries)) throw new Error('READ_OK for a dir must carry entries');
  return entries
    .map((raw) => {
      const row = raw as Record<string, unknown>;
      return { path: text(row, 'path'), bytes: integer(row, 'bytes') };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function expectedRows(sandbox: GovernanceSandbox, expected: Record<string, unknown>): { path: string; bytes: number }[] {
  const entries = expected.entries;
  if (!Array.isArray(entries)) throw new Error('a dir vector must pin its entries');
  return entries
    .map((raw) => {
      const row = raw as Record<string, unknown>;
      return { path: `${sandbox.memory_root}/${text(row, 'path')}`, bytes: integer(row, 'bytes') };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function createHash256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface SeedFile { name: string; text?: string; fill?: { byte: number; count: number } }

function sandboxFor(testCase: VectorCase): GovernanceSandbox {
  const sandbox = createGovernanceSandbox({ harness: text(testCase.input, 'harness') });
  sandbox.seed((testCase.input.files ?? []) as SeedFile[]);
  sandbox.seedMemory((testCase.input.memory ?? []) as SeedFile[]);
  return sandbox;
}

function contentOf(spec: Record<string, unknown>): Buffer {
  return Buffer.from(text(spec, 'text'), 'utf8');
}

function chunksOf(content: Buffer): Buffer[] {
  const size = MAX_FRAME_PAYLOAD - 36;
  const parts: Buffer[] = [];
  for (let offset = 0; offset < content.length; offset += size) {
    parts.push(content.subarray(offset, offset + size));
  }
  return parts;
}

function writeRequest(sandbox: GovernanceSandbox, spec: Record<string, unknown>): {
  request: Record<string, unknown>;
  chunks: Buffer[];
} {
  const content = contentOf(spec);
  const chunks = chunksOf(content);
  const request: Record<string, unknown> = {
    request_id: text(spec, 'request_id'),
    path: sandbox.path(text(spec, 'basename')),
    operation: text(spec, 'operation'),
    content_sha: createHash256(content),
    bytes: content.length,
    chunks: chunks.length,
  };
  if (typeof spec.expected_sha === 'string') request.expected_sha = spec.expected_sha;
  return { request, chunks };
}

function batchRequest(sandbox: GovernanceSandbox, spec: Record<string, unknown>): {
  request: Record<string, unknown>;
  chunks: Buffer[];
} {
  const raw = spec.entries;
  if (!Array.isArray(raw)) throw new Error('batch vector needs an entries array');
  const chunks: Buffer[] = [];
  const entries = raw.map((item) => {
    const entry = item as Record<string, unknown>;
    const chunksBefore = chunks.length;
    const wire: Record<string, unknown> = {
      path: sandbox.path(text(entry, 'basename')),
      mode: text(entry, 'mode'),
      operation: text(entry, 'operation'),
      bytes: 0,
      chunks: 0,
    };
    if (wire.mode === 'write') {
      const content = contentOf(entry);
      const parts = chunksOf(content);
      chunks.push(...parts);
      Object.assign(wire, { content_sha: createHash256(content), bytes: content.length, chunks: parts.length });
    }
    if (typeof entry.expected_sha === 'string') wire.expected_sha = entry.expected_sha;
    if (entry.announce !== undefined && entry.announce !== null) {
      chunks.length = chunksBefore;
      Object.assign(wire, entry.announce as Record<string, unknown>);
    }
    return wire;
  });
  return { request: { request_id: text(spec, 'request_id'), entries }, chunks };
}

function terminal(outputs: GovernanceOutput[]): GovernanceOutput {
  const last = outputs[outputs.length - 1];
  if (last === undefined) throw new Error('the governance handler answered nothing');
  return last;
}

function jsonOf(output: GovernanceOutput): Record<string, unknown> {
  if (!('json' in output)) throw new Error('expected a JSON reply, got a data chunk');
  return output.json;
}

describe('pty wire vectors: governed reading and writing', () => {
  it.each(casesOf('governance_read'))('$name', (testCase) => {
    const sandbox = sandboxFor(testCase);
    try {
      const request = record(testCase.input, 'request');
      const kind = text(request, 'kind');
      const outputs = sandbox.read({
        request_id: text(request, 'request_id'),
        kind,
        path: kind === 'dir' ? sandbox.memory_root : sandbox.path(text(request, 'basename')),
      });
      const last = jsonOf(terminal(outputs));
      expect(tagName(terminal(outputs).tag)).toBe(text(testCase.expected, 'terminal_tag'));
      if (testCase.must_fail) {
        expect(outputs).toHaveLength(1);
        expect(last.error).toBe(text(testCase.expected, 'error'));
        expect(last.reason).toBe(text(testCase.expected, 'reason'));
        return;
      }
      const first = outputs[0];
      if (first === undefined) throw new Error('the governance case produced no output frame');
      const head = jsonOf(first);
      expect(tagName(first.tag)).toBe(text(testCase.expected, 'ok_tag'));
      if (kind === 'dir') {
        expect(head.path).toBe(sandbox.memory_root);
        expect(head.total).toBe(testCase.expected.total);
        expect(head.observed_at_least).toBe(integer(testCase.expected, 'observed_at_least'));
        expect(head.truncated).toBe(testCase.expected.truncated);
        expect(outputs, 'metadata only: READ_OK then READ_DONE, never a chunk').toHaveLength(2);
        expect(indexRows(head)).toEqual(expectedRows(sandbox, testCase.expected));
        expect(last.request_id).toBe(text(request, 'request_id'));
        return;
      }
      expect(head.bytes).toBe(integer(testCase.expected, 'bytes'));
      expect(head.truncated).toBe(testCase.expected.truncated);
      expect(head.chunks).toBe(integer(testCase.expected, 'chunks'));
      expect(head.sha).toBe(text(testCase.expected, 'sha'));
      const data = outputs.slice(1, -1).map((output) => {
        if ('json' in output) throw new Error('READ_DATA expected between READ_OK and READ_DONE');
        return output.data;
      });
      expect(data).toHaveLength(integer(testCase.expected, 'chunks'));
      expect(Buffer.concat(data)).toHaveLength(integer(testCase.expected, 'served_bytes'));
      expect(last.request_id).toBe(text(request, 'request_id'));
    } finally {
      sandbox.dispose();
    }
  });

  it.each(casesOf('governance_write'))('$name', (testCase) => {
    const sandbox = sandboxFor(testCase);
    try {
      const spec = record(testCase.input, 'request');
      const { request, chunks } = writeRequest(sandbox, spec);
      const outputs = sandbox.runWrite(request, chunks);
      expect(outputs).toHaveLength(1);
      const body = jsonOf(terminal(outputs));
      expect(tagName(terminal(outputs).tag)).toBe(text(testCase.expected, 'terminal_tag'));
      const onDisk = readFileSync(sandbox.path(text(spec, 'basename')), 'utf8');
      expect(onDisk).toBe(text(testCase.expected, 'file_text'));
      if (testCase.must_fail) {
        expect(body.error).toBe(text(testCase.expected, 'error'));
        expect(body.reason).toBe(text(testCase.expected, 'reason'));
        return;
      }
      expect(body.operation).toBe(text(testCase.expected, 'operation'));
      expect(body.sha).toBe(text(testCase.expected, 'sha'));
      expect(body.bytes).toBe(integer(testCase.expected, 'bytes'));
    } finally {
      sandbox.dispose();
    }
  });

  it.each(casesOf('governance_write_batch'))('$name', (testCase) => {
    const sandbox = sandboxFor(testCase);
    try {
      const { request, chunks } = batchRequest(sandbox, record(testCase.input, 'request'));
      const outputs = sandbox.runWriteBatch(request, chunks);
      expect(outputs).toHaveLength(1);
      const body = jsonOf(terminal(outputs));
      expect(tagName(terminal(outputs).tag)).toBe(text(testCase.expected, 'terminal_tag'));
      if (testCase.must_fail) {
        expect(body.error).toBe(text(testCase.expected, 'error'));
        expect(body.reason).toBe(text(testCase.expected, 'reason'));
        const after = testCase.expected.files_after;
        if (!Array.isArray(after)) throw new Error('a failing batch vector must pin files_after');
        for (const raw of after) {
          const entry = raw as Record<string, unknown>;
          expect(sandbox.sha(sandbox.path(text(entry, 'basename')))).toBe(text(entry, 'sha'));
        }
        return;
      }
      const expectedFiles = testCase.expected.files;
      if (!Array.isArray(expectedFiles)) throw new Error('expected.files must be an array');
      const acknowledged = body.files;
      if (!Array.isArray(acknowledged)) throw new Error('WRITE_BATCH_OK must carry files');
      expect(acknowledged).toHaveLength(expectedFiles.length);
      expectedFiles.forEach((raw, index) => {
        const entry = raw as Record<string, unknown>;
        const ack = acknowledged[index] as Record<string, unknown>;
        expect(ack.path).toBe(sandbox.path(text(entry, 'basename')));
        expect(ack.operation).toBe(text(entry, 'operation'));
        expect(ack.sha).toBe(text(entry, 'sha'));
        expect(ack.bytes).toBe(integer(entry, 'bytes'));
        expect(sandbox.sha(sandbox.path(text(entry, 'basename')))).toBe(text(entry, 'sha'));
      });
    } finally {
      sandbox.dispose();
    }
  });
});

describe('pty wire vectors: the governance limits the four legs share', () => {
  it('declares the geometry clamp, the byte ceilings and the deadlines', () => {
    expect(vectors.geometry).toMatchObject({ min_cols: 20, max_cols: 500, min_rows: 5, max_rows: 200 });
    expect(vectors.geometry).toMatchObject(GEOMETRY_CLAMP);
    const limits = vectors.limits as Record<string, unknown>;
    const ttls = vectors.ttls as Record<string, unknown>;
    expect(integer(limits, 'max_frame')).toBe(MAX_FRAME_PAYLOAD);
    expect(integer(limits, 'session_id_bytes')).toBe(vectors.framing.session_id_bytes);
    expect(integer(limits, 'max_data')).toBe(integer(limits, 'max_frame') - integer(limits, 'session_id_bytes'));
    expect(integer(limits, 'max_write_batch_files')).toBe(7);
    expect(integer(ttls, 'session_ttl_seconds')).toBeGreaterThan(integer(ttls, 'idle_timeout_seconds'));
    const declared = new Set(vectors.framing.prefixed_tags.map((name) => {
      expect(vectors.framing.tags[name], name).toBe(TAG[name as keyof typeof TAG]);
      return vectors.framing.tags[name];
    }));
    expect([...declared].sort(), 'a tag the harness prefixes and the file omits would be misdecoded')
      .toEqual([...PREFIXED_TAGS].sort());
  });

  it('pins read_only to the agent constant and keeps the four mode sets consistent', () => {
    const { all, writable, tui, read_only: readOnly } = vectors.modes;
    expect(new Set([...writable, ...tui])).toStrictEqual(new Set(all));
    expect(readOnly).toStrictEqual(['harness']);
    expect([...readOnlyModesOfAgent()].sort(), 'session.py:READ_ONLY_MODES moved without the vectors')
      .toStrictEqual([...readOnly].sort());
    expect(readOnly.every((mode) => tui.includes(mode))).toBe(true);
    expect(writable.filter((mode) => tui.includes(mode))).toStrictEqual(['harness_rw']);
    expect(all.filter((mode) => !writable.includes(mode))).toStrictEqual(readOnly);
  });

  it('gives every governance tag of the agent the same byte the harness uses', () => {
    const governance = Object.entries(vectors.framing.tags).filter(([, tag]) => tag >= 0x50 && tag <= 0x5e);
    expect(governance).toHaveLength(15);
    for (const [name, tag] of governance) {
      expect(TAG[name as keyof typeof TAG], name).toBe(tag);
      expect(tagName(tag)).toBe(name);
    }
  });
});
