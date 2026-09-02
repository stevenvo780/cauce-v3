import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicallyEqual, sha256Hex } from '../src/index.js';

describe('canonical json and digest bytes', () => {
  it('sorts object keys recursively while preserving array order', () => {
    expect(JSON.stringify(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })))
      .toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });

  it('hashes a string as its raw bytes so persisted nonce hashes keep matching', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('cauce')).toBe('6c4b181d9cf6485e2a614143676aa22cfbad6e710704db24eb7074ba772fa654');
    expect(sha256Hex('cauce')).not.toBe(sha256Hex(JSON.stringify('cauce')));
  });

  it('encodes a value with no JSON representation as the literal undefined', () => {
    expect(sha256Hex(undefined))
      .toBe('eb045d78d273107348b0300c01d29b7552d622abbc6faf81b3ec55359aa9950c');
    expect(sha256Hex(undefined)).toBe(sha256Hex('undefined'));
  });

  it('compares two values by their canonical bytes', () => {
    expect(canonicallyEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(canonicallyEqual([1, 2], [2, 1])).toBe(false);
  });
});
