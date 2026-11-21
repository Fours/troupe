import { describe, expect, it } from 'vitest';
import { Queue } from '../src/queue.js';

describe('Queue', () => {
  it('is FIFO, and reports its size', () => {
    const q = new Queue<number>();
    expect(q.shift()).toBeUndefined();
    q.push(1);
    q.push(2);
    expect(q.size).toBe(2);
    expect(q.shift()).toBe(1);
    q.push(3);
    expect([q.shift(), q.shift(), q.shift()]).toEqual([2, 3, undefined]);
    expect(q.size).toBe(0);
  });

  it('keeps order across compaction while pushes and shifts interleave', () => {
    const q = new Queue<number>();
    const out: number[] = [];
    let next = 0;
    for (let round = 0; round < 50; round++) {
      for (let i = 0; i < 200; i++) q.push(next++);
      for (let i = 0; i < 150; i++) out.push(q.shift() as number);
    }
    while (q.size > 0) out.push(q.shift() as number);
    expect(out).toEqual(Array.from({ length: next }, (_, i) => i));
  });

  it('holds undefined as a value', () => {
    const q = new Queue<undefined | number>();
    q.push(undefined);
    q.push(1);
    expect(q.size).toBe(2);
    q.shift();
    expect(q.shift()).toBe(1);
  });
});
