// What bench/peer.ts and bench/cluster.ts share: the cluster they form and the ponger's protocol.
import type { ActorRef } from '@kylewillett/troupe';

/** The cluster's name. */
export const CLUSTER = 'bench';
/** The secret both sides prove. Loopback only. */
export const SECRET = 'bench-secret';

/** A pong. */
export interface Pong {
  readonly type: 'pong';
}

/** What the ponger answers: a ping with a pong, and `whoami` with its own plain ref. */
export type PongerMsg =
  | { readonly type: 'ping'; readonly replyTo: ActorRef<Pong> }
  | { readonly type: 'whoami'; readonly replyTo: ActorRef<{ readonly ref: ActorRef<PongerMsg> }> };
