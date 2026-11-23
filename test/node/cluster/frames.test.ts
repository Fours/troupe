import { describe, expect, it } from 'vitest';
import { encodeFrame, FrameDecoder, type Next } from '../../../src/node/cluster/frames.js';

// Milestone 4, T3: length-prefixed frames (decision 0027). TCP hands over bytes in chunks that
// have nothing to do with frames, so every way of cutting the stream must give the same frames.

const TEXTS = ['', 'a', '{"t":"msg","m":1}', 'é€😀', 'x'.repeat(300)];
const stream = Buffer.concat(TEXTS.map(encodeFrame));

/** Pushes `chunk`, then takes everything now whole, up to and including a refusal. */
function push(decoder: FrameDecoder, chunk: Buffer): Next[] {
  decoder.push(chunk);
  const out: Next[] = [];
  for (let next = decoder.next(); next !== undefined; next = decoder.next()) {
    out.push(next);
    if (next.tooLong !== undefined) break;
  }
  return out;
}

function decodeIn(chunks: readonly Buffer[], limit = 1_000): string[] {
  const decoder = new FrameDecoder(limit);
  const out: string[] = [];
  for (const chunk of chunks) {
    for (const next of push(decoder, chunk)) out.push(next.frame as string);
  }
  expect(decoder.partial).toBe(false);
  return out;
}

describe('frames', () => {
  it('are a 4-byte big-endian length, then the text in UTF-8', () => {
    const frame = encodeFrame('é');
    expect([...frame]).toEqual([0, 0, 0, 2, 0xc3, 0xa9]);
    expect(encodeFrame('x'.repeat(70_000)).readUInt32BE(0)).toBe(70_000);
  });

  it('decode the same however the stream is cut: whole, byte by byte, or at every point', () => {
    expect(decodeIn([stream])).toEqual(TEXTS);
    expect(decodeIn([...stream].map((byte) => Buffer.from([byte])))).toEqual(TEXTS);
    for (let at = 0; at <= stream.length; at++) {
      expect(decodeIn([stream.subarray(0, at), stream.subarray(at)])).toEqual(TEXTS);
    }
  });

  it('decode several frames in one chunk, and keep a partial one for the next', () => {
    const decoder = new FrameDecoder(1_000);
    const first = encodeFrame('one');
    const second = encodeFrame('two');
    // The second frame's header is cut after two bytes, and its body comes later.
    const decoded = push(decoder, Buffer.concat([first, first, second.subarray(0, 2)]));
    expect(decoded).toEqual([{ frame: 'one' }, { frame: 'one' }]);
    expect(decoder.partial).toBe(true);
    expect(push(decoder, second.subarray(2, 5))).toEqual([]);
    expect(push(decoder, Buffer.alloc(0))).toEqual([]);
    expect(push(decoder, second.subarray(5))).toEqual([{ frame: 'two' }]);
  });

  it('keep a character whose bytes are split across chunks whole', () => {
    const frame = encodeFrame('😀');
    for (let at = 5; at < frame.length; at++) {
      expect(decodeIn([frame.subarray(0, at), frame.subarray(at)])).toEqual(['😀']);
    }
  });

  it('refuse a frame over the limit as soon as its length arrives, after the frames before it', () => {
    const decoder = new FrameDecoder(10);
    const big = encodeFrame('x'.repeat(11));
    // Only the header of the big frame: its body is never waited for.
    const decoded = push(decoder, Buffer.concat([encodeFrame('ok'), big.subarray(0, 4)]));
    expect(decoded).toEqual([{ frame: 'ok' }, { tooLong: 11 }]);
    // A frame of exactly the limit is fine.
    const exact = new FrameDecoder(10);
    expect(push(exact, encodeFrame('x'.repeat(10)))).toEqual([{ frame: 'x'.repeat(10) }]);
  });

  it('hold each frame to the limit when it is taken, so the limit can change between frames of one chunk', () => {
    const decoder = new FrameDecoder(5);
    decoder.push(Buffer.concat([encodeFrame('short'), encodeFrame('x'.repeat(50))]));
    expect(decoder.next()).toEqual({ frame: 'short' });
    expect(decoder.next()).toEqual({ tooLong: 50 });
    decoder.limit = 50;
    expect(decoder.next()).toEqual({ frame: 'x'.repeat(50) });
    expect(decoder.next()).toBeUndefined();
  });
});
