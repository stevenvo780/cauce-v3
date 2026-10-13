import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { Sha256Stream } from './sha256-stream';

it('coincide con los vectores FIPS y con node:crypto en cualquier partición de los bytes', () => {
  expect(new Sha256Stream().hex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  expect(new Sha256Stream().update(new TextEncoder().encode('abc')).hex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const bytes = Uint8Array.from({ length: 200_003 }, (_, index) => (index * 131 + (index >>> 7)) & 0xff);
  const expected = createHash('sha256').update(bytes).digest('hex');
  for (const size of [1, 55, 56, 63, 64, 65, 4096, 65_537]) {
    const hash = new Sha256Stream();
    for (let offset = 0; offset < bytes.length; offset += size) hash.update(bytes.subarray(offset, offset + size));
    expect(hash.hex()).toBe(expected);
  }
  for (const length of [55, 56, 57, 63, 64, 119, 120, 128]) {
    expect(new Sha256Stream().update(bytes.subarray(0, length)).hex()).toBe(createHash('sha256').update(bytes.subarray(0, length)).digest('hex'));
  }
  const finished = new Sha256Stream(); finished.hex();
  expect(() => finished.update(bytes)).toThrow('already finished');
});
