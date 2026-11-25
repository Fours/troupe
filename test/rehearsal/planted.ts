import type { Plant } from '../../src/internal.js';

/**
 * Each planted bug's hunt, as `npm run rehearse -- --seeds 1..10000 --plant <bug>` found it on
 * 2026-11-24 (docs/decisions/data/0040-planted-2026-11-24.json): the first seed whose run broke an
 * invariant that catches the bug while the same seed and plan passed it without the bug, how many
 * faults that seed's plan had, and the line that replays its shrunk run. Each is a regression plan:
 * the line must still reproduce, so a change that hides a bug from its invariant fails a test.
 * A change to what a run draws, or when, changes the seeds and the lines, so they're recorded
 * again from the hunt, never edited by hand.
 */
export const HUNTS: readonly {
  readonly plant: Plant;
  readonly seed: number;
  readonly faults: number;
  readonly invariant: string;
  readonly line: string;
}[] = [
  {
    plant: 'late-deadline',
    seed: 9105,
    faults: 17,
    invariant: 'oneLiveInstance',
    line: 'eyJzZWVkIjo5MTA1LCJtb2RlIjoiY29udHJhY3QiLCJwbGFuIjpbeyJhdCI6NDAwMSwiZGlzayI6InNsb3ciLCJub2RlIjoibm9kZS0yIiwibGF0ZW5jeU1zIjpbNDkwLDE1OThdLCJtcyI6MjUxMH0seyJhdCI6NTUwMiwicGFydGl0aW9uIjpbWyJub2RlLTEiLCJjcm93ZCJdLFsibm9kZS0yIiwibm9kZS0zIl1dLCJtcyI6MzE3OX1dLCJ1bnRpbE1zIjo4MDA5LCJwbGFudCI6ImxhdGUtZGVhZGxpbmUiLCJ2aW9sYXRpb24iOnsiaW52YXJpYW50Ijoib25lTGl2ZUluc3RhbmNlIiwibWVzc2FnZSI6InNob3cvdGhlLXRlbXBlc3QgcmFuIG9uIG5vZGUtMiM0MDQ5ODg4MTQgYW5kIG5vZGUtMSMxNTExODExMDA3IGZyb20gNywxMTQgdG8gOCwwMDgifX0',
  },
  {
    plant: 'early-release',
    seed: 28,
    faults: 3,
    invariant: 'oneLiveInstance',
    line: 'eyJzZWVkIjoyOCwibW9kZSI6ImNvbnRyYWN0IiwicGxhbiI6W3siYXQiOjEyMDA4LCJkaXNrIjoiZXJyb3IiLCJyYXRlIjowLjQ1LCJtcyI6NDg4OH1dLCJ1bnRpbE1zIjoxNjAwOCwicGxhbnQiOiJlYXJseS1yZWxlYXNlIiwidmlvbGF0aW9uIjp7ImludmFyaWFudCI6Im9uZUxpdmVJbnN0YW5jZSIsIm1lc3NhZ2UiOiJzaG93L2xlYXIgcmFuIG9uIG5vZGUtMSM0MjczNjU2MDE5IGFuZCBub2RlLTIjNDEwNjUxNDEzMCBmcm9tIDEzLDA5OCB0byAxNiwwMDcifX0',
  },
  {
    plant: 'grants-held',
    seed: 1,
    faults: 3,
    invariant: 'oneLiveInstance',
    line: 'eyJzZWVkIjoxLCJtb2RlIjoiY29udHJhY3QiLCJwbGFuIjpbXSwidW50aWxNcyI6MjAwNiwicGxhbnQiOiJncmFudHMtaGVsZCIsInZpb2xhdGlvbiI6eyJpbnZhcmlhbnQiOiJvbmVMaXZlSW5zdGFuY2UiLCJtZXNzYWdlIjoic2hvdy91bmNsZS12YW55YSByYW4gb24gbm9kZS0xIzI4NzA3NDk2MTMgYW5kIG5vZGUtMiMzMjU4MDA3NTE2IGZyb20gMSwwMTUgdG8gMiwwMDUifX0',
  },
  {
    plant: 'greets-once',
    seed: 1626,
    faults: 6,
    invariant: 'recovers',
    line: 'eyJzZWVkIjoxNjI2LCJtb2RlIjoiY29udHJhY3QiLCJwbGFuIjpbeyJhdCI6MTA5NywicGFydGl0aW9uIjpbWyJjcm93ZCJdLFsibm9kZS0xIiwibm9kZS0yIiwibm9kZS0zIl1dLCJvbmVXYXkiOnRydWUsIm1zIjo2ODg3fSx7ImF0Ijo3NzEzLCJkaXNrIjoic2xvdyIsImxhdGVuY3lNcyI6WzE1MywxODg1XSwibXMiOjc1NDV9LHsiYXQiOjEwNDE3LCJraWxsIjoibm9kZS0yIiwicmVzdGFydEFmdGVyTXMiOjQyMzl9XSwidW50aWxNcyI6Mzg2MTYsInBsYW50IjoiZ3JlZXRzLW9uY2UiLCJ2aW9sYXRpb24iOnsiaW52YXJpYW50IjoicmVjb3ZlcnMiLCJtZXNzYWdlIjoic2hvdy91bmNsZS12YW55YSBkaWRuJ3QgYW5zd2VyIGJ1eSAyNDAgZnJvbSBjcm93ZCwgYmVndW4gYXQgMzUsNjE0LCBhZnRlciB0aGUgZmF1bHRzIGhhZCBoZWFsZWQgYXQgMTUsMjU4OiB1bmtub3duLCBBc2tUaW1lb3V0RXJyb3I6IGFzayB0byAvc2hhcmRpbmcvc2hvdy91bmNsZS12YW55YSBnb3Qgbm8gcmVwbHkgd2l0aGluIDMwMDAgbXMifX0',
  },
  {
    plant: 'routes-unreachable',
    seed: 66,
    faults: 3,
    invariant: 'failoverWithin',
    line: 'eyJzZWVkIjo2NiwibW9kZSI6ImNvbnRyYWN0IiwicGxhbiI6W3siYXQiOjMyMzIyLCJraWxsIjoibm9kZS0xIiwicmVzdGFydEFmdGVyTXMiOjc2Nzd9XSwicGxhbnQiOiJyb3V0ZXMtdW5yZWFjaGFibGUiLCJ2aW9sYXRpb24iOnsiaW52YXJpYW50IjoiZmFpbG92ZXJXaXRoaW4iLCJtZXNzYWdlIjoic2hvdy90aGUtdGVtcGVzdCwgb24gbm9kZS0xIzI4Mzc4NjA4MTMgd2hlbiBpdCB3YXMga2lsbGVkIGF0IDMyLDMyMiwgcmFuIGFnYWluIG9uIG5vZGUtMiMzNTgwMTAxNTI0IGZyb20gMzgsMDE5LCBhbmQgbm9uZSBvZiB0aGUgMSBvcGVyYXRpb25zIGJlZ3VuIG9uIGl0IGJ5IDM5LDIyMiBhbnN3ZXJlZCJ9fQ',
  },
  {
    plant: 'gossip-backwards',
    seed: 310,
    faults: 3,
    invariant: 'recovers',
    line: 'eyJzZWVkIjozMTAsIm1vZGUiOiJjb250cmFjdCIsInBsYW4iOlt7ImF0IjoyMDI0MiwiZGlzayI6ImhhbmciLCJtcyI6NjA0NX0seyJhdCI6MjgyOTEsInBhdXNlIjoibm9kZS0xIiwibXMiOjU1Mjl9LHsiYXQiOjMzMTM1LCJwYXJ0aXRpb24iOltbIm5vZGUtMSIsIm5vZGUtMiIsImNyb3dkIl0sWyJub2RlLTMiXV0sIm9uZVdheSI6dHJ1ZSwibXMiOjU0MjN9XSwidW50aWxNcyI6NTg1NTksInBsYW50IjoiZ29zc2lwLWJhY2t3YXJkcyIsInZpb2xhdGlvbiI6eyJpbnZhcmlhbnQiOiJyZWNvdmVycyIsIm1lc3NhZ2UiOiJhdCA1OCw1NTgsIG5vZGUtMSMxNzkyNDA5NDM0IGhhZCBjcm93ZCMyODUzNDIwMTExLCBub2RlLTEjMTc5MjQwOTQzNCwgbm9kZS0yIzIxODM4MDQ2MjgsIG5vZGUtMyMxMDI0NTk3ODU5LCBub2RlLTMjMjQyNTQzMjYwNSB1cCwgd2hlcmUgY3Jvd2QjMjg1MzQyMDExMSwgbm9kZS0xIzE3OTI0MDk0MzQsIG5vZGUtMiMyMTgzODA0NjI4LCBub2RlLTMjMjQyNTQzMjYwNSB3ZXJlIHJ1bm5pbmcifX0',
  },
  {
    plant: 'early-reply',
    seed: 1,
    faults: 3,
    invariant: 'acknowledgedWritesKept',
    line: 'eyJzZWVkIjoxLCJtb2RlIjoiY29udHJhY3QiLCJwbGFuIjpbeyJhdCI6Mzc5NzEsImRpc2siOiJlcnJvciIsInJhdGUiOjAuMTEsIm1zIjoyMDI4fV0sInVudGlsTXMiOjM4MzQyLCJwbGFudCI6ImVhcmx5LXJlcGx5IiwidmlvbGF0aW9uIjp7ImludmFyaWFudCI6ImFja25vd2xlZGdlZFdyaXRlc0tlcHQiLCJtZXNzYWdlIjoic2hvdy9oYW1sZXQgYWNrbm93bGVkZ2VkIGJ1eSAyNTEgZnJvbSBjcm93ZCBhdCAzOCwzNDEsIGFuZCB0aGUgam91cm5hbCBkb2Vzbid0IGhhdmUgaXQifX0',
  },
];
