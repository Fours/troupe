# 0026. Remoting is at most once and ordered per pair of nodes, behind a `Transport` interface, and remote asks settle through the asker

- **Status:** Accepted
- **Date:** 2026-11-23
- **Milestone:** 4

## Context

Milestone 4 lets a `tell` reach an actor on another node. Remoting has to keep the guarantees a local `tell` gives that still make sense across a network: it never throws, and messages from one sender to one actor stay in order. It also has to be honest about what a network takes away. The same code has to run on TCP between processes (T3), on an in-memory network in one test or browser tab, and on milestone 5's simulated network, which will lose, delay and reorder frames on purpose. Asks across nodes must behave like local ones, piped ones included ([0009](0009-ask-is-a-temporary-ref.md), [0010](0010-piped-asks-stay-on-the-scheduler.md)), and `ctx.watch` must accept a remote ref, or location transparency breaks (milestone 4, open question 4).

## Decision

- **A `Transport` carries text frames between addresses, and knows nothing about actors.** `listen`, `connect` (which returns at once, with frames sent before it opens waiting in order), and `close`. A `Connection` has `send`, which never throws, `onFrame`, `onClose` and `close`. Nothing in it is Node's.
- **`inMemoryNetwork({ scheduler, latencyMs })`** gives each node a transport in one process. Every open, frame and close takes `latencyMs` (default 1) on the scheduler, in order per connection. `kill(address)` drops a node's connections with no goodbye: frames in flight are lost, and the other ends see an error one latency later. On a `ManualScheduler` the whole network is deterministic.
- **One connection per pair of nodes.** Each connection starts with a `hello` each way: the cluster's name, the protocol version, the node's address and its uid. The uid is drawn from the system's `random` on every start. Nothing else goes on a connection until both hellos have arrived. When two nodes dial each other at once, the one the lower address dialed wins. The loser is closed without a hello, so it never carries a message. Frames on one connection arrive in order, so **messages from one node to one actor arrive in send order**.
- **A hello that doesn't match is refused, and both sides log why.** A wrong cluster name or protocol version, a bad address or uid, the node's own address, or a dialed node that names another address. The side that accepted answers with its own hello before closing, so the dialer can log the mismatch too. A frame before the hello, or one that isn't JSON, also closes the connection.
- **At most once.** Remoting doesn't acknowledge or retry. A frame lost with its connection is lost, an ask whose message or reply is lost times out, and a protocol that needs more retries at its own level. This is what Akka promises too.
- **A bounded buffer while a peer has no connection.** Messages wait in order, up to `bufferSize` (default 10,000), and go out when the handshake completes. Past that they're `unreachable` dead letters. Remoting dials only while something waits, after a failed dial with backoff that doubles from 100 ms to 5 s, jittered between half and all of that from the system's `random`. Reconnecting is remoting's job, not the transport's, since only remoting has the scheduler. So the TCP transport (T3) needs none of its own.
- **`tell` never throws.** A message that isn't JSON plus refs ([0025](0025-messages-on-the-wire-are-json-plus-refs.md)), or whose frame is over `maxFrameBytes` (default 1 MiB, counted in UTF-8 bytes), is an `unserializable` dead letter, and a warning names its first bad path. After `close()`, or once the system has terminated, every `tell` to a remote ref is a `terminated` dead letter. On the receiving node, a message to a stopped actor or an old incarnation of the node is a `stopped` dead letter, and a reply to a finished ask an `askCompleted` one, as they would be locally. A frame that can't be decoded is an `unserializable` dead letter there, with a warning.
- **Remote asks settle through the asker.** The temporary ref travels as a URI. Its reply arrives as a frame and is told to the local temporary ref, found by path (0025). So a piped remote ask is completed by the scheduler task that delivered the frame, with no promise in between, as 0010 requires.
- **The sender travels.** When the sending node knows the sender, which is while a subscriber wants message events ([0020](0020-message-events-are-opt-in.md)), the frame carries its full URI. The receiving node tells the target with that as the sender, so `delivered.from` is the remote sender's full path.
- **Remote death watch.** `ctx.watch` and a probe's `watch` find what to watch through a hook: a local actor's cell, or a stand-in remoting makes for a remote ref. The first watcher of a remote actor sends a `watch` frame, and the last to leave sends `unwatch`. The remote node watches the actor on the peer's behalf, and sends `terminated` when it stops. An actor that has already stopped, or isn't there, is answered at once. A failure crosses the wire as its name and message, and arrives as a plain `Error` with no stack. When the watched node's incarnation goes, every watch on it signals `terminated`, with a failure saying `node <address> is gone`. It goes when a hello brings a new uid at its address, or when membership downs it (T4, through `nodeDown`). A kill alone signals nothing, since the node may come back. A ref nothing can watch, such as a temporary ask ref or, from T6, an entity ref, throws a `TypeError`, as before.
- **A downed incarnation can't connect again.** After `nodeDown`, what waited for the node and everything sent to it later are `unreachable` dead letters, and a hello from the same uid is refused. A new uid at that address is a restarted node, and is welcome.
- **None of this is public yet.** `startRemoting` is internal. `/cluster` becomes an entry point with `joinCluster` in T4, and exports `inMemoryNetwork`, `Transport` and `Connection` then.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Acknowledge and redeliver (at least once) | Duplicates need deduplication at every receiver, and a message can still be lost when the sender dies. Akka chose at most once for the same reasons. Sharding's handoff (T7) resends what comes back as `notOwner`, which covers the case that matters |
| A connection each way per pair, one for each direction to send on | No tie-break to get right, but twice the connections and twice the handshakes, and the spec promises one |
| Keep the newest connection when both nodes dial | Each side would keep a different one when hellos cross, and messages sent on the one the other side closed are lost |
| Reconnect inside the transport | The transport has no scheduler or `random`, so its backoff couldn't run on virtual time, and every transport would need its own |
| Signal `terminated` for a remote watch when the connection drops | A dropped connection doesn't mean the actor stopped. Akka waits for the node to be quarantined or downed, and so does this, through `nodeDown` |
| Send the failure's stack across the wire | It leaks the other node's paths and source, and nothing can use it. The name and message are what a watcher acts on |
| `structuredClone` frames in the in-memory network | Text frames make the in-memory network run the same encoding as TCP, so a message that fails on TCP fails in tests |

