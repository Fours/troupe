import type { Plant } from '../../src/internal.js';

/**
 * Each planted bug's hunt, but gossip-backwards, which the code now tolerates (plants.test.ts shows
 * it), as `npm run rehearse -- --seeds 1..10000 --plant <bug>` found it on
 * 2026-11-27, on the code T7's hunt fixed (docs/decisions/data/0043-planted-2026-11-27.json; T6's
 * are in 0040-planted-2026-11-24.json): the first seed whose run broke an
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
    seed: 165,
    faults: 19,
    invariant: 'oneLiveInstance',
    line: 'eyJzZWVkIjoxNjUsIm1vZGUiOiJjb250cmFjdCIsInBsYW4iOlt7ImF0IjoxMzEzLCJkaXNrIjoic2xvdyIsImxhdGVuY3lNcyI6WzI5Miw2MjJdLCJtcyI6NzEzNH0seyJhdCI6MjU5NCwicGFydGl0aW9uIjpbWyJub2RlLTIiLCJub2RlLTMiXSxbIm5vZGUtMSIsImNyb3dkIl1dLCJtcyI6NzcyM30seyJhdCI6NTE5NiwiY3V0Ijoibm9kZS0xIiwibXMiOjQwNDB9XSwidW50aWxNcyI6ODQ5MCwicGxhbnQiOiJsYXRlLWRlYWRsaW5lIiwidmlvbGF0aW9uIjp7ImludmFyaWFudCI6Im9uZUxpdmVJbnN0YW5jZSIsIm1lc3NhZ2UiOiJzaG93L3RoZS10ZW1wZXN0IHJhbiBvbiBub2RlLTEjMTk2ODQ2Nzg1IGFuZCBub2RlLTIjMzE1MTQwMDgxMCBmcm9tIDgsNDY4IHRvIDgsNDg5In19',
  },
  {
    plant: 'early-release',
    seed: 51,
    faults: 4,
    invariant: 'oneLiveInstance',
    line: 'eyJzZWVkIjo1MSwibW9kZSI6ImNvbnRyYWN0IiwicGxhbiI6W3siYXQiOjkzMzYsImRpc2siOiJsb3N0UmVwbGllcyIsInJhdGUiOjAuMzQsIm1zIjoxNjF9XSwidW50aWxNcyI6MTk1NDMsInBsYW50IjoiZWFybHktcmVsZWFzZSIsInZpb2xhdGlvbiI6eyJpbnZhcmlhbnQiOiJvbmVMaXZlSW5zdGFuY2UiLCJtZXNzYWdlIjoic2hvdy9vdGhlbGxvIHJhbiBvbiBub2RlLTEjMjA5MDk0MzU3MSBhbmQgbm9kZS0zIzEzMTA0MDAyOTMgZnJvbSAxMCwwMTIgdG8gMTksNTQyIn19',
  },
  {
    plant: 'grants-held',
    seed: 3,
    faults: 6,
    invariant: 'oneLiveInstance',
    line: 'eyJzZWVkIjozLCJtb2RlIjoiY29udHJhY3QiLCJwbGFuIjpbXSwidW50aWxNcyI6MjAwNSwicGxhbnQiOiJncmFudHMtaGVsZCIsInZpb2xhdGlvbiI6eyJpbnZhcmlhbnQiOiJvbmVMaXZlSW5zdGFuY2UiLCJtZXNzYWdlIjoic2hvdy90aHJlZS1zaXN0ZXJzIHJhbiBvbiBub2RlLTEjMjc0MjM5Mjc5MSBhbmQgbm9kZS0yIzQyMzE2OTI2MTkgZnJvbSAxLDAxNyB0byAyLDAwNCJ9fQ',
  },
  {
    plant: 'greets-once',
    seed: 2244,
    faults: 12,
    invariant: 'recovers',
    line: 'eyJzZWVkIjoyMjQ0LCJtb2RlIjoiY29udHJhY3QiLCJwbGFuIjpbeyJhdCI6MzMwMDMsInJlc2V0IjpbIm5vZGUtMyIsIm5vZGUtMSJdfSx7ImF0IjozMzQ4OSwia2lsbCI6Im5vZGUtMyIsInJlc3RhcnRBZnRlck1zIjo1NjE2fSx7ImF0IjozOTExNCwicmVzZXQiOlsibm9kZS0yIiwibm9kZS0zIl19XSwidW50aWxNcyI6NTkxMTUsInBsYW50IjoiZ3JlZXRzLW9uY2UiLCJ2aW9sYXRpb24iOnsiaW52YXJpYW50IjoicmVjb3ZlcnMiLCJtZXNzYWdlIjoiYXQgNTksMTE0LCBzaGFyZCBzaG93LzE2IHdhcyBvbiBub2RlLTIsIGFuZCBiZWxvbmdzIG9uIG5vZGUtMyJ9fQ',
  },
  {
    plant: 'routes-unreachable',
    seed: 66,
    faults: 3,
    invariant: 'failoverWithin',
    line: 'eyJzZWVkIjo2NiwibW9kZSI6ImNvbnRyYWN0IiwicGxhbiI6W3siYXQiOjMyMzIyLCJraWxsIjoibm9kZS0xIiwicmVzdGFydEFmdGVyTXMiOjc2Nzd9XSwicGxhbnQiOiJyb3V0ZXMtdW5yZWFjaGFibGUiLCJ2aW9sYXRpb24iOnsiaW52YXJpYW50IjoiZmFpbG92ZXJXaXRoaW4iLCJtZXNzYWdlIjoic2hvdy90aGUtdGVtcGVzdCwgb24gbm9kZS0xIzI4Mzc4NjA4MTMgd2hlbiBpdCB3YXMga2lsbGVkIGF0IDMyLDMyMiwgcmFuIGFnYWluIG9uIG5vZGUtMiMzNTgwMTAxNTI0IGZyb20gMzgsMDE5LCBhbmQgbm9uZSBvZiB0aGUgMSBvcGVyYXRpb25zIGJlZ3VuIG9uIGl0IGJ5IDM5LDIyMiBhbnN3ZXJlZCJ9fQ',
  },
  {
    plant: 'early-reply',
    seed: 1,
    faults: 3,
    invariant: 'acknowledgedWritesKept',
    line: 'eyJzZWVkIjoxLCJtb2RlIjoiY29udHJhY3QiLCJwbGFuIjpbeyJhdCI6MzU0MzAsImRpc2siOiJlcnJvciIsInJhdGUiOjAuMTEsIm1zIjozMX1dLCJ1bnRpbE1zIjozNTQzOSwicGxhbnQiOiJlYXJseS1yZXBseSIsInZpb2xhdGlvbiI6eyJpbnZhcmlhbnQiOiJhY2tub3dsZWRnZWRXcml0ZXNLZXB0IiwibWVzc2FnZSI6InNob3cvaGFtbGV0IGFja25vd2xlZGdlZCBidXkgMjMxIGZyb20gY3Jvd2QgYXQgMzUsNDM4LCBhbmQgdGhlIGpvdXJuYWwgZG9lc24ndCBoYXZlIGl0In19',
  },
];
