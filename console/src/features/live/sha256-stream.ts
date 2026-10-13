/** Incremental SHA-256 (FIPS 180-4): Web Crypto only digests whole buffers, and a space backup reaches 1 GiB. */
const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotate = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

export class Sha256Stream {
  private readonly state = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private readonly block = new Uint8Array(64);
  private readonly words = new Uint32Array(64);
  private filled = 0;
  private bytes = 0;
  private finished = false;

  update(data: Uint8Array): this {
    if (this.finished) throw new Error('SHA-256 already finished');
    this.bytes += data.byteLength;
    let offset = 0;
    if (this.filled > 0) {
      offset = Math.min(64 - this.filled, data.byteLength);
      this.block.set(data.subarray(0, offset), this.filled); this.filled += offset;
      if (this.filled < 64) return this;
      this.compress(new DataView(this.block.buffer), 0); this.filled = 0;
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (; offset + 64 <= data.byteLength; offset += 64) this.compress(view, offset);
    this.block.set(data.subarray(offset)); this.filled = data.byteLength - offset;
    return this;
  }

  hex(): string {
    if (!this.finished) {
      const padding = new Uint8Array((this.filled < 56 ? 56 : 120) - this.filled + 8);
      padding[0] = 0x80;
      const length = new DataView(padding.buffer);
      length.setUint32(padding.length - 8, Math.floor(this.bytes / 0x20000000));
      length.setUint32(padding.length - 4, (this.bytes * 8) >>> 0);
      const total = this.bytes; this.update(padding); this.bytes = total; this.finished = true;
    }
    return Array.from(this.state, word => word.toString(16).padStart(8, '0')).join('');
  }

  private compress(view: DataView, offset: number): void {
    const words = this.words;
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const early = words[index - 15] ?? 0; const late = words[index - 2] ?? 0;
      const small = rotate(early, 7) ^ rotate(early, 18) ^ (early >>> 3);
      const large = rotate(late, 17) ^ rotate(late, 19) ^ (late >>> 10);
      words[index] = ((words[index - 16] ?? 0) + small + (words[index - 7] ?? 0) + large) >>> 0;
    }
    const state = this.state;
    let [a, b, c, d, e, f, g, h] = [state[0], state[1], state[2], state[3], state[4], state[5], state[6], state[7]];
    for (let index = 0; index < 64; index++) {
      const first = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + (K[index]) + (words[index])) >>> 0;
      const second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + first) >>> 0; d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    state[0] = (state[0]) + a; state[1] = (state[1]) + b; state[2] = (state[2]) + c; state[3] = (state[3]) + d;
    state[4] = (state[4]) + e; state[5] = (state[5]) + f; state[6] = (state[6]) + g; state[7] = (state[7]) + h;
  }
}