## Evidence

**T2 (2026-11-23):**

- `test/cluster/memory.test.ts`:
  - Opens and frames take the latency, and frames arrive in order, including frames sent before the connection opened.
  - Dialing an address where nothing listens closes the connection with an error.
  - A close delivers what was already sent, then closes the other end cleanly.
  - `kill` drops frames in flight both ways, the other end sees an error, and the address can be listened on again.
  - Options and addresses are checked where they're passed in.
- `test/cluster/remoting.test.ts`, on `test/helpers/cluster.ts`, which runs N systems on one `ManualScheduler` and one network:
  - **Order.** 2,000 tells from one node to one actor arrive in order, the first 1,000 of them buffered while the handshake runs. Tells from an actor on `throughput: 1` keep their order too.
  - **One connection per pair.** Two nodes dial each other at once, and every message from both goes on the connection the lower address dialed.
  - **Asks.** A remote ask resolves. A piped one completes with only the scheduler running, with no promise awaited. One to a killed node times out at exactly `askTimeoutMs`. A late reply is an `askCompleted` dead letter on the asking node.
  - **Refs in messages.** A reply carries a ref back. A ref passed on to a third node reaches the right actor, and so does the asking node's own ref passed there and back.
  - **What can't be sent.**
    - A `Map`, and a ref from another system, are `unserializable` dead letters with a warning naming the path, and `tell` doesn't throw.
    - A frame over `maxFrameBytes` is too, counted in UTF-8 bytes. `utf8Bytes` agrees with `TextEncoder`, lone surrogates included.
    - With `bufferSize: 3` and the peer killed, tells 4 and 5 are `unreachable` at once, 1 to 3 wait through 30 s of failed dials, and `nodeDown` turns them, and a later tell, into `unreachable` dead letters.
  - **Reconnecting.** Against an address where nothing listens, each gap between dials is between half and all of `min(5,000, 100 × 2^n)` ms, the gaps vary, and dialing stops once the node is down.
  - **The handshake.**
    - A node from another cluster is refused, and both sides log why.
    - So is a frame before the hello, a frame that isn't JSON, another protocol version, a bad uid or address, the node's own address, and a dialed node that names another address.
    - Unknown frame types and misaddressed messages after the hello are logged and ignored.
    - A downed incarnation that dials again is refused.
  - **Death watch.**
    - Watching a remote actor gives `terminated` when it stops, and when it fails, as a `RangeError` with its message.
    - Watching twice is the same as once.
    - An actor that had already stopped signals at once, and after `unwatch` nothing comes.
    - A kill alone signals nothing. A restart with a new uid, or `nodeDown`, signals `terminated` with `node node-1 is gone`, and watching the old incarnation afterwards signals at once.
    - The watches a restarted node held are dropped, so its new incarnation hears nothing of them.
    - Probes watch remote refs too, and watching a temporary ask ref throws.
  - **The sender.** `delivered.from` is the remote sender's full URI when an actor sent the message, and absent when nothing did.
  - **Determinism.** Three nodes with periodic piped asks, a kill and a restart, run twice with seed 42, give identical events on every incarnation of every node. Seed 43 gives different ones.
- The rest of the suite passes unchanged. Death watch moved behind the `WatchTarget` hook, and no existing test changed.
- Breaking each of these fails a test:
  - flushing the buffer in reverse fails the order tests
  - flipping the tie-break fails the one-connection test
  - removing the buffer bound fails the buffer test
  - ignoring a new uid fails the restart test
  - keeping a restarted node's watches fails the dropped-watches test
  - dropping the sender from frames fails the sender test

T3 runs the same suite on TCP.

## Consequences

- A message can be lost without anyone being told, when a connection drops with it on the wire. Code that needs to know asks, and handles the timeout.
- A node that loses its connection keeps everything sent to the peer in memory, up to `bufferSize` messages, until the peer is back or downed. Without membership (until T4), a peer that never comes back holds its buffer for good.
- A node that dials into a half-open connection, which the other side hasn't noticed is dead, is refused until the other side notices, if the stale connection was dialed by the lower address. On the in-memory network a close always arrives. On TCP, T4's heartbeats are what notice.
- `delivered.from` for a remote message depends on the sending node having a message-events subscriber, as it does locally (0020).
- Milestone 5 can wrap or replace the in-memory network to lose, delay and reorder frames, and remoting needs no change to run on it.
