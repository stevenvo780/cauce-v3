import { describe, expect, it } from 'vitest';
import {
  decodeDataFrame, decodeJsonFrame, encodeDataFrame, encodeFrame, encodeJsonFrame,
  FrameDecoder, FramingError, FRAME_TAGS, MAX_FRAME_PAYLOAD_BYTES
} from './framing.js';

/**
 * The golden vector is the cross-language contract with the Python PTY agent. If this hex
 * changes, the agent stops understanding the relay: change both, or neither.
 */
const GOLDEN_STDOUT_HEX =
  '210000002631313131313131312d323232322d333333332d343434342d3535353535353535353535356869';

describe('agent framing', () => {
  it('encodes the golden STDOUT vector byte for byte', () => {
    const frame = encodeDataFrame(FRAME_TAGS.STDOUT, '11111111-2222-3333-4444-555555555555', Buffer.from('hi', 'utf8'));
    expect(frame.toString('hex')).toBe(GOLDEN_STDOUT_HEX);
  });

  it('decodes the golden vector back into its session id and data', () => {
    const [frame] = new FrameDecoder().push(Buffer.from(GOLDEN_STDOUT_HEX, 'hex'));
    expect(frame?.tag).toBe(FRAME_TAGS.STDOUT);
    const data = decodeDataFrame(frame?.payload ?? Buffer.alloc(0));
    expect(data.sessionId).toBe('11111111-2222-3333-4444-555555555555');
    expect(data.data.toString('utf8')).toBe('hi');
  });

  it('reassembles a stream delivered one byte at a time', () => {
    const stream = Buffer.concat([
      encodeJsonFrame(FRAME_TAGS.AGENT_HELLO, { v: 1, alias: 'jarvis' }),
      encodeFrame(FRAME_TAGS.PING),
      encodeDataFrame(FRAME_TAGS.STDOUT, '11111111-2222-3333-4444-555555555555', Buffer.from('abc')),
      encodeJsonFrame(FRAME_TAGS.CLOSED, { session_id: '11111111-2222-3333-4444-555555555555', exit_code: 0 })
    ]);
    const decoder = new FrameDecoder();
    const frames = [];
    for (const byte of stream) frames.push(...decoder.push(Buffer.from([byte])));
    expect(frames.map((frame) => frame.tag)).toEqual([
      FRAME_TAGS.AGENT_HELLO, FRAME_TAGS.PING, FRAME_TAGS.STDOUT, FRAME_TAGS.CLOSED
    ]);
    expect(decodeJsonFrame(frames[0]?.payload ?? Buffer.alloc(0))).toEqual({ v: 1, alias: 'jarvis' });
    expect(frames[1]?.payload.byteLength).toBe(0);
    expect(decodeDataFrame(frames[2]?.payload ?? Buffer.alloc(0)).data.toString()).toBe('abc');
  });

  it('yields several frames from one oversized chunk and keeps the partial tail', () => {
    const decoder = new FrameDecoder();
    const complete = Buffer.concat([encodeFrame(FRAME_TAGS.PING), encodeFrame(FRAME_TAGS.PONG)]);
    const partial = encodeDataFrame(FRAME_TAGS.STDOUT, '11111111-2222-3333-4444-555555555555', Buffer.from('tail'));
    expect(decoder.push(Buffer.concat([complete, partial.subarray(0, 7)])).map((frame) => frame.tag))
      .toEqual([FRAME_TAGS.PING, FRAME_TAGS.PONG]);
    expect(decoder.push(partial.subarray(7)).map((frame) => frame.tag)).toEqual([FRAME_TAGS.STDOUT]);
  });

  it('rejects an unknown tag and an oversized length', () => {
    const unknown = Buffer.from([0x99, 0, 0, 0, 0]);
    expect(() => new FrameDecoder().push(unknown)).toThrow(FramingError);
    const oversized = Buffer.alloc(5);
    oversized.writeUInt8(FRAME_TAGS.STDOUT, 0);
    oversized.writeUInt32BE(MAX_FRAME_PAYLOAD_BYTES + 1, 1);
    expect(() => new FrameDecoder().push(oversized)).toThrow(FramingError);
  });

  it('refuses data frames whose session id is not a dashed UUID', () => {
    expect(() => encodeDataFrame(FRAME_TAGS.STDIN, 'not-a-uuid', Buffer.from('x'))).toThrow(FramingError);
    const payload = Buffer.concat([Buffer.from('x'.repeat(36), 'ascii'), Buffer.from('data')]);
    expect(() => decodeDataFrame(payload)).toThrow(FramingError);
    expect(() => decodeDataFrame(Buffer.from('short'))).toThrow(FramingError);
  });

  it('refuses JSON payloads that are not objects', () => {
    expect(() => decodeJsonFrame(Buffer.from('[1,2]'))).toThrow(FramingError);
    expect(() => decodeJsonFrame(Buffer.from('nope'))).toThrow(FramingError);
  });
});
