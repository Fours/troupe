# 0025. Messages on the wire are JSON plus refs, refs travel as an address and a path, and messages to entities are always encoded

- **Status:** Proposed
- **Date:** 2026-11-23
- **Milestone:** 4

## Context

Milestone 4 sends messages between nodes. A message has to become text on one node and the same value on another, and the refs in it, a `replyTo` most often, have to reach the right actor from anywhere in the cluster. Milestone 1 left open whether to check that messages can be serialized at all. The answer has to work for a message that happens to stay on one node, too: with sharding, whether an entity is local depends on where its shard is today, which is exactly what location transparency says you shouldn't need to know.

## Decision

- **Messages that cross a node are JSON values plus refs.** It's 0014's rule for events, with one addition: a ref may appear anywhere a value can. There's one definition of "JSON value" in the package. 0014's check moved from `src/persistence/json.ts` to `src/json.ts`, and it now has a ref hook. The persistence check passes no hook, so its behaviour is unchanged. The wire's encoder passes one, and builds its copy in the same walk.
- **A ref on the wire is `{ "$ref": "troupe://<cluster>@<address>#<uid><path>" }`:** the cluster's name, the node's address, its uid (new on every start) and the actor's path. Actor names are URL-safe ([`names.ts`](../../src/names.ts)), so URIs need no escaping. A path is a `/`-separated list of actor names and generated names such as `$3`.
- **Only refs this system made can be sent.** A ref is recognised by its shape, as in Backstage's encoding ([0021](0021-backstage-only-watches.md)). It must also be one the system's asker made: a cell's, an ask's, a probe's, or a remote ref made through the system's hooks. A ref from another system in the same process, or an object shaped like a ref, is refused at its path. Without this check, its local path would be encoded as if it belonged to this node.
- **Keys starting with `$` get one more `$`,** as in 0021. A marker is an object with a single `$`-key, and data can never produce one. Decoding refuses any marker it doesn't know, so a newer peer's message fails loudly rather than decoding as data. `$entity` comes with sharding (T6).
- **Decoding a ref:**
  - A ref to this node with this uid is looked up by path: a live actor under `/user` or `/system`, or the temporary ref of an ask that is still waiting. If nothing is found, the result is a ref whose `tell`s are `stopped` dead letters, as for a stopped local actor.
  - A ref to an old incarnation of this node (another uid) decodes the same way, even when its path is live again. That is a different actor.
  - A ref to another node is remoting's to make (T2).
  - A ref to another cluster is refused.
- **Nothing throws.** `encode` gives the text or a problem naming the first bad part, such as `$.replyTo is a ref from another actor system`. `decode` gives the value or a problem, for malformed JSON, unknown markers, bad URIs and nesting deeper than the stack. A throwing getter or a revoked proxy is a problem too. T2 turns an encoding problem into an `unserializable` dead letter. `deadLetter`'s reason gains `unreachable`, `unserializable` and `invalid` for T2 and T6.
- **The core gains internal hooks, never exported** (`src/internal.ts`, `system[HOOKS]`):
  - a `/system` guardian for the cluster's actors, which `terminate()` stops after `/user`
  - lookup by path, for actors and pending temporary refs
  - `owns`
  - `makeRef`, which gives remote refs the system's `ask`
  - `deadLetter`
  
  Actors under `/system` aren't in the inspection walk, and `system.stop` refuses them.
- **Messages to entities are always encoded** (milestone 4, open question 3), even when the entity is on the same node. A message with a `Map` in it fails on a one-node cluster, not in production when the shard moves, and an entity never shares an object with its sender. Plain local refs are unchanged and pay nothing. This answers milestone 1's open question 4. T6 builds it.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Encode only messages that leave the node, as Akka does by default, with a test switch to encode everything | Whether a message works would depend on where a shard happens to be. A switch can later turn always-encoding off if it costs too much, but it's hard to turn on once code relies on shared objects |
| Check every `tell`, local ones included | Plain local refs would pay a walk per message for a guarantee only the network needs. The benchmark's `events-none` row is the price list |
| `structuredClone` or a binary encoding | Not every runtime has it (0004), and a peer that sends text can be read by Backstage and by people. 0014 already chose JSON for events |
| Refs by shape alone, as Backstage encodes them | Backstage only shows refs. The wire has to send them back to the right actor, and a ref from another system shaped like ours would arrive at the wrong one |
| A ref as its path alone, with the node implied by the connection | A ref passed on to a third node would point at the wrong node, and a restarted node's old refs would reach its new actors |
| Decoding an unknown `$` marker as data | A message from a newer peer would quietly mean something else |

## Evidence

**T1 (2026-11-23):**
- `test/cluster/wire.test.ts`:
  - Every kind of JSON value round-trips, and so do refs anywhere in a value. A seeded property test (300 seeds, `seededRandom`) round-trips arbitrary values with refs among the leaves and keys such as `$ref`, `$$x`, `$` and `__proto__`.
  - Every kind of non-JSON part, and a ref from another system or a lookalike, is refused with its path. A throwing getter, a revoked proxy and nesting 100,000 deep are problems, never throws.
  - Data shaped like a `$ref` is escaped and comes back as data.
  - A local ref encodes with this node's address and uid and decodes to the same object. A stopped actor, and the same path under an old uid, decode to refs whose `tell` is a `stopped` dead letter. A temporary ask ref decodes to itself while its ask waits, and not after.
  - Every malformed frame a peer could send is a problem naming its path.
- `test/hooks.test.ts`:
  - Actors under `/system` don't appear in the walk, and `terminate()` stops them after everything under `/user`, children first.
  - Lookup finds live actors at any depth and nothing else. It finds a temporary ref until its ask is answered, times out, fails in `build`, or is rejected by `terminate()`.
  - `owns` accepts the system's refs and refuses another system's and a lookalike.
- The rest of the suite passes. Only the type test of `deadLetter`'s reasons changed, to list the three new ones.
- The benchmark's `events-none` row is unchanged. It was run with `node --expose-gc bench/run.ts --only events-none` on an Apple M5 Pro with Node 26.12.1, 10 runs each, on the commit before T1 and then on T1. The median went from 4,235,101 to 4,194,290 msg/s (−1%), inside 0020's recorded Node 26 range of 3,995,715 to 4,564,825. Each run had one fast outlier of about 20 million msg/s, on both commits.
- Breaking the `$` escaping, the uid check, the removal of temporary refs, and the `/user`-before-`/system` order each fails a test.

**T2 (2026-11-23):** remoting sends what this encodes between nodes on the in-memory network ([0026](0026-remoting-is-at-most-once-behind-a-transport.md)). Refs in replies, refs passed on to a third node, and temporary ask refs all reach the right actor, and an unserializable message is a dead letter, never a throw (`test/cluster/remoting.test.ts`). The codec gained `decodeValue`, for a message inside a frame that has already been parsed.

Still to prove: T6 encodes every message to an entity, local ones included. The record is accepted then.

## Consequences

- A message that crosses a node can't hold a `Date`, a `Map` or a class instance, as events can't. The README will say so in the cluster section (T10).
- Every message to an entity is walked, copied and parsed, even on one node. T8's "entity tell, local" row prices it.
- A ref that crosses a node keeps working only while its actor lives on that node's incarnation. That is what Akka's refs promise too. Entity refs (T6) name the entity instead, so they outlive shard moves.
- The `/system` guardian is where the cluster's regions and shards live. Backstage shows it from T9.
