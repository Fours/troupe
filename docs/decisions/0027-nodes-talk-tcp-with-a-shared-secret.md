# 0027. Nodes talk over TCP on `node:net` with length-prefixed JSON frames and a challenge-response on a shared secret

- **Status:** Accepted
- **Date:** 2026-11-23
- **Milestone:** 4

## Context

Remoting runs on any `Transport` that carries text frames in order ([0026](0026-remoting-is-at-most-once-behind-a-transport.md)). Between Node processes it needs a real one. The package has no runtime dependencies and no peer dependencies, so the transport can use only what Node has (milestone 4, open question 1). Remoting lets a peer tell any actor anything, so a cluster port that the wrong network can reach is a remote control for the whole system. A peer has to prove it belongs before it can send a message (open question 5). TLS is out of scope for this milestone.

## Decision

- **TCP on `node:net`, in `src/node/cluster/`, as `@kylewillett/troupe/cluster/tcp`.** `tcpTransport({ port, host, advertise, secret, maxFrameBytes })`. It loads `node:net` and `node:crypto` and nothing else outside the package.
- **Frames are a 4-byte big-endian length, then UTF-8 JSON text.** The decoder takes one frame at a time from whatever chunks the socket gives it, so frames split across reads and several frames in one read decode the same. A frame whose length is over the limit closes the connection as soon as its header arrives, before its body is buffered, since the peer is broken or hostile. The limit is `maxFrameBytes`, default 1 MiB, which is also remoting's default limit on what it sends. A node that raises one should raise the other.
- **Peers prove the secret before any other frame.**
  - Each side sends a `challenge` with the protocol (`troupe-tcp/1`) and a 32-byte nonce from `randomBytes`. Each answers the other's challenge with a `proof`: an HMAC-SHA256, under the secret, of the protocol, its own role (`dialer` or `acceptor`) and both nonces. Proofs are compared with `timingSafeEqual`.
  - The secret never crosses the wire. An eavesdropper sees two random nonces and two MACs that are good for that connection only.
  - The role is in the MAC, so a proof sent back to the side that made it fails. A challenge that comes back unchanged is refused outright.
  - Before its proof, a peer may send only its challenge and proof, each at most 256 bytes, and has 5 s to finish. The timeout is the socket's own idle timer, the only clock in the transport. Anything else closes the connection.
  - Frames sent early wait in order, and go out once the other side has proven the secret, so nothing is ever sent to a peer that hasn't. `listen` hands over only connections whose peer has proven it.
- **A refused peer is logged.** `Transport.listen` takes a second callback, `onRefused`, through which a transport says why it dropped a peer, in either direction. Remoting logs it as a warning with the system's logger, so the transport needs no logger of its own.
- **Localhost by default.** `host` defaults to `127.0.0.1`, as `serveBackstage`'s does ([0023](0023-backstage-server-uses-sse.md)). Listening anywhere else is a choice made with `host`. `advertise` is the address other nodes dial when it isn't `host:port`, as in Docker. IPv6 addresses go in brackets.
- **No reconnecting, no timers.** Remoting dials again with backoff from the system's scheduler and `random` (0026), so the transport has none of its own. `close()` stops listening and closes every connection after what was already written. A dial that can't be made closes with the error that says why.
- **Chance for security comes from `node:crypto`.** The system's `random` is seeded for repeatable runs ([0003](0003-injected-scheduler-and-random.md)), which is what a nonce must never be. The nonces don't change what the cluster does, only whether a peer is let in, so a simulated run in milestone 5 loses nothing.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A WebSocket server written by hand on `node:http` | An upgrade handshake and masking to get right, and nodes need nothing WebSockets add |
| `ws` as an optional peer dependency | Breaks "no peer dependencies", for framing that takes a few dozen lines |
| No authentication, on a private network | One misconfigured port gives anyone a remote control for every actor |
| Mutual TLS on `node:tls` | Certificates to issue and rotate for a demo. It can come later in this same transport, under the same frames |
| Sending the secret, or a hash of it, in the handshake | Anyone who sees one handshake can replay it. A challenge-response proves knowledge without revealing anything reusable |
| One MAC label for both sides | A peer could reflect a node's own proof back to it. The role in the MAC closes that |
| Reconnecting inside the transport | 0026 put it in remoting, where the scheduler and `random` are, so it runs on virtual time in tests |
| A `logger` option on `tcpTransport` | A second place to configure logging. `onRefused` sends the transport's refusals to the system's logger |
| Decoding every frame in a chunk before acting on any | The proof raises the limit. Frames that arrived in the same chunk as the proof would be held to the small pre-proof limit. T3's first version did this, and a test that sent its proof and a big frame in one write caught it |

