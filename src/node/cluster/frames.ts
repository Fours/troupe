// Length-prefixed frames on a byte stream (decision 0027): a 4-byte big-endian length, then that
// many bytes of UTF-8 text. TCP delivers bytes in chunks that have nothing to do with frames, so
// the decoder keeps what it has until a frame is whole.

/** The length prefix, in bytes. */
const HEADER = 4;

/** Encodes one frame: its UTF-8 bytes, after their length. */
export function encodeFrame(text: string): Buffer {
  const length = Buffer.byteLength(text, 'utf8');
  const frame = Buffer.allocUnsafe(HEADER + length);
  frame.writeUInt32BE(length, 0);
  frame.write(text, HEADER, 'utf8');
  return frame;
}

/** The next thing in the stream: a whole frame, or the length of one over the limit. */
export type Next =
  | { readonly frame: string; readonly tooLong?: undefined }
  | { readonly frame?: undefined; readonly tooLong: number };

/**
 * Turns chunks of a stream into frames, one at a time, so the limit can change between frames.
 * That's how the transport keeps a peer to small frames until it has proven the secret, even when
 * its proof and its first big frame arrive in one chunk.
 */
export class FrameDecoder {
  /** The largest frame accepted, in bytes. */
  limit: number;
  #chunks: Buffer[] = [];
  #buffered = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** Adds a chunk of the stream. */
  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
  }

  /**
   * The next whole frame, or undefined until there is one. A frame whose length is over the
   * limit is reported as soon as its header arrives, before its body is buffered, and decoding
   * should stop there.
   */
  next(): Next | undefined {
    if (this.#buffered < HEADER) return undefined;
    const length = this.#peek(HEADER).readUInt32BE(0);
    if (length > this.limit) return { tooLong: length };
    if (this.#buffered < HEADER + length) return undefined;
    return { frame: this.#take(HEADER + length).toString('utf8', HEADER) };
  }

  /** Whether part of a frame is waiting for the rest. */
  get partial(): boolean {
    return this.#buffered > 0;
  }

  /** The first `n` bytes, joined into the first chunk so the next peek is free. */
  #peek(n: number): Buffer {
    const first = this.#chunks[0] as Buffer;
    if (first.length >= n) return first;
    const joined = Buffer.concat(this.#chunks);
    this.#chunks = [joined];
    return joined;
  }

  #take(n: number): Buffer {
    const head = this.#peek(n);
    const taken = head.subarray(0, n);
    const rest = head.subarray(n);
    if (rest.length > 0) this.#chunks[0] = rest;
    else this.#chunks.shift();
    this.#buffered -= n;
    return taken;
  }
}
