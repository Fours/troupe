// Links from the write-up to the decision records it rests on (milestone 3, T8: every claim
// links to one). The ids are a type, so a link to a record that doesn't exist fails typecheck,
// and test/demo/records.test.ts checks this list against docs/decisions/ and that the page
// cites every record. Record.tsx draws the links.
import { REPO_URL } from '../site/links.ts';

export const RECORDS = {
  '0001': '0001-state-and-reducer-actors',
  '0002': '0002-async-receive-blocks-the-mailbox',
  '0003': '0003-injected-scheduler-and-random',
  '0004': '0004-runtime-agnostic-core',
  '0005': '0005-one-package-with-subpaths',
  '0006': '0006-supervision-chosen-at-spawn',
  '0007': '0007-microtask-wake-macrotask-yield',
  '0008': '0008-restart-is-a-new-incarnation',
  '0009': '0009-ask-is-a-temporary-ref',
  '0010': '0010-piped-asks-stay-on-the-scheduler',
  '0011': '0011-persisting-holds-the-mailbox',
  '0012': '0012-commands-return-effects',
  '0013': '0013-sequence-check-is-the-single-writer-backstop',
  '0014': '0014-events-are-json',
  '0015': '0015-journal-timestamps-come-from-an-injected-clock',
  '0016': '0016-postgres-appends-take-a-journal-lock',
  '0017': '0017-backends-add-no-dependencies',
  '0018': '0018-standard-schema-and-upcasters',
  '0019': '0019-how-the-benchmark-measures',
  '0020': '0020-message-events-are-opt-in',
  '0021': '0021-backstage-only-watches',
  '0022': '0022-demo-drives-virtual-time',
  '0023': '0023-backstage-server-uses-sse',
  '0024': '0024-publish-from-ci-with-provenance',
  '0025': '0025-messages-on-the-wire-are-json-plus-refs',
  '0026': '0026-remoting-is-at-most-once-behind-a-transport',
  '0027': '0027-nodes-talk-tcp-with-a-shared-secret',
  '0028': '0028-membership-is-gossiped-with-automatic-downing',
  '0029': '0029-a-shard-is-owned-by-whoever-holds-its-lease',
  '0030': '0030-shards-are-placed-by-rendezvous-hashing',
  '0031': '0031-failover-waits-for-the-lease-not-for-downing',
  '0032': '0032-1-0-comes-after-rehearsal',
  '0033': '0033-one-simulation-clock-and-a-clock-per-node',
  '0034': '0034-a-run-is-a-seed-and-a-plan',
  '0035': '0035-safety-under-any-network-ordering-under-the-contract',
  '0036': '0036-timeouts-are-unknown-outcomes-settled-by-recovery',
  '0037': '0037-the-json-check-is-public',
  '0038': '0038-a-pipe-with-a-signal-ends-on-the-scheduler',
} as const;

export type RecordId = keyof typeof RECORDS;

/** The record on GitHub, rendered, on main. */
export const recordUrl = (id: RecordId) => `${REPO_URL}/blob/main/docs/decisions/${RECORDS[id]}.md`;