## Evidence

**T3 (2026-11-23):**

- `test/node/cluster/remoting.test.ts` runs T2's whole remoting suite, `test/cluster/remoting-suite.ts`, on TCP over loopback: 29 tests, on the same `ManualScheduler`, with frames on real sockets. `test/helpers/tcp-network.ts` gives each node a free port and knows when the network is quiet: no dial or proof under way, and every connection's other end, found by port, has read every frame it wrote. Two tests run only on the in-memory network, since TCP's timing is the operating system's: determinism from a seed, and a piped ask completing with only the scheduler running.
- `test/node/cluster/frames.test.ts`: frames decode the same whole, byte by byte, and cut at every point of the stream. Several frames in one chunk, a header split across chunks, and a character split across chunks all decode correctly. A frame over the limit is refused at its header, after the frames before it, and each frame is held to the limit when it's taken.
- `test/node/cluster/tcp.test.ts`:
  - Frames go both ways in order, including frames sent before the connection opened, multibyte and empty ones included.
  - A frame over the limit closes the connection, after the frames before it, and the refusal says so.
  - A peer with the wrong secret is disconnected on both sides, and both log it. The acceptor never hands it over, and the dialer's frame never goes.
  - On raw sockets, both ways, a peer that hasn't proven the secret receives exactly a challenge and a proof. The proof is the expected HMAC of both nonces and the role. The secret appears nowhere in the bytes, as text, hex or base64.
  - A reflected challenge and a reflected proof are refused.
  - So is anything else before the proof: another frame first, another protocol, a malformed nonce, a frame over 256 bytes, a second frame that isn't a proof, and a peer that says nothing for the timeout.
  - A peer that proves the secret and sends a big frame in the same write has it accepted, and one over the real limit in the same write is refused.
  - **Reconnecting.** A connection dropped by a proxy is dialed again at once. The next two dials are refused, and each following dial waits its backoff, 50 to 100 ms and then 100 to 200 ms. The 50 messages sent meanwhile arrive in order.
  - `host` defaults to `127.0.0.1`. `close()` ends connections both ways, the other ends hear of it, and later dials to the port are refused. `kill()` resets every socket and tells nothing locally.
  - Options are checked where they're passed in.
- `test/package.test.ts`: `/cluster/tcp` loads from `dist/`, `node:net` and `node:crypto` alone, and no other entry point loads it.
- Breaking each of these fails a test:
  - one MAC label for both sides fails the reflection test
  - dropping the echo check fails it too
  - sending before the peer's proof fails the over-limit and reconnecting tests and most of the TCP suite
  - removing the limit fails the frame tests and the TCP suite
  - reading a header from the first chunk only fails the split tests
  - raising the limit only after the chunk fails the same-write test
  - a test network that's always quiet fails the TCP suite

## Consequences

- Cluster traffic isn't encrypted. Anyone on the network path can read messages, though they can't join. The README must say to keep it on a private network until TLS comes, which it will when T10 documents the cluster.
- Every node needs the same secret, and changing it means restarting every node.
- Once a peer is connected, remoting writes into the socket without waiting for it to drain, so a slow peer grows Node's write buffer without bound. `bufferSize` bounds only what waits for a connection. T8's benchmark will show whether this needs backpressure.
- The proof timeout runs on the socket's real clock. Milestone 5's simulated network replaces the transport, so it doesn't need to run on virtual time.
